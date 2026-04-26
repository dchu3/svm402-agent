import { Type, type FunctionDeclaration } from '@google/genai';

export const TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: 'get_report',
    description:
      'Fetch a comprehensive Token report for a Base mainnet ERC-20 token (including optional risk score and flags). Best single tool for "is this token safe?". Costs $0.01 USDC.',
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
