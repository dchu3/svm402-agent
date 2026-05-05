import type { DexAdapter } from './types.js';

/**
 * Quote the USD price of a single token unit using the configured DexAdapter.
 *
 * We probe with `1 token` (10**decimals atomic units) and convert the resulting
 * USDC out into a USD price. Token decimals are detected by the adapter
 * implementation; callers pass the integer decimals here.
 */
export async function priceTokenInUsdc(
  adapter: DexAdapter,
  tokenAddress: string,
  tokenDecimals: number,
  feeTierHint?: number,
): Promise<{ priceUsd: number; feeTier: number }> {
  if (!Number.isFinite(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 36) {
    throw new Error('invalid_token_decimals');
  }
  const oneTokenAtomic = 10n ** BigInt(tokenDecimals);
  const quote = await adapter.quoteTokenToUsdc(tokenAddress, oneTokenAtomic, feeTierHint);
  return { priceUsd: quote.priceUsd, feeTier: quote.feeTier };
}
