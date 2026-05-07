import { describe, it, expect, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import {
  createUniswapV3Adapter,
  WETH_BASE,
  UNISWAP_V3_BASE,
} from '../../src/trading/dex/uniswapV3.js';
import { USDC } from '../../src/wallet.js';
import type { Wallet } from '../../src/wallet.js';

// A throwaway test key. Never used to sign anything against the network —
// the public client is fully mocked below.
const TEST_KEY = '0x'.padEnd(66, '1') as `0x${string}`;

const TOKEN_ADDR = '0xd4a0e0b9149bcee3c920d2e00b5de09138fd8bb7'; // AWETH
const FAKE_TOKEN = '0xcccccccccccccccccccccccccccccccccccccccc';

interface MockPublic {
  readContract: ReturnType<typeof vi.fn>;
  waitForTransactionReceipt?: ReturnType<typeof vi.fn>;
}

function makeWallet(): Wallet {
  const account = privateKeyToAccount(TEST_KEY);
  return {
    address: account.address,
    account,
    publicClient: {} as never,
    usdcBalance: vi.fn(async () => ({ raw: 0n, formatted: '0' })),
  };
}

function makeRevertError(message: string): Error {
  // Simulate viem's ContractFunctionExecutionError so the adapter classifies
  // it as a "no pool" revert rather than a transient RPC error.
  const err = new Error(`execution reverted: ${message}`);
  err.name = 'ContractFunctionExecutionError';
  return err;
}

/**
 * Build a public client mock whose readContract responds based on the
 * `functionName`. This lets us simulate "single-hop quoter misses, multi-hop
 * succeeds" without standing up a real chain.
 */
function makePublicClient(
  handlers: {
    quoteExactInputSingle?: (args: {
      tokenIn: string;
      tokenOut: string;
      fee: number;
      amountIn: bigint;
    }) => bigint | null;
    quoteExactInput?: (args: { path: string; amountIn: bigint }) => bigint | null;
    decimals?: (token: string) => number;
  } = {},
): MockPublic {
  return {
    readContract: vi.fn(async ({ functionName, args }: { functionName: string; args: unknown[] }) => {
      if (functionName === 'decimals') {
        return handlers.decimals ? handlers.decimals(args[0] as string) : 18;
      }
      if (functionName === 'quoteExactInputSingle') {
        const [params] = args as [
          {
            tokenIn: string;
            tokenOut: string;
            fee: number;
            amountIn: bigint;
          },
        ];
        const out = handlers.quoteExactInputSingle?.(params);
        if (out === null || out === undefined) {
          throw makeRevertError(`no_pool_${params.fee}`);
        }
        return [out, 0n, 0, 0n];
      }
      if (functionName === 'quoteExactInput') {
        const [path, amountIn] = args as [string, bigint];
        const out = handlers.quoteExactInput?.({ path, amountIn });
        if (out === null || out === undefined) {
          throw makeRevertError('no_multihop_pool');
        }
        return [out, [], [], 0n];
      }
      throw new Error(`unexpected functionName=${functionName}`);
    }),
  };
}

describe('UniswapV3Adapter routing', () => {
  it('uses single-hop when a direct USDC pool exists', async () => {
    const publicClient = makePublicClient({
      quoteExactInputSingle: ({ fee }) => (fee === 3000 ? 7n * 10n ** 17n : null),
    });
    const adapter = createUniswapV3Adapter({
      wallet: makeWallet(),
      publicClient: publicClient as never,
    });
    const quote = await adapter.quoteUsdcToToken(TOKEN_ADDR, 5_000_000n);
    expect(quote.amountOutAtomic).toBe(7n * 10n ** 17n);
    expect(quote.feeTier).toBe(3000);
    expect(quote.route?.kind).toBe('single');
  });

  it('falls back to USDC->WETH->token multi-hop when no direct pool exists', async () => {
    const calls: string[] = [];
    const publicClient = makePublicClient({
      // All single-hop fee tiers miss.
      quoteExactInputSingle: ({ tokenIn, tokenOut, fee }) => {
        calls.push(`single:${tokenIn}->${tokenOut}@${fee}`);
        return null;
      },
      // Multi-hop: only the [500, 3000] pair has liquidity. Path layout is
      // tokenIn(20) || feeIn(3) || hop(20) || feeOut(3) || tokenOut(20).
      // In the 0x-prefixed lowercase hex string that's:
      //   feeIn  -> chars 42..47 (after 0x + 20 bytes)
      //   feeOut -> chars 88..93 (after 0x + 20 + 3 + 20 bytes)
      quoteExactInput: ({ path }) => {
        calls.push(`multi:${path}`);
        const lower = path.toLowerCase();
        const feeIn = lower.slice(42, 48);
        const feeOut = lower.slice(88, 94);
        if (feeIn === '0001f4' && feeOut === '000bb8') return 5n * 10n ** 17n;
        return null;
      },
    });
    const adapter = createUniswapV3Adapter({
      wallet: makeWallet(),
      publicClient: publicClient as never,
    });
    const quote = await adapter.quoteUsdcToToken(TOKEN_ADDR, 5_000_000n);
    expect(quote.route?.kind).toBe('multi');
    if (quote.route?.kind === 'multi') {
      expect(quote.route.hopToken.toLowerCase()).toBe(WETH_BASE.toLowerCase());
      expect(quote.route.feeTierIn).toBe(500);
      expect(quote.route.feeTierOut).toBe(3000);
    }
    expect(quote.feeTier).toBe(500); // headline = feeTierIn
    expect(quote.amountOutAtomic).toBe(5n * 10n ** 17n);
  });

  it('throws no_pool:USDC->token when both single and multi-hop miss', async () => {
    const publicClient = makePublicClient({
      quoteExactInputSingle: () => null,
      quoteExactInput: () => null,
    });
    const adapter = createUniswapV3Adapter({
      wallet: makeWallet(),
      publicClient: publicClient as never,
    });
    await expect(adapter.quoteUsdcToToken(FAKE_TOKEN, 5_000_000n)).rejects.toThrow(
      /no_pool:USDC->token/,
    );
  });

  it('does not attempt multi-hop when one side already equals the hop token', async () => {
    const seen: string[] = [];
    const publicClient = makePublicClient({
      quoteExactInputSingle: ({ tokenIn, tokenOut, fee }) => {
        seen.push(`${tokenIn}->${tokenOut}@${fee}`);
        return null;
      },
      quoteExactInput: () => {
        // Should never be called because tokenOut == hopToken.
        throw new Error('multihop should not be attempted when tokenOut==hopToken');
      },
    });
    const adapter = createUniswapV3Adapter({
      wallet: makeWallet(),
      publicClient: publicClient as never,
    });
    await expect(adapter.quoteUsdcToToken(WETH_BASE, 5_000_000n)).rejects.toThrow(
      /no_pool:USDC->token/,
    );
    // Only single-hop tiers should have been probed.
    expect(seen.length).toBeGreaterThan(0);
  });

  it('propagates transient RPC errors instead of silently returning no_pool', async () => {
    // All quoter calls fail with a non-revert (network-style) error. The
    // adapter must NOT classify this as a missing pool — otherwise the
    // engine's non-tradable cache would be poisoned by a transient outage.
    const transient = new Error('HTTP request failed: 503 Service Unavailable');
    transient.name = 'HttpRequestError';
    const publicClient: MockPublic = {
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName === 'decimals') return 18;
        throw transient;
      }),
    };
    const adapter = createUniswapV3Adapter({
      wallet: makeWallet(),
      publicClient: publicClient as never,
    });
    await expect(adapter.quoteUsdcToToken(FAKE_TOKEN, 5_000_000n)).rejects.toThrow(
      /HTTP request failed/,
    );
  });

  it('exports the canonical Base v3 deployment addresses', () => {
    expect(UNISWAP_V3_BASE.swapRouter02).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(WETH_BASE.toLowerCase()).toBe('0x4200000000000000000000000000000000000006');
    expect(USDC.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});
