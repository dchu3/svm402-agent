import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { Agent, ToolCallEvent, ToolEndEvent } from './agent.js';
import type { OracleClient } from './oracle/client.js';
import type { Wallet } from './wallet.js';
import type { SpendTracker } from './oracle/handlers.js';
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
}

const ELEVATED_TOP10_PCT = 30;

function buildSummary(ev: ToolEndEvent): string | undefined {
  if (!ev.result.ok) return undefined;
  const data = ev.result.data as
    | {
        risk_score?: number;
        risk_level?: string;
        risk_confidence?: string;
        top10_concentration_pct?: number | null;
        holder_count?: number | null;
        flags?: string[];
        risk_coverage?: { evaluated?: number; total?: number } | null;
      }
    | undefined;
  if (!data) return undefined;

  const parts: string[] = [];
  if (typeof data.risk_score === 'number') {
    let head = `risk ${data.risk_score}/10`;
    if (data.risk_level) head += ` · ${data.risk_level}`;
    if (data.risk_confidence) head += ` · conf ${data.risk_confidence}`;
    parts.push(head);
  }
  if (typeof data.top10_concentration_pct === 'number') {
    const tag =
      data.top10_concentration_pct >= ELEVATED_TOP10_PCT &&
      !(data.flags ?? []).includes('high_concentration')
        ? ' ⚠'
        : '';
    parts.push(`top-10 ${data.top10_concentration_pct.toFixed(1)}%${tag}`);
  }
  if (typeof data.holder_count === 'number') {
    parts.push(`${data.holder_count.toLocaleString()} holders`);
  }
  const cov = data.risk_coverage ?? undefined;
  const partial =
    typeof cov?.evaluated === 'number' &&
    typeof cov?.total === 'number' &&
    cov.evaluated < cov.total;
  if (data.risk_confidence === 'low' || partial) {
    if (cov && typeof cov.evaluated === 'number' && typeof cov.total === 'number') {
      parts.push(`partial coverage ${cov.evaluated}/${cov.total}`);
    } else {
      parts.push('partial coverage');
    }
  }
  if (parts.length === 0 && Array.isArray(data.flags) && data.flags.length > 0) {
    parts.push(`${data.flags.length} flag${data.flags.length === 1 ? '' : 's'}`);
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
    if (line.startsWith('/')) {
      printError(`unknown command: ${line}`, 'type /help for the list of commands.');
      refreshPrompt();
      rl.prompt();
      continue;
    }

    try {
      const reply = await deps.agent.send(line, { onToolStart, onToolEnd });
      printAgent(reply);
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
