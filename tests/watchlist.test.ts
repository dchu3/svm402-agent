import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { openWatchlistDb } from '../src/watchlist/db.js';

function tempDb(): { dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'watchlist-'));
  const dbPath = path.join(dir, 'watchlist.db');
  return {
    dbPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('watchlist db', () => {
  it('round-trips entries and orders by score', () => {
    const { dbPath, cleanup } = tempDb();
    try {
      const db = openWatchlistDb(dbPath);
      db.upsert({ address: '0x' + 'a'.repeat(40), score: 70, report: { foo: 'bar' } });
      db.upsert({ address: '0x' + 'b'.repeat(40), score: 90, report: {} });
      db.upsert({ address: '0x' + 'c'.repeat(40), score: 20, report: {} });
      expect(db.count()).toBe(3);
      const list = db.list();
      expect(list.map((e) => e.score)).toEqual([90, 70, 20]);
      const lowest = db.lowestScored();
      expect(lowest?.score).toBe(20);
      db.close();
    } finally {
      cleanup();
    }
  });

  it('upsert overwrites the existing entry', () => {
    const { dbPath, cleanup } = tempDb();
    try {
      const db = openWatchlistDb(dbPath);
      const addr = '0x' + 'a'.repeat(40);
      db.upsert({ address: addr, score: 50, report: {} });
      db.upsert({ address: addr, score: 80, report: {}, reasoning: 'better' });
      const entry = db.get(addr);
      expect(entry?.score).toBe(80);
      expect(entry?.reasoning).toBe('better');
      expect(db.count()).toBe(1);
      db.close();
    } finally {
      cleanup();
    }
  });

  it('remove returns false when nothing was deleted', () => {
    const { dbPath, cleanup } = tempDb();
    try {
      const db = openWatchlistDb(dbPath);
      expect(db.remove('0x' + '0'.repeat(40))).toBe(false);
      db.upsert({ address: '0x' + '1'.repeat(40), score: 1, report: {} });
      expect(db.remove('0x' + '1'.repeat(40))).toBe(true);
      expect(db.count()).toBe(0);
      db.close();
    } finally {
      cleanup();
    }
  });

  it('records and finishes scan runs', () => {
    const { dbPath, cleanup } = tempDb();
    try {
      const db = openWatchlistDb(dbPath);
      const id = db.recordScan({ startedAt: 1000 });
      expect(id).toBeGreaterThan(0);
      db.finishScan(id, { finishedAt: 2000, candidates: 5, added: 1, removed: 0 });
      db.close();
    } finally {
      cleanup();
    }
  });
});
