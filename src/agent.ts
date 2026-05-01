import { GoogleGenAI, type Chat, type FunctionCall } from '@google/genai';
import { TOOL_DECLARATIONS } from './oracle/tools.js';
import { handlers, type HandlerDeps, TOOL_PRICES_USD, type ToolCallResult } from './oracle/handlers.js';
import type { PaymentReceipt } from './oracle/client.js';
import { debug } from './util/log.js';

const SYSTEM_INSTRUCTION = `
You are svm402, an agent that helps users analyze ERC-20 tokens on Base mainnet.

You have one paid tool backed by the base-token-oracle service. The call
costs real USDC on Base mainnet, so:
- Use get_report to answer token safety questions.
- Never guess token data — always call the tool when the user asks for facts.
- When the tool errors with spend_cap_exceeded, tell the user clearly that the
  client-side budget was hit and suggest raising MAX_SPEND_USDC.
- After receiving tool data, summarize the key numbers and risk flags in a structured, polished plain-text format.

REPORT FORMATTING GUIDELINES:
1. Use ALL CAPS for section headers.
2. Use emojis to make the UI feel "alive" (e.g., 📊 for stats, 🚨 for risks, ℹ️ for info).
3. Start the report with a summary section including the numeric risk score from get_report (e.g., "📊 RISK SCORE: 0/10").
4. Always state the confidence level and rule coverage (from risk_confidence and risk_coverage). When risk_confidence is "low" or risk_coverage.evaluated < risk_coverage.total, prominently warn the user that the "clean" or low score may be incomplete and list which rules were missing (risk_coverage.missing).
5. When top10_concentration_pct is at or above 30% but no high_concentration flag is set, call this out as an elevated-but-sub-threshold concentration the user should be aware of.
6. Use bullet points (using emojis like 🔹 or ⚠) for individual risk flags or details.
7. Ensure double line breaks between major sections for clarity on mobile.
8. Do NOT use Markdown formatting (like bold or italics) to avoid parsing errors in Telegram.

Example layout:
📊 SUMMARY
Risk Score: 0/10 (Clean)

🚨 RISK ANALYSIS
🔹 No high-risk flags detected.
🔹 Contract is verified.

ℹ️ TOKEN DETAILS
Symbol: WETH
Liquidity: $8.4M

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
