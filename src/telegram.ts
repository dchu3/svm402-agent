import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import type { Agent, ToolCallEvent, ToolEndEvent } from './agent.js';
import { debug } from './util/log.js';
import type { Wallet } from './wallet.js';
import type { OracleClient } from './oracle/client.js';
import type { SpendTracker } from './oracle/handlers.js';
import { formatAtomicUsdc, parseAtomicUsdc } from './util/usdc.js';
import type { WatchlistDb } from './watchlist/db.js';
import type { Scheduler } from './scheduler/index.js';
import type { TradingEngine } from './trading/engine.js';
import type { TradingStore } from './trading/store.js';
import { summarizeWatchlist, summarizeWatchlistMarkdown } from './notifications/index.js';

export interface TelegramBotDeps {
  agent: Agent;
  token: string;
  allowedUserId: number;
  wallet: Wallet;
  spend: SpendTracker;
  oracle: OracleClient;
  db?: WatchlistDb;
  getScheduler?: () => Scheduler | undefined;
  getTradingEngine?: () => TradingEngine | undefined;
  tradingStore?: TradingStore;
  registerNotifier?: (bot: Telegraf) => void;
}

export async function startTelegramBot(deps: TelegramBotDeps): Promise<{ stop: () => void }> {
  const bot = new Telegraf(deps.token);

  // Global error handler — without this, any uncaught error inside a command
  // handler (e.g. a Telegram API 400 from a bad parse_mode entity) escapes
  // through Telegraf's middleware as an unhandled rejection and crashes the
  // entire process, killing both the REPL and the bot.
  bot.catch((err, ctx) => {
    const msg = err instanceof Error ? err.message : String(err);
    debug('telegram', `handler error in update ${ctx.update?.update_id}: ${msg}`);
    // Best-effort plain-text apology; ignore any secondary failure.
    if (ctx.chat) {
      ctx.reply(`⚠️ Internal error handling that command: ${msg.slice(0, 200)}`).catch(() => undefined);
    }
  });

  // Authorization Middleware
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId !== deps.allowedUserId) {
      debug('telegram', `Unauthorized access attempt from user ID: ${userId}`);
      if (ctx.chat?.type === 'private') {
        await ctx.reply('Unauthorized. This bot is private.');
      }
      return;
    }
    return await next();
  });

  bot.start(async (ctx) => {
    await ctx.reply(
      '🤖 Welcome to svm402 Telegram Bot!\n\n' +
      'I am an AI agent that analyzes ERC-20 tokens on Base mainnet for security risks. 🛡️\n\n' +
      '📍 Send me a 0x-prefixed token address to get started.\n\n' +
      '💡 COMMANDS:\n' +
      '🔹 /balance - Show wallet balance\n' +
      '🔹 /spend - Show session spend\n' +
      '🔹 /receipts - Show payment receipts\n' +
      '🔹 /watchlist - Show curated watchlist\n' +
      '🔹 /scan - Run a watchlist scan now\n' +
      '🔹 /scheduler - on | off | status\n' +
      '🔹 /clear - Reset chat history\n' +
      '🔹 /help - Show help message',
    );
  });

  bot.command('clear', async (ctx) => {
    deps.agent.reset();
    await ctx.reply('🧹 Chat history cleared.');
  });

  bot.command('watchlist', async (ctx) => {
    if (!deps.db) {
      await ctx.reply('Watchlist not enabled.');
      return;
    }
    const entries = deps.db.list();
    try {
      await ctx.reply(`📋 *Watchlist*\n\n${summarizeWatchlistMarkdown(entries)}`, {
        parse_mode: 'MarkdownV2',
      });
    } catch (err) {
      debug('telegram-watchlist-markdown', err);
      try {
        await ctx.reply(`📋 Watchlist\n\n${summarizeWatchlist(entries)}`);
      } catch (fallbackErr) {
        debug('telegram-watchlist-fallback', fallbackErr);
      }
    }
  });

  bot.command('scan', async (ctx) => {
    const sched = deps.getScheduler?.();
    if (!sched) {
      await ctx.reply('Scheduler not configured.');
      return;
    }
    if (sched.isScanning()) {
      await ctx.reply('⏳ Scan already in progress.');
      return;
    }
    await ctx.reply('🔍 Triggering watchlist scan…');
    try {
      const res = await sched.triggerNow();
      if (res.error) {
        await ctx.reply(`❌ Scan failed: ${res.error}`);
      } else {
        const dur = typeof res.durationMs === 'number' ? ` in ${(res.durationMs / 1000).toFixed(1)}s` : '';
        await ctx.reply(
          `✅ Scan done: +${res.added}/-${res.removed} of ${res.candidates} candidate(s)${dur}.`,
        );
      }
    } catch (err) {
      await ctx.reply(`❌ ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  bot.command('scheduler', async (ctx) => {
    const sched = deps.getScheduler?.();
    if (!sched) {
      await ctx.reply('Scheduler not configured.');
      return;
    }
    const arg = ctx.message.text.split(/\s+/)[1];
    if (arg === 'on') {
      sched.setEnabled(true);
      await ctx.reply('▶️ Scheduler enabled.');
    } else if (arg === 'off') {
      sched.setEnabled(false);
      await ctx.reply('⏸ Scheduler disabled.');
    } else {
      await ctx.reply(
        `Scheduler ${sched.isRunning() ? 'running' : 'stopped'}${sched.isScanning() ? ' (scanning…)' : ''}`,
      );
    }
  });

  bot.command('balance', async (ctx) => {
    try {
      const { formatted } = await deps.wallet.usdcBalance();
      await ctx.reply(
        `💰 *Wallet Balance*\n\n` +
        `📍 *Address:* \`${deps.wallet.address}\`\n` +
        `⛓ *Network:* Base Mainnet\n` +
        `💵 *USDC:* \`${formatted}\``,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await ctx.reply(`❌ Balance lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  bot.command('spend', async (ctx) => {
    const total = deps.spend.total;
    const cap = deps.spend.cap;
    const remaining = Math.max(0, cap - total);
    const ratio = cap > 0 ? Math.min(1, Math.max(0, total / cap)) : 0;
    const pct = ratio * 100;

    const cells = 12;
    const filled = Math.round(ratio * cells);
    const bar = '▰'.repeat(filled) + '▱'.repeat(cells - filled);
    const indicator = ratio >= 0.85 ? '🔴' : ratio >= 0.6 ? '🟡' : '🟢';

    const lines = [
      '📊 *Session Spend*',
      '',
      `${indicator} \`${bar}\` ${pct.toFixed(1)}%`,
      '',
      `💸 *Used:*      \`$${total.toFixed(2)}\` USDC`,
      `🪙 *Remaining:* \`$${remaining.toFixed(2)}\` USDC`,
      `🛡 *Cap:*       \`$${cap.toFixed(2)}\` USDC`,
    ];
    if (ratio >= 1) {
      lines.push('', '⚠️ Cap reached — raise `MAX_SPEND_USDC` to make more calls.');
    }

    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
  });

  bot.command('receipts', async (ctx) => {
    const receipts = deps.oracle.receipts;
    if (receipts.length === 0) {
      await ctx.reply('🧾 No receipts yet in this session.');
      return;
    }

    let total = 0;
    const list = receipts.slice(-10).map((r) => {
      const amountNum = parseAtomicUsdc(r.amountAtomic);
      if (r.success && amountNum !== undefined) total += amountNum;
      const status = r.success ? '✅' : '❌';
      const display = amountNum !== undefined ? `$${amountNum.toFixed(2)}` : formatAtomicUsdc(r.amountAtomic);
      return `${status} \`${display}\` - ${r.endpoint}`;
    }).join('\n');

    await ctx.reply(
      `🧾 *Recent Receipts* (last 10)\n\n` +
      `${list}\n\n` +
      `💰 *Total Spent:* \`$${total.toFixed(2)}\` USDC`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.command('help', async (ctx) => {
    // Plain text (no parse_mode) — command names contain underscores
    // (/trade_on, /trade_off, /trade_status) which Telegram's legacy Markdown
    // parser interprets as italic delimiters and rejects when unbalanced.
    await ctx.reply(
      '📖 HOW TO USE:\n' +
      'Just send a 0x-prefixed token address (Base mainnet only) and I will perform a security audit.\n\n' +
      '💡 COMMANDS:\n' +
      '🔹 /balance - Wallet address + USDC balance\n' +
      '🔹 /spend - Session spend vs cap\n' +
      '🔹 /receipts - List settled payments\n' +
      '🔹 /watchlist - Show curated watchlist with scores\n' +
      '🔹 /scan - Run a watchlist scan on demand\n' +
      '🔹 /scheduler - on | off | (no arg for status)\n' +
      '🔹 /positions - Show open trading positions\n' +
      '🔹 /trades - Show recent trades\n' +
      '🔹 /trade_on | /trade_off - Toggle the trading engine\n' +
      '🔹 /trade_status - Show engine config\n' +
      '🔹 /sell <addr> - Manually close a position\n' +
      '🔹 /clear - Reset chat history\n' +
      '🔹 /help - Show this message',
    );
  });

  bot.command('positions', async (ctx) => {
    const store = deps.tradingStore;
    if (!store) return void await ctx.reply('Trading engine not configured.');
    const open = store.listOpen();
    if (open.length === 0) return void await ctx.reply('No open positions.');
    const lines = open.map((p) => {
      const tag = p.dryRun ? '[dry-run]' : '[live]';
      const held = ((Date.now() - p.openedAt) / 60000).toFixed(1);
      return `${tag} *${p.symbol ?? p.address.slice(0, 10)}* \`${p.address}\`\n  entry $${p.entryPriceUsd.toExponential(3)} · size $${p.entryAmountUsdc.toFixed(2)} · peak $${p.highestPriceUsd.toExponential(3)} · held ${held}m`;
    });
    await ctx.reply(lines.join('\n\n'), { parse_mode: 'Markdown' });
  });

  bot.command('trades', async (ctx) => {
    const store = deps.tradingStore;
    if (!store) return void await ctx.reply('Trading engine not configured.');
    const trades = store.listTrades(20);
    if (trades.length === 0) return void await ctx.reply('No trades recorded.');
    const lines = trades.map((t) => {
      const tag = t.dryRun ? '[dry-run]' : '[live]';
      const tx = t.txHash ? ` tx \`${t.txHash.slice(0, 10)}…\`` : '';
      const err = t.error ? ` ERROR: ${t.error}` : '';
      return `${tag} ${t.side.toUpperCase()} \`${t.positionAddress}\` @ $${t.priceUsd.toExponential(3)}${tx}${err}`;
    });
    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
  });

  bot.command('trade_on', async (ctx) => {
    const engine = deps.getTradingEngine?.();
    if (!engine) return void await ctx.reply('Trading engine not configured.');
    engine.setEnabled(true);
    await ctx.reply(`✅ Trading engine enabled (${engine.isLive() ? 'LIVE' : 'DRY-RUN'}).`);
  });

  bot.command('trade_off', async (ctx) => {
    const engine = deps.getTradingEngine?.();
    if (!engine) return void await ctx.reply('Trading engine not configured.');
    engine.setEnabled(false);
    await ctx.reply('🛑 Trading engine disabled.');
  });

  bot.command('trade_status', async (ctx) => {
    const engine = deps.getTradingEngine?.();
    if (!engine) return void await ctx.reply('Trading engine not configured.');
    const s = engine.status();
    await ctx.reply(
      `*Trading status*\n` +
      `state: ${s.enabled ? 'enabled' : 'disabled'} · ${s.live ? 'LIVE' : 'DRY-RUN'}\n` +
      `open: ${s.openPositions}/${s.maxOpenPositions} · size $${s.tradeSizeUsdc} · min score ${s.minScore}\n` +
      `dex: ${s.dex}\n` +
      `policy: TP ${s.policy.takeProfitPct}% / SL ${s.policy.stopLossPct}% / trail ${s.policy.trailingStopPct}% / hold ${(s.policy.maxHoldMs / 60000).toFixed(0)}m`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.command('sell', async (ctx) => {
    const engine = deps.getTradingEngine?.();
    if (!engine) return void await ctx.reply('Trading engine not configured.');
    const arg = ctx.message.text.split(/\s+/)[1]?.trim();
    if (!arg) return void await ctx.reply('Usage: /sell <0xAddress>');
    const res = await engine.manualSell(arg);
    if (res.closed) await ctx.reply(`✅ Sell triggered for \`${arg}\`.`, { parse_mode: 'Markdown' });
    else await ctx.reply(`❌ Sell failed: ${res.error ?? 'unknown_error'}`);
  });

  bot.on(message('text'), async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;

    let statusMessagePromise: Promise<number> | undefined;

    const onToolStart = async (ev: ToolCallEvent) => {
      const statusText = `🔍 Analyzing with ${ev.name}...\n⚡ Signing & settling payment on Base...`;
      statusMessagePromise = ctx.reply(statusText).then((m) => m.message_id);
    };

    const onToolEnd = async (ev: ToolEndEvent) => {
      if (statusMessagePromise) {
        const messageId = await statusMessagePromise;
        let text = ev.result.ok ? `✅ ${ev.name} completed.` : `❌ ${ev.name} failed.`;
        if (ev.result.ok) {
          const data = ev.result.data as
            | {
                top10_concentration_pct?: number | null;
                circulating_top10_concentration_pct?: number | null;
                holder_count?: number | null;
                flags?: string[] | null;
                contract?: {
                  verified?: boolean | null;
                  traits?: {
                    mintable?: boolean | null;
                    pausable?: boolean | null;
                    blacklist?: boolean | null;
                    fee_setter?: boolean | null;
                    proxy_upgradeable?: boolean | null;
                  } | null;
                } | null;
              }
            | undefined;
          if (data) {
            const raw = typeof data.top10_concentration_pct === 'number' ? data.top10_concentration_pct : null;
            const circ =
              typeof data.circulating_top10_concentration_pct === 'number'
                ? data.circulating_top10_concentration_pct
                : null;
            const headline = circ ?? raw;
            if (typeof headline === 'number') {
              const elevated = headline >= 30;
              const label = circ !== null ? 'Top-10 (circulating)' : 'Top-10';
              text += `\n📊 ${label}: ${headline.toFixed(1)}%${elevated ? ' (elevated)' : ''}`;
              if (circ !== null && raw !== null && Math.abs(raw - circ) >= 1) {
                text += ` (raw: ${raw.toFixed(1)}%)`;
              }
            }
            if (typeof data.holder_count === 'number') {
              text += `\n👥 Holders: ${data.holder_count.toLocaleString()}`;
            }
            if (Array.isArray(data.flags) && data.flags.length > 0) {
              text += `\n⚠ Flags: ${data.flags.join(', ')}`;
            }
            const contract = data.contract;
            if (contract) {
              const signals: string[] = [];
              if (contract.verified === false) signals.push('unverified');
              const t = contract.traits;
              if (t) {
                if (t.mintable === true) signals.push('mintable');
                if (t.pausable === true) signals.push('pausable');
                if (t.blacklist === true) signals.push('blacklist');
                if (t.fee_setter === true) signals.push('fee_setter');
                if (t.proxy_upgradeable === true) signals.push('proxy_upgradeable');
              }
              if (signals.length > 0) {
                text += `\n🧱 Contract: ${signals.join(', ')}`;
              }
            }
          }
          if (ev.receipt) {
            text += `\n💸 Paid $${ev.priceUsd.toFixed(2)} USDC`;
            if (ev.receipt.transaction) {
              const shortHash = `${ev.receipt.transaction.slice(0, 6)}...${ev.receipt.transaction.slice(-4)}`;
              text += `\n⛓ Tx: ${shortHash}`;
            }
          }
        }
        try {
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            messageId,
            undefined,
            text,
          );
        } catch (err) {
          debug('telegram-edit-error', err);
        }
      }
    };

    try {
      const reply = await deps.agent.send(text, {
        onToolStart: (ev) => { onToolStart(ev).catch(e => debug('telegram-hook', e)); },
        onToolEnd: (ev) => { onToolEnd(ev).catch(e => debug('telegram-hook', e)); }
      });
      await ctx.reply(reply);
    } catch (err) {
      debug('telegram-error', err);
      await ctx.reply(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  await bot.telegram.setMyCommands([
    { command: 'balance', description: 'Show wallet balance' },
    { command: 'spend', description: 'Show session spend' },
    { command: 'receipts', description: 'Show payment receipts' },
    { command: 'watchlist', description: 'Show curated watchlist' },
    { command: 'scan', description: 'Run a watchlist scan now' },
    { command: 'scheduler', description: 'on | off | status' },
    { command: 'positions', description: 'Show open trading positions' },
    { command: 'trades', description: 'Show recent trades' },
    { command: 'trade_on', description: 'Enable the trading engine' },
    { command: 'trade_off', description: 'Disable the trading engine' },
    { command: 'trade_status', description: 'Show trading engine status' },
    { command: 'sell', description: 'Manually close a position' },
    { command: 'clear', description: 'Reset chat history' },
    { command: 'help', description: 'Show help message' },
  ]);

  deps.registerNotifier?.(bot);

  void bot.launch();
  console.log('Telegram bot is running...');

  return {
    stop: (reason?: string) => {
      bot.stop(reason);
    }
  };
}
