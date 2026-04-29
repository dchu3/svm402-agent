import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import type { Agent } from './agent.js';
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
      'Welcome to svm402 Telegram Bot!\n\n' +
      'I can help you analyze ERC-20 tokens on Base mainnet.\n' +
      'Send me a token address to get started.\n\n' +
      'Commands:\n' +
      '/clear - Reset chat history\n' +
      '/help - Show help message'
    );
  });

  bot.command('clear', async (ctx) => {
    deps.agent.reset();
    await ctx.reply('Chat history cleared.');
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(
      'Send a 0x-prefixed token address to get a safety report.\n' +
      'Example: `0x...` (Base mainnet only)'
    );
  });

  bot.on(message('text'), async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;

    let statusMessagePromise: Promise<number> | undefined;

    const onToolStart = async (ev: { name: string }) => {
      statusMessagePromise = ctx.reply(`🔍 Calling ${ev.name}...`).then((m) => m.message_id);
    };

    const onToolEnd = async (ev: { name: string; result: { ok: boolean } }) => {
      if (statusMessagePromise) {
        const messageId = await statusMessagePromise;
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          messageId,
          undefined,
          ev.result.ok ? `✅ ${ev.name} completed.` : `❌ ${ev.name} failed.`,
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
