import type { HandlerDeps } from './oracle/handlers.js';
import { createLlmProvider, type LlmProviderName } from './llm/index.js';
import type { LlmProvider } from './llm/types.js';

export type {
  ToolCallEvent,
  ToolEndEvent,
  SendHooks,
  CandidateForEval,
  WatchlistEntryForEval,
  EvaluateCandidatesInput,
  EvaluateCandidatesResult,
  RankedCandidate,
  ReplacementProposal,
} from './llm/types.js';

/**
 * Public deps used by callers that haven't been migrated to the new
 * provider config object. `apiKey` is interpreted as the Gemini API key for
 * back-compat. To use Ollama, callers should use `createAgentWithProvider`.
 */
export interface AgentDeps extends HandlerDeps {
  apiKey: string;
  model: string;
}

export interface AgentProviderDeps extends HandlerDeps {
  provider: LlmProviderName;
  model: string;
  geminiApiKey?: string;
  ollamaHost?: string;
  ollamaRequestTimeoutMs?: number;
  ollamaDisableTools?: boolean;
}

export interface Agent {
  /** Provider label (e.g., "gemini", "ollama"). */
  readonly providerName: string;
  /** Resolved model id. */
  readonly model: string;
  send: LlmProvider['send'];
  reset: LlmProvider['reset'];
  evaluateCandidates: LlmProvider['evaluateCandidates'];
}

export function createAgent(deps: AgentDeps): Agent {
  return wrap(
    createLlmProvider({
      provider: 'gemini',
      model: deps.model,
      geminiApiKey: deps.apiKey,
      oracle: deps.oracle,
      spend: deps.spend,
    }),
  );
}

export function createAgentWithProvider(deps: AgentProviderDeps): Agent {
  return wrap(
    createLlmProvider({
      provider: deps.provider,
      model: deps.model,
      geminiApiKey: deps.geminiApiKey,
      ollamaHost: deps.ollamaHost,
      ollamaRequestTimeoutMs: deps.ollamaRequestTimeoutMs,
      ollamaDisableTools: deps.ollamaDisableTools,
      oracle: deps.oracle,
      spend: deps.spend,
    }),
  );
}

function wrap(provider: LlmProvider): Agent {
  return {
    get providerName() {
      return provider.providerName;
    },
    get model() {
      return provider.model;
    },
    send: provider.send.bind(provider),
    reset: provider.reset.bind(provider),
    evaluateCandidates: provider.evaluateCandidates.bind(provider),
  };
}
