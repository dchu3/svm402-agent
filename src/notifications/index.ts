import type { WatchlistEntry } from '../watchlist/types.js';
import { debug } from '../util/log.js';

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

const ADDRESS_REGEX = /0x[a-fA-F0-9]{40}/g;

function escapeMarkdownV2(text: string): string {
  // MarkdownV2 reserved characters per Telegram Bot API:
  // _ * [ ] ( ) ~ ` > # + - = | { } . !  (and \ itself)
  return text.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

function toMarkdownV2(plainText: string): string {
  // Escape the whole string for MarkdownV2, then wrap any 0x-addresses in
  // backticks so Telegram renders them as a tap-to-copy monospace span.
  // Hex addresses contain no MarkdownV2 reserved chars, so escaping is a no-op
  // on them and they remain matchable after the escape pass.
  const escaped = escapeMarkdownV2(plainText);
  return escaped.replace(ADDRESS_REGEX, (addr) => `\`${addr}\``);
}

function buildNotificationPlain(event: NotificationEvent): string {
  switch (event.type) {
    case 'watchlist:add': {
      const label = event.symbol ?? event.name ?? fmtAddr(event.address);
      return `➕ Added to watchlist: ${label} (${event.address}) — score ${event.score.toFixed(1)}${
        event.reasoning ? `\n   ${event.reasoning}` : ''
      }`;
    }
    case 'watchlist:replace': {
      const inLabel = event.added.symbol ?? fmtAddr(event.added.address);
      const outLabel = event.removed.symbol ?? fmtAddr(event.removed.address);
      return `🔁 Replaced ${outLabel} (${event.removed.address}, score ${event.removed.score.toFixed(1)}) with ${inLabel} (${event.added.address}, score ${event.added.score.toFixed(1)})${
        event.added.reasoning ? `\n   ${event.added.reasoning}` : ''
      }`;
    }
    case 'watchlist:remove': {
      const label = event.symbol ?? fmtAddr(event.address);
      return `➖ Removed from watchlist: ${label} (${event.address}, score ${event.score.toFixed(1)}) — ${event.reason}`;
    }
    case 'scan:start':
      return `🔍 Scan started — ${event.candidates} Base candidate(s)`;
    case 'scan:complete':
      return `✅ Scan complete — +${event.added} / -${event.removed} from ${event.candidates} candidate(s) in ${(event.durationMs / 1000).toFixed(1)}s`;
    case 'scan:error':
      return `❌ Scan error: ${event.message}`;
  }
}

export function formatNotification(event: NotificationEvent): string {
  return buildNotificationPlain(event);
}

export function formatNotificationMarkdown(event: NotificationEvent): string {
  return toMarkdownV2(buildNotificationPlain(event));
}

function summarizeWatchlistPlain(entries: WatchlistEntry[]): string {
  if (entries.length === 0) return 'Watchlist is empty.';
  return entries
    .map((e, i) => {
      const label = e.symbol ?? e.name ?? fmtAddr(e.address);
      return `${i + 1}. ${label} (${e.address}) — score ${e.score.toFixed(1)}`;
    })
    .join('\n');
}

export function summarizeWatchlist(entries: WatchlistEntry[]): string {
  return summarizeWatchlistPlain(entries);
}

export function summarizeWatchlistMarkdown(entries: WatchlistEntry[]): string {
  return toMarkdownV2(summarizeWatchlistPlain(entries));
}

export function compositeNotifier(notifiers: Notifier[]): Notifier {
  return {
    async notify(event) {
      await Promise.all(
        notifiers.map((n) =>
          n.notify(event).catch((err) => {
            debug('notifier error', err);
            return undefined;
          }),
        ),
      );
    },
  };
}
