import { z } from 'zod';

const TokenSchema = z
  .object({
    name: z.string().optional(),
    symbol: z.string().optional(),
    decimals: z.number().optional(),
    total_supply: z.string().optional(),
    circulating_market_cap: z.string().nullable().optional(),
    exchange_rate: z.string().nullable().optional(),
    type: z.string().optional(),
    verified: z.boolean().optional(),
  })
  .passthrough();

const DeployerSchema = z
  .object({
    address: z.string().optional(),
    is_contract: z.boolean().optional(),
    tx_count: z.number().optional(),
    coin_balance: z.string().nullable().optional(),
    creation_tx_hash: z.string().nullable().optional(),
    last_active_timestamp: z.string().nullable().optional(),
  })
  .passthrough();

const TokenActivitySchema = z
  .object({
    last_active_timestamp: z.string().nullable().optional(),
    recent_methods: z.array(z.string()).optional(),
  })
  .passthrough();

const RiskComponentSchema = z
  .object({
    id: z.string().optional(),
    points: z.number().optional(),
    detail: z.string().optional(),
  })
  .passthrough();

const RiskCoverageSchema = z
  .object({
    evaluated: z.number().optional(),
    total: z.number().optional(),
    missing: z.array(z.string()).optional(),
  })
  .passthrough();

export const ReportResponseSchema = z
  .object({
    address: z.string(),
    chain: z.literal('base'),
    token: TokenSchema.optional(),
    deployer: DeployerSchema.optional(),
    token_activity: TokenActivitySchema.optional(),
    holder_count: z.number().nullable().optional(),
    top10_concentration_pct: z.number().nullable().optional(),
    deployer_holdings_pct: z.number().nullable().optional(),
    lp_locked_heuristic: z.boolean().nullable().optional(),
    risk_score: z.number().optional(),
    risk_level: z.string().optional(),
    flags: z.array(z.string()).optional(),
    risk_components: z.array(RiskComponentSchema).optional(),
    risk_mitigants: z.array(z.string()).optional(),
    risk_coverage: RiskCoverageSchema.optional(),
    risk_confidence: z.string().optional(),
  })
  .passthrough();

export type ReportResponse = z.infer<typeof ReportResponseSchema>;
