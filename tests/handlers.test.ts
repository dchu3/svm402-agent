import { describe, it, expect } from 'vitest';
import { handlers, createSpendTracker, type HandlerDeps } from '../src/oracle/handlers.js';
import type { OracleClient } from '../src/oracle/client.js';

function fakeOracle(
  responder: (path: string) => Promise<unknown>,
): OracleClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    baseUrl: 'http://test',
    walletAddress: '0x0000000000000000000000000000000000000000',
    receipts: [],
    calls,
    async get<T>(path: string) {
      calls.push(path);
      const data = (await responder(path)) as T;
      return { status: 200, data };
    },
  } as OracleClient & { calls: string[] };
}

const VALID_ADDR = '0x4200000000000000000000000000000000000006';

describe('handlers', () => {
  it('rejects an invalid address', async () => {
    const deps: HandlerDeps = {
      oracle: fakeOracle(async () => ({})),
      spend: createSpendTracker(1),
    };
    const result = await handlers.get_market!({ address: 'nope' }, deps);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('invalid_address');
  });

  it('lower-cases the address and hits the right path for /market', async () => {
    const oracle = fakeOracle(async (path) => ({
      address: path.split('/')[6] ?? '',
      chain: 'base',
      price_usd: 1.0,
      price_change_24h_pct: 0,
      fdv: null,
      market_cap: null,
      volume_24h_usd: 0,
      liquidity_usd: 0,
      top_pool: {
        pair_address: null,
        dex_id: null,
        base_token_symbol: null,
        quote_token_symbol: null,
        pair_created_at: null,
      },
      pool_count: 0,
    }));
    const spend = createSpendTracker(1);
    const result = await handlers.get_market!({ address: VALID_ADDR.toUpperCase() }, {
      oracle,
      spend,
    });
    expect(result.ok).toBe(true);
    expect(oracle.calls[0]).toBe(`/api/v1/x402/base/token/${VALID_ADDR.toLowerCase()}/market`);
    expect(spend.total).toBeCloseTo(0.005);
  });

  it('refuses calls past the spend cap', async () => {
    const oracle = fakeOracle(async () => ({}));
    const spend = createSpendTracker(0.001);
    const result = await handlers.get_report!({ address: VALID_ADDR }, { oracle, spend });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/spend_cap_exceeded/);
    expect(oracle.calls).toHaveLength(0);
  });

  it('appends ?pair= when forensics is given a valid pair', async () => {
    const oracle = fakeOracle(async () => ({ address: VALID_ADDR, chain: 'base' }));
    const pair = '0x0000000000000000000000000000000000000abc';
    const result = await handlers.get_forensics!(
      { address: VALID_ADDR, pair },
      { oracle, spend: createSpendTracker(1) },
    );
    expect(result.ok).toBe(true);
    expect(oracle.calls[0]).toBe(
      `/api/v1/x402/base/token/${VALID_ADDR}/forensics?pair=${pair}`,
    );
  });
});
