import { getAddress } from 'viem';
import type { Notifier } from '../notifications/index.js';
import type { Wallet } from '../wallet.js';
import type { DexAdapter, ExitReason, Position, TradingConfig } from './types.js';
import type { TradingStore } from './store.js';
import { bumpHighestPrice } from './store.js';
import { evaluateExit } from './policy.js';
import { priceTokenInUsdc } from './price.js';
import { logWatchlist, warnWatchlist, debug } from '../util/log.js';
import type Database from 'better-sqlite3';

const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;
const USDC_DECIMALS = 6;

export interface WatchlistAddInput {
  address: string;
  symbol: string | null;
  name: string | null;
  score: number;
}

export interface TradingEngineDeps {
  config: TradingConfig;
  wallet: Wallet;
  adapter: DexAdapter;
  store: TradingStore;
  /** Underlying DB handle so we can ratchet trailing-stop highs in-place. */
  db: Database.Database;
  notifier: Notifier;
}

export interface TradingEngine {
  start(): void;
  stop(): void;
  isRunning(): boolean;
  isLive(): boolean;
  setLiveEnabled(value: boolean): void;
  isEnabled(): boolean;
  setEnabled(value: boolean): void;
  onWatchlistAdd(input: WatchlistAddInput): Promise<void>;
  manualSell(address: string): Promise<{ closed: boolean; error?: string }>;
  status(): TradingEngineStatus;
}

export interface TradingEngineStatus {
  enabled: boolean;
  live: boolean;
  running: boolean;
  openPositions: number;
  maxOpenPositions: number;
  tradeSizeUsdc: number;
  minScore: number;
  dex: string;
  policy: TradingConfig['policy'];
}

function validateAddress(input: string): string | null {
  if (!ADDRESS_REGEX.test(input)) return null;
  try {
    return getAddress(input).toLowerCase();
  } catch {
    return null;
  }
}

function applySlippageBps(amount: bigint, slippageBps: number): bigint {
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.floor(slippageBps))));
  return (amount * (10_000n - bps)) / 10_000n;
}

export function createTradingEngine(deps: TradingEngineDeps): TradingEngine {
  let { live } = deps.config;
  let enabled = deps.config.enabled;
  let monitorTimer: NodeJS.Timeout | undefined;

  // In-flight reservation sets serialize entry/exit per address and bound the
  // concurrent open-count, since async work happens between the SQLite check
  // and write. Without these, two concurrent watchlist events can both pass
  // the maxOpenPositions / position-already-open guards and both swap.
  const opening = new Set<string>();
  const closing = new Set<string>();

  async function notifyError(
    address: string,
    symbol: string | null,
    stage: 'open' | 'close' | 'monitor',
    err: unknown,
  ): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    warnWatchlist(`trading ${stage} error`, { address, error: message });
    await deps.notifier.notify({
      type: 'trade:error',
      address,
      symbol,
      stage,
      message,
    });
  }

  async function tryOpen(input: WatchlistAddInput): Promise<void> {
    if (!enabled) return;
    const address = validateAddress(input.address);
    if (!address) {
      debug('trading: invalid address from watchlist event', input.address);
      return;
    }
    if (!Number.isFinite(input.score) || input.score < deps.config.minScore) {
      debug('trading: score below threshold', { score: input.score, min: deps.config.minScore });
      return;
    }
    if (deps.store.isNonTradable(address)) {
      // Token previously failed with no_pool (or another non-tradable signal).
      // Skip silently — we already notified the operator on the first failure
      // and re-attempting would just spam the same error on every replace.
      debug('trading: skipping non-tradable token', address);
      return;
    }
    if (opening.has(address)) {
      debug('trading: open already in flight', address);
      return;
    }
    if (deps.store.countOpen() + opening.size >= deps.config.maxOpenPositions) {
      logWatchlist('trading: max open positions reached, skipping', {
        address,
        max: deps.config.maxOpenPositions,
      });
      return;
    }
    if (deps.store.get(address)?.status === 'open') {
      debug('trading: position already open', address);
      return;
    }

    opening.add(address);
    try {
      const tradeSizeAtomic = BigInt(Math.floor(deps.config.tradeSizeUsdc * 10 ** USDC_DECIMALS));
      if (tradeSizeAtomic <= 0n) {
        await notifyError(address, input.symbol, 'open', new Error('invalid_trade_size'));
        return;
      }

      // Pre-flight: confirm wallet has enough USDC for the trade.
      try {
        const { raw } = await deps.wallet.usdcBalance();
        if (raw < tradeSizeAtomic) {
          await notifyError(
            address,
            input.symbol,
            'open',
            new Error(
              `insufficient_usdc: need ${deps.config.tradeSizeUsdc}, have ${(Number(raw) / 1e6).toFixed(4)}`,
            ),
          );
          return;
        }
      } catch (err) {
        await notifyError(address, input.symbol, 'open', err);
        return;
      }

      let quote;
      try {
        quote = await deps.adapter.quoteUsdcToToken(address, tradeSizeAtomic);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.startsWith('no_pool:')) {
          // No direct or multi-hop route exists. Mark the token so we don't
          // retry on subsequent watchlist replace events. The error is still
          // surfaced to the operator once.
          try {
            deps.store.markNonTradable(address, message);
          } catch (markErr) {
            debug('trading: markNonTradable failed', { address, err: String(markErr) });
          }
        }
        await notifyError(address, input.symbol, 'open', err);
        return;
      }
      if (quote.amountOutAtomic <= 0n) {
        await notifyError(address, input.symbol, 'open', new Error('zero_quote'));
        return;
      }
      const minOut = applySlippageBps(quote.amountOutAtomic, deps.config.slippageBps);

      // Resolve authoritative ERC-20 decimals from the adapter (cached) BEFORE
      // sending the swap so we can persist a correct position record.
      let tokenDecimals = 18;
      try {
        tokenDecimals = await deps.adapter.getDecimals(address);
      } catch (err) {
        debug('trading: getDecimals failed, defaulting to 18', { address, err: String(err) });
      }

      // Re-check after the awaits: another caller could have flipped the
      // engine off, or filled the slot between our entry and now.
      if (!enabled) {
        debug('trading: engine disabled mid-open, aborting', address);
        return;
      }

      let swap;
      try {
        swap = await deps.adapter.swapUsdcForToken({
          tokenAddress: address,
          amountInAtomic: tradeSizeAtomic,
          minAmountOutAtomic: minOut,
          feeTier: quote.feeTier,
          route: quote.route,
          dryRun: !live,
        });
      } catch (err) {
        await notifyError(address, input.symbol, 'open', err);
        return;
      }

      let position: Position;
      try {
        position = deps.store.openPosition({
          address,
          symbol: input.symbol,
          name: input.name,
          entryPriceUsd: swap.priceUsd,
          entryAmountUsdc: deps.config.tradeSizeUsdc,
          tokenAmountAtomic: swap.amountOutAtomic.toString(),
          tokenDecimals,
          dex: deps.adapter.name,
          feeTier: swap.feeTier,
          dryRun: swap.dryRun,
        });
      } catch (err) {
        // Critical: a real swap may have already executed. Surface the tx
        // hash in the error so the operator can reconcile manually.
        await notifyError(
          address,
          input.symbol,
          'open',
          new Error(
            `position_record_failed${swap.txHash ? `:tx=${swap.txHash}` : ''}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        return;
      }

      try {
        deps.store.recordTrade({
          positionAddress: address,
          side: 'buy',
          dex: deps.adapter.name,
          txHash: swap.txHash,
          amountInAtomic: tradeSizeAtomic.toString(),
          amountOutAtomic: swap.amountOutAtomic.toString(),
          priceUsd: swap.priceUsd,
          feeTier: swap.feeTier,
          dryRun: swap.dryRun,
        });
      } catch (err) {
        debug('trading: recordTrade failed (non-fatal)', { address, err: String(err) });
      }

      await deps.notifier.notify({
        type: 'trade:open',
        address: position.address,
        symbol: position.symbol,
        entryPriceUsd: position.entryPriceUsd,
        entryAmountUsdc: position.entryAmountUsdc,
        dex: position.dex,
        feeTier: position.feeTier,
        txHash: swap.txHash,
        dryRun: position.dryRun,
      });
    } finally {
      opening.delete(address);
    }
  }

  async function tryClose(
    position: Position,
    reason: ExitReason,
    currentPriceUsd: number,
  ): Promise<{ closed: boolean; error?: string }> {
    // Per-address closing lock: prevents the monitor loop and a manual /sell
    // from racing two concurrent sells against the same wallet balance.
    if (closing.has(position.address)) {
      return { closed: false, error: 'close_in_flight' };
    }
    closing.add(position.address);
    try {
      // Refuse to "close" a live position when the engine is in dry-run mode:
      // doing so would mark it closed in the DB without actually selling on
      // chain, leaving real tokens stranded. Operator must flip back to live
      // (or sell out-of-band) to exit a live position.
      if (!position.dryRun && !live) {
        const message = 'cannot_close_live_position_in_dry_run_mode';
        await notifyError(position.address, position.symbol, 'close', new Error(message));
        return { closed: false, error: message };
      }

      const tokenAtomic = BigInt(position.tokenAmountAtomic);
      if (tokenAtomic <= 0n) {
        // Defensive: should never happen for a real position.
        const closed = deps.store.closePosition({
          address: position.address,
          exitReason: reason,
          exitPriceUsd: currentPriceUsd,
          realizedPnlUsd: 0,
        });
        if (closed) {
          await deps.notifier.notify({
            type: 'trade:close',
            address: closed.address,
            symbol: closed.symbol,
            reason,
            entryPriceUsd: closed.entryPriceUsd,
            exitPriceUsd: currentPriceUsd,
            realizedPnlUsd: 0,
            durationMs: (closed.closedAt ?? Date.now()) - closed.openedAt,
            txHash: null,
            dryRun: closed.dryRun,
          });
        }
        return { closed: !!closed };
      }

      let quote;
      try {
        quote = await deps.adapter.quoteTokenToUsdc(
          position.address,
          tokenAtomic,
          position.feeTier ?? undefined,
        );
      } catch (err) {
        await notifyError(position.address, position.symbol, 'close', err);
        return { closed: false, error: err instanceof Error ? err.message : String(err) };
      }
      const minOut = applySlippageBps(quote.amountOutAtomic, deps.config.slippageBps);

      let swap;
      try {
        swap = await deps.adapter.swapTokenForUsdc({
          tokenAddress: position.address,
          amountInAtomic: tokenAtomic,
          minAmountOutAtomic: minOut,
          feeTier: quote.feeTier,
          route: quote.route,
          dryRun: position.dryRun,
        });
      } catch (err) {
        await notifyError(position.address, position.symbol, 'close', err);
        return { closed: false, error: err instanceof Error ? err.message : String(err) };
      }

      const proceedsUsdc = Number(swap.amountOutAtomic) / 10 ** USDC_DECIMALS;
      const realizedPnlUsd = proceedsUsdc - position.entryAmountUsdc;

      const closed = deps.store.closePosition({
        address: position.address,
        exitReason: reason,
        exitPriceUsd: swap.priceUsd,
        realizedPnlUsd,
      });

      try {
        deps.store.recordTrade({
          positionAddress: position.address,
          side: 'sell',
          dex: deps.adapter.name,
          txHash: swap.txHash,
          amountInAtomic: tokenAtomic.toString(),
          amountOutAtomic: swap.amountOutAtomic.toString(),
          priceUsd: swap.priceUsd,
          feeTier: swap.feeTier,
          dryRun: swap.dryRun,
        });
      } catch (err) {
        debug('trading: recordTrade(sell) failed (non-fatal)', { address: position.address, err: String(err) });
      }

      if (closed) {
        await deps.notifier.notify({
          type: 'trade:close',
          address: closed.address,
          symbol: closed.symbol,
          reason,
          entryPriceUsd: closed.entryPriceUsd,
          exitPriceUsd: swap.priceUsd,
          realizedPnlUsd,
          durationMs: (closed.closedAt ?? Date.now()) - closed.openedAt,
          txHash: swap.txHash,
          dryRun: swap.dryRun,
        });
      }
      return { closed: !!closed };
    } finally {
      closing.delete(position.address);
    }
  }

  async function monitorTick(): Promise<void> {
    const open = deps.store.listOpen();
    if (open.length === 0) return;
    const now = Date.now();

    // Process in batches of 5 to avoid hitting RPC rate limits while still
    // gaining performance over sequential execution.
    const CONCURRENCY_LIMIT = 5;
    for (let i = 0; i < open.length; i += CONCURRENCY_LIMIT) {
      const chunk = open.slice(i, i + CONCURRENCY_LIMIT);
      await Promise.allSettled(
        chunk.map(async (pos) => {
          try {
            const { priceUsd } = await priceTokenInUsdc(
              deps.adapter,
              pos.address,
              pos.tokenDecimals,
              pos.feeTier ?? undefined,
            );
            if (!Number.isFinite(priceUsd) || priceUsd <= 0) return;
            bumpHighestPrice(deps.db, pos.address, priceUsd);
            // Re-read the position so highestPriceUsd reflects the bump.
            const refreshed = deps.store.get(pos.address);
            if (!refreshed || refreshed.status !== 'open') return;
            const decision = evaluateExit({
              position: refreshed,
              currentPriceUsd: priceUsd,
              now,
              config: deps.config.policy,
            });
            if (decision.shouldExit && decision.reason) {
              await tryClose(refreshed, decision.reason, priceUsd);
            }
          } catch (err) {
            await notifyError(pos.address, pos.symbol, 'monitor', err);
          }
        }),
      );
    }
  }

  function start(): void {
    if (monitorTimer) return;
    enabled = true;
    const tick = async (): Promise<void> => {
      try {
        if (enabled) await monitorTick();
      } catch (err) {
        debug('trading monitor tick error', err);
      } finally {
        if (enabled) {
          monitorTimer = setTimeout(tick, deps.config.monitorIntervalMs);
        } else {
          monitorTimer = undefined;
        }
      }
    };
    monitorTimer = setTimeout(tick, deps.config.monitorIntervalMs);
  }

  function stop(): void {
    enabled = false;
    if (monitorTimer) {
      clearTimeout(monitorTimer);
      monitorTimer = undefined;
    }
  }

  return {
    start,
    stop,
    isRunning: () => Boolean(monitorTimer) && enabled,
    isLive: () => live,
    setLiveEnabled(value) {
      live = value;
    },
    isEnabled: () => enabled,
    setEnabled(value) {
      if (value) start();
      else stop();
    },
    async onWatchlistAdd(input) {
      await tryOpen(input);
    },
    async manualSell(address) {
      const normalized = validateAddress(address);
      if (!normalized) return { closed: false, error: 'invalid_address' };
      const pos = deps.store.get(normalized);
      if (!pos || pos.status !== 'open') {
        return { closed: false, error: 'no_open_position' };
      }
      try {
        let priceUsd = pos.entryPriceUsd;
        try {
          const p = await priceTokenInUsdc(
            deps.adapter,
            pos.address,
            pos.tokenDecimals,
            pos.feeTier ?? undefined,
          );
          priceUsd = p.priceUsd;
        } catch {
          // fall back to entry price for accounting; close still proceeds
        }
        const result = await tryClose(pos, 'manual', priceUsd);
        if (result.closed) return { closed: true };
        // tryClose already emitted a trade:error notification; surface the
        // reason here so REPL/Telegram can show why the sell didn't go through.
        const refreshed = deps.store.get(normalized);
        if (refreshed?.status === 'closed') return { closed: true };
        return { closed: false, error: result.error ?? 'close_failed' };
      } catch (err) {
        return { closed: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    status() {
      return {
        enabled,
        live,
        running: Boolean(monitorTimer) && enabled,
        openPositions: deps.store.countOpen(),
        maxOpenPositions: deps.config.maxOpenPositions,
        tradeSizeUsdc: deps.config.tradeSizeUsdc,
        minScore: deps.config.minScore,
        dex: deps.adapter.name,
        policy: deps.config.policy,
      };
    },
  };
}
