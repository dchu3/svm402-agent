import { getTheme } from './theme.js';

export interface PromptState {
  spend: number;
  cap: number;
  receipts: number;
}

export function buildPrompt(state: PromptState): string {
  const t = getTheme();
  const c = t.colors;
  if (t.promptStyle === 'plain') {
    return 'svm402> ';
  }
  const ratio = state.cap > 0 ? state.spend / state.cap : 0;
  const spendColor =
    ratio >= 0.85 ? c.red : ratio >= 0.6 ? c.yellow : c.green;
  const spendText = spendColor(`$${state.spend.toFixed(4)}`);
  const capText = c.dim(`/ $${state.cap.toFixed(3)}`);
  const callsText = c.dim(`${state.receipts} call${state.receipts === 1 ? '' : 's'}`);
  const status = c.dim('[') +
    spendText + ' ' + capText + ' ' + c.dim(t.glyphs.bullet) + ' ' + callsText +
    c.dim(']');
  return `${status} ${c.cyan(c.bold('svm402'))}${c.cyan(t.glyphs.promptCaret)} `;
}
