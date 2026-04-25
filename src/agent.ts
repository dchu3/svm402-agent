import { GoogleGenAI, type Chat, type FunctionCall } from '@google/genai';
import { TOOL_DECLARATIONS } from './oracle/tools.js';
import { handlers, type HandlerDeps, TOOL_PRICES_USD, type ToolCallResult } from './oracle/handlers.js';
import type { PaymentReceipt } from './oracle/client.js';
import { debug } from './util/log.js';

const SYSTEM_INSTRUCTION = `
You are svm402, an agent that helps users analyze ERC-20 tokens on Base mainnet.

You have four paid tools backed by the base-token-oracle service. Each call
costs real USDC on Base mainnet, so:
- Use the cheapest tool that answers the user's question.
- For general "is this token safe?" questions, prefer get_report (one paid call,
  composite answer) over fanning out to multiple individual endpoints.
- Never guess token data — always call a tool when the user asks for facts.
- When a tool errors with spend_cap_exceeded, tell the user clearly that the
  client-side budget was hit and suggest raising MAX_SPEND_USDC.
- After receiving tool data, summarize the key numbers and risk flags in plain
  English. Always quote the numeric risk score from get_report when you have it.
- Token addresses must be 0x-prefixed 40 hex chars on Base mainnet (chainId 8453).
`.trim();

export interface ToolCallEvent {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolEndEvent extends ToolCallEvent {
  result: ToolCallResult;
  priceUsd: number;
  receipt?: PaymentReceipt;
}

export interface AgentDeps extends HandlerDeps {
  apiKey: string;
  model: string;
}

export interface SendHooks {
  onToolStart?: (ev: ToolCallEvent) => void;
  onToolEnd?: (ev: ToolEndEvent) => void;
}

export interface Agent {
  chat: Chat;
  send(message: string, hooks?: SendHooks): Promise<string>;
  reset(): void;
}

export function createAgent(deps: AgentDeps): Agent {
  const ai = new GoogleGenAI({ apiKey: deps.apiKey });
  const buildChat = (): Chat =>
    ai.chats.create({
      model: deps.model,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
      },
    });
  let chat = buildChat();

  return {
    get chat() {
      return chat;
    },
    reset() {
      chat = buildChat();
    },
    async send(message: string, hooks?: SendHooks): Promise<string> {
      let response = await chat.sendMessage({ message });
      let safetyHops = 0;
      while (response.functionCalls && response.functionCalls.length > 0) {
        if (++safetyHops > 6) {
          return '[agent stopped: too many tool-call hops]';
        }
        const calls: FunctionCall[] = response.functionCalls;
        const functionResponses: Array<{
          name: string;
          response: Record<string, unknown>;
        }> = [];
        for (const call of calls) {
          const name = call.name ?? '';
          const args = (call.args ?? {}) as Record<string, unknown>;
          debug('tool-call', name, args);
          const handler = handlers[name];
          if (!handler) {
            functionResponses.push({
              name,
              response: { ok: false, error: `unknown_tool:${name}` },
            });
            continue;
          }
          hooks?.onToolStart?.({ name, args });
          const receiptsBefore = deps.oracle.receipts.length;
          const result = await handler(args, deps);
          const newReceipt =
            deps.oracle.receipts.length > receiptsBefore
              ? deps.oracle.receipts[deps.oracle.receipts.length - 1]
              : undefined;
          hooks?.onToolEnd?.({
            name,
            args,
            result,
            priceUsd: TOOL_PRICES_USD[name] ?? 0,
            ...(newReceipt ? { receipt: newReceipt } : {}),
          });
          functionResponses.push({ name, response: result as unknown as Record<string, unknown> });
        }
        response = await chat.sendMessage({
          message: functionResponses.map((fr) => ({
            functionResponse: { name: fr.name, response: fr.response },
          })),
        });
      }
      return response.text ?? '';
    },
  };
}
