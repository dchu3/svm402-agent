import type Database from 'better-sqlite3';
import type {
  ClosePositionInput,
  OpenPositionInput,
  Position,
  Trade,
  TradeInput,
} from './types.js';

export interface TradingStore {
  openPosition(input: OpenPositionInput): Position;
  closePosition(input: ClosePositionInput): Position | undefined;
  listOpen(): Position[];
  listAll(): Position[];
  get(address: string): Position | undefined;
  countOpen(): number;
  recordTrade(input: TradeInput): Trade;
  listTrades(limit?: number): Trade[];
  listTradesForPosition(address: string): Trade[];
}

interface PositionRow {
  address: string;
  symbol: string | null;
  name: string | null;
  status: string;
  entry_price_usd: number;
  entry_amount_usdc: number;
  token_amount_atomic: string;
  token_decimals: number;
  highest_price_usd: number;
  opened_at: number;
  closed_at: number | null;
  exit_reason: string | null;
  exit_price_usd: number | null;
  realized_pnl_usd: number | null;
  dex: string;
  fee_tier: number | null;
  dry_run: number;
}

interface TradeRow {
  id: number;
  position_address: string;
  side: string;
  dex: string;
  tx_hash: string | null;
  amount_in_atomic: string;
  amount_out_atomic: string;
  price_usd: number;
  fee_tier: number | null;
  dry_run: number;
  created_at: number;
  error: string | null;
}

function rowToPosition(row: PositionRow): Position {
  return {
    address: row.address,
    symbol: row.symbol,
    name: row.name,
    status: row.status === 'closed' ? 'closed' : 'open',
    entryPriceUsd: row.entry_price_usd,
    entryAmountUsdc: row.entry_amount_usdc,
    tokenAmountAtomic: row.token_amount_atomic,
    tokenDecimals: row.token_decimals,
    highestPriceUsd: row.highest_price_usd,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    exitReason: (row.exit_reason as Position['exitReason']) ?? null,
    exitPriceUsd: row.exit_price_usd,
    realizedPnlUsd: row.realized_pnl_usd,
    dex: row.dex,
    feeTier: row.fee_tier,
    dryRun: row.dry_run === 1,
  };
}

function rowToTrade(row: TradeRow): Trade {
  return {
    id: row.id,
    positionAddress: row.position_address,
    side: row.side === 'sell' ? 'sell' : 'buy',
    dex: row.dex,
    txHash: row.tx_hash,
    amountInAtomic: row.amount_in_atomic,
    amountOutAtomic: row.amount_out_atomic,
    priceUsd: row.price_usd,
    feeTier: row.fee_tier,
    dryRun: row.dry_run === 1,
    createdAt: row.created_at,
    error: row.error,
  };
}

export function createTradingStore(db: Database.Database): TradingStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS positions (
      address TEXT PRIMARY KEY,
      symbol TEXT,
      name TEXT,
      status TEXT NOT NULL,
      entry_price_usd REAL NOT NULL,
      entry_amount_usdc REAL NOT NULL,
      token_amount_atomic TEXT NOT NULL,
      token_decimals INTEGER NOT NULL,
      highest_price_usd REAL NOT NULL,
      opened_at INTEGER NOT NULL,
      closed_at INTEGER,
      exit_reason TEXT,
      exit_price_usd REAL,
      realized_pnl_usd REAL,
      dex TEXT NOT NULL,
      fee_tier INTEGER,
      dry_run INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS positions_status_idx ON positions(status);
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position_address TEXT NOT NULL,
      side TEXT NOT NULL,
      dex TEXT NOT NULL,
      tx_hash TEXT,
      amount_in_atomic TEXT NOT NULL,
      amount_out_atomic TEXT NOT NULL,
      price_usd REAL NOT NULL,
      fee_tier INTEGER,
      dry_run INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS trades_position_idx ON trades(position_address);
  `);

  const insertPositionStmt = db.prepare(`
    INSERT INTO positions (
      address, symbol, name, status,
      entry_price_usd, entry_amount_usdc, token_amount_atomic, token_decimals,
      highest_price_usd, opened_at, dex, fee_tier, dry_run
    ) VALUES (
      @address, @symbol, @name, 'open',
      @entry_price_usd, @entry_amount_usdc, @token_amount_atomic, @token_decimals,
      @entry_price_usd, @opened_at, @dex, @fee_tier, @dry_run
    )
  `);
  const closePositionStmt = db.prepare(`
    UPDATE positions
    SET status = 'closed',
        closed_at = @closed_at,
        exit_reason = @exit_reason,
        exit_price_usd = @exit_price_usd,
        realized_pnl_usd = @realized_pnl_usd
    WHERE address = @address AND status = 'open'
  `);
  const getPositionStmt = db.prepare('SELECT * FROM positions WHERE address = ?');
  const listOpenStmt = db.prepare(
    "SELECT * FROM positions WHERE status = 'open' ORDER BY opened_at ASC",
  );
  const listAllStmt = db.prepare(
    'SELECT * FROM positions ORDER BY opened_at DESC',
  );
  const countOpenStmt = db.prepare(
    "SELECT COUNT(*) AS c FROM positions WHERE status = 'open'",
  );
  const insertTradeStmt = db.prepare(`
    INSERT INTO trades (
      position_address, side, dex, tx_hash,
      amount_in_atomic, amount_out_atomic, price_usd, fee_tier,
      dry_run, created_at, error
    ) VALUES (
      @position_address, @side, @dex, @tx_hash,
      @amount_in_atomic, @amount_out_atomic, @price_usd, @fee_tier,
      @dry_run, @created_at, @error
    )
  `);
  const getTradeStmt = db.prepare('SELECT * FROM trades WHERE id = ?');
  const listTradesStmt = db.prepare('SELECT * FROM trades ORDER BY created_at DESC LIMIT ?');
  const listTradesForPosStmt = db.prepare(
    'SELECT * FROM trades WHERE position_address = ? ORDER BY created_at DESC',
  );

  const deletePositionStmt = db.prepare('DELETE FROM positions WHERE address = ?');
  const openPositionTxn = db.transaction((address: string, hadClosed: boolean, params: Record<string, unknown>) => {
    if (hadClosed) deletePositionStmt.run(address);
    insertPositionStmt.run(params);
  });

  return {
    openPosition(input) {
      const address = input.address.toLowerCase();
      const now = Date.now();
      const existing = getPositionStmt.get(address) as PositionRow | undefined;
      if (existing && existing.status === 'open') {
        throw new Error(`position_already_open:${address}`);
      }
      openPositionTxn(address, !!(existing && existing.status === 'closed'), {
        address,
        symbol: input.symbol,
        name: input.name,
        entry_price_usd: input.entryPriceUsd,
        entry_amount_usdc: input.entryAmountUsdc,
        token_amount_atomic: input.tokenAmountAtomic,
        token_decimals: input.tokenDecimals,
        opened_at: now,
        dex: input.dex,
        fee_tier: input.feeTier,
        dry_run: input.dryRun ? 1 : 0,
      });
      return rowToPosition(getPositionStmt.get(address) as PositionRow);
    },
    closePosition(input) {
      const address = input.address.toLowerCase();
      const result = closePositionStmt.run({
        address,
        closed_at: input.closedAt ?? Date.now(),
        exit_reason: input.exitReason,
        exit_price_usd: input.exitPriceUsd,
        realized_pnl_usd: input.realizedPnlUsd,
      });
      if (result.changes === 0) return undefined;
      const row = getPositionStmt.get(address) as PositionRow | undefined;
      return row ? rowToPosition(row) : undefined;
    },
    listOpen() {
      return (listOpenStmt.all() as PositionRow[]).map(rowToPosition);
    },
    listAll() {
      return (listAllStmt.all() as PositionRow[]).map(rowToPosition);
    },
    get(address) {
      const row = getPositionStmt.get(address.toLowerCase()) as PositionRow | undefined;
      return row ? rowToPosition(row) : undefined;
    },
    countOpen() {
      const row = countOpenStmt.get() as { c: number };
      return row.c;
    },
    recordTrade(input) {
      const info = insertTradeStmt.run({
        position_address: input.positionAddress.toLowerCase(),
        side: input.side,
        dex: input.dex,
        tx_hash: input.txHash,
        amount_in_atomic: input.amountInAtomic,
        amount_out_atomic: input.amountOutAtomic,
        price_usd: input.priceUsd,
        fee_tier: input.feeTier,
        dry_run: input.dryRun ? 1 : 0,
        created_at: Date.now(),
        error: input.error ?? null,
      });
      const row = getTradeStmt.get(Number(info.lastInsertRowid)) as TradeRow;
      return rowToTrade(row);
    },
    listTrades(limit = 50) {
      return (listTradesStmt.all(Math.max(1, Math.min(500, limit))) as TradeRow[]).map(
        rowToTrade,
      );
    },
    listTradesForPosition(address) {
      return (listTradesForPosStmt.all(address.toLowerCase()) as TradeRow[]).map(rowToTrade);
    },
  };
}

/**
 * Update the highest observed price for a position. Used by the monitor loop
 * to power the trailing-stop policy. Returns the new highest price.
 */
export function bumpHighestPrice(
  db: Database.Database,
  address: string,
  candidate: number,
): number {
  const row = db
    .prepare('SELECT highest_price_usd FROM positions WHERE address = ?')
    .get(address.toLowerCase()) as { highest_price_usd: number } | undefined;
  if (!row) return candidate;
  if (!Number.isFinite(candidate) || candidate <= row.highest_price_usd) {
    return row.highest_price_usd;
  }
  db.prepare('UPDATE positions SET highest_price_usd = ? WHERE address = ?').run(
    candidate,
    address.toLowerCase(),
  );
  return candidate;
}
