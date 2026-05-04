import type { WatchlistEntry } from '../watchlist/types.js';

export type NotificationEvent =
  | {
      type: 'watchlist:add';
      address: string;
      symbol: string | null;
      name: string | null;
      score: number;
      reasoning: string | null;
    }
  | {
      type: 'watchlist:replace';
      added: { address: string; symbol: string | null; score: number; reasoning: string | null };
      removed: { address: string; symbol: string | null; score: number };
    }
  | {
      type: 'watchlist:remove';
      address: string;
      symbol: string | null;
      score: number;
      reason: string;
    }
  | {
      type: 'scan:start';
      candidates: number;
    }
  | {
      type: 'scan:complete';
      added: number;
      removed: number;
      candidates: number;
      durationMs: number;
    }
  | {
      type: 'scan:error';
      message: string;
    };

export interface Notifier {
  notify(event: NotificationEvent): Promise<void>;
}

function fmtAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function formatNotification(event: NotificationEvent): string {
  switch (event.type) {
    case 'watchlist:add': {
      const label = event.symbol ?? event.name ?? fmtAddr(event.address);
      return `➕ Added to watchlist: ${label} (${fmtAddr(event.address)}) — score ${event.score.toFixed(1)}${
        event.reasoning ? `\n   ${event.reasoning}` : ''
      }`;
    }
    case 'watchlist:replace': {
      const inLabel = event.added.symbol ?? fmtAddr(event.added.address);
      const outLabel = event.removed.symbol ?? fmtAddr(event.removed.address);
      return `🔁 Replaced ${outLabel} (score ${event.removed.score.toFixed(1)}) with ${inLabel} (score ${event.added.score.toFixed(1)})${
        event.added.reasoning ? `\n   ${event.added.reasoning}` : ''
      }`;
    }
    case 'watchlist:remove': {
      const label = event.symbol ?? fmtAddr(event.address);
      return `➖ Removed from watchlist: ${label} (score ${event.score.toFixed(1)}) — ${event.reason}`;
    }
    case 'scan:start':
      return `🔍 Scan started — ${event.candidates} Base candidate(s)`;
    case 'scan:complete':
      return `✅ Scan complete — +${event.added} / -${event.removed} from ${event.candidates} candidate(s) in ${(event.durationMs / 1000).toFixed(1)}s`;
    case 'scan:error':
      return `❌ Scan error: ${event.message}`;
  }
}

export function summarizeWatchlist(entries: WatchlistEntry[]): string {
  if (entries.length === 0) return 'Watchlist is empty.';
  const lines = entries.map((e, i) => {
    const label = e.symbol ?? e.name ?? fmtAddr(e.address);
    return `${i + 1}. ${label} (${fmtAddr(e.address)}) — score ${e.score.toFixed(1)}`;
  });
  return lines.join('\n');
}

export function compositeNotifier(notifiers: Notifier[]): Notifier {
  return {
    async notify(event) {
      await Promise.all(notifiers.map((n) => n.notify(event).catch(() => undefined)));
    },
  };
}
