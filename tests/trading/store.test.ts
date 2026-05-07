import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createTradingStore, bumpHighestPrice } from '../../src/trading/store.js';

function freshStore() {
  const db = new Database(':memory:');
  const store = createTradingStore(db);
  return { db, store };
}

const ADDR = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('TradingStore', () => {
  it('opens and lists positions; address is lower-cased', () => {
    const { store } = freshStore();
    const pos = store.openPosition({
      address: ADDR.toUpperCase(),
      symbol: 'T',
      name: null,
      entryPriceUsd: 1,
      entryAmountUsdc: 5,
      tokenAmountAtomic: '1000',
      tokenDecimals: 18,
      dex: 'mock',
      feeTier: 3000,
      dryRun: true,
    });
    expect(pos.address).toBe(ADDR);
    expect(store.listOpen()).toHaveLength(1);
    expect(store.countOpen()).toBe(1);
    expect(store.get(ADDR)?.symbol).toBe('T');
  });

  it('rejects opening a second open position for the same address', () => {
    const { store } = freshStore();
    const input = {
      address: ADDR,
      symbol: 'T',
      name: null,
      entryPriceUsd: 1,
      entryAmountUsdc: 5,
      tokenAmountAtomic: '1000',
      tokenDecimals: 18,
      dex: 'mock',
      feeTier: 3000,
      dryRun: true,
    };
    store.openPosition(input);
    expect(() => store.openPosition(input)).toThrow(/position_already_open/);
  });

  it('closes a position and updates fields', () => {
    const { store } = freshStore();
    store.openPosition({
      address: ADDR,
      symbol: 'T',
      name: null,
      entryPriceUsd: 1,
      entryAmountUsdc: 5,
      tokenAmountAtomic: '1000',
      tokenDecimals: 18,
      dex: 'mock',
      feeTier: 3000,
      dryRun: true,
    });
    const closed = store.closePosition({
      address: ADDR,
      exitReason: 'take_profit',
      exitPriceUsd: 1.5,
      realizedPnlUsd: 2.5,
    });
    expect(closed?.status).toBe('closed');
    expect(closed?.exitReason).toBe('take_profit');
    expect(store.countOpen()).toBe(0);
  });

  it('records and lists trades', () => {
    const { store } = freshStore();
    store.recordTrade({
      positionAddress: ADDR,
      side: 'buy',
      dex: 'mock',
      txHash: '0xdead',
      amountInAtomic: '5000000',
      amountOutAtomic: '1000',
      priceUsd: 1,
      feeTier: 3000,
      dryRun: true,
    });
    const trades = store.listTrades();
    expect(trades).toHaveLength(1);
    expect(trades[0].side).toBe('buy');
    expect(trades[0].positionAddress).toBe(ADDR);
  });

  it('bumpHighestPrice ratchets monotonically', () => {
    const { db, store } = freshStore();
    store.openPosition({
      address: ADDR,
      symbol: 'T',
      name: null,
      entryPriceUsd: 1,
      entryAmountUsdc: 5,
      tokenAmountAtomic: '1000',
      tokenDecimals: 18,
      dex: 'mock',
      feeTier: 3000,
      dryRun: true,
    });
    expect(bumpHighestPrice(db, ADDR, 1.2)).toBe(1.2);
    expect(bumpHighestPrice(db, ADDR, 1.1)).toBe(1.2);
    expect(bumpHighestPrice(db, ADDR, 1.5)).toBe(1.5);
    expect(store.get(ADDR)?.highestPriceUsd).toBe(1.5);
  });

  it('non-tradable cache: mark / isNonTradable / clear are case-insensitive', () => {
    const { store } = freshStore();
    expect(store.isNonTradable(ADDR)).toBe(false);
    store.markNonTradable(ADDR.toUpperCase(), 'no_pool:USDC->token');
    expect(store.isNonTradable(ADDR)).toBe(true);
    expect(store.isNonTradable(ADDR.toUpperCase())).toBe(true);
    store.markNonTradable(ADDR, 'no_pool:USDC->token');
    expect(store.isNonTradable(ADDR)).toBe(true);
    store.clearNonTradable(ADDR);
    expect(store.isNonTradable(ADDR)).toBe(false);
  });
});
