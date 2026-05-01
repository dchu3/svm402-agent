import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import type { Agent, ToolCallEvent, ToolEndEvent } from './agent.js';
import { debug } from './util/log.js';
import type { Wallet } from './wallet.js';
import type { OracleClient } from './oracle/client.js';
import type { SpendTracker } from './oracle/handlers.js';

export interface TelegramBotDeps {
  agent: Agent;
  token: string;
  allowedUserId: number;
  wallet: Wallet;
  spend: SpendTracker;
  oracle: OracleClient;
}

export async function startTelegramBot(deps: TelegramBotDeps): Promise<void> {
  const bot = new Telegraf(deps.token);

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
      '🔹 /clear - Reset chat history\n' +
      '🔹 /help - Show help message',
      { parse_mode: 'Markdown' }
    );
  });

  bot.command('clear', async (ctx) => {
    deps.agent.reset();
    await ctx.reply('🧹 Chat history cleared.');
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
    const ratio = cap > 0 ? (total / cap) * 100 : 0;
    await ctx.reply(
      `📊 *Session Spend*\n\n` +
      `💸 *Used:* \`$${total.toFixed(4)}\` USDC\n` +
      `🛡 *Cap:* \`$${cap.toFixed(3)}\` USDC\n` +
      `📈 *Progress:* \`${ratio.toFixed(1)}%\``,
      { parse_mode: 'Markdown' }
    );
  });

  bot.command('receipts', async (ctx) => {
    const receipts = deps.oracle.receipts;
    if (receipts.length === 0) {
      await ctx.reply('🧾 No receipts yet in this session.');
      return;
    }

    let total = 0;
    const USDC_DECIMALS = 1_000_000;
    const list = receipts.slice(-10).map((r, i) => {
      const amount = Number(r.amountAtomic) / USDC_DECIMALS;
      if (r.success) total += amount;
      const status = r.success ? '✅' : '❌';
      return `${status} \`$${amount.toFixed(4)}\` - ${r.endpoint}`;
    }).join('\n');

    await ctx.reply(
      `🧾 *Recent Receipts* (last 10)\n\n` +
      `${list}\n\n` +
      `💰 *Total Spent:* \`$${total.toFixed(4)}\` USDC`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(
      '📖 *HOW TO USE:*\n' +
      'Just send a 0x-prefixed token address (Base mainnet only) and I will perform a security audit.\n\n' +
      '💡 *COMMANDS:*\n' +
      '🔹 /balance - Wallet address + USDC balance\n' +
      '🔹 /spend - Session spend vs cap\n' +
      '🔹 /receipts - List settled payments\n' +
      '🔹 /clear - Reset chat history\n' +
      '🔹 /help - Show this message',
      { parse_mode: 'Markdown' }
    );
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
                risk_score?: number;
                risk_level?: string;
                risk_confidence?: string;
                top10_concentration_pct?: number | null;
                holder_count?: number | null;
                flags?: string[];
              }
            | undefined;
          if (data) {
            if (typeof data.risk_score === 'number') {
              let line = `\n🛡 Risk: ${data.risk_score}/10`;
              if (data.risk_level) line += ` (${data.risk_level})`;
              if (data.risk_confidence) line += ` · confidence ${data.risk_confidence}`;
              text += line;
            }
            if (typeof data.top10_concentration_pct === 'number') {
              text += `\n📊 Top-10 holders: ${data.top10_concentration_pct.toFixed(1)}%`;
            }
            if (typeof data.holder_count === 'number') {
              text += `\n👥 Holders: ${data.holder_count.toLocaleString()}`;
            }
            if (Array.isArray(data.flags) && data.flags.length > 0) {
              const shown = data.flags.slice(0, 5);
              const more = data.flags.length - shown.length;
              text += `\n⚠ Flags: ${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`;
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
    { command: 'clear', description: 'Reset chat history' },
    { command: 'help', description: 'Show help message' },
  ]);

  bot.launch();
  console.log('Telegram bot is running...');

  // Enable graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}
