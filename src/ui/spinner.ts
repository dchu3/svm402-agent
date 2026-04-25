import ora, { type Ora } from 'ora';
import { getTheme } from './theme.js';

export interface SpinnerHandle {
  stopAndClear(): void;
  fail(text?: string): void;
}

export function startSpinner(text: string): SpinnerHandle {
  const t = getTheme();
  if (!t.spinnersEnabled) {
    process.stdout.write(text + '\n');
    return {
      stopAndClear() {
        // no-op; line already flushed
      },
      fail() {
        // no-op
      },
    };
  }
  const spinner: Ora = ora({
    text,
    color: 'yellow',
    spinner: t.ascii ? 'line' : 'dots',
    stream: process.stdout,
  }).start();
  return {
    stopAndClear() {
      spinner.stop();
    },
    fail(failText?: string) {
      if (failText) {
        spinner.fail(failText);
      } else {
        spinner.stop();
      }
    },
  };
}
