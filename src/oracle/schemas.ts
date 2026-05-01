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

export const ReportResponseSchema = z
  .object({
    address: z.string(),
    chain: z.literal('base'),
    token: TokenSchema.nullable().optional(),
    deployer: DeployerSchema.nullable().optional(),
    token_activity: TokenActivitySchema.nullable().optional(),
    holder_count: z.number().nullable().optional(),
    top10_concentration_pct: z.number().nullable().optional(),
    deployer_holdings_pct: z.number().nullable().optional(),
    lp_locked_heuristic: z.boolean().nullable().optional(),
  })
  .passthrough();

export type ReportResponse = z.infer<typeof ReportResponseSchema>;
