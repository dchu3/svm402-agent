import type { ExitDecision, ExitPolicyConfig, Position } from './types.js';

export interface PolicyEvalInput {
  position: Position;
  currentPriceUsd: number;
  now: number;
  config: ExitPolicyConfig;
}

/**
 * Evaluate whether to exit a position. Pure function — it does NOT mutate the
 * supplied position. Trailing-stop ratcheting is handled separately by the
 * caller via {@link nextHighestPrice}.
 */
export function evaluateExit(input: PolicyEvalInput): ExitDecision {
  const { position, currentPriceUsd, now, config } = input;
  if (position.status !== 'open') return { shouldExit: false };
  if (!Number.isFinite(currentPriceUsd) || currentPriceUsd <= 0) return { shouldExit: false };
  if (!Number.isFinite(position.entryPriceUsd) || position.entryPriceUsd <= 0) {
    return { shouldExit: false };
  }

  const pnlPct = ((currentPriceUsd - position.entryPriceUsd) / position.entryPriceUsd) * 100;

  if (config.takeProfitPct > 0 && pnlPct >= config.takeProfitPct) {
    return { shouldExit: true, reason: 'take_profit' };
  }

  if (config.stopLossPct > 0 && pnlPct <= -config.stopLossPct) {
    return { shouldExit: true, reason: 'stop_loss' };
  }

  if (config.trailingStopPct > 0) {
    const peak = Math.max(position.highestPriceUsd, position.entryPriceUsd);
    if (peak > position.entryPriceUsd) {
      const drawdownPct = ((peak - currentPriceUsd) / peak) * 100;
      if (drawdownPct >= config.trailingStopPct) {
        return { shouldExit: true, reason: 'trailing_stop' };
      }
    }
  }

  if (config.maxHoldMs > 0 && now - position.openedAt >= config.maxHoldMs) {
    return { shouldExit: true, reason: 'max_hold' };
  }

  return { shouldExit: false };
}

/** Returns the new highest-observed price, ratcheting up from the prior peak. */
export function nextHighestPrice(prev: number, current: number): number {
  if (!Number.isFinite(current) || current <= 0) return prev;
  return current > prev ? current : prev;
}
