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

  it('accepts an unknown holder category', () => {
    const result = ReportResponseSchema.safeParse({
      address: '0x4200000000000000000000000000000000000006',
      chain: 'base',
      top_holders: [
        { address: '0xabc', value: '1', percent: 1, category: 'whale' },
      ],
    });
    expect(result.success).toBe(true);
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

  describe('contract block', () => {
    const CLAWBANK = {
      address: '0x16332535e2c27da578bc2e82beb09ce9d3c8eb07',
      chain: 'base' as const,
      token: {
        name: 'ClawBank',
        symbol: '$CLAWBANK',
        decimals: 18,
        total_supply: '100000000000000000000000000000',
        circulating_market_cap: '0.0',
        exchange_rate: '0.00003353',
        type: 'ERC-20',
        verified: true,
      },
      deployer: null,
      token_activity: {
        last_active_timestamp: '2026-05-03T11:06:13.000000Z',
        recent_methods: ['approve', 'transfer'],
      },
      holder_count: 5525,
      top10_concentration_pct: 43.87,
      circulating_top10_concentration_pct: 43.87,
      top_holders: [],
      deployer_holdings_pct: null,
      lp_locked_heuristic: null,
      contract: {
        verified: true,
        language: 'solidity',
        compiler_version: '0.8.28+commit.7893614a',
        is_proxy: false,
        proxy_type: null,
        implementations: [],
        traits: {
          mintable: false,
          pausable: false,
          ownable: false,
          blacklist: false,
          fee_setter: false,
          proxy_upgradeable: false,
        },
      },
      flags: [],
    };

    it('parses the ClawBank fixture with a fully populated contract block', () => {
      const parsed = ReportResponseSchema.parse(CLAWBANK);
      expect(parsed.contract?.verified).toBe(true);
      expect(parsed.contract?.language).toBe('solidity');
      expect(parsed.contract?.compiler_version).toBe('0.8.28+commit.7893614a');
      expect(parsed.contract?.is_proxy).toBe(false);
      expect(parsed.contract?.proxy_type).toBeNull();
      expect(parsed.contract?.implementations).toEqual([]);
      expect(parsed.contract?.traits?.mintable).toBe(false);
      expect(parsed.contract?.traits?.proxy_upgradeable).toBe(false);
    });

    it('tolerates a null contract block (unverified contract)', () => {
      const parsed = ReportResponseSchema.parse({
        address: '0x4200000000000000000000000000000000000006',
        chain: 'base',
        contract: null,
      });
      expect(parsed.contract).toBeNull();
    });

    it('accepts partial traits with null signals (no ABI)', () => {
      const parsed = ReportResponseSchema.parse({
        address: '0x4200000000000000000000000000000000000006',
        chain: 'base',
        contract: {
          verified: false,
          traits: {
            mintable: null,
            pausable: null,
          },
        },
      });
      expect(parsed.contract?.verified).toBe(false);
      expect(parsed.contract?.traits?.mintable).toBeNull();
      expect(parsed.contract?.traits?.pausable).toBeNull();
      expect(parsed.contract?.traits?.ownable).toBeUndefined();
    });

    it('passes through unknown fields on contract and contract.traits', () => {
      const parsed = ReportResponseSchema.parse({
        address: '0x4200000000000000000000000000000000000006',
        chain: 'base',
        contract: {
          verified: true,
          future_contract_field: 'x',
          traits: { mintable: true, future_trait: true },
        },
      });
      const contract = parsed.contract as Record<string, unknown>;
      expect(contract.future_contract_field).toBe('x');
      const traits = contract.traits as Record<string, unknown>;
      expect(traits.future_trait).toBe(true);
    });

    it('parses an implementation with a name', () => {
      const parsed = ReportResponseSchema.parse({
        address: '0x4200000000000000000000000000000000000006',
        chain: 'base',
        contract: {
          verified: true,
          is_proxy: true,
          proxy_type: 'eip1967',
          implementations: [
            { address: '0xabcabcabcabcabcabcabcabcabcabcabcabcabca', name: 'TokenV2' },
            { address: '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead', name: null },
          ],
          traits: { proxy_upgradeable: true },
        },
      });
      expect(parsed.contract?.implementations?.length).toBe(2);
      expect(parsed.contract?.implementations?.[0]?.name).toBe('TokenV2');
      expect(parsed.contract?.implementations?.[1]?.name).toBeNull();
      expect(parsed.contract?.traits?.proxy_upgradeable).toBe(true);
    });
  });
});
