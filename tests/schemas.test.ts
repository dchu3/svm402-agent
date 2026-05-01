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
  risk_score: 0,
  risk_level: 'clean',
  flags: [],
  risk_components: [],
  risk_mitigants: [],
  risk_coverage: { evaluated: 4, total: 8, missing: ['honeypot_detected', 'high_tax', 'low_liquidity', 'new_pair'] },
  risk_confidence: 'medium',
};

describe('ReportResponseSchema', () => {
  it('parses the README /report fixture with all top-level fields preserved', () => {
    const parsed = ReportResponseSchema.parse(FIXTURE);
    expect(parsed.risk_score).toBe(0);
    expect(parsed.risk_level).toBe('clean');
    expect(parsed.risk_confidence).toBe('medium');
    expect(parsed.holder_count).toBe(312104);
    expect(parsed.top10_concentration_pct).toBe(34.12);
    expect(parsed.deployer_holdings_pct).toBe(0);
    expect(parsed.lp_locked_heuristic).toBeNull();
    expect(parsed.flags).toEqual([]);
    expect(parsed.risk_coverage?.evaluated).toBe(4);
    expect(parsed.risk_coverage?.missing).toContain('honeypot_detected');
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
    expect(parsed.risk_score).toBeUndefined();
    expect(parsed.token).toBeUndefined();
  });

  it('passes through unknown top-level fields without dropping them', () => {
    const parsed = ReportResponseSchema.parse({
      ...FIXTURE,
      future_field: { hello: 'world' },
    }) as unknown as { future_field?: unknown };
    expect(parsed.future_field).toEqual({ hello: 'world' });
  });

  it('tolerates null for nested objects (deployer/token/token_activity/risk_coverage)', () => {
    const parsed = ReportResponseSchema.parse({
      address: '0x16332535e2c27da578bc2e82beb09ce9d3c8eb07',
      chain: 'base',
      token: null,
      deployer: null,
      token_activity: null,
      risk_coverage: null,
      risk_score: 3,
      risk_level: 'caution',
      flags: ['unverified_contract'],
    });
    expect(parsed.deployer).toBeNull();
    expect(parsed.token).toBeNull();
    expect(parsed.token_activity).toBeNull();
    expect(parsed.risk_coverage).toBeNull();
    expect(parsed.risk_score).toBe(3);
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
});
