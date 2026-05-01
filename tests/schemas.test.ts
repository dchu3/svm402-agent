import { describe, it, expect } from 'vitest';
import { ReportResponseSchema } from '../src/oracle/schemas.js';

const FIXTURE = {
  address: '0x4200000000000000000000000000000000000006',
  chain: 'base' as const,
  token: {
    name: 'Wrapped Ether',
    symbol: 'WETH',
    decimals: 18,
    total_supply: '140238472812345678901234',
    circulating_market_cap: '1000000000',
    exchange_rate: '2500.50',
    type: 'ERC-20',
    verified: true,
  },
  deployer: {
    address: '0x4200000000000000000000000000000000000000',
    is_contract: true,
    tx_count: 12,
    coin_balance: '1000000000000000000',
    creation_tx_hash: '0xabc123',
    last_active_timestamp: '2026-04-29T12:00:00Z',
  },
  token_activity: {
    last_active_timestamp: '2026-04-29T12:15:00Z',
    recent_methods: ['transfer', 'approve'],
  },
  holder_count: 312104,
  top10_concentration_pct: 34.12,
  deployer_holdings_pct: 0,
  lp_locked_heuristic: null,
};

describe('ReportResponseSchema', () => {
  it('parses the README /report fixture with all top-level fields preserved', () => {
    const parsed = ReportResponseSchema.parse(FIXTURE);
    expect(parsed.holder_count).toBe(312104);
    expect(parsed.top10_concentration_pct).toBe(34.12);
    expect(parsed.deployer_holdings_pct).toBe(0);
    expect(parsed.lp_locked_heuristic).toBeNull();
    expect(parsed.token?.symbol).toBe('WETH');
    expect(parsed.token?.verified).toBe(true);
    expect(parsed.deployer?.tx_count).toBe(12);
    expect(parsed.token_activity?.recent_methods).toEqual(['transfer', 'approve']);
  });

  it('tolerates missing optional fields (partial response)', () => {
    const parsed = ReportResponseSchema.parse({
      address: '0x4200000000000000000000000000000000000006',
      chain: 'base',
    });
    expect(parsed.address).toBe('0x4200000000000000000000000000000000000006');
    expect(parsed.token).toBeUndefined();
    expect(parsed.holder_count).toBeUndefined();
  });

  it('passes through unknown top-level fields without dropping them', () => {
    const parsed = ReportResponseSchema.parse({
      ...FIXTURE,
      future_field: { hello: 'world' },
    }) as unknown as { future_field?: unknown };
    expect(parsed.future_field).toEqual({ hello: 'world' });
  });

  it('tolerates null for nested objects (deployer/token/token_activity)', () => {
    const parsed = ReportResponseSchema.parse({
      address: '0x16332535e2c27da578bc2e82beb09ce9d3c8eb07',
      chain: 'base',
      token: null,
      deployer: null,
      token_activity: null,
      holder_count: null,
    });
    expect(parsed.deployer).toBeNull();
    expect(parsed.token).toBeNull();
    expect(parsed.token_activity).toBeNull();
    expect(parsed.holder_count).toBeNull();
  });

  it('passes through unknown nested fields on token / deployer', () => {
    const parsed = ReportResponseSchema.parse({
      address: '0x4200000000000000000000000000000000000006',
      chain: 'base',
      token: { symbol: 'X', future_token_field: 1 },
      deployer: { address: '0x0', future_deployer_field: true },
    });
    expect((parsed.token as Record<string, unknown>).future_token_field).toBe(1);
    expect((parsed.deployer as Record<string, unknown>).future_deployer_field).toBe(true);
  });

  it('tolerates null primitives inside deployer / token / token_activity', () => {
    const parsed = ReportResponseSchema.parse({
      address: '0x532f27101965dd16442e59d40670faf5ebb142e4',
      chain: 'base',
      token: {
        name: null,
        symbol: null,
        decimals: null,
        total_supply: null,
        type: null,
        verified: null,
      },
      deployer: {
        address: '0x0',
        is_contract: null,
        tx_count: null,
        coin_balance: null,
      },
      token_activity: {
        last_active_timestamp: null,
        recent_methods: null,
      },
    });
    expect(parsed.deployer?.is_contract).toBeNull();
    expect(parsed.deployer?.tx_count).toBeNull();
    expect(parsed.token?.verified).toBeNull();
    expect(parsed.token_activity?.recent_methods).toBeNull();
  });
});
