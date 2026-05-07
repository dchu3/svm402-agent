import { handlers, TOOL_PRICES_USD, type ToolCallResult } from '../oracle/handlers.js';
import type { HandlerDeps } from '../oracle/handlers.js';
import type { PaymentReceipt } from '../oracle/client.js';
import { debug } from '../util/log.js';
import type { SendHooks } from './types.js';

export interface ResolvedToolCall {
  name: string;
  args: Record<string, unknown>;
  result: ToolCallResult;
  receipt?: PaymentReceipt;
}

/**
 * Dispatch a single tool call: validates against the registered handlers,
 * tracks the resulting payment receipt (if any), back-fills the atomic
 * amount when the oracle did not include it, and fires the hooks.
 */
export async function dispatchToolCall(
  name: string,
  args: Record<string, unknown>,
  deps: HandlerDeps,
  hooks?: SendHooks,
): Promise<ResolvedToolCall> {
  debug('tool-call', name, args);
  const handler = handlers[name];
  if (!handler) {
    const result: ToolCallResult = { ok: false, error: `unknown_tool:${name}` };
    return { name, args, result };
  }
  hooks?.onToolStart?.({ name, args });
  const receiptsBefore = deps.oracle.receipts.length;
  const result = await handler(args, deps);
  const newReceipt =
    deps.oracle.receipts.length > receiptsBefore
      ? deps.oracle.receipts[deps.oracle.receipts.length - 1]
      : undefined;

  if (newReceipt && !newReceipt.amountAtomic && result.ok) {
    const price = TOOL_PRICES_USD[name];
    if (price !== undefined) {
      newReceipt.amountAtomic = String(Math.floor(price * 1_000_000));
    }
  }

  hooks?.onToolEnd?.({
    name,
    args,
    result,
    priceUsd: TOOL_PRICES_USD[name] ?? 0,
    ...(newReceipt ? { receipt: newReceipt } : {}),
  });
  return { name, args, result, receipt: newReceipt };
}

export const MAX_TOOL_HOPS = 6;
