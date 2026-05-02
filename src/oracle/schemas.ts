import { z } from 'zod';

const TokenSchema = z
  .object({
    name: z.string().nullable().optional(),
    symbol: z.string().nullable().optional(),
    decimals: z.number().nullable().optional(),
    total_supply: z.string().nullable().optional(),
    circulating_market_cap: z.string().nullable().optional(),
    exchange_rate: z.string().nullable().optional(),
    type: z.string().nullable().optional(),
    verified: z.boolean().nullable().optional(),
  })
  .passthrough();

const DeployerSchema = z
  .object({
    address: z.string().nullable().optional(),
    is_contract: z.boolean().nullable().optional(),
    tx_count: z.number().nullable().optional(),
    coin_balance: z.string().nullable().optional(),
    creation_tx_hash: z.string().nullable().optional(),
    last_active_timestamp: z.string().nullable().optional(),
  })
  .passthrough();

const TokenActivitySchema = z
  .object({
    last_active_timestamp: z.string().nullable().optional(),
    recent_methods: z.array(z.string()).nullable().optional(),
  })
  .passthrough();

export const HolderCategorySchema = z.string();
export type HolderCategory = z.infer<typeof HolderCategorySchema>;

const TopHolderSchema = z
  .object({
    address: z.string(),
    value: z.string().nullable().optional(),
    percent: z.number().nullable().optional(),
    category: HolderCategorySchema,
  })
  .passthrough();

export type TopHolder = z.infer<typeof TopHolderSchema>;

export const ReportResponseSchema = z
  .object({
    address: z.string(),
    chain: z.literal('base'),
    token: TokenSchema.nullable().optional(),
    deployer: DeployerSchema.nullable().optional(),
    token_activity: TokenActivitySchema.nullable().optional(),
    holder_count: z.number().nullable().optional(),
    top10_concentration_pct: z.number().nullable().optional(),
    circulating_top10_concentration_pct: z.number().nullable().optional(),
    top_holders: z.array(TopHolderSchema).nullable().optional(),
    deployer_holdings_pct: z.number().nullable().optional(),
    lp_locked_heuristic: z.boolean().nullable().optional(),
    flags: z.array(z.string()).nullable().optional(),
  })
  .passthrough();

export type ReportResponse = z.infer<typeof ReportResponseSchema>;
