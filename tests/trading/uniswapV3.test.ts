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
    vi.useFakeTimers();
    try {
      const promise = adapter.quoteUsdcToToken(FAKE_TOKEN, 5_000_000n);
      const swallowed = promise.catch(() => undefined);
      await vi.runAllTimersAsync();
      await swallowed;
      await expect(promise).rejects.toThrow(/HTTP request failed/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates ContractFunctionExecutionError that wraps a transient `block not found` cause', async () => {
    // Reproduces the live-trading bug: viem wraps llamarpc's "block not
    // found" in a ContractFunctionExecutionError whose top-level message is
    // "RPC Request failed." (NOT a revert phrase). The OLD classifier
    // returned true for any error with that constructor name and treated
    // this as a clean revert, so every fee tier "missed" and the engine
    // marked the token permanently non-tradable. The NEW classifier walks
    // the cause chain, finds "block not found", and surfaces the underlying
    // transport error instead.
    const cause = new Error('block not found: 0x2b92c16');
    cause.name = 'HttpRequestError';
    const wrapper = Object.assign(new Error('RPC Request failed.'), {
      name: 'ContractFunctionExecutionError',
      shortMessage: 'RPC Request failed.',
      details: 'block not found: 0x2b92c16',
      cause,
    });
    const publicClient: MockPublic = {
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName === 'decimals') return 18;
        throw wrapper;
      }),
    };
    const adapter = createUniswapV3Adapter({
      wallet: makeWallet(),
      publicClient: publicClient as never,
    });
    vi.useFakeTimers();
    try {
      // Must propagate (not collapse to no_pool:USDC->token) so the engine
      // does not mark the token non-tradable on a transient RPC outage.
      const promise = adapter.quoteUsdcToToken(FAKE_TOKEN, 5_000_000n);
      // Suppress potential late-settle "unhandled rejection" while we drive
      // the retry timers; we'll assert on the same promise below.
      const swallowed = promise.catch(() => undefined);
      await vi.runAllTimersAsync();
      await swallowed;
      let caught: unknown = null;
      try {
        await promise;
      } catch (err) {
        caught = err;
      }
      expect(caught).toMatchObject({ name: 'ContractFunctionExecutionError' });
      const msg = caught instanceof Error ? caught.message : String(caught);
      expect(msg).not.toMatch(/no_pool:/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not misclassify a real revert whose call args coincidentally contain transient digits', async () => {
    // Regression guard for the GPT-5.4 review finding: viem's pretty-printed
    // "Contract Call:" block (metaMessages) embeds raw call data and
    // addresses. If our classifier scanned that block, an arg byte sequence
    // ending in 503/504/429 could falsely trigger transient classification
    // and turn a genuine empty-pool revert into a "propagate transient"
    // outcome — which would NOT be cached as non-tradable, so the engine
    // would re-try the bad token forever.
    //
    // We mock a viem-shaped revert with metaMessages containing a 503-like
    // address substring AND an explicit "execution reverted" cause. The
    // adapter must classify this as a revert (return null from quoteSingle,
    // ultimately throwing no_pool), NOT as transient.
    const cause = new Error('execution reverted');
    cause.name = 'ContractFunctionRevertedError';
    const revert = Object.assign(new Error('The contract function "quoteExactInputSingle" reverted.'), {
      name: 'ContractFunctionExecutionError',
      shortMessage: 'The contract function "quoteExactInputSingle" reverted.',
      // metaMessages contains an address ending in 503 — must be ignored.
      metaMessages: [
        'Contract Call:',
        '  address:   0x000000000000000000000000000000000000503',
        '  function:  quoteExactInputSingle(...)',
      ],
      cause,
    });
    const publicClient: MockPublic = {
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName === 'decimals') return 18;
        throw revert;
      }),
    };
    const adapter = createUniswapV3Adapter({
      wallet: makeWallet(),
      publicClient: publicClient as never,
    });
    await expect(adapter.quoteUsdcToToken(FAKE_TOKEN, 5_000_000n)).rejects.toThrow(
      /no_pool:USDC->token/,
    );
  });

  it('does not misclassify a real revert that mentions the word "timeout" in its reason', async () => {
    // Regression guard for the Haiku review finding: bare keywords like
    // "timeout" must not be enough to flag transient. A contract revert
    // reason of "timeout exceeded" should still be classified as a revert.
    const cause = new Error('execution reverted: timeout exceeded');
    cause.name = 'ContractFunctionRevertedError';
    const revert = Object.assign(new Error('execution reverted: timeout exceeded'), {
      name: 'ContractFunctionExecutionError',
      shortMessage: 'execution reverted: timeout exceeded',
      cause,
    });
    const publicClient: MockPublic = {
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName === 'decimals') return 18;
        throw revert;
      }),
    };
    const adapter = createUniswapV3Adapter({
      wallet: makeWallet(),
      publicClient: publicClient as never,
    });
    await expect(adapter.quoteUsdcToToken(FAKE_TOKEN, 5_000_000n)).rejects.toThrow(
      /no_pool:USDC->token/,
    );
  });

  it('retries transient RPC errors and recovers when a later attempt succeeds', async () => {
    // First call to quoteExactInputSingle throws a wrapped "block not
    // found"; the second succeeds. withRpcRetry should swallow the first
    // failure and return the recovered quote.
    let calls = 0;
    const cause = new Error('block not found: 0x2b92c16');
    cause.name = 'HttpRequestError';
    const wrapper = Object.assign(new Error('reverted'), {
      name: 'ContractFunctionExecutionError',
      details: 'block not found: 0x2b92c16',
      cause,
    });
    const publicClient: MockPublic = {
      readContract: vi.fn(async ({ functionName, args }: { functionName: string; args: unknown[] }) => {
        if (functionName === 'decimals') return 18;
        if (functionName === 'quoteExactInputSingle') {
          const [params] = args as [{ fee: number }];
          if (params.fee !== 3000) return [0n, 0n, 0, 0n]; // miss other tiers cleanly
          calls++;
          if (calls === 1) throw wrapper;
          return [42n * 10n ** 17n, 0n, 0, 0n];
        }
        if (functionName === 'quoteExactInput') return [0n, [], [], 0n];
        throw new Error(`unexpected ${functionName}`);
      }),
    };
    const adapter = createUniswapV3Adapter({
      wallet: makeWallet(),
      publicClient: publicClient as never,
    });
    const quote = await adapter.quoteUsdcToToken(TOKEN_ADDR, 5_000_000n);
    expect(quote.amountOutAtomic).toBe(42n * 10n ** 17n);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('exports the canonical Base v3 deployment addresses', () => {
    expect(UNISWAP_V3_BASE.swapRouter02).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(WETH_BASE.toLowerCase()).toBe('0x4200000000000000000000000000000000000006');
    expect(USDC.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});
