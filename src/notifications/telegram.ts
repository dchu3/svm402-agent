import type { Telegraf } from 'telegraf';
import { formatNotification, formatNotificationMarkdown, type NotificationEvent, type Notifier } from './index.js';
import { debug } from '../util/log.js';

function isMarkdownParseError(err: unknown): boolean {
  // Telegraf surfaces Telegram API errors with a numeric `code` (or
  // `response.error_code`). 400 is the response when MarkdownV2 entities
  // can't be parsed — it's the only condition we want to retry as plain text.
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: number; response?: { error_code?: number } };
  return e.code === 400 || e.response?.error_code === 400;
}

export function createTelegramNotifier(bot: Telegraf, chatId: number): Notifier {
  return {
    async notify(event: NotificationEvent): Promise<void> {
      try {
        await bot.telegram.sendMessage(chatId, formatNotificationMarkdown(event), {
          parse_mode: 'MarkdownV2',
        });
      } catch (err) {
        if (!isMarkdownParseError(err)) {
          debug('telegram-notifier', err);
          return;
        }
        debug('telegram-notifier-markdown-parse', err);
        try {
          await bot.telegram.sendMessage(chatId, formatNotification(event));
        } catch (fallbackErr) {
          debug('telegram-notifier-fallback', fallbackErr);
        }
      }
    },
  };
}
