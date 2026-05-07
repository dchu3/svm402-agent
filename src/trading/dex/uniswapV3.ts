import {
  createWalletClient,
  http,
  encodeFunctionData,
  encodePacked,
  parseAbi,
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { base } from 'viem/chains';
import type { Wallet } from '../../wallet.js';
import { USDC } from '../../wallet.js';
import { debug } from '../../util/log.js';
import type { DexAdapter, DexRoute, DexSwapResult, SwapArgs } from '../types.js';

// Uniswap v3 deployments on Base mainnet (chainId 8453).
// Docs: https://docs.uniswap.org/contracts/v3/reference/deployments/base-deployments
export const UNISWAP_V3_BASE = {
  swapRouter02: '0x2626664c2603336E57B271c5C0b26F421741e481',
  quoterV2: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
  factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
} as const;

export const UNISWAP_V3_FEE_TIERS = [100, 500, 3000, 10000] as const;

/**
 * Canonical WETH on Base. Used as the hop token for USDC<->token routes when
 * no direct USDC/token v3 pool exists at any fee tier (common for aTokens and
 * other wrappers, e.g. AWETH).
 */
export const WETH_BASE = '0x4200000000000000000000000000000000000006' as const;

/**
 * Fee-tier pairs we try for the WETH multi-hop fallback. Restricted to the
 * tiers most likely to have meaningful Base liquidity to keep the quoter call
 * count bounded (4 pairs * 2 quoter calls per quote pass).
 */
const MULTIHOP_FEE_PAIRS: ReadonlyArray<readonly [number, number]> = [
  [500, 3000],
  [3000, 500],
  [3000, 3000],
  [500, 500],
];

const QUOTER_ABI = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
  'function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)',
]);

const ROUTER_ABI = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
  'function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum)) payable returns (uint256 amountOut)',
]);

const ERC20_ABI = parseAbi([
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

/**
 * Retry an RPC read on transient rate-limit / network errors with
 * exponential backoff. Public Base RPC endpoints are aggressively throttled,
 * and a single 429 should not abort an entry/exit decision when the next
 * request a few hundred ms later will succeed.
 */
function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /over rate limit|rate.?limit|429|too many requests|request timed out/i.test(msg);
}

async function withRpcRetry<T>(
  fn: () => Promise<T>,
  label: string,
  attempts = 4,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRateLimitError(err) || i === attempts - 1) throw err;
      const delayMs = 300 * 2 ** i + Math.floor(Math.random() * 150);
      debug('uniswap-v3 rpc retry', { label, attempt: i + 1, delayMs, err: String(err).slice(0, 200) });
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

interface UniswapV3AdapterOptions {
  wallet: Wallet;
  publicClient: PublicClient;
  rpcUrl?: string;
  /** Override deployment addresses (mostly for tests). */
  addresses?: Partial<typeof UNISWAP_V3_BASE>;
  /** Override the supported fee tiers. */
  feeTiers?: readonly number[];
  /**
   * Override the hop token for the multi-hop fallback. Defaults to WETH on
   * Base. Tests can pass a different address.
   */
  hopToken?: string;
  /** Override the multi-hop fee-tier pairs. Tests pass a small fixed set. */
  multihopFeePairs?: ReadonlyArray<readonly [number, number]>;
}

/**
 * Resolve the on-chain decimals for a token. Cached for the lifetime of the
 * adapter so we don't re-read state every quote.
 */
function makeDecimalsCache(publicClient: PublicClient): (token: Address) => Promise<number> {
  const cache = new Map<string, number>();
  // USDC and a few well-known tokens have known decimals; seed for resilience.
  cache.set(USDC.address.toLowerCase(), USDC.decimals);
  return async (token: Address): Promise<number> => {
    const key = token.toLowerCase();
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const decimals = (await withRpcRetry(
      () =>
        publicClient.readContract({
          address: token,
          abi: ERC20_ABI,
          functionName: 'decimals',
        }),
      `decimals(${token})`,
    )) as number;
    cache.set(key, decimals);
    return decimals;
  };
}

function toAddress(addr: string): Address {
  return addr as Address;
}

function priceFromAmounts(
  amountInAtomic: bigint,
  amountOutAtomic: bigint,
  decimalsIn: number,
  decimalsOut: number,
  /** When true, returned price is denominated in the IN token (USDC per OUT token). */
  inIsNumeraire: boolean,
): number {
  if (amountInAtomic === 0n || amountOutAtomic === 0n) return 0;
  const inFloat = Number(amountInAtomic) / 10 ** decimalsIn;
  const outFloat = Number(amountOutAtomic) / 10 ** decimalsOut;
  if (!Number.isFinite(inFloat) || !Number.isFinite(outFloat)) return 0;
  if (outFloat === 0 || inFloat === 0) return 0;
  return inIsNumeraire ? inFloat / outFloat : outFloat / inFloat;
}

export function createUniswapV3Adapter(opts: UniswapV3AdapterOptions): DexAdapter {
  const addresses = { ...UNISWAP_V3_BASE, ...(opts.addresses ?? {}) };
  const feeTiers = opts.feeTiers ?? UNISWAP_V3_FEE_TIERS;
  const hopToken = (opts.hopToken ?? WETH_BASE) as Address;
  const multihopFeePairs = opts.multihopFeePairs ?? MULTIHOP_FEE_PAIRS;
  const getDecimals = makeDecimalsCache(opts.publicClient);

  const walletClient: WalletClient = createWalletClient({
    account: opts.wallet.account,
    chain: base,
    transport: http(opts.rpcUrl, { retryCount: 3, retryDelay: 250 }),
  });

  function encodeMultihopPath(
    tokenIn: Address,
    feeIn: number,
    hop: Address,
    feeOut: number,
    tokenOut: Address,
  ): `0x${string}` {
    return encodePacked(
      ['address', 'uint24', 'address', 'uint24', 'address'],
      [tokenIn, feeIn, hop, feeOut, tokenOut],
    );
  }

  async function quoteSingle(
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint,
    feeTier: number,
  ): Promise<bigint | null> {
    try {
      const result = (await withRpcRetry(
        () =>
          opts.publicClient.readContract({
            address: addresses.quoterV2 as Address,
            abi: QUOTER_ABI,
            functionName: 'quoteExactInputSingle',
            args: [
              {
                tokenIn,
                tokenOut,
                amountIn,
                fee: feeTier,
                sqrtPriceLimitX96: 0n,
              },
            ],
          }),
        `quoter(${tokenIn}->${tokenOut}@${feeTier})`,
      )) as readonly [bigint, bigint, number, bigint];
      return result[0];
    } catch (err) {
      debug('uniswap-v3 quoter miss', { tokenIn, tokenOut, feeTier, err: String(err) });
      return null;
    }
  }

  async function findBestQuote(
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint,
    preferredTier?: number,
  ): Promise<{ feeTier: number; amountOut: bigint } | null> {
    const tiers = preferredTier
      ? [preferredTier, ...feeTiers.filter((t) => t !== preferredTier)]
      : feeTiers;

    const results = await Promise.allSettled(
      tiers.map(async (tier) => {
        const out = await quoteSingle(tokenIn, tokenOut, amountIn, tier);
        if (out === null || out <= 0n) throw new Error(`no_quote_tier_${tier}`);
        return { feeTier: tier, amountOut: out };
      }),
    );

    let best: { feeTier: number; amountOut: bigint } | null = null;
    for (const result of results) {
      if (result.status === 'fulfilled') {
        if (!best || result.value.amountOut > best.amountOut) {
          best = result.value;
        }
      }
    }
    return best;
  }

  async function quoteMultihop(
    path: `0x${string}`,
    amountIn: bigint,
    label: string,
  ): Promise<bigint | null> {
    try {
      const result = (await withRpcRetry(
        () =>
          opts.publicClient.readContract({
            address: addresses.quoterV2 as Address,
            abi: QUOTER_ABI,
            functionName: 'quoteExactInput',
            args: [path, amountIn],
          }),
        `quoter-multihop(${label})`,
      )) as readonly [bigint, readonly bigint[], readonly number[], bigint];
      return result[0];
    } catch (err) {
      debug('uniswap-v3 multihop quoter miss', { label, err: String(err) });
      return null;
    }
  }

  async function findBestMultihop(
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint,
  ): Promise<{
    feeTierIn: number;
    feeTierOut: number;
    amountOut: bigint;
    path: `0x${string}`;
  } | null> {
    if (
      tokenIn.toLowerCase() === hopToken.toLowerCase() ||
      tokenOut.toLowerCase() === hopToken.toLowerCase()
    ) {
      // Both legs would collapse to a single hop; the single-hop search
      // already covered this case.
      return null;
    }
    const attempts = multihopFeePairs.map(async ([feeIn, feeOut]) => {
      const path = encodeMultihopPath(tokenIn, feeIn, hopToken, feeOut, tokenOut);
      const out = await quoteMultihop(
        path,
        amountIn,
        `${tokenIn}->WETH@${feeIn}->${tokenOut}@${feeOut}`,
      );
      if (out === null || out <= 0n) throw new Error(`no_multihop_${feeIn}_${feeOut}`);
      return { feeTierIn: feeIn, feeTierOut: feeOut, amountOut: out, path };
    });
    const results = await Promise.allSettled(attempts);
    let best: {
      feeTierIn: number;
      feeTierOut: number;
      amountOut: bigint;
      path: `0x${string}`;
    } | null = null;
    for (const r of results) {
      if (r.status === 'fulfilled') {
        if (!best || r.value.amountOut > best.amountOut) best = r.value;
      }
    }
    return best;
  }

  /**
   * Find the best route from tokenIn to tokenOut. Prefers single-hop pools
   * (lower gas, simpler path); falls back to a 2-hop path through `hopToken`
   * (WETH on Base) when no direct pool exists at any tier. Returns null when
   * no route is found.
   */
  async function findBestRoute(
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint,
    preferredTier?: number,
  ): Promise<
    | { kind: 'single'; feeTier: number; amountOut: bigint }
    | {
        kind: 'multi';
        feeTierIn: number;
        feeTierOut: number;
        amountOut: bigint;
        path: `0x${string}`;
      }
    | null
  > {
    const single = await findBestQuote(tokenIn, tokenOut, amountIn, preferredTier);
    if (single) return { kind: 'single', ...single };
    const multi = await findBestMultihop(tokenIn, tokenOut, amountIn);
    if (multi) return { kind: 'multi', ...multi };
    return null;
  }

  function routeFromBest(
    best:
      | { kind: 'single'; feeTier: number; amountOut: bigint }
      | {
          kind: 'multi';
          feeTierIn: number;
          feeTierOut: number;
          amountOut: bigint;
          path: `0x${string}`;
        },
  ): { route: DexRoute; headlineFeeTier: number } {
    if (best.kind === 'single') {
      return {
        route: { kind: 'single', feeTier: best.feeTier },
        headlineFeeTier: best.feeTier,
      };
    }
    return {
      route: {
        kind: 'multi',
        path: best.path,
        feeTierIn: best.feeTierIn,
        feeTierOut: best.feeTierOut,
        hopToken,
      },
      headlineFeeTier: best.feeTierIn,
    };
  }

  async function ensureAllowance(token: Address, spender: Address, amount: bigint): Promise<Hash | null> {
    const current = (await opts.publicClient.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [opts.wallet.address, spender],
    })) as bigint;
    if (current >= amount) return null;
    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [spender, amount],
    });
    const hash = await walletClient.sendTransaction({
      account: opts.wallet.account,
      chain: base,
      to: token,
      data,
      value: 0n,
    });
    await opts.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  async function executeSwap(
    tokenIn: Address,
    tokenOut: Address,
    args: SwapArgs,
  ): Promise<{ txHash: Hash; amountOut: bigint }> {
    await ensureAllowance(tokenIn, addresses.swapRouter02 as Address, args.amountInAtomic);
    const recipient = (args.recipient ?? opts.wallet.address) as Address;
    // Read the recipient's tokenOut balance BEFORE the swap so we can derive
    // the actual filled amount from the delta. Re-simulating exactInputSingle
    // post-trade would query a shifted pool and report the wrong amount.
    const balanceBefore = (await opts.publicClient.readContract({
      address: tokenOut,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [recipient],
    })) as bigint;
    const route: DexRoute = args.route ?? { kind: 'single', feeTier: args.feeTier };
    const data =
      route.kind === 'multi'
        ? encodeFunctionData({
            abi: ROUTER_ABI,
            functionName: 'exactInput',
            args: [
              {
                path: route.path,
                recipient,
                amountIn: args.amountInAtomic,
                amountOutMinimum: args.minAmountOutAtomic,
              },
            ],
          })
        : encodeFunctionData({
            abi: ROUTER_ABI,
            functionName: 'exactInputSingle',
            args: [
              {
                tokenIn,
                tokenOut,
                fee: route.feeTier,
                recipient,
                amountIn: args.amountInAtomic,
                amountOutMinimum: args.minAmountOutAtomic,
                sqrtPriceLimitX96: 0n,
              },
            ],
          });
    const hash = await walletClient.sendTransaction({
      account: opts.wallet.account,
      chain: base,
      to: addresses.swapRouter02 as Address,
      data,
      value: 0n,
    });
    const receipt = await opts.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      throw new Error(`swap_reverted:${hash}`);
    }
    const balanceAfter = (await opts.publicClient.readContract({
      address: tokenOut,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [recipient],
    })) as bigint;
    const amountOut = balanceAfter > balanceBefore ? balanceAfter - balanceBefore : 0n;
    if (amountOut < args.minAmountOutAtomic) {
      // Should never happen: router enforces amountOutMinimum, but guard so
      // we never persist a falsely-low fill (which would orphan tokens).
      throw new Error(
        `swap_balance_delta_below_min: got=${amountOut} min=${args.minAmountOutAtomic} tx=${hash}`,
      );
    }
    return { txHash: hash, amountOut };
  }

  return {
    name: 'uniswap-v3',
    async getDecimals(tokenAddress) {
      return getDecimals(toAddress(tokenAddress));
    },
    async quoteUsdcToToken(tokenAddress, amountUsdcAtomic) {
      const tokenIn = toAddress(USDC.address);
      const tokenOut = toAddress(tokenAddress);
      const best = await findBestRoute(tokenIn, tokenOut, amountUsdcAtomic);
      if (!best) throw new Error('no_pool:USDC->token');
      const decimalsOut = await getDecimals(tokenOut);
      const priceUsd = priceFromAmounts(
        amountUsdcAtomic,
        best.amountOut,
        USDC.decimals,
        decimalsOut,
        true,
      );
      const { route, headlineFeeTier } = routeFromBest(best);
      return { amountOutAtomic: best.amountOut, feeTier: headlineFeeTier, priceUsd, route };
    },
    async quoteTokenToUsdc(tokenAddress, amountTokenAtomic, feeTierHint) {
      const tokenIn = toAddress(tokenAddress);
      const tokenOut = toAddress(USDC.address);
      const best = await findBestRoute(tokenIn, tokenOut, amountTokenAtomic, feeTierHint);
      if (!best) throw new Error('no_pool:token->USDC');
      const decimalsIn = await getDecimals(tokenIn);
      const priceUsd = priceFromAmounts(
        best.amountOut,
        amountTokenAtomic,
        USDC.decimals,
        decimalsIn,
        true,
      );
      const { route, headlineFeeTier } = routeFromBest(best);
      return { amountOutAtomic: best.amountOut, feeTier: headlineFeeTier, priceUsd, route };
    },
    async swapUsdcForToken(args): Promise<DexSwapResult> {
      if (args.dryRun) {
        const decimalsOut = await getDecimals(toAddress(args.tokenAddress));
        const priceUsd = priceFromAmounts(
          args.amountInAtomic,
          args.minAmountOutAtomic,
          USDC.decimals,
          decimalsOut,
          true,
        );
        return {
          txHash: null,
          amountInAtomic: args.amountInAtomic,
          amountOutAtomic: args.minAmountOutAtomic,
          feeTier: args.feeTier,
          priceUsd,
          dryRun: true,
        };
      }
      const { txHash, amountOut } = await executeSwap(
        toAddress(USDC.address),
        toAddress(args.tokenAddress),
        args,
      );
      const decimalsOut = await getDecimals(toAddress(args.tokenAddress));
      const priceUsd = priceFromAmounts(
        args.amountInAtomic,
        amountOut,
        USDC.decimals,
        decimalsOut,
        true,
      );
      return {
        txHash,
        amountInAtomic: args.amountInAtomic,
        amountOutAtomic: amountOut,
        feeTier: args.feeTier,
        priceUsd,
        dryRun: false,
      };
    },
    async swapTokenForUsdc(args): Promise<DexSwapResult> {
      if (args.dryRun) {
        const decimalsIn = await getDecimals(toAddress(args.tokenAddress));
        const priceUsd = priceFromAmounts(
          args.minAmountOutAtomic,
          args.amountInAtomic,
          USDC.decimals,
          decimalsIn,
          true,
        );
        return {
          txHash: null,
          amountInAtomic: args.amountInAtomic,
          amountOutAtomic: args.minAmountOutAtomic,
          feeTier: args.feeTier,
          priceUsd,
          dryRun: true,
        };
      }
      const { txHash, amountOut } = await executeSwap(
        toAddress(args.tokenAddress),
        toAddress(USDC.address),
        args,
      );
      const decimalsIn = await getDecimals(toAddress(args.tokenAddress));
      const priceUsd = priceFromAmounts(
        amountOut,
        args.amountInAtomic,
        USDC.decimals,
        decimalsIn,
        true,
      );
      return {
        txHash,
        amountInAtomic: args.amountInAtomic,
        amountOutAtomic: amountOut,
        feeTier: args.feeTier,
        priceUsd,
        dryRun: false,
      };
    },
  };
}
