import { z } from 'zod';

export const TopPoolSchema = z.object({
  pair_address: z.string().nullable(),
  dex_id: z.string().nullable(),
  base_token_symbol: z.string().nullable(),
  quote_token_symbol: z.string().nullable(),
  pair_created_at: z.string().nullable(),
});

export const MarketResponseSchema = z
  .object({
    address: z.string(),
    chain: z.literal('base'),
    price_usd: z.number().nullable(),
    price_change_24h_pct: z.number().nullable(),
    fdv: z.number().nullable(),
    market_cap: z.number().nullable(),
    volume_24h_usd: z.number().nullable(),
    liquidity_usd: z.number().nullable(),
    top_pool: TopPoolSchema,
    pool_count: z.number().int().nonnegative(),
  })
  .passthrough();

export const HoneypotResponseSchema = z
  .object({
    address: z.string(),
    chain: z.literal('base'),
    is_honeypot: z.boolean().nullable(),
    buy_tax: z.number().nullable(),
    sell_tax: z.number().nullable(),
    transfer_tax: z.number().nullable(),
    simulation_success: z.boolean().nullable(),
    honeypot_reason: z.string().nullable(),
    flags: z.array(z.string()),
  })
  .passthrough();

export const ForensicsResponseSchema = z
  .object({
    address: z.string(),
    chain: z.literal('base'),
  })
  .passthrough();

export const ReportResponseSchema = z
  .object({
    address: z.string(),
    chain: z.literal('base'),
    risk: z
      .object({
        score: z.number(),
        level: z.string(),
        flags: z.array(z.string()),
      })
      .passthrough(),
  })
  .passthrough();

export type MarketResponse = z.infer<typeof MarketResponseSchema>;
export type HoneypotResponse = z.infer<typeof HoneypotResponseSchema>;
export type ForensicsResponse = z.infer<typeof ForensicsResponseSchema>;
export type ReportResponse = z.infer<typeof ReportResponseSchema>;
