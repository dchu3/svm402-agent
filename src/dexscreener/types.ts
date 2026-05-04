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

export interface TrendingBaseToken {
  chainId: 'base';
  tokenAddress: string;
  symbol?: string;
  name?: string;
  url?: string;
  icon?: string;
  header?: string;
  volumeH24: number;
  txnsH24: number;
  priceChangeH24?: number;
  pairCount: number;
  topPairAddress?: string;
}
