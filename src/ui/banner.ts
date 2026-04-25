import boxen from 'boxen';
import { getTheme } from './theme.js';

export interface BannerInfo {
  oracleUrl: string;
  walletAddress: string;
  model: string;
  spendCap: number;
  usdcBalance: string | null;
  balanceError?: string;
}

function pad(label: string, width: number): string {
  if (label.length >= width) return label;
  return label + ' '.repeat(width - label.length);
}

function shortAddress(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function renderBanner(info: BannerInfo): string {
  const t = getTheme();
  const c = t.colors;

  const title = c.bold(c.cyan('svm402-agent'));
  const subtitle = c.dim('Gemini × x402 client for base-token-oracle');
  const warn = c.yellow(
    `${t.glyphs.warn}  signs REAL USDC payments on Base mainnet (chainId 8453)`,
  );

  const balText = info.usdcBalance ?? c.red(`<${info.balanceError ?? 'lookup failed'}>`);

  const labelWidth = 10;
  const rows = [
    `${c.dim(pad('oracle', labelWidth))}${c.white(info.oracleUrl)}`,
    `${c.dim(pad('wallet', labelWidth))}${c.white(info.walletAddress)}`,
    `${c.dim(pad('balance', labelWidth))}${c.green(balText)} ${c.dim('USDC')}`,
    `${c.dim(pad('model', labelWidth))}${c.white(info.model)}`,
    `${c.dim(pad('spend cap', labelWidth))}${c.white('$' + info.spendCap.toFixed(3))} ${c.dim('USDC / session')}`,
  ];

  const body = [title, subtitle, warn, '', ...rows].join('\n');

  const box = boxen(body, {
    padding: { top: 0, bottom: 0, left: 1, right: 1 },
    margin: 0,
    borderStyle: t.ascii ? 'classic' : 'round',
    borderColor: 'cyan',
    title: shortAddress(info.walletAddress),
    titleAlignment: 'right',
  });

  const lines = [box];
  if (info.usdcBalance !== null) {
    const num = Number(info.usdcBalance);
    if (Number.isFinite(num) && num < 0.05) {
      lines.push(
        c.yellow(
          `  ${t.glyphs.warn} USDC balance is very low — paid calls will 402 then fail to settle.`,
        ),
      );
    }
  }
  lines.push(c.dim('  Type /help for commands. Ctrl-C or /quit to exit.'));
  return lines.join('\n');
}
