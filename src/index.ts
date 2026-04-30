import process from 'node:process';
import { createWallet } from './wallet.js';
import { createOracleClient } from './oracle/client.js';
import { createSpendTracker } from './oracle/handlers.js';
import { createAgent } from './agent.js';
import { startRepl } from './repl.js';
import { startTelegramBot } from './telegram.js';
import { renderBanner } from './ui/banner.js';
import { printError } from './ui/render.js';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v === '0x' || v.trim().length === 0) {
    printError(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

async function main(): Promise<void> {
  const oracleUrl = process.env.ORACLE_URL ?? 'https://svm402.com';
  const privateKey = requireEnv('PRIVATE_KEY');
  const geminiApiKey = requireEnv('GEMINI_API_KEY');
  const model = process.env.GEMINI_MODEL ?? 'gemini-3.1-flash-lite-preview';
  const cap = Number(process.env.MAX_SPEND_USDC ?? '0.10');
  if (!Number.isFinite(cap) || cap <= 0) {
    printError('MAX_SPEND_USDC must be a positive number.');
    process.exit(1);
  }

  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  const telegramAllowedUser = process.env.TELEGRAM_ALLOWED_USER_ID;

  const wallet = createWallet(privateKey);
  const oracle = createOracleClient({ baseUrl: oracleUrl, wallet });
  const spend = createSpendTracker(cap);
  const agent = createAgent({ apiKey: geminiApiKey, model, oracle, spend });

  let usdcBalance: string | null = null;
  let balanceError: string | undefined;
  try {
    const { formatted } = await wallet.usdcBalance();
    usdcBalance = formatted;
  } catch (err) {
    balanceError = err instanceof Error ? err.message : String(err);
  }

  console.log(
    renderBanner({
      oracleUrl,
      walletAddress: wallet.address,
      model,
      spendCap: cap,
      usdcBalance,
      balanceError,
    }),
  );

  if (telegramToken && telegramAllowedUser) {
    const allowedUserId = Number(telegramAllowedUser);
    if (isNaN(allowedUserId)) {
      printError('TELEGRAM_ALLOWED_USER_ID must be a number.');
      process.exit(1);
    }
    await startTelegramBot({
      agent,
      token: telegramToken,
      allowedUserId,
      oracle,
      wallet,
      spend,
    });
  } else {
    await startRepl({ agent, oracle, wallet, spend });
  }
}

main().catch((err) => {
  printError('fatal', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
