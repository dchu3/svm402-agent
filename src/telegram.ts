import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import type { Agent, ToolCallEvent, ToolEndEvent } from './agent.js';
import { debug } from './util/log.js';

export interface TelegramBotDeps {
  agent: Agent;
  token: string;
  allowedUserId: number;
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
      '🔹 /clear - Reset chat history\n' +
      '🔹 /help - Show help message'
    );
  });

  bot.command('clear', async (ctx) => {
    deps.agent.reset();
    await ctx.reply('🧹 Chat history cleared.');
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(
      '📖 HOW TO USE:\n' +
      'Just send a 0x-prefixed token address (Base mainnet only) and I will perform a security audit.\n\n' +
      'Example:\n' +
      '0x4200000000000000000000000000000000000006'
    );
  });

  bot.on(message('text'), async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;

    let statusMessagePromise: Promise<number> | undefined;

    const onToolStart = async (ev: ToolCallEvent) => {
      statusMessagePromise = ctx.reply(`🔍 Analyzing with ${ev.name}...\n⚡ Signing & settling payment on Base...`).then((m) => m.message_id);
    };

    const onToolEnd = async (ev: ToolEndEvent) => {
      if (statusMessagePromise) {
        const messageId = await statusMessagePromise;
        let text = ev.result.ok ? `✅ ${ev.name} completed.` : `❌ ${ev.name} failed.`;
        if (ev.result.ok && ev.receipt) {
          text += `\n💸 Paid $${ev.priceUsd.toFixed(2)} USDC`;
          if (ev.receipt.transaction) {
            const shortHash = `${ev.receipt.transaction.slice(0, 6)}...${ev.receipt.transaction.slice(-4)}`;
            text += `\n⛓ Tx: ${shortHash}`;
          }
        }
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          messageId,
          undefined,
          text,
        );
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

  bot.launch();
  console.log('Telegram bot is running...');

  // Enable graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}
