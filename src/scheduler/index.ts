import { getAddress } from 'viem';
import type { Agent, CandidateForEval } from '../agent.js';
import type { DexscreenerMcpClient } from '../dexscreener/mcp-client.js';
import { handlers, TOOL_PRICES_USD, type SpendTracker } from '../oracle/handlers.js';
import type { OracleClient } from '../oracle/client.js';
import type { Notifier } from '../notifications/index.js';
import type { WatchlistDb } from '../watchlist/db.js';
import type { ReportResponse } from '../oracle/schemas.js';
import { debug } from '../util/log.js';

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
      debug('scheduler', 'scan already running, skipping');
      return { candidates: 0, added: 0, removed: 0, skipped: true };
    }
    scanning = true;
    const startedAt = Date.now();
    const scanId = deps.db.recordScan({ startedAt });
    let added = 0;
    let removed = 0;
    let candidatesCount = 0;
    let errorMessage: string | undefined;

    try {
      const tokens = await deps.dexscreener.getTopBoostedTokens();
      const baseTokens = tokens.filter((t) => t.chainId === 'base');
      candidatesCount = baseTokens.length;
      await deps.notifier.notify({ type: 'scan:start', candidates: candidatesCount });

      const candidates: CandidateForEval[] = [];
      for (const tok of baseTokens) {
        const addr = tok.tokenAddress.toLowerCase();
        if (deps.db.get(addr)) {
          continue;
        }
        if (deps.spend.wouldExceed(REPORT_PRICE)) {
          debug('scheduler', 'spend cap reached, stopping report fetches');
          break;
        }
        let normalized: string;
        try {
          normalized = getAddress(addr);
        } catch {
          continue;
        }
        const result = await handlers.get_report({ address: normalized }, { oracle: deps.oracle, spend: deps.spend });
        if (!result.ok || !result.data) {
          debug('scheduler', 'report failed for', addr, result.error);
          continue;
        }
        const report = result.data as ReportResponse;
        const token = (report as { token?: { symbol?: string | null; name?: string | null } }).token ?? undefined;
        candidates.push({
          address: addr,
          symbol: token?.symbol ?? null,
          name: token?.name ?? null,
          reportSummary: summarizeReport(report),
        });
      }

      if (candidates.length === 0) {
        deps.db.finishScan(scanId, { finishedAt: Date.now(), candidates: candidatesCount, added: 0, removed: 0 });
        return { candidates: candidatesCount, added: 0, removed: 0, skipped: false };
      }

      const watchlist = deps.db.list();
      const evaluation = await deps.agent.evaluateCandidates({
        candidates,
        watchlist: watchlist.map((w) => ({ address: w.address, symbol: w.symbol, score: w.score })),
        maxSize: deps.maxWatchlistSize,
      });

      const candidateMap = new Map(candidates.map((c) => [c.address, c]));
      const reportMap = new Map<string, ReportResponse>();
      for (const c of candidates) {
        reportMap.set(c.address, c.reportSummary as unknown as ReportResponse);
      }
      const rankedMap = new Map(evaluation.ranked.map((r) => [r.address, r]));

      // Step 1: apply explicit replacements (only when score strictly greater).
      for (const rep of evaluation.replacements) {
        const ranked = rankedMap.get(rep.add);
        const cand = candidateMap.get(rep.add);
        const existing = deps.db.get(rep.remove);
        if (!ranked || !cand || !existing) continue;
        if (ranked.score <= existing.score) continue;
        deps.db.remove(existing.address);
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
        await deps.notifier.notify({
          type: 'watchlist:replace',
          added: { address: inserted.address, symbol: inserted.symbol, score: inserted.score, reasoning: inserted.reasoning },
          removed: { address: existing.address, symbol: existing.symbol, score: existing.score },
        });
      }

      // Step 2: fill remaining capacity, or evict lowest if a stronger ranked candidate exists.
      const handled = new Set<string>([
        ...evaluation.replacements.map((r) => r.add),
      ]);
      const sortedRanked = [...evaluation.ranked]
        .filter((r) => !handled.has(r.address) && candidateMap.has(r.address))
        .sort((a, b) => b.score - a.score);

      for (const ranked of sortedRanked) {
        const cand = candidateMap.get(ranked.address);
        if (!cand) continue;
        if (deps.db.get(ranked.address)) continue;
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
          if (ranked.score <= lowest.score) continue;
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
          await deps.notifier.notify({
            type: 'watchlist:replace',
            added: { address: inserted.address, symbol: inserted.symbol, score: inserted.score, reasoning: inserted.reasoning },
            removed: { address: lowest.address, symbol: lowest.symbol, score: lowest.score },
          });
        }
      }

      deps.db.finishScan(scanId, {
        finishedAt: Date.now(),
        candidates: candidatesCount,
        added,
        removed,
      });
      await deps.notifier.notify({
        type: 'scan:complete',
        added,
        removed,
        candidates: candidatesCount,
        durationMs: Date.now() - startedAt,
      });
      return { candidates: candidatesCount, added, removed, skipped: false };
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
      deps.db.finishScan(scanId, {
        finishedAt: Date.now(),
        candidates: candidatesCount,
        added,
        removed,
        error: errorMessage,
      });
      await deps.notifier.notify({ type: 'scan:error', message: errorMessage });
      return { candidates: candidatesCount, added, removed, skipped: false, error: errorMessage };
    } finally {
      scanning = false;
    }
  }

  function start(): void {
    if (timer) return;
    if (!enabled) return;
    const initialDelay = Math.min(deps.intervalMs, 10_000);
    timer = setTimeout(async function tick() {
      try {
        await runScan();
      } catch (err) {
        debug('scheduler tick error', err);
      } finally {
        if (enabled) {
          timer = setTimeout(tick, deps.intervalMs);
        }
      }
    }, initialDelay);
  }

  function stop(): void {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  return {
    start,
    stop,
    isRunning: () => timer !== undefined,
    isScanning: () => scanning,
    triggerNow: () => runScan(),
    setEnabled(value) {
      enabled = value;
      if (!value) stop();
      else if (!timer) start();
    },
  };
}
