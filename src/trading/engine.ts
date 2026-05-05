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
    if (deps.store.countOpen() >= deps.config.maxOpenPositions) {
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
      await notifyError(address, input.symbol, 'open', err);
      return;
    }
    if (quote.amountOutAtomic <= 0n) {
      await notifyError(address, input.symbol, 'open', new Error('zero_quote'));
      return;
    }
    const minOut = applySlippageBps(quote.amountOutAtomic, deps.config.slippageBps);

    let swap;
    try {
      swap = await deps.adapter.swapUsdcForToken({
        tokenAddress: address,
        amountInAtomic: tradeSizeAtomic,
        minAmountOutAtomic: minOut,
        feeTier: quote.feeTier,
        dryRun: !live,
      });
    } catch (err) {
      await notifyError(address, input.symbol, 'open', err);
      return;
    }

    // Resolve token decimals from the price helper round-trip; a 1-token
    // re-quote also confirms the pool can be used for marking later.
    let tokenDecimals = 18;
    try {
      // Use entry quote's price directly; decimals derived from quote ratio
      // is unreliable. Fall back to ERC20 decimals via adapter cache by
      // making a 1-unit USDC quote (already done above) — adapter has cached.
      // We trust the position's priceUsd from the swap result.
      tokenDecimals = inferDecimalsFromRatio(
        Number(tradeSizeAtomic),
        Number(swap.amountOutAtomic),
        swap.priceUsd,
      );
    } catch {
      // keep default 18
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
      await notifyError(address, input.symbol, 'open', err);
      return;
    }

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
  }

  async function tryClose(
    position: Position,
    reason: ExitReason,
    currentPriceUsd: number,
  ): Promise<void> {
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
      return;
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
      return;
    }
    const minOut = applySlippageBps(quote.amountOutAtomic, deps.config.slippageBps);

    let swap;
    try {
      swap = await deps.adapter.swapTokenForUsdc({
        tokenAddress: position.address,
        amountInAtomic: tokenAtomic,
        minAmountOutAtomic: minOut,
        feeTier: quote.feeTier,
        dryRun: position.dryRun || !live,
      });
    } catch (err) {
      await notifyError(position.address, position.symbol, 'close', err);
      return;
    }

    const proceedsUsdc = Number(swap.amountOutAtomic) / 10 ** USDC_DECIMALS;
    const realizedPnlUsd = proceedsUsdc - position.entryAmountUsdc;

    const closed = deps.store.closePosition({
      address: position.address,
      exitReason: reason,
      exitPriceUsd: swap.priceUsd,
      realizedPnlUsd,
    });

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
  }

  async function monitorTick(): Promise<void> {
    const open = deps.store.listOpen();
    if (open.length === 0) return;
    const now = Date.now();
    for (const pos of open) {
      try {
        const { priceUsd } = await priceTokenInUsdc(
          deps.adapter,
          pos.address,
          pos.tokenDecimals,
          pos.feeTier ?? undefined,
        );
        if (!Number.isFinite(priceUsd) || priceUsd <= 0) continue;
        bumpHighestPrice(deps.db, pos.address, priceUsd);
        // Re-read the position so highestPriceUsd reflects the bump.
        const refreshed = deps.store.get(pos.address);
        if (!refreshed || refreshed.status !== 'open') continue;
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
        await tryClose(pos, 'manual', priceUsd);
        return { closed: true };
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

/**
 * Best-effort token decimals inference from a USDC->token swap result.
 * Given the USDC amount in (atomic, 6 dec), the token amount out (atomic), and
 * the price (USDC per 1 whole token), derive decimals by checking which
 * 10**d makes the numbers consistent. Returns 18 when ambiguous.
 */
function inferDecimalsFromRatio(
  usdcAtomicIn: number,
  tokenAtomicOut: number,
  priceUsd: number,
): number {
  if (
    !Number.isFinite(usdcAtomicIn) ||
    !Number.isFinite(tokenAtomicOut) ||
    !Number.isFinite(priceUsd) ||
    priceUsd <= 0 ||
    tokenAtomicOut <= 0
  ) {
    return 18;
  }
  const usdcUnits = usdcAtomicIn / 1e6;
  const tokensWhole = usdcUnits / priceUsd;
  if (tokensWhole <= 0) return 18;
  const ratio = tokenAtomicOut / tokensWhole;
  // Find the integer d such that 10**d ≈ ratio.
  for (const d of [6, 8, 9, 12, 18]) {
    const expected = 10 ** d;
    if (ratio > expected * 0.5 && ratio < expected * 2) return d;
  }
  return 18;
}
