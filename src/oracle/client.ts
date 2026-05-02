import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import type { Wallet } from '../wallet.js';
import { debug } from '../util/log.js';

export interface PaymentReceipt {
  endpoint: string;
  success: boolean;
  transaction: string;
  network: string;
  payer?: string;
  amountAtomic?: string;
  errorReason?: string;
}

export interface OracleClient {
  readonly baseUrl: string;
  readonly walletAddress: `0x${string}`;
  readonly receipts: PaymentReceipt[];
  get<T = unknown>(path: string): Promise<{ status: number; data: T; receipt?: PaymentReceipt }>;
}

export interface OracleClientOptions {
  baseUrl: string;
  wallet: Wallet;
}

function diffShallow(a: unknown, b: unknown): Array<{ key: string; a: unknown; b: unknown }> {
  const out: Array<{ key: string; a: unknown; b: unknown }> = [];
  const ao = (a && typeof a === 'object' ? (a as Record<string, unknown>) : undefined);
  const bo = (b && typeof b === 'object' ? (b as Record<string, unknown>) : undefined);
  const keys = new Set<string>([
    ...(ao ? Object.keys(ao) : []),
    ...(bo ? Object.keys(bo) : []),
  ]);
  for (const k of keys) {
    const av = ao?.[k];
    const bv = bo?.[k];
    if (JSON.stringify(av) !== JSON.stringify(bv)) out.push({ key: k, a: av, b: bv });
  }
  return out;
}

type PaymentRequiredArg = {
  x402Version?: number;
  accepts?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

type PaymentPayloadShape = {
  x402Version: number;
  payload: unknown;
  accepted?: Record<string, unknown>;
  [key: string]: unknown;
};

// Coinbase CDP facilitator only accepts a small set of legacy network names at
// the *root* of the payment payload, even though @x402/core v2 uses CAIP-2
// identifiers internally. Map CAIP-2 → CDP-legacy for the root field; leave the
// `accepted` block unchanged so non-CDP servers that compare via deepEqual
// still match.
const CDP_NETWORK_NAMES: Record<string, string> = {
  'eip155:8453': 'base',
  'eip155:84532': 'base-sepolia',
  'eip155:137': 'polygon',
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'solana',
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': 'solana-devnet',
};

export function createOracleClient({ baseUrl, wallet }: OracleClientOptions): OracleClient {
  const trimmedBase = baseUrl.replace(/\/+$/, '');
  const client = new x402Client().register(
    'eip155:8453',
    new ExactEvmScheme({
      address: wallet.address,
      signTypedData: async (msg) =>
        wallet.account.signTypedData({
          domain: msg.domain as Record<string, unknown>,
          types: msg.types as Record<string, Array<{ name: string; type: string }>>,
          primaryType: msg.primaryType,
          message: msg.message,
        } as Parameters<typeof wallet.account.signTypedData>[0]),
    }),
  );

  // The Coinbase CDP facilitator (used by svm402.com and any oracle that
  // forwards verification/settlement to https://api.cdp.coinbase.com/) requires
  // `scheme` and `network` at the *root* of the payment payload, even for
  // x402 v2. The @x402/core v2 SDK only places those inside `accepted`, which
  // causes CDP to respond with HTTP 400:
  //   "'paymentPayload' is invalid: must match one of
  //    [x402V2PaymentPayload, x402V1PaymentPayload]. schema requires 'scheme'"
  //
  // We additively mirror `scheme` and `network` (and the rest of the accepted
  // requirement fields) at the root while keeping the nested `accepted` object
  // intact, so both CDP and any strict @x402/core-based server (which uses
  // deepEqual on `accepted`) accept the payload.
  const originalCreate = client.createPaymentPayload.bind(client);
  client.createPaymentPayload = (async (paymentRequired) => {
    const raw = await originalCreate(paymentRequired);
    const payload = raw as unknown as PaymentPayloadShape;
    if (payload && payload.x402Version === 2 && payload.accepted && typeof payload.accepted === 'object') {
      const merged: Record<string, unknown> = { ...payload.accepted, ...payload };
      const acceptedNetwork = payload.accepted.network;
      if (typeof acceptedNetwork === 'string' && CDP_NETWORK_NAMES[acceptedNetwork]) {
        merged.network = CDP_NETWORK_NAMES[acceptedNetwork];
      }
      if (process.env.DEBUG === '1' || process.env.DEBUG === 'true') {
        try {
          const pr = paymentRequired as unknown as PaymentRequiredArg;
          debug('paymentRequired.x402Version:', pr?.x402Version);
          debug('paymentRequired.accepts:', JSON.stringify(pr?.accepts, null, 2));
          debug('paymentPayload (sent):', JSON.stringify(merged, null, 2));
          const accepts = Array.isArray(pr?.accepts) ? pr.accepts : [];
          accepts.forEach((req, idx) => {
            const diff = diffShallow(req, payload.accepted);
            debug(`accepts[${idx}] vs payload.accepted diff:`, diff.length ? JSON.stringify(diff, null, 2) : '<no diff>');
          });
        } catch (err) {
          debug('diagnostics failed:', err);
        }
      }
      return merged as unknown as Awaited<ReturnType<typeof originalCreate>>;
    }
    return raw;
  }) as typeof client.createPaymentPayload;

  const disableX402 = process.env.DISABLE_X402 === '1' || process.env.DISABLE_X402 === 'true';
  const payFetch = disableX402 ? fetch : wrapFetchWithPayment(fetch, client);
  const receipts: PaymentReceipt[] = [];

  return {
    baseUrl: trimmedBase,
    walletAddress: wallet.address,
    receipts,
    async get<T = unknown>(path: string) {
      const url = `${trimmedBase}${path.startsWith('/') ? path : `/${path}`}`;
      debug('GET', url);
      const res = await payFetch(url, { method: 'GET' });
      const status = res.status;
      const paymentRespHeader = res.headers.get('payment-response') || res.headers.get('x-payment-response');
      let receipt: PaymentReceipt | undefined;
      if (paymentRespHeader) {
        try {
          const settle = decodePaymentResponseHeader(paymentRespHeader) as any;
          receipt = {
            endpoint: path,
            success: settle.success,
            transaction: settle.transaction,
            network: settle.network,
            payer: settle.payer,
            amountAtomic: settle.amount,
            errorReason: settle.errorReason,
          };
          receipts.push(receipt);
          debug(
            `[receipt] ${path} ${receipt.success ? '✓ settled' : '✗ failed'} tx=${receipt.transaction} (${receipt.network})${receipt.amountAtomic ? ` amount=${receipt.amountAtomic}` : ''}`,
          );
        } catch (err) {
          debug('failed to decode X-PAYMENT-RESPONSE', err);
        }
      }
      const text = await res.text();
      debug('Response text:', text);
      if (!res.ok) {
        if (status === 402) {
          const reqHeader = res.headers.get('payment-required') || res.headers.get('x-payment-required');
          if (reqHeader) {
            try {
              const decoded = JSON.parse(Buffer.from(reqHeader, 'base64').toString());
              debug('Payment required error:', decoded.error);
            } catch {
              /* ignore */
            }
          }
        }
        const snippet = text.slice(0, 500);
        throw new Error(`Oracle ${status} for ${path}: ${snippet}`);
      }
      if (text.trim() === '') {
        throw new Error(`Oracle returned an empty response for ${path}`);
      }
      let data: T;
      try {
        data = JSON.parse(text) as T;
      } catch {
        throw new Error(`Oracle returned non-JSON body for ${path}: ${text.slice(0, 200)}`);
      }
      return { status, data, ...(receipt ? { receipt } : {}) };
    },
  };
}
