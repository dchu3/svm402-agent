import { printInfo, printWarn, printError } from '../ui/render.js';
import { formatNotification, type NotificationEvent, type Notifier } from './index.js';

export function createCliNotifier(): Notifier {
  return {
    async notify(event: NotificationEvent): Promise<void> {
      const text = formatNotification(event);
      switch (event.type) {
        case 'scan:error':
          printError('scheduler', text);
          return;
        case 'trade:error':
          printError('trading', text);
          return;
        case 'watchlist:remove':
          printWarn(text);
          return;
        default:
          printInfo(text);
      }
    },
  };
}
