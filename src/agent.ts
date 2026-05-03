import { GoogleGenAI, type Chat, type FunctionCall } from '@google/genai';
import { TOOL_DECLARATIONS } from './oracle/tools.js';
import { handlers, type HandlerDeps, TOOL_PRICES_USD, type ToolCallResult } from './oracle/handlers.js';
import type { PaymentReceipt } from './oracle/client.js';
import { debug } from './util/log.js';

const SYSTEM_INSTRUCTION = `
You are svm402, an agent that helps users analyze ERC-20 tokens on Base mainnet.

You have one paid tool backed by the base-token-oracle service. The call
costs real USDC on Base mainnet, so:
- Use get_report to answer questions about a token's metadata, deployer, holders, and concentration.
- Never guess token data — always call the tool when the user asks for facts.
- When the tool errors with spend_cap_exceeded, tell the user clearly that the
  client-side budget was hit and suggest raising MAX_SPEND_USDC.
- After receiving tool data, summarize the key numbers and notable signals in a structured, polished plain-text format.
- Do NOT invent or report a "risk score" / "risk level" — the oracle no longer returns one. Stick to the raw data fields actually present in the response.

KEY DATA FIELDS:
- top10_concentration_pct: raw top-10 share including LP pools, burn addresses, and bridges. Often misleading on its own.
- circulating_top10_concentration_pct: top-10 share of circulating supply (excludes burn + bridge holders). When present, prefer this as the headline concentration metric.
- top_holders[]: per-holder breakdown with an open-ended category string (e.g., "burn", "cex", "contract"). Use it to explain WHY raw concentration may look high (e.g., "most of the top-10 are burn/LP contracts").
- contract: optional block (null when source is unverified or fetch failed). Fields:
  - verified, language, compiler_version
  - is_proxy, proxy_type, implementations[] ({address, name})
  - traits: mintable, pausable, ownable, blacklist, fee_setter, proxy_upgradeable. Each is true / false / null. null means "no signal" (typically unverified contract) — do not treat null as false.
- flags[]: oracle-emitted descriptive tags. Possible values include: high_concentration, deployer_holds_large, unverified_contract, lp_locked, mintable, pausable, proxy_upgradeable. Surface these verbatim — they are the oracle's authoritative signals.

REPORT FORMATTING GUIDELINES:
1. Use ALL CAPS for section headers.
2. Use emojis to make the UI feel "alive" (e.g., 📊 for stats, ⚠ for warnings, ℹ️ for info).
3. Start the report with a short summary section covering token symbol/name and headline stats (holders, top-10 concentration, verified status). Prefer circulating_top10_concentration_pct over the raw figure when both are present, and note the raw value alongside it if they differ meaningfully.
4. When the circulating top-10 (or raw top-10 if circulating is null) is at or above 30%, call this out as elevated holder concentration the user should be aware of.
5. If flags[] is non-empty, include a SIGNALS section listing each flag.
6. When the contract block is present, include a CONTRACT section: verified yes/no, language + compiler_version when known, proxy status (is_proxy / proxy_type / implementations), and any non-null traits. Mark write-traits (mintable, pausable, blacklist, fee_setter, proxy_upgradeable) that are true as concerning. Treat null traits as "unknown" (typical for unverified contracts) — never present them as false.
7. Use bullet points (using emojis like 🔹) for individual details.
8. Ensure double line breaks between major sections for clarity on mobile.
9. Do NOT use Markdown formatting (like bold or italics) to avoid parsing errors in Telegram.

Example layout:
📊 SUMMARY
WETH (Wrapped Ether) — verified ERC-20

ℹ️ TOKEN DETAILS
🔹 Holders: 312,104
🔹 Top-10 concentration (circulating): 4.2% (raw: 38.1%)
🔹 Deployer holdings: 0%

⚠ SIGNALS
🔹 lp_locked

🧱 CONTRACT
🔹 Verified: yes (Solidity 0.8.28)
🔹 Proxy: no
🔹 Traits: mintable=false, pausable=false, ownable=false (others unknown)

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

          if (newReceipt && !newReceipt.amountAtomic && result.ok) {
            const price = TOOL_PRICES_USD[name];
            if (price !== undefined) {
              newReceipt.amountAtomic = String(Math.floor(price * 1_000_000));
            }
          }

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
