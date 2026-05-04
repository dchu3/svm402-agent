import { getAddress } from 'viem';
import type { Agent, CandidateForEval } from '../agent.js';
import type { DexscreenerMcpClient } from '../dexscreener/mcp-client.js';
import { handlers, TOOL_PRICES_USD, type SpendTracker } from '../oracle/handlers.js';
import type { OracleClient } from '../oracle/client.js';
import type { Notifier } from '../notifications/index.js';
import type { WatchlistDb } from '../watchlist/db.js';
import type { ReportResponse } from '../oracle/schemas.js';
import { debug, logWatchlist, warnWatchlist } from '../util/log.js';

export interface SchedulerDeps {
  dexscreener: DexscreenerMcpClient;
  oracle: OracleClient;
  spend: SpendTracker;
  agent: Agent;
  db: WatchlistDb;
  notifier: Notifier;
  intervalMs: number;
  maxWatchlistSize: number;
  enabled: boolean;
}

export interface Scheduler {
  start(): void;
  stop(): void;
  isRunning(): boolean;
  isScanning(): boolean;
  triggerNow(): Promise<ScanResult>;
  setEnabled(value: boolean): void;
}

export interface ScanResult {
  candidates: number;
  added: number;
  removed: number;
  skipped: boolean;
  durationMs?: number;
  error?: string;
}

const REPORT_PRICE = TOOL_PRICES_USD.get_report ?? 0.01;

function summarizeReport(report: ReportResponse | Record<string, unknown> | undefined): Record<string, unknown> {
  if (!report || typeof report !== 'object') return {};
  const r = report as Record<string, unknown>;
  const token = (r.token ?? null) as Record<string, unknown> | null;
  const contract = (r.contract ?? null) as Record<string, unknown> | null;
  return {
    address: r.address,
    chain: r.chain,
    symbol: token?.symbol ?? null,
    name: token?.name ?? null,
    verified: token?.verified ?? null,
    holder_count: r.holder_count ?? null,
    top10_concentration_pct: r.top10_concentration_pct ?? null,
    circulating_top10_concentration_pct: r.circulating_top10_concentration_pct ?? null,
    deployer_holdings_pct: r.deployer_holdings_pct ?? null,
    flags: r.flags ?? [],
    contract: contract
      ? {
          verified: contract.verified ?? null,
          is_proxy: contract.is_proxy ?? null,
          traits: contract.traits ?? null,
        }
      : null,
  };
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  let timer: NodeJS.Timeout | undefined;
  let scanning = false;
  let enabled = deps.enabled;

  async function runScan(): Promise<ScanResult> {
    if (scanning) {
      logWatchlist('scan requested but one is already running, skipping');
      return { candidates: 0, added: 0, removed: 0, skipped: true };
    }
    scanning = true;
    const startedAt = Date.now();
    const scanId = deps.db.recordScan({ startedAt });
    let added = 0;
    let removed = 0;
    let candidatesCount = 0;
    let errorMessage: string | undefined;

    logWatchlist('scan started', {
      scanId,
      maxWatchlistSize: deps.maxWatchlistSize,
      currentSize: deps.db.count(),
      spendUsed: deps.spend.total.toFixed(4),
      spendCap: deps.spend.cap.toFixed(4),
    });

    try {
      const trendingLimit = Math.max(deps.maxWatchlistSize * 3, 30);
      const tokens = await deps.dexscreener.getTrendingBaseTokens(trendingLimit);
      candidatesCount = tokens.length;
      logWatchlist('dexscreener trending base tokens fetched', {
        trending: tokens.length,
        limit: trendingLimit,
      });
      await deps.notifier.notify({ type: 'scan:start', candidates: candidatesCount });

      const candidates: CandidateForEval[] = [];
      const reportBudget = Math.max(1, deps.maxWatchlistSize);
      let skippedAlreadyOnList = 0;
      let skippedInvalidAddress = 0;
      let skippedReportFailed = 0;
      let stoppedAtBudget = false;
      let stoppedAtSpendCap = false;
      for (const tok of tokens) {
        if (candidates.length >= reportBudget) {
          stoppedAtBudget = true;
          logWatchlist('report budget reached, stopping fetches', { budget: reportBudget });
          break;
        }
        const addr = tok.tokenAddress.toLowerCase();
        // Defense-in-depth: the MCP-side ranker filters known sentinels and
        // non-EVM addresses, but reject obviously invalid candidates here
        // too so a future MCP-server change can't accidentally feed the
        // zero address (or a non-40-hex string) to the oracle.
        if (!/^0x[0-9a-f]{40}$/.test(addr) || /^0x0{40}$/.test(addr)) {
          skippedInvalidAddress++;
          continue;
        }
        if (deps.db.get(addr)) {
          skippedAlreadyOnList++;
          continue;
        }
        if (deps.spend.wouldExceed(REPORT_PRICE)) {
          stoppedAtSpendCap = true;
          logWatchlist('spend cap would be exceeded, stopping report fetches', {
            spendUsed: deps.spend.total.toFixed(4),
            spendCap: deps.spend.cap.toFixed(4),
            reportPrice: REPORT_PRICE,
          });
          break;
        }
        let normalized: string;
        try {
          normalized = getAddress(addr);
        } catch {
          skippedInvalidAddress++;
          continue;
        }
        const result = await handlers.get_report({ address: normalized }, { oracle: deps.oracle, spend: deps.spend });
        if (!result.ok || !result.data) {
          skippedReportFailed++;
          warnWatchlist('report fetch failed for candidate', {
            address: addr,
            error: result.ok ? 'no_data' : result.error,
          });
          continue;
        }
        const report = result.data as ReportResponse;
        const token = (report as { token?: { symbol?: string | null; name?: string | null } }).token ?? undefined;
        candidates.push({
          address: normalized.toLowerCase(),
          symbol: token?.symbol ?? null,
          name: token?.name ?? null,
          reportSummary: summarizeReport(report),
        });
      }

      logWatchlist('candidate gathering complete', {
        candidates: candidates.length,
        skippedAlreadyOnList,
        skippedInvalidAddress,
        skippedReportFailed,
        stoppedAtBudget,
        stoppedAtSpendCap,
      });

      if (candidates.length === 0) {
        logWatchlist('no new candidates to evaluate; nothing to add or replace');
        const durationMs = Date.now() - startedAt;
        deps.db.finishScan(scanId, { finishedAt: Date.now(), candidates: candidatesCount, added: 0, removed: 0 });
        await deps.notifier.notify({
          type: 'scan:complete',
          added: 0,
          removed: 0,
          candidates: candidatesCount,
          durationMs,
        });
        return { candidates: candidatesCount, added: 0, removed: 0, skipped: false, durationMs };
      }

      const watchlist = deps.db.list();
      logWatchlist('evaluating candidates with LLM', {
        candidates: candidates.length,
        currentWatchlistSize: watchlist.length,
      });
      const evaluation = await deps.agent.evaluateCandidates({
        candidates,
        watchlist: watchlist.map((w) => ({ address: w.address, symbol: w.symbol, score: w.score })),
        maxSize: deps.maxWatchlistSize,
      });
      logWatchlist('evaluation complete', {
        ranked: evaluation.ranked.length,
        replacements: evaluation.replacements.length,
      });
      if (evaluation.ranked.length === 0) {
        warnWatchlist('LLM evaluator returned no ranked candidates; nothing will be added', {
          candidates: candidates.length,
        });
      }

      const candidateMap = new Map(candidates.map((c) => [c.address, c]));
      const reportMap = new Map<string, ReportResponse>();
      for (const c of candidates) {
        reportMap.set(c.address, c.reportSummary as unknown as ReportResponse);
      }
      const rankedMap = new Map(evaluation.ranked.map((r) => [r.address, r]));

      // Step 1: apply explicit replacements (only when score strictly greater).
      // Dedup: each candidate may only be added once, each entry may only be removed once.
      const handled = new Set<string>();
      const evictedFromDb = new Set<string>();
      for (const rep of evaluation.replacements) {
        const addAddr = (rep.add ?? '').toLowerCase();
        const removeAddr = (rep.remove ?? '').toLowerCase();
        if (!addAddr || !removeAddr) continue;
        if (handled.has(addAddr) || evictedFromDb.has(removeAddr)) {
          logWatchlist('replacement skipped (dedup)', { add: addAddr, remove: removeAddr });
          continue;
        }
        const ranked = rankedMap.get(addAddr);
        const cand = candidateMap.get(addAddr);
        const existing = deps.db.get(removeAddr);
        if (!ranked || !cand || !existing) {
          logWatchlist('replacement skipped (missing data)', {
            add: addAddr,
            remove: removeAddr,
            hasRanked: Boolean(ranked),
            hasCandidate: Boolean(cand),
            hasExisting: Boolean(existing),
          });
          continue;
        }
        if (ranked.score <= existing.score) {
          logWatchlist('replacement rejected (score not strictly greater)', {
            add: addAddr,
            addScore: ranked.score,
            remove: removeAddr,
            removeScore: existing.score,
          });
          continue;
        }
        deps.db.remove(existing.address);
        const inserted = deps.db.upsert({
          address: cand.address,
          symbol: cand.symbol,
          name: cand.name,
          score: ranked.score,
          reasoning: ranked.reasoning,
          report: reportMap.get(cand.address),
        });
        handled.add(addAddr);
        evictedFromDb.add(removeAddr);
        added++;
        removed++;
        logWatchlist('replacement applied', {
          add: cand.address,
          addScore: ranked.score,
          remove: existing.address,
          removeScore: existing.score,
        });
        await deps.notifier.notify({
          type: 'watchlist:replace',
          added: { address: inserted.address, symbol: inserted.symbol, score: inserted.score, reasoning: inserted.reasoning },
          removed: { address: existing.address, symbol: existing.symbol, score: existing.score },
        });
      }

      // Step 2: fill remaining capacity, or evict lowest if a stronger ranked candidate exists.
      const sortedRanked = [...evaluation.ranked]
        .filter((r) => !handled.has(r.address) && candidateMap.has(r.address))
        .sort((a, b) => b.score - a.score);

      for (const ranked of sortedRanked) {
        const cand = candidateMap.get(ranked.address);
        if (!cand) continue;
        if (deps.db.get(ranked.address)) {
          logWatchlist('candidate already on watchlist after step 1, skipping', { address: ranked.address });
          continue;
        }
        if (deps.db.count() < deps.maxWatchlistSize) {
          const inserted = deps.db.upsert({
            address: cand.address,
            symbol: cand.symbol,
            name: cand.name,
            score: ranked.score,
            reasoning: ranked.reasoning,
            report: reportMap.get(cand.address),
          });
          added++;
          logWatchlist('added new entry to watchlist', {
            address: inserted.address,
            symbol: inserted.symbol,
            score: inserted.score,
          });
          await deps.notifier.notify({
            type: 'watchlist:add',
            address: inserted.address,
            symbol: inserted.symbol,
            name: inserted.name,
            score: inserted.score,
            reasoning: inserted.reasoning,
          });
        } else {
          const lowest = deps.db.lowestScored();
          if (!lowest) break;
          if (ranked.score <= lowest.score) {
            logWatchlist('eviction rejected (score not strictly greater than lowest)', {
              candidate: ranked.address,
              candidateScore: ranked.score,
              lowest: lowest.address,
              lowestScore: lowest.score,
            });
            continue;
          }
          deps.db.remove(lowest.address);
          const inserted = deps.db.upsert({
            address: cand.address,
            symbol: cand.symbol,
            name: cand.name,
            score: ranked.score,
            reasoning: ranked.reasoning,
            report: reportMap.get(cand.address),
          });
          added++;
          removed++;
          logWatchlist('evicted lowest-scored entry to make room', {
            add: cand.address,
            addScore: ranked.score,
            remove: lowest.address,
            removeScore: lowest.score,
          });
          await deps.notifier.notify({
            type: 'watchlist:replace',
            added: { address: inserted.address, symbol: inserted.symbol, score: inserted.score, reasoning: inserted.reasoning },
            removed: { address: lowest.address, symbol: lowest.symbol, score: lowest.score },
          });
        }
      }

      const durationMs = Date.now() - startedAt;
      deps.db.finishScan(scanId, {
        finishedAt: Date.now(),
        candidates: candidatesCount,
        added,
        removed,
      });
      logWatchlist('scan finished', {
        added,
        removed,
        candidates: candidatesCount,
        durationMs,
        finalSize: deps.db.count(),
      });
      await deps.notifier.notify({
        type: 'scan:complete',
        added,
        removed,
        candidates: candidatesCount,
        durationMs,
      });
      return { candidates: candidatesCount, added, removed, skipped: false, durationMs };
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - startedAt;
      warnWatchlist('scan errored', { error: errorMessage, durationMs });
      deps.db.finishScan(scanId, {
        finishedAt: Date.now(),
        candidates: candidatesCount,
        added,
        removed,
        error: errorMessage,
      });
      await deps.notifier.notify({ type: 'scan:error', message: errorMessage });
      return { candidates: candidatesCount, added, removed, skipped: false, durationMs, error: errorMessage };
    } finally {
      scanning = false;
    }
  }

  function start(): void {
    if (timer) return;
    enabled = true;
    const initialDelay = Math.min(deps.intervalMs, 10_000);
    timer = setTimeout(async function tick() {
      try {
        await runScan();
      } catch (err) {
        debug('scheduler tick error', err);
      } finally {
        if (enabled) {
          timer = setTimeout(tick, deps.intervalMs);
        } else {
          timer = undefined;
        }
      }
    }, initialDelay);
  }

  function stop(): void {
    enabled = false;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  return {
    start,
    stop,
    isRunning: () => enabled,
    isScanning: () => scanning,
    triggerNow: () => runScan(),
    setEnabled(value) {
      if (value) start();
      else stop();
    },
  };
}
