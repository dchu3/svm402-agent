import { z } from 'zod';
import type { OracleClient } from './client.js';
import {
  MarketResponseSchema,
  HoneypotResponseSchema,
  ForensicsResponseSchema,
  ReportResponseSchema,
} from './schemas.js';
import { debug } from '../util/log.js';

const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/i;

export const TOOL_PRICES_USD: Record<string, number> = {
  get_market: 0.005,
  get_honeypot: 0.01,
  get_forensics: 0.02,
  get_report: 0.03,
};

export interface SpendTracker {
  total: number;
  cap: number;
  add(usd: number): void;
  wouldExceed(usd: number): boolean;
}

export function createSpendTracker(capUsd: number): SpendTracker {
  return {
    total: 0,
    cap: capUsd,
    add(usd) {
      this.total += usd;
    },
    wouldExceed(usd) {
      return this.total + usd > this.cap + 1e-9;
    },
  };
}

export interface HandlerDeps {
  oracle: OracleClient;
  spend: SpendTracker;
}

export interface ToolCallResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

function validateAddress(addr: unknown): string | null {
  if (typeof addr !== 'string') return null;
  return ADDRESS_REGEX.test(addr) ? addr.toLowerCase() : null;
}

async function runPaid<T>(
  deps: HandlerDeps,
  toolName: string,
  path: string,
  schema: z.ZodType<T>,
): Promise<ToolCallResult> {
  const price = TOOL_PRICES_USD[toolName] ?? 0;
  if (deps.spend.wouldExceed(price)) {
    return {
      ok: false,
      error: `spend_cap_exceeded: this call would push session spend past $${deps.spend.cap.toFixed(3)} USDC (currently $${deps.spend.total.toFixed(3)}, this call costs $${price.toFixed(3)}).`,
    };
  }
  try {
    const { data } = await deps.oracle.get<unknown>(path);
    deps.spend.add(price);
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      debug('schema validation failed for', path, parsed.error.message);
      return { ok: true, data };
    }
    return { ok: true, data: parsed.data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export const handlers: Record<
  string,
  (args: Record<string, unknown>, deps: HandlerDeps) => Promise<ToolCallResult>
> = {
  async get_market(args, deps) {
    const addr = validateAddress(args.address);
    if (!addr) return { ok: false, error: 'invalid_address' };
    return runPaid(
      deps,
      'get_market',
      `/api/v1/x402/base/token/${addr}/market`,
      MarketResponseSchema,
    );
  },
  async get_honeypot(args, deps) {
    const addr = validateAddress(args.address);
    if (!addr) return { ok: false, error: 'invalid_address' };
    return runPaid(
      deps,
      'get_honeypot',
      `/api/v1/x402/base/token/${addr}/honeypot`,
      HoneypotResponseSchema,
    );
  },
  async get_forensics(args, deps) {
    const addr = validateAddress(args.address);
    if (!addr) return { ok: false, error: 'invalid_address' };
    const pair = typeof args.pair === 'string' && ADDRESS_REGEX.test(args.pair) ? args.pair : null;
    const path = `/api/v1/x402/base/token/${addr}/forensics${pair ? `?pair=${pair}` : ''}`;
    return runPaid(deps, 'get_forensics', path, ForensicsResponseSchema);
  },
  async get_report(args, deps) {
    const addr = validateAddress(args.address);
    if (!addr) return { ok: false, error: 'invalid_address' };
    const pair = typeof args.pair === 'string' && ADDRESS_REGEX.test(args.pair) ? args.pair : null;
    const path = `/api/v1/x402/base/token/${addr}/report${pair ? `?pair=${pair}` : ''}`;
    return runPaid(deps, 'get_report', path, ReportResponseSchema);
  },
};
