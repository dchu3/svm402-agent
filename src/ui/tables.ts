import process from 'node:process';
import Table from 'cli-table3';
import { getTheme } from './theme.js';
import { TOOL_PRICES_USD } from '../oracle/handlers.js';
import type { PaymentReceipt } from '../oracle/client.js';
import { formatAtomicUsdc } from '../util/usdc.js';

function termWidth(): number {
  return process.stdout.columns ?? 100;
}

function midTruncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 3) return s.slice(0, max);
  const keep = Math.max(1, Math.floor((max - 1) / 2));
  return `${s.slice(0, keep)}…${s.slice(-(max - keep - 1))}`;
}

function shortTx(hash: string, max: number): string {
  if (!hash) return '—';
  return midTruncate(hash, max);
}

function tableChars(ascii: boolean): Record<string, string> {
  if (ascii) {
    return {
      top: '-',
      'top-mid': '+',
      'top-left': '+',
      'top-right': '+',
      bottom: '-',
      'bottom-mid': '+',
      'bottom-left': '+',
      'bottom-right': '+',
      left: '|',
      'left-mid': '+',
      mid: '-',
      'mid-mid': '+',
      right: '|',
      'right-mid': '+',
      middle: '|',
    };
  }
  return {
    top: '─',
    'top-mid': '┬',
    'top-left': '┌',
    'top-right': '┐',
    bottom: '─',
    'bottom-mid': '┴',
    'bottom-left': '└',
    'bottom-right': '┘',
    left: '│',
    'left-mid': '├',
    mid: '─',
    'mid-mid': '┼',
    right: '│',
    'right-mid': '┤',
    middle: '│',
  };
}

export interface BalanceInfo {
  address: string;
  usdcFormatted: string;
}

export function renderBalanceTable(info: BalanceInfo): string {
  const t = getTheme();
  const c = t.colors;
  const table = new Table({
    chars: tableChars(t.ascii),
    style: { head: [], border: [], 'padding-left': 1, 'padding-right': 1 },
  });
  table.push(
    [c.dim('address'), c.white(info.address)],
    [c.dim('chain'), c.white('Base mainnet (8453)')],
    [c.dim('USDC'), c.green(info.usdcFormatted)],
  );
  return table.toString();
}

export function renderSpendBar(spend: number, cap: number): string {
  const t = getTheme();
  const c = t.colors;
  const ratio = cap > 0 ? Math.min(1, Math.max(0, spend / cap)) : 0;
  const cells = 24;
  const filled = Math.round(ratio * cells);
  const empty = cells - filled;
  const fillColor = ratio >= 0.85 ? c.red : ratio >= 0.6 ? c.yellow : c.green;
  const bar = fillColor(t.glyphs.barFill.repeat(filled)) + c.dim(t.glyphs.barEmpty.repeat(empty));
  const pct = Math.round(ratio * 100);
  const summary = `$${spend.toFixed(4)} / $${cap.toFixed(3)}  (${pct}%)`;
  const lines = [`${c.bold('session spend')}  ${bar}  ${c.white(summary)}`];
  if (ratio >= 1) {
    lines.push(c.red(`  ${t.glyphs.warn} cap reached — raise MAX_SPEND_USDC to make more calls.`));
  }
  return lines.join('\n');
}

export function renderReceiptsTable(receipts: PaymentReceipt[]): string {
  const t = getTheme();
  const c = t.colors;
  if (receipts.length === 0) {
    return c.dim('  no receipts yet.');
  }
  const width = termWidth();
  const compact = width < 100;
  const endpointMax = compact ? 28 : 44;
  const txMax = compact ? 12 : 20;

  const table = new Table({
    head: [
      c.dim('#'),
      c.dim('endpoint'),
      c.dim('amount'),
      c.dim('status'),
      c.dim('tx'),
      c.dim('network'),
    ],
    chars: tableChars(t.ascii),
    style: { head: [], border: [], 'padding-left': 1, 'padding-right': 1 },
  });

  let total = 0;
  let failed = 0;
  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i]!;
    const amount = formatAtomicUsdc(r.amountAtomic);
    const amountNum = Number(amount);
    if (Number.isFinite(amountNum) && r.success) total += amountNum;
    if (!r.success) failed++;
    table.push([
      c.dim(String(i + 1)),
      c.white(midTruncate(r.endpoint, endpointMax)),
      r.success ? c.green(amount) : c.dim(amount),
      r.success ? c.green(t.glyphs.ok) : c.red(t.glyphs.fail),
      c.dim(shortTx(r.transaction, txMax)),
      c.dim(r.network),
    ]);
  }

  const summary = `total: ${c.green('$' + total.toFixed(6).replace(/0+$/, '').replace(/\.$/, ''))} USDC across ${c.bold(String(receipts.length))} call${receipts.length === 1 ? '' : 's'}${failed ? c.red(` (${failed} failed)`) : ''}`;
  return table.toString() + '\n' + summary;
}

export interface HelpRow {
  cmd: string;
  desc: string;
  price?: number;
}

const SLASH_ROWS: HelpRow[] = [
  { cmd: '/help', desc: 'Show this help' },
  { cmd: '/balance', desc: 'Show wallet address + USDC balance on Base' },
  { cmd: '/spend', desc: 'Show session spend (USDC) with progress bar' },
  { cmd: '/receipts', desc: 'List all settled payment receipts this session' },
  { cmd: '/watchlist', desc: 'Show the current curated watchlist (max 10)' },
  { cmd: '/scan', desc: 'Run a watchlist scan now (on demand, outside schedule)' },
  { cmd: '/scheduler [on|off]', desc: 'Show or toggle the periodic scanner' },
  { cmd: '/clear', desc: 'Reset Gemini chat history (does not refund spend)' },
  { cmd: '/quit, /exit', desc: 'Leave the REPL' },
];

const TOOL_ROWS: HelpRow[] = [
  { cmd: 'get_report(address, pair?)', desc: 'Token report', price: TOOL_PRICES_USD.get_report },
];

function renderRows(rows: HelpRow[]): string {
  const t = getTheme();
  const c = t.colors;
  const cmdWidth = Math.max(...rows.map((r) => r.cmd.length));
  return rows
    .map((r) => {
      const cmd = c.green(r.cmd) + ' '.repeat(cmdWidth - r.cmd.length);
      const desc = c.white(r.desc);
      const price = r.price !== undefined ? '  ' + c.dim(`$${r.price.toFixed(3)} USDC`) : '';
      return `  ${cmd}  ${desc}${price}`;
    })
    .join('\n');
}

export function renderHelp(): string {
  const t = getTheme();
  const c = t.colors;
  const slashHeader = c.bold(c.cyan('Slash commands'));
  const toolsHeader = c.bold(c.cyan('Tools available to Gemini'));
  return [
    slashHeader,
    renderRows(SLASH_ROWS),
    '',
    toolsHeader,
    renderRows(TOOL_ROWS),
    '',
    c.dim('Anything else is sent to Gemini.'),
  ].join('\n');
}
