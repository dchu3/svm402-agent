import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWallet } from './wallet.js';
import { createOracleClient } from './oracle/client.js';
import { createSpendTracker } from './oracle/handlers.js';
import { createAgentWithProvider } from './agent.js';
import type { LlmProviderName } from './llm/index.js';
import { startRepl } from './repl.js';
import { startTelegramBot } from './telegram.js';
import { renderBanner } from './ui/banner.js';
import { printError, printInfo, printWarn } from './ui/render.js';
import { createDexscreenerMcpClient } from './dexscreener/mcp-client.js';
import { openWatchlistDb } from './watchlist/db.js';
import { createCliNotifier } from './notifications/cli.js';
import { compositeNotifier, type Notifier } from './notifications/index.js';
import { createScheduler, type Scheduler } from './scheduler/index.js';
import { openTradingDb } from './trading/db.js';
import { createTradingStore } from './trading/store.js';
import { createUniswapV3Adapter } from './trading/dex/uniswapV3.js';
import { createDexRegistry } from './trading/dex/index.js';
import { createTradingEngine, type TradingEngine } from './trading/engine.js';
import type { TradingConfig } from './trading/types.js';

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

function envNumber(name: string, defaultValue: number): number {
  const raw = (process.env[name] ?? '').trim();
  if (raw === '') return defaultValue;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    printWarn(`Ignoring invalid ${name}=${raw}; using default ${defaultValue}.`);
    return defaultValue;
  }
  return n;
}

function buildTradingConfig(): TradingConfig {
  const slippageBpsRaw = envNumber('TRADING_SLIPPAGE_BPS', 100);
  const slippageBps = Math.max(1, Math.min(500, Math.round(slippageBpsRaw)));
  return {
    enabled: envFlag('TRADING_ENABLED', false),
    live: envFlag('TRADING_LIVE', false),
    minScore: envNumber('TRADING_MIN_SCORE', 80),
    tradeSizeUsdc: envNumber('TRADE_SIZE_USDC', 5),
    maxOpenPositions: Math.max(1, Math.min(50, Math.floor(envNumber('MAX_OPEN_POSITIONS', 3)))),
    slippageBps,
    monitorIntervalMs: Math.max(10, Math.floor(envNumber('TRADING_MONITOR_INTERVAL_SEC', 60))) * 1000,
    dexName: (process.env.TRADING_DEX ?? 'uniswap-v3').toLowerCase(),
    policy: {
      takeProfitPct: envNumber('TP_PCT', 50),
      stopLossPct: envNumber('SL_PCT', 20),
      trailingStopPct: envNumber('TRAILING_STOP_PCT', 15),
      maxHoldMs: Math.max(0, Math.floor(envNumber('MAX_HOLD_MINUTES', 1440))) * 60_000,
    },
  };
}

async function main(): Promise<void> {
  const oracleUrl = process.env.ORACLE_URL ?? 'https://svm402.com';
  const privateKey = requireEnv('PRIVATE_KEY');

  const providerRaw = (process.env.LLM_PROVIDER ?? 'gemini').toLowerCase().trim();
  if (providerRaw !== 'gemini' && providerRaw !== 'ollama') {
    printError(`Unsupported LLM_PROVIDER="${providerRaw}". Use "gemini" or "ollama".`);
    process.exit(1);
  }
  const provider = providerRaw as LlmProviderName;

  const geminiApiKey = provider === 'gemini' ? requireEnv('GEMINI_API_KEY') : undefined;
  const ollamaHost =
    provider === 'ollama'
      ? (process.env.OLLAMA_HOST ?? 'http://localhost:11434').trim() || 'http://localhost:11434'
      : undefined;

  const explicitModel = (process.env.LLM_MODEL ?? '').trim();
  const model =
    explicitModel ||
    (provider === 'gemini'
      ? (process.env.GEMINI_MODEL ?? 'gemini-3.1-flash-lite-preview')
      : (process.env.OLLAMA_MODEL ?? 'llama3.2:3b'));
  const cap = Number(process.env.MAX_SPEND_USDC ?? '0.10');
  if (!Number.isFinite(cap) || cap <= 0) {
    printError('MAX_SPEND_USDC must be a positive number.');
    process.exit(1);
  }

  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  const telegramAllowedUser = process.env.TELEGRAM_ALLOWED_USER_ID;

  const baseRpcUrl = (process.env.BASE_RPC_URL ?? '').trim() || undefined;

  const wallet = createWallet(privateKey, baseRpcUrl);
  const oracle = createOracleClient({ baseUrl: oracleUrl, wallet });
  const spend = createSpendTracker(cap);
  const agent = createAgentWithProvider({
    provider,
    model,
    geminiApiKey,
    ollamaHost,
    oracle,
    spend,
  });

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
      provider: agent.providerName,
      model,
      ollamaHost,
      spendCap: cap,
      usdcBalance,
      balanceError,
    }),
  );

  const cliNotifier = createCliNotifier();
  const notifiers: Notifier[] = [cliNotifier];

  // Trading engine wiring (dry-run by default; only goes live when
  // TRADING_LIVE=1 in the environment).
  const tradingConfig = buildTradingConfig();
  const tradingDbPath =
    (process.env.TRADING_DB_PATH ?? '').trim() || path.resolve('./data/trading.db');
  const tradingDb = openTradingDb(tradingDbPath);
  const tradingStore = createTradingStore(tradingDb.db);
  const dexRegistry = createDexRegistry();
  dexRegistry.register(
    'uniswap-v3',
    createUniswapV3Adapter({ wallet, publicClient: wallet.publicClient, rpcUrl: baseRpcUrl }),
  );
  const tradingAdapter = dexRegistry.get(tradingConfig.dexName);
  let tradingEngine: TradingEngine | undefined;
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
      getTradingEngine: () => tradingEngine,
      tradingStore,
    });
  }

  const notifier = compositeNotifier(notifiers);

  if (tradingAdapter) {
    tradingEngine = createTradingEngine({
      config: tradingConfig,
      wallet,
      adapter: tradingAdapter,
      store: tradingStore,
      db: tradingDb.db,
      notifier,
    });
    // Subscribe to watchlist add/replace events; the engine decides whether
    // to act based on score threshold and current open-position count.
    notifiers.push({
      async notify(event) {
        if (!tradingEngine) return;
        if (event.type === 'watchlist:add') {
          await tradingEngine.onWatchlistAdd({
            address: event.address,
            symbol: event.symbol,
            name: event.name,
            score: event.score,
          });
        } else if (event.type === 'watchlist:replace') {
          await tradingEngine.onWatchlistAdd({
            address: event.added.address,
            symbol: event.added.symbol,
            name: null,
            score: event.added.score,
          });
        }
      },
    });
    if (tradingConfig.enabled) {
      tradingEngine.start();
      printInfo(
        `Trading engine enabled (${tradingConfig.live ? 'LIVE' : 'DRY-RUN'}) on ${tradingAdapter.name} — min score ${tradingConfig.minScore}, size $${tradingConfig.tradeSizeUsdc}, max ${tradingConfig.maxOpenPositions} open.`,
      );
    } else {
      printInfo('Trading engine disabled (TRADING_ENABLED=0). Use /trade-on to start.');
    }
  } else {
    printWarn(`Unknown TRADING_DEX="${tradingConfig.dexName}"; trading engine will not run.`);
  }

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
    if (tradingEngine) {
      try {
        tradingEngine.stop();
      } catch {
        /* ignore */
      }
    }
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
    try {
      tradingDb.close();
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

  await startRepl({
    agent,
    oracle,
    wallet,
    spend,
    db,
    getScheduler: () => scheduler,
    getTradingEngine: () => tradingEngine,
    tradingStore,
  });
  await shutdown();
}

main().catch((err) => {
  printError('fatal', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
