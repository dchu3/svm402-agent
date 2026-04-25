import process from 'node:process';
import pc from 'picocolors';

export interface Glyphs {
  user: string;
  agent: string;
  toolStart: string;
  ok: string;
  fail: string;
  receipt: string;
  info: string;
  warn: string;
  error: string;
  debug: string;
  bullet: string;
  arrow: string;
  promptCaret: string;
  barFill: string;
  barEmpty: string;
}

const UNICODE_GLYPHS: Glyphs = {
  user: '❯',
  agent: '🤖',
  toolStart: '⚡',
  ok: '✓',
  fail: '✗',
  receipt: '💰',
  info: 'ℹ',
  warn: '⚠',
  error: '✗',
  debug: '·',
  bullet: '•',
  arrow: '→',
  promptCaret: '❯',
  barFill: '█',
  barEmpty: '░',
};

const ASCII_GLYPHS: Glyphs = {
  user: '>',
  agent: '>>',
  toolStart: '*',
  ok: 'OK',
  fail: 'X',
  receipt: '$',
  info: 'i',
  warn: '!',
  error: 'X',
  debug: '.',
  bullet: '-',
  arrow: '->',
  promptCaret: '>',
  barFill: '#',
  barEmpty: '-',
};

export interface Theme {
  colors: typeof pc;
  glyphs: Glyphs;
  ascii: boolean;
  isTTY: boolean;
  spinnersEnabled: boolean;
  promptStyle: 'rich' | 'plain';
}

function isAscii(): boolean {
  if (process.env.SVM402_ASCII === '1') return true;
  const lang = process.env.LANG ?? process.env.LC_ALL ?? process.env.LC_CTYPE ?? '';
  if (/UTF-?8/i.test(lang)) return false;
  if (process.platform === 'win32' && !process.env.WT_SESSION) return true;
  return false;
}

let theme: Theme | null = null;

export function getTheme(): Theme {
  if (theme) return theme;
  const ascii = isAscii();
  const isTTY = Boolean(process.stdout.isTTY);
  const spinnersEnabled = isTTY && process.env.SVM402_NO_SPINNER !== '1';
  const promptStyle: 'rich' | 'plain' =
    process.env.SVM402_PROMPT === 'plain' ? 'plain' : 'rich';
  theme = {
    colors: pc,
    glyphs: ascii ? ASCII_GLYPHS : UNICODE_GLYPHS,
    ascii,
    isTTY,
    spinnersEnabled,
    promptStyle,
  };
  return theme;
}

export function resetThemeForTest(): void {
  theme = null;
}
