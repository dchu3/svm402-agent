import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { Agent } from './agent.js';
import type { OracleClient } from './oracle/client.js';
import type { Wallet } from './wallet.js';
import type { SpendTracker } from './oracle/handlers.js';

export interface ReplDeps {
  agent: Agent;
  oracle: OracleClient;
  wallet: Wallet;
  spend: SpendTracker;
}

const HELP = `
Slash commands:
  /help              Show this help
  /balance           Show wallet address + USDC balance on Base
  /spend             Show session spend (USDC)
  /receipts          Show all settled payment receipts this session
  /clear             Reset Gemini chat history (does not refund spend)
  /quit, /exit       Leave the REPL

Tools available to Gemini:
  get_market(address)              $0.005 USDC
  get_honeypot(address)            $0.010 USDC
  get_forensics(address, pair?)    $0.020 USDC
  get_report(address, pair?)       $0.030 USDC

Anything else is sent to Gemini.
`.trim();

export async function startRepl(deps: ReplDeps): Promise<void> {
  const rl = readline.createInterface({ input, output, terminal: true });
  rl.setPrompt('svm402> ');
  console.log('Type /help for commands. Ctrl-C or /quit to exit.');
  rl.prompt();

  rl.on('SIGINT', () => {
    console.log('\nuse /quit to exit.');
    rl.prompt();
  });

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) {
      rl.prompt();
      continue;
    }
    if (line === '/quit' || line === '/exit') break;
    if (line === '/help') {
      console.log(HELP);
      rl.prompt();
      continue;
    }
    if (line === '/balance') {
      try {
        const { formatted } = await deps.wallet.usdcBalance();
        console.log(`address: ${deps.wallet.address}\nUSDC on Base: ${formatted}`);
      } catch (err) {
        console.error('balance lookup failed:', err instanceof Error ? err.message : err);
      }
      rl.prompt();
      continue;
    }
    if (line === '/spend') {
      console.log(
        `session spend: $${deps.spend.total.toFixed(4)} USDC (cap $${deps.spend.cap.toFixed(3)})`,
      );
      rl.prompt();
      continue;
    }
    if (line === '/receipts') {
      if (deps.oracle.receipts.length === 0) {
        console.log('no receipts yet.');
      } else {
        for (const r of deps.oracle.receipts) {
          console.log(
            `  ${r.endpoint}  ${r.success ? '✓' : '✗'}  tx=${r.transaction}  ${r.network}${r.amountAtomic ? `  amount=${r.amountAtomic}` : ''}`,
          );
        }
      }
      rl.prompt();
      continue;
    }
    if (line === '/clear') {
      deps.agent.reset();
      console.log('chat history cleared.');
      rl.prompt();
      continue;
    }
    if (line.startsWith('/')) {
      console.log(`unknown command: ${line}. Type /help.`);
      rl.prompt();
      continue;
    }

    try {
      const reply = await deps.agent.send(line);
      console.log(reply || '[no text response]');
    } catch (err) {
      console.error('agent error:', err instanceof Error ? err.message : err);
    }
    rl.prompt();
  }

  rl.close();
  console.log('bye.');
}
