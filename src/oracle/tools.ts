import { Type, type FunctionDeclaration } from '@google/genai';

export const TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: 'get_report',
    description:
      'Fetch a comprehensive token report for a Base mainnet ERC-20 token, including token metadata, deployer info, holder count, and top-10 concentration. Best single tool for "what do we know about this token?". Costs $0.01 USDC.',
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
