export const debugEnabled = (): boolean => process.env.DEBUG === '1' || process.env.DEBUG === 'true';

export function debug(...args: unknown[]): void {
  if (debugEnabled()) {
    console.error('[debug]', ...args);
  }
}

export function info(...args: unknown[]): void {
  console.error(...args);
}
