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

const ContractTraitsSchema = z
  .object({
    mintable: z.boolean().nullable().optional(),
    pausable: z.boolean().nullable().optional(),
    ownable: z.boolean().nullable().optional(),
    blacklist: z.boolean().nullable().optional(),
    fee_setter: z.boolean().nullable().optional(),
    proxy_upgradeable: z.boolean().nullable().optional(),
  })
  .passthrough();

export type ContractTraits = z.infer<typeof ContractTraitsSchema>;

const ContractImplementationSchema = z
  .object({
    address: z.string(),
    name: z.string().nullable().optional(),
  })
  .passthrough();

const ContractInfoSchema = z
  .object({
    verified: z.boolean().nullable().optional(),
    language: z.string().nullable().optional(),
    compiler_version: z.string().nullable().optional(),
    is_proxy: z.boolean().nullable().optional(),
    proxy_type: z.string().nullable().optional(),
    implementations: z.array(ContractImplementationSchema).nullable().optional(),
    traits: ContractTraitsSchema.nullable().optional(),
  })
  .passthrough();

export type ContractInfo = z.infer<typeof ContractInfoSchema>;

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
    contract: ContractInfoSchema.nullable().optional(),
    flags: z.array(z.string()).nullable().optional(),
  })
  .passthrough();

export type ReportResponse = z.infer<typeof ReportResponseSchema>;
