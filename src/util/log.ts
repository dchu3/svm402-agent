export const debugEnabled = (): boolean => process.env.DEBUG === '1' || process.env.DEBUG === 'true';

export function debug(...args: unknown[]): void {
  if (debugEnabled()) {
    console.error('[debug]', ...args);
  }
}

export function info(...args: unknown[]): void {
  console.error(...args);
}

function fmtFields(fields?: Record<string, unknown>): string {
  if (!fields) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    let rendered: string;
    if (v === null) rendered = 'null';
    else if (typeof v === 'string') rendered = v;
    else if (typeof v === 'number' || typeof v === 'boolean') rendered = String(v);
    else {
      try {
        rendered = JSON.stringify(v);
      } catch {
        rendered = String(v);
      }
    }
    parts.push(`${k}=${rendered}`);
  }
  return parts.length > 0 ? ' ' + parts.join(' ') : '';
}

/**
 * Always-on, scoped logger for the watchlist / scheduler subsystem.
 * Emits to stderr regardless of DEBUG so users can see what the scan is doing.
 */
export function logWatchlist(message: string, fields?: Record<string, unknown>): void {
  console.error(`[watchlist] ${message}${fmtFields(fields)}`);
}

export function warnWatchlist(message: string, fields?: Record<string, unknown>): void {
  console.error(`[watchlist] WARN ${message}${fmtFields(fields)}`);
}
