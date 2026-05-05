export type PositionStatus = 'open' | 'closed';

export type ExitReason =
  | 'take_profit'
  | 'stop_loss'
  | 'trailing_stop'
  | 'max_hold'
  | 'manual'
  | 'engine_stopped';

export type TradeSide = 'buy' | 'sell';

export interface Position {
  address: string;
  symbol: string | null;
  name: string | null;
  status: PositionStatus;
  entryPriceUsd: number;
  entryAmountUsdc: number;
  tokenAmountAtomic: string;
  tokenDecimals: number;
  highestPriceUsd: number;
  openedAt: number;
  closedAt: number | null;
  exitReason: ExitReason | null;
  exitPriceUsd: number | null;
  realizedPnlUsd: number | null;
  dex: string;
  feeTier: number | null;
  dryRun: boolean;
}

export interface OpenPositionInput {
  address: string;
  symbol: string | null;
  name: string | null;
  entryPriceUsd: number;
  entryAmountUsdc: number;
  tokenAmountAtomic: string;
  tokenDecimals: number;
  dex: string;
  feeTier: number | null;
  dryRun: boolean;
}

export interface ClosePositionInput {
  address: string;
  exitReason: ExitReason;
  exitPriceUsd: number;
  realizedPnlUsd: number;
  closedAt?: number;
}

export interface Trade {
  id: number;
  positionAddress: string;
  side: TradeSide;
  dex: string;
  txHash: string | null;
  amountInAtomic: string;
  amountOutAtomic: string;
  priceUsd: number;
  feeTier: number | null;
  dryRun: boolean;
  createdAt: number;
  error: string | null;
}

export interface TradeInput {
  positionAddress: string;
  side: TradeSide;
  dex: string;
  txHash: string | null;
  amountInAtomic: string;
  amountOutAtomic: string;
  priceUsd: number;
  feeTier: number | null;
  dryRun: boolean;
  error?: string | null;
}

export interface DexQuote {
  amountOutAtomic: bigint;
  feeTier: number;
  priceUsd: number;
}

export interface DexSwapResult {
  txHash: string | null;
  amountInAtomic: bigint;
  amountOutAtomic: bigint;
  feeTier: number;
  priceUsd: number;
  dryRun: boolean;
  gasUsed?: bigint;
}

export interface DexAdapter {
  readonly name: string;
  /** Get a quote for swapping a fixed USDC amount into the given token. */
  quoteUsdcToToken(tokenAddress: string, amountUsdcAtomic: bigint): Promise<DexQuote>;
  /** Get a quote for swapping a fixed token amount into USDC. */
  quoteTokenToUsdc(
    tokenAddress: string,
    amountTokenAtomic: bigint,
    feeTierHint?: number,
  ): Promise<DexQuote>;
  /** Execute USDC -> token swap. Honors live/dry-run flag from caller. */
  swapUsdcForToken(args: SwapArgs): Promise<DexSwapResult>;
  /** Execute token -> USDC swap. */
  swapTokenForUsdc(args: SwapArgs): Promise<DexSwapResult>;
  /** Resolve on-chain decimals for a token (cached). */
  getDecimals(tokenAddress: string): Promise<number>;
}

export interface SwapArgs {
  tokenAddress: string;
  amountInAtomic: bigint;
  minAmountOutAtomic: bigint;
  feeTier: number;
  dryRun: boolean;
  /** Recipient defaults to wallet address when omitted. */
  recipient?: `0x${string}`;
  /** Deadline in unix seconds. */
  deadline?: number;
}

export interface ExitDecision {
  shouldExit: boolean;
  reason?: ExitReason;
}

export interface ExitPolicyConfig {
  takeProfitPct: number;
  stopLossPct: number;
  trailingStopPct: number;
  maxHoldMs: number;
}

export interface TradingConfig {
  enabled: boolean;
  live: boolean;
  minScore: number;
  tradeSizeUsdc: number;
  maxOpenPositions: number;
  slippageBps: number;
  monitorIntervalMs: number;
  dexName: string;
  policy: ExitPolicyConfig;
}
