import { describe, it, expect } from 'vitest';
import { evaluateExit, nextHighestPrice } from '../../src/trading/policy.js';
import type { ExitPolicyConfig, Position } from '../../src/trading/types.js';

const config: ExitPolicyConfig = {
  takeProfitPct: 50,
  stopLossPct: 20,
  trailingStopPct: 15,
  maxHoldMs: 60_000,
};

function pos(over: Partial<Position> = {}): Position {
  return {
    address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    symbol: 'T',
    name: null,
    status: 'open',
    entryPriceUsd: 1,
    entryAmountUsdc: 5,
    tokenAmountAtomic: '0',
    tokenDecimals: 18,
    highestPriceUsd: 1,
    openedAt: 0,
    closedAt: null,
    exitReason: null,
    exitPriceUsd: null,
    realizedPnlUsd: null,
    dex: 'mock',
    feeTier: 3000,
    dryRun: true,
    ...over,
  };
}

describe('evaluateExit', () => {
  it('returns no-op when position is closed', () => {
    const r = evaluateExit({ position: pos({ status: 'closed' }), currentPriceUsd: 2, now: 0, config });
    expect(r.shouldExit).toBe(false);
  });

  it('triggers take-profit at >= TP threshold', () => {
    const r = evaluateExit({ position: pos(), currentPriceUsd: 1.5, now: 0, config });
    expect(r).toEqual({ shouldExit: true, reason: 'take_profit' });
  });

  it('triggers stop-loss at <= -SL threshold', () => {
    const r = evaluateExit({ position: pos(), currentPriceUsd: 0.79, now: 0, config });
    expect(r).toEqual({ shouldExit: true, reason: 'stop_loss' });
  });

  it('triggers trailing-stop after a peak above entry', () => {
    const r = evaluateExit({
      position: pos({ highestPriceUsd: 1.4 }),
      currentPriceUsd: 1.18,
      now: 0,
      config,
    });
    expect(r).toEqual({ shouldExit: true, reason: 'trailing_stop' });
  });

  it('does not trail when peak <= entry', () => {
    const r = evaluateExit({
      position: pos({ highestPriceUsd: 1 }),
      currentPriceUsd: 0.9,
      now: 0,
      config: { ...config, stopLossPct: 50 },
    });
    expect(r.shouldExit).toBe(false);
  });

  it('triggers max-hold when elapsed >= maxHoldMs', () => {
    const r = evaluateExit({
      position: pos({ openedAt: 0 }),
      currentPriceUsd: 1.05,
      now: 60_000,
      config,
    });
    expect(r).toEqual({ shouldExit: true, reason: 'max_hold' });
  });

  it('returns no-op for invalid prices', () => {
    expect(evaluateExit({ position: pos(), currentPriceUsd: 0, now: 0, config }).shouldExit).toBe(false);
    expect(evaluateExit({ position: pos({ entryPriceUsd: 0 }), currentPriceUsd: 1, now: 0, config }).shouldExit).toBe(false);
  });
});

describe('nextHighestPrice', () => {
  it('ratchets up only', () => {
    expect(nextHighestPrice(1, 1.2)).toBe(1.2);
    expect(nextHighestPrice(1.5, 1.2)).toBe(1.5);
    expect(nextHighestPrice(1.5, 0)).toBe(1.5);
    expect(nextHighestPrice(1.5, NaN)).toBe(1.5);
  });
});
