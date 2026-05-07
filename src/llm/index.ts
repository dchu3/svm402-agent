import type { HandlerDeps } from '../oracle/handlers.js';
import type { LlmProvider } from './types.js';
import { createGeminiProvider } from './gemini.js';
import { createOllamaProvider } from './ollama.js';

export type LlmProviderName = 'gemini' | 'ollama';

export interface CreateLlmProviderOptions extends HandlerDeps {
  provider: LlmProviderName;
  model: string;
  geminiApiKey?: string;
  ollamaHost?: string;
}

export function createLlmProvider(opts: CreateLlmProviderOptions): LlmProvider {
  if (opts.provider === 'gemini') {
    if (!opts.geminiApiKey) {
      throw new Error('GEMINI_API_KEY is required when LLM_PROVIDER=gemini');
    }
    return createGeminiProvider({
      apiKey: opts.geminiApiKey,
      model: opts.model,
      oracle: opts.oracle,
      spend: opts.spend,
    });
  }
  if (opts.provider === 'ollama') {
    return createOllamaProvider({
      model: opts.model,
      host: opts.ollamaHost,
      oracle: opts.oracle,
      spend: opts.spend,
    });
  }
  throw new Error(`unsupported_llm_provider: ${String(opts.provider)}`);
}

export type {
  LlmProvider,
  EvaluateCandidatesInput,
  EvaluateCandidatesResult,
  CandidateForEval,
  WatchlistEntryForEval,
  RankedCandidate,
  ReplacementProposal,
  SendHooks,
  ToolCallEvent,
  ToolEndEvent,
} from './types.js';
