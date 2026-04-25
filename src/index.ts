import process from 'node:process';
import { createWallet } from './wallet.js';
import { createOracleClient } from './oracle/client.js';
import { createSpendTracker } from './oracle/handlers.js';
import { createAgent } from './agent.js';
import { startRepl } from './repl.js';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v === '0x' || v.trim().length === 0) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

async function main(): Promise<void> {
  const oracleUrl = process.env.ORACLE_URL ?? 'https://svm402.com';
  const privateKey = requireEnv('PRIVATE_KEY');
  const geminiApiKey = requireEnv('GEMINI_API_KEY');
  const model = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
  const cap = Number(process.env.MAX_SPEND_USDC ?? '0.10');
  if (!Number.isFinite(cap) || cap <= 0) {
    console.error('MAX_SPEND_USDC must be a positive number.');
    process.exit(1);
  }

  const wallet = createWallet(privateKey);
  const oracle = createOracleClient({ baseUrl: oracleUrl, wallet });
  const spend = createSpendTracker(cap);
  const agent = createAgent({ apiKey: geminiApiKey, model, oracle, spend });

  console.log('======================================================================');
  console.log(' svm402-agent — Gemini × x402 client for base-token-oracle');
  console.log(' WARNING: this client signs REAL USDC payments on Base mainnet (8453).');
  console.log('----------------------------------------------------------------------');
  console.log(` oracle:    ${oracleUrl}`);
  console.log(` wallet:    ${wallet.address}`);
  console.log(` model:     ${model}`);
  console.log(` spend cap: $${cap.toFixed(3)} USDC per session`);
  console.log('======================================================================');

  try {
    const { formatted } = await wallet.usdcBalance();
    console.log(` USDC bal:  ${formatted}`);
    if (Number(formatted) < 0.05) {
      console.log(
        ' (warning) USDC balance is very low — paid calls will 402 then fail to settle.',
      );
    }
  } catch (err) {
    console.log(` USDC bal:  <lookup failed: ${err instanceof Error ? err.message : err}>`);
  }
  console.log('======================================================================');

  await startRepl({ agent, oracle, wallet, spend });
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
