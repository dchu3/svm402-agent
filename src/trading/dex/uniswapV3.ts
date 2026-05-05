import {
  createWalletClient,
  http,
  encodeFunctionData,
  decodeFunctionResult,
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
import type { DexAdapter, DexSwapResult, SwapArgs } from '../types.js';

// Uniswap v3 deployments on Base mainnet (chainId 8453).
// Docs: https://docs.uniswap.org/contracts/v3/reference/deployments/base-deployments
export const UNISWAP_V3_BASE = {
  swapRouter02: '0x2626664c2603336E57B271c5C0b26F421741e481',
  quoterV2: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
  factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
} as const;

export const UNISWAP_V3_FEE_TIERS = [100, 500, 3000, 10000] as const;

const QUOTER_ABI = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);

const ROUTER_ABI = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
]);

const ERC20_ABI = parseAbi([
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

interface UniswapV3AdapterOptions {
  wallet: Wallet;
  publicClient: PublicClient;
  rpcUrl?: string;
  /** Override deployment addresses (mostly for tests). */
  addresses?: Partial<typeof UNISWAP_V3_BASE>;
  /** Override the supported fee tiers. */
  feeTiers?: readonly number[];
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
    const decimals = (await publicClient.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: 'decimals',
    })) as number;
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
  const getDecimals = makeDecimalsCache(opts.publicClient);

  const walletClient: WalletClient = createWalletClient({
    account: opts.wallet.account,
    chain: base,
    transport: http(opts.rpcUrl),
  });

  async function quoteSingle(
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint,
    feeTier: number,
  ): Promise<bigint | null> {
    try {
      const result = (await opts.publicClient.readContract({
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
      })) as readonly [bigint, bigint, number, bigint];
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
    let best: { feeTier: number; amountOut: bigint } | null = null;
    for (const tier of tiers) {
      const out = await quoteSingle(tokenIn, tokenOut, amountIn, tier);
      if (out !== null && out > 0n && (!best || out > best.amountOut)) {
        best = { feeTier: tier, amountOut: out };
      }
    }
    return best;
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
    const data = encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: 'exactInputSingle',
      args: [
        {
          tokenIn,
          tokenOut,
          fee: args.feeTier,
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
    // We can't reliably decode router return value from the receipt without a
    // log parser, so we re-read the recipient balance delta via the simulator
    // is not free; instead trust the quote-based minimum and re-quote post-trade.
    // For accounting we rely on the router's return value via simulateContract:
    let amountOut: bigint;
    try {
      const sim = await opts.publicClient.simulateContract({
        account: opts.wallet.account,
        address: addresses.swapRouter02 as Address,
        abi: ROUTER_ABI,
        functionName: 'exactInputSingle',
        args: [
          {
            tokenIn,
            tokenOut,
            fee: args.feeTier,
            recipient,
            amountIn: args.amountInAtomic,
            amountOutMinimum: args.minAmountOutAtomic,
            sqrtPriceLimitX96: 0n,
          },
        ],
        value: 0n,
      });
      amountOut = sim.result as bigint;
    } catch {
      amountOut = args.minAmountOutAtomic;
    }
    return { txHash: hash, amountOut };
  }

  return {
    name: 'uniswap-v3',
    async quoteUsdcToToken(tokenAddress, amountUsdcAtomic) {
      const tokenIn = toAddress(USDC.address);
      const tokenOut = toAddress(tokenAddress);
      const best = await findBestQuote(tokenIn, tokenOut, amountUsdcAtomic);
      if (!best) throw new Error('no_pool:USDC->token');
      const decimalsOut = await getDecimals(tokenOut);
      const priceUsd = priceFromAmounts(
        amountUsdcAtomic,
        best.amountOut,
        USDC.decimals,
        decimalsOut,
        true,
      );
      return { amountOutAtomic: best.amountOut, feeTier: best.feeTier, priceUsd };
    },
    async quoteTokenToUsdc(tokenAddress, amountTokenAtomic, feeTierHint) {
      const tokenIn = toAddress(tokenAddress);
      const tokenOut = toAddress(USDC.address);
      const best = await findBestQuote(tokenIn, tokenOut, amountTokenAtomic, feeTierHint);
      if (!best) throw new Error('no_pool:token->USDC');
      const decimalsIn = await getDecimals(tokenIn);
      const priceUsd = priceFromAmounts(
        best.amountOut,
        amountTokenAtomic,
        USDC.decimals,
        decimalsIn,
        true,
      );
      return { amountOutAtomic: best.amountOut, feeTier: best.feeTier, priceUsd };
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

// Suppress unused-import lint for decodeFunctionResult; kept for future log decoding paths.
void decodeFunctionResult;
