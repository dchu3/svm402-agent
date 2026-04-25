import { Type, type FunctionDeclaration } from '@google/genai';

export const TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: 'get_market',
    description:
      'Fetch DexScreener-derived market summary for a Base mainnet ERC-20 token: price USD, 24h change %, FDV, market cap, 24h volume, liquidity USD, top pool, and pool count. Costs $0.005 USDC.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        address: {
          type: Type.STRING,
          description: 'Token contract address on Base mainnet (0x-prefixed 40 hex chars).',
        },
      },
      required: ['address'],
    },
  },
  {
    name: 'get_honeypot',
    description:
      'Run a Honeypot.is simulation for a Base mainnet token. Returns is_honeypot, buy/sell/transfer tax, simulation_success, honeypot_reason, and risk flags. Costs $0.01 USDC.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        address: {
          type: Type.STRING,
          description: 'Token contract address on Base mainnet (0x-prefixed 40 hex chars).',
        },
      },
      required: ['address'],
    },
  },
  {
    name: 'get_forensics',
    description:
      'Blockscout-based on-chain forensics for a Base mainnet token: deployer, verified status, holder count, top-10 holder concentration %, deployer holdings %, and an LP-lock heuristic when a pair is supplied. Costs $0.02 USDC.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        address: {
          type: Type.STRING,
          description: 'Token contract address on Base mainnet (0x-prefixed 40 hex chars).',
        },
        pair: {
          type: Type.STRING,
          description:
            'Optional liquidity pair address (0x-prefixed). When supplied, enables the LP-lock heuristic.',
        },
      },
      required: ['address'],
    },
  },
  {
    name: 'get_report',
    description:
      'Composite due-diligence report fanning out to market + honeypot + forensics, plus a deterministic risk score (0–10), risk level (clean/caution/risky/critical), and risk flags. Best single tool for "is this token safe?". Costs $0.03 USDC.',
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
