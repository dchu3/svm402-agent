import { Type, type FunctionDeclaration } from '@google/genai';

export const TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: 'get_report',
    description:
      'Composite due-diligence report fanning out to market + honeypot + forensics, plus a deterministic risk score (0–10), risk level (clean/caution/risky/critical), and risk flags. Best single tool for "is this token safe?". Costs $0.01 USDC.',
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
