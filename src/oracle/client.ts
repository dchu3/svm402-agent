import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import type { SettleResponse } from '@x402/core/types';
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
  const payFetch = wrapFetchWithPayment(fetch, client);
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
          const settle: SettleResponse = decodePaymentResponseHeader(paymentRespHeader);
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
      if (!res.ok) {
        const snippet = text.slice(0, 500);
        throw new Error(`Oracle ${status} for ${path}: ${snippet}`);
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
