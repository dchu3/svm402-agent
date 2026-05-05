import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export interface TradingDbHandle {
  db: Database.Database;
  close(): void;
}

export function openTradingDb(filePath: string): TradingDbHandle {
  const resolved = path.resolve(filePath);
  mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new Database(resolved);
  db.pragma('journal_mode = WAL');
  return {
    db,
    close() {
      db.close();
    },
  };
}
