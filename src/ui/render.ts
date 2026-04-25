import process from 'node:process';
import { getTheme } from './theme.js';

function write(line: string): void {
  process.stdout.write(line + '\n');
}

function writeErr(line: string): void {
  process.stderr.write(line + '\n');
}

export function printAgent(text: string): void {
  const t = getTheme();
  const c = t.colors;
  const trimmed = text.replace(/\s+$/u, '');
  if (!trimmed) {
    write(c.dim(`${t.glyphs.agent}  [no text response]`));
    return;
  }
  const lines = trimmed.split('\n');
  const first = lines.shift() as string;
  write(`${t.glyphs.agent}  ${c.white(first)}`);
  for (const line of lines) {
    write(`    ${c.white(line)}`);
  }
}

export function printInfo(text: string): void {
  const t = getTheme();
  const c = t.colors;
  write(`${c.cyan(t.glyphs.info)} ${c.cyan(text)}`);
}

export function printWarn(text: string): void {
  const t = getTheme();
  const c = t.colors;
  write(`${c.yellow(t.glyphs.warn)} ${c.yellow(text)}`);
}

export function printError(header: string, detail?: string, hint?: string): void {
  const t = getTheme();
  const c = t.colors;
  writeErr(`${c.red(t.glyphs.error)} ${c.red(c.bold(header))}`);
  if (detail) {
    for (const line of detail.split('\n')) {
      writeErr(`  ${c.red(line)}`);
    }
  }
  if (hint) {
    writeErr(`  ${c.dim(c.italic('hint: ' + hint))}`);
  }
}

export function printDebug(...args: unknown[]): void {
  if (process.env.DEBUG !== '1' && process.env.DEBUG !== 'true') return;
  const t = getTheme();
  const c = t.colors;
  const msg = args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  writeErr(`${c.dim(t.glyphs.debug)} ${c.dim(msg)}`);
}

export interface ToolEndInfo {
  name: string;
  ok: boolean;
  priceUsd: number;
  txHash?: string;
  network?: string;
  error?: string;
  summary?: string;
}

function shortTx(hash: string | undefined): string {
  if (!hash) return '—';
  if (hash.length <= 12) return hash;
  return `${hash.slice(0, 8)}…${hash.slice(-4)}`;
}

export function printToolEnd(info: ToolEndInfo): void {
  const t = getTheme();
  const c = t.colors;
  if (!info.ok) {
    write(
      `${c.red(t.glyphs.fail)} ${c.bold(info.name)}  ${c.dim(t.glyphs.arrow)}  ${c.red(info.error ?? 'failed')}`,
    );
    return;
  }
  const parts = [c.green(`$${info.priceUsd.toFixed(3)} USDC`)];
  if (info.summary) parts.unshift(c.white(info.summary));
  if (info.txHash) parts.push(c.dim(`tx ${shortTx(info.txHash)}`));
  write(
    `${c.green(t.glyphs.ok)} ${c.bold(info.name)}  ${c.dim(t.glyphs.arrow)}  ${parts.join('  ' + c.dim(t.glyphs.bullet) + '  ')}`,
  );
}

export function formatToolStart(name: string, args: Record<string, unknown>): string {
  const t = getTheme();
  const c = t.colors;
  const addr = typeof args.address === 'string' ? args.address : '';
  const display = addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
  const argText = display ? `(${display})` : '';
  return `${c.yellow(t.glyphs.toolStart)} ${c.bold(name)}${c.dim(argText)} ${c.dim('… signing & settling on Base')}`;
}
