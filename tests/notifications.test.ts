import { describe, it, expect } from 'vitest';
import {
  formatNotification,
  formatNotificationMarkdown,
  summarizeWatchlist,
  summarizeWatchlistMarkdown,
  type NotificationEvent,
} from '../src/notifications/index.js';

const ADDRESS = '0x2bdf00000000000000000000000000000000bae9';

const addEvent: NotificationEvent = {
  type: 'watchlist:add',
  address: ADDRESS,
  symbol: 'BASEFOREVER',
  name: null,
  score: 10,
  reasoning: 'Highly penalized for mintable trait and extreme concentration.',
};

describe('formatNotification', () => {
  it('renders the full contract address for watchlist:add', () => {
    const text = formatNotification(addEvent);
    expect(text).toContain(ADDRESS);
    expect(text).not.toContain('…');
    expect(text).toContain('BASEFOREVER');
    expect(text).toContain('score 10.0');
  });

  it('renders watchlist:remove with full address', () => {
    const ev: NotificationEvent = {
      type: 'watchlist:remove',
      address: ADDRESS,
      symbol: 'FOO',
      score: 5,
      reason: 'evicted by higher-scoring candidate',
    };
    expect(formatNotification(ev)).toContain(ADDRESS);
  });
});

describe('formatNotificationMarkdown', () => {
  it('wraps the address in backticks for tap-to-copy', () => {
    const text = formatNotificationMarkdown(addEvent);
    expect(text).toContain(`\`${ADDRESS}\``);
  });

  it('escapes MarkdownV2 special characters in labels', () => {
    const ev: NotificationEvent = {
      ...addEvent,
      symbol: 'WEIRD_TOKEN*NAME',
    };
    const text = formatNotificationMarkdown(ev);
    expect(text).toContain('WEIRD\\_TOKEN\\*NAME');
  });

  it('escapes MarkdownV2 dot/parentheses in static formatter output', () => {
    const text = formatNotificationMarkdown(addEvent);
    // "score 10.0" must become "score 10\.0" in MarkdownV2.
    expect(text).toContain('score 10\\.0');
    // The literal "(0x..." must have its opening paren escaped.
    expect(text).toContain('\\(`0x');
  });
});

describe('summarizeWatchlist', () => {
  it('shows full addresses', () => {
    const out = summarizeWatchlist([
      {
        address: ADDRESS,
        symbol: 'FOO',
        name: 'Foo Token',
        score: 7.5,
        reasoning: null,
        reportJson: '{}',
        addedAt: 0,
        updatedAt: 0,
      },
    ]);
    expect(out).toContain(ADDRESS);
  });

  it('markdown variant wraps addresses in backticks', () => {
    const out = summarizeWatchlistMarkdown([
      {
        address: ADDRESS,
        symbol: 'FOO',
        name: 'Foo Token',
        score: 7.5,
        reasoning: null,
        reportJson: '{}',
        addedAt: 0,
        updatedAt: 0,
      },
    ]);
    expect(out).toContain(`\`${ADDRESS}\``);
  });
});
