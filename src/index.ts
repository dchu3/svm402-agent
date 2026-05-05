import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWallet } from './wallet.js';
import { createOracleClient } from './oracle/client.js';
import { createSpendTracker } from './oracle/handlers.js';
import { createAgent } from './agent.js';
import { startRepl } from './repl.js';
import { startTelegramBot } from './telegram.js';
import { renderBanner } from './ui/banner.js';
import { printError, printInfo, printWarn } from './ui/render.js';
import { createDexscreenerMcpClient } from './dexscreener/mcp-client.js';
import { openWatchlistDb } from './watchlist/db.js';
import { createCliNotifier } from './notifications/cli.js';
import { compositeNotifier, type Notifier } from './notifications/index.js';
import { createScheduler, type Scheduler } from './scheduler/index.js';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v === '0x' || v.trim().length === 0) {
    printError(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

function envFlag(name: string, defaultValue: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return defaultValue;
  return v === '1' || v.toLowerCase() === 'true';
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

  const here = path.dirname(fileURLToPath(import.meta.url));
  const defaultMcpPath = path.resolve(here, '../../dex-screener-mcp/dist/index.js');
  const mcpServerPath = process.env.DEXSCREENER_MCP_PATH ?? defaultMcpPath;
  const dexscreener = createDexscreenerMcpClient({ serverPath: mcpServerPath });

  const dbPath = (process.env.WATCHLIST_DB_PATH ?? '').trim() || path.resolve('./data/watchlist.db');
  const db = openWatchlistDb(dbPath);

  const schedulerEnabled = envFlag('SCHEDULER_ENABLED', true);
  const intervalMinutes = Number((process.env.SCHEDULER_INTERVAL_MINUTES ?? '').trim() || '60');
  const maxWatchlistSize = Number((process.env.WATCHLIST_MAX_SIZE ?? '').trim() || '10');

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

  const cliNotifier = createCliNotifier();
  const notifiers: Notifier[] = [cliNotifier];

  const schedulerRef: { current: Scheduler | undefined } = { current: undefined };
  let allowedUserId: number | undefined;
  let botHandle: { stop: () => void } | undefined;

  if (telegramToken && telegramAllowedUser) {
    const parsed = Number(telegramAllowedUser);
    if (isNaN(parsed)) {
      printError('TELEGRAM_ALLOWED_USER_ID must be a number.');
      process.exit(1);
    }
    allowedUserId = parsed;
  }

  if (allowedUserId !== undefined && telegramToken) {
    const { createTelegramNotifier } = await import('./notifications/telegram.js');
    const userId = allowedUserId;
    botHandle = await startTelegramBot({
      agent,
      token: telegramToken,
      allowedUserId: userId,
      oracle,
      wallet,
      spend,
      registerNotifier: (bot) => {
        notifiers.push(createTelegramNotifier(bot, userId));
      },
      getScheduler: () => schedulerRef.current,
      db,
    });
  }

  const notifier = compositeNotifier(notifiers);
  const scheduler = createScheduler({
    dexscreener,
    oracle,
    spend,
    agent,
    db,
    notifier,
    intervalMs: Math.max(1, intervalMinutes) * 60_000,
    maxWatchlistSize: Math.max(1, Math.min(50, maxWatchlistSize)),
    enabled: schedulerEnabled,
  });
  schedulerRef.current = scheduler;
  if (schedulerEnabled) {
    try {
      await dexscreener.connect();
      scheduler.start();
      printInfo(`Scheduler enabled — scanning Base every ${intervalMinutes} min (watchlist max ${maxWatchlistSize}).`);
    } catch (err) {
      printWarn(
        `Scheduler disabled: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    printInfo('Scheduler disabled (SCHEDULER_ENABLED=0). Use /scheduler on to start.');
  }

  const shutdown = async (): Promise<void> => {
    scheduler.stop();
    if (botHandle) {
      try {
        botHandle.stop();
      } catch {
        /* ignore */
      }
    }
    try {
      await dexscreener.close();
    } catch {
      /* ignore */
    }
    try {
      db.close();
    } catch {
      /* ignore */
    }
  };
  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });

  await startRepl({ agent, oracle, wallet, spend, db, getScheduler: () => scheduler });
  await shutdown();
}

main().catch((err) => {
  printError('fatal', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
