export interface BoostedToken {
  url?: string;
  chainId: string;
  tokenAddress: string;
  amount?: number;
  totalAmount?: number;
  icon?: string;
  header?: string;
  description?: string;
  links?: Array<{ type?: string; label?: string; url: string }>;
}
