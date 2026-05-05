import {
  createPublicClient,
  http,
  formatUnits,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const USDC_BASE_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;
const USDC_DECIMALS = 6;

const ERC20_BALANCE_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

export interface Wallet {
  readonly address: `0x${string}`;
  readonly account: PrivateKeyAccount;
  readonly publicClient: PublicClient;
  usdcBalance(): Promise<{ raw: bigint; formatted: string }>;
}

export function createWallet(privateKey: string, rpcUrl?: string): Wallet {
  if (!privateKey) {
    throw new Error('PRIVATE_KEY is required.');
  }
  
  // Normalize: add 0x prefix if missing
  const normalized = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error('PRIVATE_KEY must be a 64-character hex string (32 bytes), optionally prefixed with 0x.');
  }
  const account = privateKeyToAccount(normalized as `0x${string}`);

  const publicClient = createPublicClient({
    chain: base,
    // viem's http transport retries automatically on 429/5xx when retryCount > 0.
    // The default public Base RPC (mainnet.base.org) is aggressively rate-limited;
    // operators should set BASE_RPC_URL to a dedicated provider for live use.
    transport: http(rpcUrl, { retryCount: 3, retryDelay: 250 }),
  });

  return {
    address: account.address,
    account,
    publicClient: publicClient as unknown as PublicClient,
    async usdcBalance() {
      const raw = (await publicClient.readContract({
        address: USDC_BASE_ADDRESS,
        abi: ERC20_BALANCE_ABI,
        functionName: 'balanceOf',
        args: [account.address],
      })) as bigint;
      return { raw, formatted: formatUnits(raw, USDC_DECIMALS) };
    },
  };
}

export const USDC = {
  address: USDC_BASE_ADDRESS,
  decimals: USDC_DECIMALS,
};
