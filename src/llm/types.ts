import type { PaymentReceipt } from '../oracle/client.js';
import type { HandlerDeps, ToolCallResult } from '../oracle/handlers.js';

export interface ToolCallEvent {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolEndEvent extends ToolCallEvent {
  result: ToolCallResult;
  priceUsd: number;
  receipt?: PaymentReceipt;
}

export interface SendHooks {
  onToolStart?: (ev: ToolCallEvent) => void;
  onToolEnd?: (ev: ToolEndEvent) => void;
  /**
   * Invoked once per non-empty incremental assistant content delta from a
   * streaming provider. Hook errors are swallowed by the caller — never let
   * a UI hook abort the stream.
   */
  onStreamChunk?: (delta: string) => void;
}

export interface CandidateForEval {
  address: string;
  symbol: string | null;
  name: string | null;
  reportSummary: Record<string, unknown>;
}

export interface WatchlistEntryForEval {
  address: string;
  symbol: string | null;
  score: number;
}

export interface EvaluateCandidatesInput {
  candidates: CandidateForEval[];
  watchlist: WatchlistEntryForEval[];
  maxSize: number;
}

export interface RankedCandidate {
  address: string;
  score: number;
  reasoning: string;
}

export interface ReplacementProposal {
  add: string;
  remove: string;
}

export interface EvaluateCandidatesResult {
  ranked: RankedCandidate[];
  replacements: ReplacementProposal[];
}

/**
 * Provider-agnostic LLM interface. Both the Gemini and Ollama backends
 * implement this so the rest of the application (REPL, Telegram, scheduler,
 * trading) does not depend on any specific SDK.
 */
export interface LlmProvider {
  /** Provider label for logs and the banner (e.g., "gemini", "ollama"). */
  readonly providerName: string;
  /** Resolved model id (e.g., "gemini-3.1-flash-lite-preview", "llama3.2:3b"). */
  readonly model: string;
  /** Multi-turn chat send. Drives the tool-calling loop internally and
   *  returns the final assistant text. */
  send(message: string, hooks?: SendHooks): Promise<string>;
  /** Reset the chat history (used by /clear). */
  reset(): void;
  /** One-shot strict-JSON evaluation for the watchlist scheduler. */
  evaluateCandidates(input: EvaluateCandidatesInput): Promise<EvaluateCandidatesResult>;
}

export interface ProviderDeps extends HandlerDeps {
  model: string;
}
