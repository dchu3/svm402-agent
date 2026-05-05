import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createTradingStore } from '../../src/trading/store.js';
import { createTradingEngine } from '../../src/trading/engine.js';
import type { DexAdapter, TradingConfig } from '../../src/trading/types.js';
import type { Wallet } from '../../src/wallet.js';
import type { Notifier } from '../../src/notifications/index.js';

const ADDR = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function makeConfig(over: Partial<TradingConfig> = {}): TradingConfig {
  return {
    enabled: true,
    live: false,
    minScore: 80,
    tradeSizeUsdc: 5,
    maxOpenPositions: 3,
    slippageBps: 100,
    monitorIntervalMs: 60_000,
    dexName: 'mock',
    policy: { takeProfitPct: 50, stopLossPct: 20, trailingStopPct: 15, maxHoldMs: 60_000 },
    ...over,
  };
}

function makeAdapter(): DexAdapter & { quoteUsdcToToken: ReturnType<typeof vi.fn>; swapUsdcForToken: ReturnType<typeof vi.fn> } {
  return {
    name: 'mock',
    quoteUsdcToToken: vi.fn(async (_t: string, amount: bigint) => ({
      amountOutAtomic: amount * 200n,
      feeTier: 3000,
      priceUsd: 0.005,
    })),
    quoteTokenToUsdc: vi.fn(async () => ({ amountOutAtomic: 1n, feeTier: 3000, priceUsd: 0.005 })),
    swapUsdcForToken: vi.fn(async (args) => ({
      txHash: null,
      amountInAtomic: args.amountInAtomic,
      amountOutAtomic: args.amountInAtomic * 200n,
      feeTier: args.feeTier,
      priceUsd: 0.005,
      dryRun: args.dryRun,
    })),
    swapTokenForUsdc: vi.fn(async (args) => ({
      txHash: null,
      amountInAtomic: args.amountInAtomic,
      amountOutAtomic: 5_000_000n,
      feeTier: args.feeTier,
      priceUsd: 0.005,
      dryRun: args.dryRun,
    })),
  } as never;
}

function makeWallet(usdcAtomic = 100_000_000n): Wallet {
  return {
    address: '0x000000000000000000000000000000000000beef',
    usdcBalance: vi.fn(async () => ({ raw: usdcAtomic, formatted: (Number(usdcAtomic) / 1e6).toFixed(2) })),
  } as unknown as Wallet;
}

function makeNotifier(): Notifier & { notify: ReturnType<typeof vi.fn> } {
  return { notify: vi.fn(async () => undefined) };
}

function setup(over: Partial<TradingConfig> = {}) {
  const db = new Database(':memory:');
  const store = createTradingStore(db);
  const adapter = makeAdapter();
  const wallet = makeWallet();
  const notifier = makeNotifier();
  const engine = createTradingEngine({
    config: makeConfig(over),
    wallet,
    adapter,
    store,
    db,
    notifier,
  });
  return { engine, store, adapter, wallet, notifier, db };
}

describe('TradingEngine.onWatchlistAdd', () => {
  it('opens a dry-run position above threshold', async () => {
    const { engine, store, adapter, notifier } = setup();
    await engine.onWatchlistAdd({ address: ADDR, symbol: 'T', name: null, score: 90 });
    expect(adapter.swapUsdcForToken).toHaveBeenCalledTimes(1);
    expect(adapter.swapUsdcForToken.mock.calls[0][0].dryRun).toBe(true);
    expect(store.listOpen()).toHaveLength(1);
    expect(notifier.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'trade:open' }));
  });

  it('skips when score is below threshold', async () => {
    const { engine, store, adapter } = setup({ minScore: 80 });
    await engine.onWatchlistAdd({ address: ADDR, symbol: 'T', name: null, score: 70 });
    expect(adapter.swapUsdcForToken).not.toHaveBeenCalled();
    expect(store.listOpen()).toHaveLength(0);
  });

  it('skips when engine is disabled', async () => {
    const { engine, store, adapter } = setup();
    engine.setEnabled(false);
    await engine.onWatchlistAdd({ address: ADDR, symbol: 'T', name: null, score: 99 });
    expect(adapter.swapUsdcForToken).not.toHaveBeenCalled();
    expect(store.listOpen()).toHaveLength(0);
  });

  it('respects max open positions cap', async () => {
    const { engine, store, adapter } = setup({ maxOpenPositions: 1 });
    await engine.onWatchlistAdd({ address: ADDR, symbol: 'T', name: null, score: 99 });
    const second = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    await engine.onWatchlistAdd({ address: second, symbol: 'U', name: null, score: 99 });
    expect(store.listOpen()).toHaveLength(1);
    expect(adapter.swapUsdcForToken).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid addresses without calling adapter', async () => {
    const { engine, adapter } = setup();
    await engine.onWatchlistAdd({ address: '0xnothex', symbol: 'T', name: null, score: 99 });
    expect(adapter.swapUsdcForToken).not.toHaveBeenCalled();
  });
});

describe('TradingEngine.manualSell', () => {
  it('closes an open position', async () => {
    const { engine, store, adapter, notifier } = setup();
    await engine.onWatchlistAdd({ address: ADDR, symbol: 'T', name: null, score: 99 });
    expect(store.listOpen()).toHaveLength(1);
    const res = await engine.manualSell(ADDR);
    expect(res.closed).toBe(true);
    expect(adapter.swapTokenForUsdc).toHaveBeenCalledTimes(1);
    expect(store.listOpen()).toHaveLength(0);
    expect(notifier.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'trade:close' }));
  });

  it('returns error when no open position exists', async () => {
    const { engine } = setup();
    const res = await engine.manualSell(ADDR);
    expect(res.closed).toBe(false);
    expect(res.error).toBeDefined();
  });
});

describe('TradingEngine.status', () => {
  it('reports config and open count', async () => {
    const { engine } = setup();
    const s = engine.status();
    expect(s.enabled).toBe(true);
    expect(s.live).toBe(false);
    expect(s.openPositions).toBe(0);
    expect(s.maxOpenPositions).toBe(3);
    expect(s.dex).toBe('mock');
  });
});
