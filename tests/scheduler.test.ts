import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { openWatchlistDb } from '../src/watchlist/db.js';
import { createScheduler } from '../src/scheduler/index.js';
import { createSpendTracker } from '../src/oracle/handlers.js';
import type { OracleClient } from '../src/oracle/client.js';
import type { Agent, EvaluateCandidatesResult } from '../src/agent.js';
import type { DexscreenerMcpClient } from '../src/dexscreener/mcp-client.js';
import type { Notifier, NotificationEvent } from '../src/notifications/index.js';

const ADDR_A = '0x' + 'a'.repeat(40);
const ADDR_B = '0x' + 'b'.repeat(40);
const ADDR_C = '0x' + 'c'.repeat(40);

function fakeOracle(): OracleClient {
  return {
    baseUrl: 'http://test',
    walletAddress: '0x0000000000000000000000000000000000000000',
    receipts: [],
    async get(path: string) {
      const m = path.match(/token\/(0x[0-9a-fA-F]{40})\//);
      const address = m ? m[1].toLowerCase() : '0x';
      return {
        status: 200,
        data: {
          address,
          chain: 'base',
          token: { symbol: 'TEST', name: 'Test', verified: true },
          holder_count: 100,
          top10_concentration_pct: 10,
          flags: [],
          contract: { verified: true },
        } as unknown,
      };
    },
  } as OracleClient;
}

function fakeDex(addresses: string[]): DexscreenerMcpClient {
  return {
    async connect() {},
    async close() {},
    async getTopBoostedTokens() {
      return addresses.map((a) => ({ chainId: 'base', tokenAddress: a }));
    },
    async getLatestBoostedTokens() {
      return [];
    },
    async getTrendingBaseTokens() {
      return addresses.map((a, i) => ({
        chainId: 'base' as const,
        tokenAddress: a,
        symbol: `SYM${i}`,
        volumeH24: 1000 - i,
        txnsH24: 100,
        pairCount: 1,
      }));
    },
  };
}

function fakeAgent(result: EvaluateCandidatesResult): Agent {
  return {
    chat: {} as Agent['chat'],
    async send() {
      return '';
    },
    reset() {},
    async evaluateCandidates() {
      return result;
    },
  };
}

function recordingNotifier(): { events: NotificationEvent[]; notifier: Notifier } {
  const events: NotificationEvent[] = [];
  return {
    events,
    notifier: {
      async notify(ev: NotificationEvent) {
        events.push(ev);
      },
    },
  };
}

function tempDbPath(): { dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sched-'));
  return {
    dbPath: path.join(dir, 'watchlist.db'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('scheduler', () => {
  it('consumes trending base tokens and adds new ones up to capacity', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const db = openWatchlistDb(dbPath);
      const dex: DexscreenerMcpClient = {
        async connect() {},
        async close() {},
        async getTopBoostedTokens() {
          return [];
        },
        async getLatestBoostedTokens() {
          return [];
        },
        async getTrendingBaseTokens() {
          // The MCP-side helper already filters to chainId=base, so the
          // scheduler should consume the list as-is without re-filtering.
          return [
            { chainId: 'base', tokenAddress: ADDR_A, volumeH24: 1000, txnsH24: 50, pairCount: 1 },
            { chainId: 'base', tokenAddress: ADDR_C, volumeH24: 500, txnsH24: 30, pairCount: 1 },
          ];
        },
      };
      const agent = fakeAgent({
        ranked: [
          { address: ADDR_A, score: 80, reasoning: 'good' },
          { address: ADDR_C, score: 60, reasoning: 'meh' },
        ],
        replacements: [],
      });
      const { notifier, events } = recordingNotifier();
      const scheduler = createScheduler({
        dexscreener: dex,
        oracle: fakeOracle(),
        spend: createSpendTracker(1),
        agent,
        db,
        notifier,
        intervalMs: 60_000,
        maxWatchlistSize: 10,
        enabled: false,
      });
      const res = await scheduler.triggerNow();
      expect(res.candidates).toBe(2);
      expect(res.added).toBe(2);
      expect(res.removed).toBe(0);
      expect(db.count()).toBe(2);
      expect(events.some((e) => e.type === 'watchlist:add')).toBe(true);
      db.close();
    } finally {
      cleanup();
    }
  });

  it('respects spend cap and stops fetching reports', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const db = openWatchlistDb(dbPath);
      const dex = fakeDex([ADDR_A, ADDR_B, ADDR_C]);
      const agent = fakeAgent({ ranked: [], replacements: [] });
      const { notifier } = recordingNotifier();
      const scheduler = createScheduler({
        dexscreener: dex,
        oracle: fakeOracle(),
        spend: createSpendTracker(0.005), // less than one report
        agent,
        db,
        notifier,
        intervalMs: 60_000,
        maxWatchlistSize: 10,
        enabled: false,
      });
      const res = await scheduler.triggerNow();
      expect(res.candidates).toBe(3);
      expect(db.count()).toBe(0);
      expect(res.added).toBe(0);
      db.close();
    } finally {
      cleanup();
    }
  });

  it('replaces lowest-scored entry only if new score is strictly higher', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const db = openWatchlistDb(dbPath);
      // Pre-fill watchlist to capacity (max=2 for this test)
      db.upsert({ address: ADDR_B, score: 50, report: {} });
      db.upsert({ address: ADDR_C, score: 70, report: {} });
      const dex = fakeDex([ADDR_A]);
      const agent = fakeAgent({
        ranked: [{ address: ADDR_A, score: 60, reasoning: 'better than B' }],
        replacements: [],
      });
      const { notifier, events } = recordingNotifier();
      const scheduler = createScheduler({
        dexscreener: dex,
        oracle: fakeOracle(),
        spend: createSpendTracker(1),
        agent,
        db,
        notifier,
        intervalMs: 60_000,
        maxWatchlistSize: 2,
        enabled: false,
      });
      const res = await scheduler.triggerNow();
      expect(res.added).toBe(1);
      expect(res.removed).toBe(1);
      expect(db.get(ADDR_B)).toBeUndefined();
      expect(db.get(ADDR_A)?.score).toBe(60);
      expect(events.some((e) => e.type === 'watchlist:replace')).toBe(true);
      db.close();
    } finally {
      cleanup();
    }
  });

  it('does not replace when new score is not strictly higher', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const db = openWatchlistDb(dbPath);
      db.upsert({ address: ADDR_B, score: 50, report: {} });
      db.upsert({ address: ADDR_C, score: 70, report: {} });
      const dex = fakeDex([ADDR_A]);
      const agent = fakeAgent({
        ranked: [{ address: ADDR_A, score: 50, reasoning: 'tied' }],
        replacements: [],
      });
      const { notifier } = recordingNotifier();
      const scheduler = createScheduler({
        dexscreener: dex,
        oracle: fakeOracle(),
        spend: createSpendTracker(1),
        agent,
        db,
        notifier,
        intervalMs: 60_000,
        maxWatchlistSize: 2,
        enabled: false,
      });
      const res = await scheduler.triggerNow();
      expect(res.added).toBe(0);
      expect(db.get(ADDR_A)).toBeUndefined();
      db.close();
    } finally {
      cleanup();
    }
  });
});
