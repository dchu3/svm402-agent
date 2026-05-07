import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { Agent, ToolCallEvent, ToolEndEvent } from './agent.js';
import type { OracleClient } from './oracle/client.js';
import type { Wallet } from './wallet.js';
import type { SpendTracker } from './oracle/handlers.js';
import type { WatchlistDb } from './watchlist/db.js';
import type { Scheduler } from './scheduler/index.js';
import type { TradingEngine } from './trading/engine.js';
import type { TradingStore } from './trading/store.js';
import { summarizeWatchlist } from './notifications/index.js';
import { buildPrompt } from './ui/prompt.js';
import {
  printAgent,
  printError,
  printInfo,
  printToolEnd,
  formatToolStart,
} from './ui/render.js';
import {
  renderBalanceTable,
  renderHelp,
  renderReceiptsTable,
  renderSpendBar,
} from './ui/tables.js';
import { startSpinner, type SpinnerHandle } from './ui/spinner.js';
import { getTheme } from './ui/theme.js';

export interface ReplDeps {
  agent: Agent;
  oracle: OracleClient;
  wallet: Wallet;
  spend: SpendTracker;
  db?: WatchlistDb;
  getScheduler?: () => Scheduler | undefined;
  getTradingEngine?: () => TradingEngine | undefined;
  tradingStore?: TradingStore;
}

const ELEVATED_TOP10_PCT = 30;

interface ContractSummaryShape {
  verified?: boolean | null;
  traits?: {
    mintable?: boolean | null;
    pausable?: boolean | null;
    blacklist?: boolean | null;
    fee_setter?: boolean | null;
    proxy_upgradeable?: boolean | null;
  } | null;
}

function compactContractSignals(contract: ContractSummaryShape | null | undefined): string[] {
  if (!contract) return [];
  const parts: string[] = [];
  if (contract.verified === false) parts.push('unverified');
  const t = contract.traits;
  if (t) {
    if (t.mintable === true) parts.push('mintable');
    if (t.pausable === true) parts.push('pausable');
    if (t.blacklist === true) parts.push('blacklist');
    if (t.fee_setter === true) parts.push('fee_setter');
    if (t.proxy_upgradeable === true) parts.push('proxy_upgradeable');
  }
  return parts;
}

function buildSummary(ev: ToolEndEvent): string | undefined {
  if (!ev.result.ok) return undefined;
  const data = ev.result.data as
    | {
        top10_concentration_pct?: number | null;
        holder_count?: number | null;
        contract?: ContractSummaryShape | null;
      }
    | undefined;
  if (!data) return undefined;

  const parts: string[] = [];
  if (typeof data.top10_concentration_pct === 'number') {
    const tag = data.top10_concentration_pct >= ELEVATED_TOP10_PCT ? ' ⚠' : '';
    parts.push(`top-10 ${data.top10_concentration_pct.toFixed(1)}%${tag}`);
  }
  if (typeof data.holder_count === 'number') {
    parts.push(`${data.holder_count.toLocaleString()} holders`);
  }
  const contractSignals = compactContractSignals(data.contract);
  if (contractSignals.length > 0) {
    parts.push(`contract ⚠ ${contractSignals.join(', ')}`);
  }
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

export async function startRepl(deps: ReplDeps): Promise<void> {
  const rl = readline.createInterface({ input, output, terminal: true });
  const refreshPrompt = (): void => {
    rl.setPrompt(
      buildPrompt({
        spend: deps.spend.total,
        cap: deps.spend.cap,
        receipts: deps.oracle.receipts.length,
      }),
    );
  };
  refreshPrompt();
  rl.prompt();

  let activeSpinner: SpinnerHandle | null = null;

  const clearSpinner = (): void => {
    const s = activeSpinner;
    if (s) {
      s.stopAndClear();
      activeSpinner = null;
    }
  };

  rl.on('SIGINT', () => {
    clearSpinner();
    output.write('\n');
    printInfo('use /quit to exit.');
    refreshPrompt();
    rl.prompt();
  });

  const onToolStart = (ev: ToolCallEvent): void => {
    activeSpinner = startSpinner(formatToolStart(ev.name, ev.args));
  };
  const onToolEnd = (ev: ToolEndEvent): void => {
    clearSpinner();
    printToolEnd({
      name: ev.name,
      ok: ev.result.ok,
      priceUsd: ev.priceUsd,
      ...(ev.receipt?.transaction ? { txHash: ev.receipt.transaction } : {}),
      ...(ev.receipt?.network ? { network: ev.receipt.network } : {}),
      ...(ev.result.error ? { error: ev.result.error } : {}),
      ...((): { summary?: string } => {
        const s = buildSummary(ev);
        return s ? { summary: s } : {};
      })(),
    });
  };

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) {
      refreshPrompt();
      rl.prompt();
      continue;
    }
    if (line === '/quit' || line === '/exit') break;
    if (line === '/help') {
      output.write(renderHelp() + '\n');
      refreshPrompt();
      rl.prompt();
      continue;
    }
    if (line === '/balance') {
      try {
        const { formatted } = await deps.wallet.usdcBalance();
        output.write(
          renderBalanceTable({ address: deps.wallet.address, usdcFormatted: formatted }) + '\n',
        );
      } catch (err) {
        printError('balance lookup failed', err instanceof Error ? err.message : String(err));
      }
      refreshPrompt();
      rl.prompt();
      continue;
    }
    if (line === '/spend') {
      output.write(renderSpendBar(deps.spend.total, deps.spend.cap) + '\n');
      refreshPrompt();
      rl.prompt();
      continue;
    }
    if (line === '/receipts') {
      output.write(renderReceiptsTable(deps.oracle.receipts) + '\n');
      refreshPrompt();
      rl.prompt();
      continue;
    }
    if (line === '/clear') {
      deps.agent.reset();
      printInfo('chat history cleared.');
      refreshPrompt();
      rl.prompt();
      continue;
    }
    if (line === '/watchlist') {
      if (!deps.db) {
        printInfo('watchlist not enabled.');
      } else {
        output.write(summarizeWatchlist(deps.db.list()) + '\n');
      }
      refreshPrompt();
      rl.prompt();
      continue;
    }
    if (line === '/scan') {
      const sched = deps.getScheduler?.();
      if (!sched) {
        printError('scheduler not configured.');
      } else if (sched.isScanning()) {
        printInfo('scan already in progress.');
      } else {
        printInfo('triggering watchlist scan…');
        sched
          .triggerNow()
          .then((res) => {
            if (res.error) {
              printError('scan failed', res.error);
              return;
            }
            const dur = typeof res.durationMs === 'number' ? ` in ${(res.durationMs / 1000).toFixed(1)}s` : '';
            printInfo(
              `scan finished: +${res.added}/-${res.removed} of ${res.candidates} candidate(s)${dur}.`,
            );
          })
          .catch((err) => printError('scan error', err instanceof Error ? err.message : String(err)));
      }
      refreshPrompt();
      rl.prompt();
      continue;
    }
    if (line.startsWith('/scheduler')) {
      const sched = deps.getScheduler?.();
      if (!sched) {
        printError('scheduler not configured.');
      } else {
        const arg = line.split(/\s+/)[1];
        if (arg === 'on') {
          sched.setEnabled(true);
          printInfo('scheduler enabled.');
        } else if (arg === 'off') {
          sched.setEnabled(false);
          printInfo('scheduler disabled.');
        } else {
          printInfo(`scheduler ${sched.isRunning() ? 'running' : 'stopped'}${sched.isScanning() ? ' (scanning…)' : ''}`);
        }
      }
      refreshPrompt();
      rl.prompt();
      continue;
    }
    if (
      line === '/positions' ||
      line === '/trades' ||
      line === '/trade-on' ||
      line === '/trade-off' ||
      line === '/trade-status' ||
      line.startsWith('/sell ')
    ) {
      const engine = deps.getTradingEngine?.();
      const store = deps.tradingStore;
      if (!engine || !store) {
        printError('trading engine not configured.');
      } else if (line === '/positions') {
        const open = store.listOpen();
        if (open.length === 0) {
          printInfo('no open positions.');
        } else {
          for (const p of open) {
            const tag = p.dryRun ? '[dry-run]' : '[live]';
            const held = ((Date.now() - p.openedAt) / 60000).toFixed(1);
            output.write(
              `  ${tag} ${p.symbol ?? p.address.slice(0, 10)} (${p.address}) — entry $${p.entryPriceUsd.toExponential(3)} · size $${p.entryAmountUsdc.toFixed(2)} · peak $${p.highestPriceUsd.toExponential(3)} · held ${held}m · ${p.dex}${p.feeTier ? ` ${p.feeTier}bps` : ''}\n`,
            );
          }
        }
      } else if (line === '/trades') {
        const trades = store.listTrades(20);
        if (trades.length === 0) {
          printInfo('no trades recorded.');
        } else {
          for (const t of trades) {
            const tag = t.dryRun ? '[dry-run]' : '[live]';
            const tx = t.txHash ? ` tx ${t.txHash.slice(0, 10)}…` : '';
            const err = t.error ? ` ERROR: ${t.error}` : '';
            output.write(
              `  ${tag} ${t.side.toUpperCase()} ${t.positionAddress} @ $${t.priceUsd.toExponential(3)} on ${t.dex}${t.feeTier ? ` ${t.feeTier}bps` : ''}${tx}${err}\n`,
            );
          }
        }
      } else if (line === '/trade-on') {
        engine.setEnabled(true);
        printInfo(`trading engine enabled (${engine.isLive() ? 'LIVE' : 'DRY-RUN'}).`);
      } else if (line === '/trade-off') {
        engine.setEnabled(false);
        printInfo('trading engine disabled.');
      } else if (line === '/trade-status') {
        const s = engine.status();
        printInfo(
          `trading: ${s.enabled ? 'enabled' : 'disabled'} · ${s.live ? 'LIVE' : 'DRY-RUN'} · ${s.openPositions}/${s.maxOpenPositions} open · size $${s.tradeSizeUsdc} · min score ${s.minScore} · dex ${s.dex} · TP ${s.policy.takeProfitPct}% / SL ${s.policy.stopLossPct}% / trail ${s.policy.trailingStopPct}% / hold ${(s.policy.maxHoldMs / 60000).toFixed(0)}m`,
        );
      } else if (line.startsWith('/sell ')) {
        const arg = line.slice(6).trim();
        const res = await engine.manualSell(arg);
        if (res.closed) printInfo(`sell triggered for ${arg}.`);
        else printError(`sell failed: ${res.error ?? 'unknown_error'}`);
      }
      refreshPrompt();
      rl.prompt();
      continue;
    }
    if (line.startsWith('/')) {
      printError(`unknown command: ${line}`, 'type /help for the list of commands.');
      refreshPrompt();
      rl.prompt();
      continue;
    }

    try {
      const startedAt = Date.now();
      const t = getTheme();
      const c = t.colors;
      const isTty = t.isTTY;
      let firstChunkSeen = false;
      let streamedContent = false;
      let streamLineOpen = false;
      const clearHeartbeat = (): void => {
        // Erase the current TTY line; only valid on a real terminal.
        if (isTty) output.write('\r\x1b[2K');
      };
      const openStreamLine = (): void => {
        if (streamLineOpen) return;
        clearHeartbeat();
        output.write(`${t.glyphs.agent}  `);
        streamLineOpen = true;
      };
      const closeStreamLine = (): void => {
        if (!streamLineOpen) return;
        output.write('\n');
        streamLineOpen = false;
      };
      // No point in animating a heartbeat into a non-TTY (it'd just spam logs
      // with one "still thinking" line every 5s that can never be erased).
      const heartbeat = isTty
        ? setInterval(() => {
            if (firstChunkSeen) return;
            const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
            clearHeartbeat();
            output.write(c.dim(`… still thinking (${elapsedSec}s)`));
          }, 5000)
        : null;
      heartbeat?.unref?.();
      const onStreamChunk = (delta: string): void => {
        firstChunkSeen = true;
        streamedContent = true;
        if (!streamLineOpen) openStreamLine();
        output.write(c.white(delta));
      };
      // If a model turn mixes streamed text with a tool call, the tool UI
      // would otherwise overwrite the streamed line. Terminate the stream
      // line first so the spinner / tool-end block lands cleanly.
      const onToolStartWrapped = (ev: ToolCallEvent): void => {
        closeStreamLine();
        onToolStart(ev);
      };
      try {
        const reply = await deps.agent.send(line, {
          onToolStart: onToolStartWrapped,
          onToolEnd,
          onStreamChunk,
        });
        if (heartbeat) clearInterval(heartbeat);
        if (streamedContent) {
          closeStreamLine();
        } else {
          clearHeartbeat();
          printAgent(reply);
        }
      } finally {
        if (heartbeat) clearInterval(heartbeat);
      }
    } catch (err) {
      clearSpinner();
      printError('agent error', err instanceof Error ? err.message : String(err));
    }
    refreshPrompt();
    rl.prompt();
  }

  rl.close();
  const t = getTheme();
  output.write(t.colors.dim('bye.\n'));
}
