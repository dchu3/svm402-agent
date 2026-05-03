export const USDC_DECIMALS = 6;

function isIntegerAtomic(s: string): boolean {
  return /^-?\d+$/.test(s);
}

function formatAtomicBigInt(atomic: string): string {
  const negative = atomic.startsWith('-');
  const digits = negative ? atomic.slice(1) : atomic;
  const padded = digits.padStart(USDC_DECIMALS + 1, '0');
  const whole = padded.slice(0, padded.length - USDC_DECIMALS);
  const frac = padded.slice(padded.length - USDC_DECIMALS).replace(/0+$/, '');
  const body = frac.length === 0 ? whole : `${whole}.${frac}`;
  return negative ? `-${body}` : body;
}

export function formatAtomicUsdc(atomic?: string | null): string {
  if (atomic === undefined || atomic === null || atomic === '') return '—';
  if (!isIntegerAtomic(atomic)) return '—';
  return formatAtomicBigInt(atomic);
}

export function parseAtomicUsdc(atomic?: string | null): number | undefined {
  if (atomic === undefined || atomic === null || atomic === '') return undefined;
  if (!isIntegerAtomic(atomic)) return undefined;
  const n = Number(atomic) / 10 ** USDC_DECIMALS;
  return Number.isFinite(n) ? n : undefined;
}

