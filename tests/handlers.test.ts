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
    const result = await handlers.get_report!({ address: 'nope' }, deps);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('invalid_address');
  });

  it('refuses calls past the spend cap', async () => {
    const oracle = fakeOracle(async () => ({}));
    const spend = createSpendTracker(0.001);
    const result = await handlers.get_report!({ address: VALID_ADDR }, { oracle, spend });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/spend_cap_exceeded/);
    expect(oracle.calls).toHaveLength(0);
  });
});
