import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { ScanRunRecord, WatchlistEntry, WatchlistEntryInput } from './types.js';

export interface WatchlistDb {
  list(): WatchlistEntry[];
  get(address: string): WatchlistEntry | undefined;
  count(): number;
  upsert(entry: WatchlistEntryInput): WatchlistEntry;
  remove(address: string): boolean;
  lowestScored(): WatchlistEntry | undefined;
  recordScan(record: ScanRunRecord): number;
  finishScan(id: number, patch: Partial<ScanRunRecord>): void;
  close(): void;
}

interface WatchlistRow {
  address: string;
  symbol: string | null;
  name: string | null;
  score: number;
  reasoning: string | null;
  report_json: string;
  added_at: number;
  updated_at: number;
}

function rowToEntry(row: WatchlistRow): WatchlistEntry {
  return {
    address: row.address,
    symbol: row.symbol,
    name: row.name,
    score: row.score,
    reasoning: row.reasoning,
    reportJson: row.report_json,
    addedAt: row.added_at,
    updatedAt: row.updated_at,
  };
}

export function openWatchlistDb(filePath: string): WatchlistDb {
  const resolved = path.resolve(filePath);
  mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new Database(resolved);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS watchlist (
      address TEXT PRIMARY KEY,
      symbol TEXT,
      name TEXT,
      score REAL NOT NULL,
      reasoning TEXT,
      report_json TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scan_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      candidates INTEGER,
      added INTEGER,
      removed INTEGER,
      error TEXT
    );
  `);

  const listStmt = db.prepare('SELECT * FROM watchlist ORDER BY score DESC, updated_at DESC');
  const getStmt = db.prepare('SELECT * FROM watchlist WHERE address = ?');
  const countStmt = db.prepare('SELECT COUNT(*) AS c FROM watchlist');
  const lowestStmt = db.prepare('SELECT * FROM watchlist ORDER BY score ASC, updated_at ASC LIMIT 1');
  const upsertStmt = db.prepare(`
    INSERT INTO watchlist (address, symbol, name, score, reasoning, report_json, added_at, updated_at)
    VALUES (@address, @symbol, @name, @score, @reasoning, @report_json, @now, @now)
    ON CONFLICT(address) DO UPDATE SET
      symbol = excluded.symbol,
      name = excluded.name,
      score = excluded.score,
      reasoning = excluded.reasoning,
      report_json = excluded.report_json,
      updated_at = excluded.updated_at
  `);
  const removeStmt = db.prepare('DELETE FROM watchlist WHERE address = ?');
  const insertScanStmt = db.prepare(
    'INSERT INTO scan_runs (started_at, finished_at, candidates, added, removed, error) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const updateScanStmt = db.prepare(
    'UPDATE scan_runs SET finished_at = ?, candidates = ?, added = ?, removed = ?, error = ? WHERE id = ?',
  );
  const getScanStmt = db.prepare('SELECT * FROM scan_runs WHERE id = ?');

  return {
    list() {
      return (listStmt.all() as WatchlistRow[]).map(rowToEntry);
    },
    get(address) {
      const row = getStmt.get(address.toLowerCase()) as WatchlistRow | undefined;
      return row ? rowToEntry(row) : undefined;
    },
    count() {
      const row = countStmt.get() as { c: number };
      return row.c;
    },
    lowestScored() {
      const row = lowestStmt.get() as WatchlistRow | undefined;
      return row ? rowToEntry(row) : undefined;
    },
    upsert(entry) {
      const now = Date.now();
      const address = entry.address.toLowerCase();
      upsertStmt.run({
        address,
        symbol: entry.symbol ?? null,
        name: entry.name ?? null,
        score: entry.score,
        reasoning: entry.reasoning ?? null,
        report_json: JSON.stringify(entry.report ?? null),
        now,
      });
      const row = getStmt.get(address) as WatchlistRow;
      return rowToEntry(row);
    },
    remove(address) {
      const info = removeStmt.run(address.toLowerCase());
      return info.changes > 0;
    },
    recordScan(record) {
      const info = insertScanStmt.run(
        record.startedAt,
        record.finishedAt ?? null,
        record.candidates ?? null,
        record.added ?? null,
        record.removed ?? null,
        record.error ?? null,
      );
      return Number(info.lastInsertRowid);
    },
    finishScan(id, patch) {
      const existing = getScanStmt.get(id) as
        | {
            finished_at: number | null;
            candidates: number | null;
            added: number | null;
            removed: number | null;
            error: string | null;
          }
        | undefined;
      if (!existing) return;
      updateScanStmt.run(
        patch.finishedAt ?? existing.finished_at ?? Date.now(),
        patch.candidates ?? existing.candidates,
        patch.added ?? existing.added,
        patch.removed ?? existing.removed,
        patch.error ?? existing.error,
        id,
      );
    },
    close() {
      db.close();
    },
  };
}
