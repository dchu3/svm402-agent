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
  circulating_top10_concentration_pct: 12.7,
  top_holders: [
    { address: '0x000000000000000000000000000000000000dead', value: '5000000', percent: 22.0, category: 'burn' },
    { address: '0x4200000000000000000000000000000000000010', value: '4000000', percent: 18.0, category: 'bridge' },
    { address: '0xabc0000000000000000000000000000000000001', value: '1000000', percent: 4.5, category: 'contract' },
    { address: '0xabc0000000000000000000000000000000000002', value: '900000', percent: 4.1, category: 'eoa' },
    { address: '0x4200000000000000000000000000000000000000', value: '0', percent: 0, category: 'deployer' },
    { address: '0xabc0000000000000000000000000000000000003', value: null, percent: null, category: 'unknown' },
  ],
  deployer_holdings_pct: 0,
  lp_locked_heuristic: null,
  flags: ['unverified_contract'],
};

describe('ReportResponseSchema', () => {
  it('parses the README /report fixture with all top-level fields preserved', () => {
    const parsed = ReportResponseSchema.parse(FIXTURE);
    expect(parsed.holder_count).toBe(312104);
    expect(parsed.top10_concentration_pct).toBe(34.12);
    expect(parsed.circulating_top10_concentration_pct).toBe(12.7);
    expect(parsed.top_holders?.length).toBe(6);
    expect(parsed.top_holders?.map((h) => h.category)).toEqual([
      'burn',
      'bridge',
      'contract',
      'eoa',
      'deployer',
      'unknown',
    ]);
    expect(parsed.flags).toEqual(['unverified_contract']);
    expect(parsed.deployer_holdings_pct).toBe(0);
    expect(parsed.lp_locked_heuristic).toBeNull();
    expect(parsed.token?.symbol).toBe('WETH');
    expect(parsed.token?.verified).toBe(true);
    expect(parsed.deployer?.tx_count).toBe(12);
    expect(parsed.token_activity?.recent_methods).toEqual(['transfer', 'approve']);
  });

  it('rejects an unknown holder category', () => {
    const result = ReportResponseSchema.safeParse({
      address: '0x4200000000000000000000000000000000000006',
      chain: 'base',
      top_holders: [
        { address: '0xabc', value: '1', percent: 1, category: 'whale' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('tolerates null top_holders / circulating / flags', () => {
    const parsed = ReportResponseSchema.parse({
      address: '0x4200000000000000000000000000000000000006',
      chain: 'base',
      circulating_top10_concentration_pct: null,
      top_holders: null,
      flags: null,
    });
    expect(parsed.circulating_top10_concentration_pct).toBeNull();
    expect(parsed.top_holders).toBeNull();
    expect(parsed.flags).toBeNull();
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
