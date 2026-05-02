import { Type, type FunctionDeclaration } from '@google/genai';

export const TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: 'get_report',
    description:
      'Fetch a comprehensive token report for a Base mainnet ERC-20 token. Returns token metadata (name, symbol, decimals, total supply, market cap, verified status), deployer info, recent on-chain activity, holder count, raw and circulating top-10 holder concentration, a per-holder breakdown with category tags (burn, bridge, deployer, contract, eoa, unknown), an LP-lock heuristic when a pair is supplied, and a flags[] array of descriptive signals (e.g. high_concentration, deployer_holds_large, unverified_contract, lp_locked). Best single tool for "what do we know about this token?". Costs $0.01 USDC.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        address: {
          type: Type.STRING,
          description: 'Token contract address on Base mainnet (0x-prefixed 40 hex chars).',
        },
        pair: {
          type: Type.STRING,
          description: 'Optional liquidity pair address used to enrich forensics.',
        },
      },
      required: ['address'],
    },
  },
];
