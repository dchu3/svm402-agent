import type { Telegraf } from 'telegraf';
import { formatNotification, type NotificationEvent, type Notifier } from './index.js';
import { debug } from '../util/log.js';

export function createTelegramNotifier(bot: Telegraf, chatId: number): Notifier {
  return {
    async notify(event: NotificationEvent): Promise<void> {
      try {
        await bot.telegram.sendMessage(chatId, formatNotification(event));
      } catch (err) {
        debug('telegram-notifier', err);
      }
    },
  };
}
