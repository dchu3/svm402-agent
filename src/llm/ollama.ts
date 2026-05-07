import { TOOL_DECLARATIONS } from '../oracle/tools.js';
import { toJsonSchemaTools } from './toolSchema.js';
import { dispatchToolCall, MAX_TOOL_HOPS } from './toolLoop.js';
import { SYSTEM_INSTRUCTION, EVALUATION_INSTRUCTION } from './prompts.js';
import { parseEvaluationJson } from './evaluation.js';
import { debug } from '../util/log.js';
import type {
  EvaluateCandidatesInput,
  EvaluateCandidatesResult,
  LlmProvider,
  ProviderDeps,
  SendHooks,
} from './types.js';

interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}

interface OllamaChatResponse {
  message?: {
    role: string;
    content?: string;
    tool_calls?: OllamaToolCall[];
  };
  done?: boolean;
  error?: string;
}

export interface OllamaProviderOptions extends ProviderDeps {
  /** Base URL of the Ollama server. Defaults to http://localhost:11434. */
  host?: string;
  /** Override fetch — useful in tests. */
  fetchImpl?: typeof fetch;
}

interface OllamaTagsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

/**
 * Pre-flight check: verify that the Ollama server is reachable and that the
 * configured model tag is actually pulled. Throws an Error with an actionable
 * message when the host is unreachable or the model is missing.
 */
export async function assertOllamaModelAvailable(opts: {
  host: string;
  model: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const host = opts.host.replace(/\/+$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${host}/api/tags`;

  let res: Response;
  try {
    res = await fetchImpl(url, { method: 'GET' });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Cannot reach Ollama at ${host} (${reason}). Is \`ollama serve\` running, ` +
        `and is OLLAMA_HOST correct?`,
    );
  }

  if (!res.ok) {
    throw new Error(
      `Ollama tag listing failed at ${url}: ${res.status} ${res.statusText}. ` +
        `Is the Ollama server healthy?`,
    );
  }

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Ollama returned a non-JSON response from ${url} (${reason}). ` +
        `Is OLLAMA_HOST pointing at the Ollama server (and not, e.g., a proxy)?`,
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `Ollama returned an unexpected payload from ${url} (expected an object with a "models" array). ` +
        `Is OLLAMA_HOST pointing at the Ollama server?`,
    );
  }

  const json = parsed as OllamaTagsResponse;
  if (json.models !== undefined && !Array.isArray(json.models)) {
    throw new Error(
      `Ollama returned an unexpected payload from ${url} ("models" was not an array). ` +
        `Is OLLAMA_HOST pointing at the Ollama server?`,
    );
  }
  const available = (json.models ?? [])
    .map((m) => m.name ?? m.model ?? '')
    .filter((s) => s.length > 0);

  // Ollama tags are exact: "llama3.2" and "llama3.2:3b" are distinct entries.
  // For the common "<name>" vs "<name>:latest" case we treat the two as
  // interchangeable in BOTH directions so a user-set `OLLAMA_MODEL=llama3.2`
  // matches `llama3.2:latest` from /api/tags AND vice versa.
  const stripLatest = (name: string) => name.replace(/:latest$/, '');
  const wanted = opts.model;
  const wantedNorm = stripLatest(wanted);
  const found = available.some(
    (name) => name === wanted || stripLatest(name) === wantedNorm,
  );
  if (found) return;

  const list = available.length
    ? available.map((n) => `  - ${n}`).join('\n')
    : '  (no models pulled)';
  throw new Error(
    `Ollama model "${wanted}" is not available on ${host}.\n` +
      `Pull it with:  ollama pull ${wanted}\n` +
      `Available models:\n${list}`,
  );
}

const TOOLS_JSON = toJsonSchemaTools(TOOL_DECLARATIONS);

function normalizeArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* fall through */
    }
  }
  return {};
}

export function createOllamaProvider(opts: OllamaProviderOptions): LlmProvider {
  const host = (opts.host ?? 'http://localhost:11434').replace(/\/+$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;

  let messages: OllamaMessage[] = [{ role: 'system', content: SYSTEM_INSTRUCTION }];

  async function callOllama(body: Record<string, unknown>): Promise<OllamaChatResponse> {
    const url = `${host}/api/chat`;
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`ollama_request_failed: ${res.status} ${res.statusText} ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as OllamaChatResponse;
    if (json.error) throw new Error(`ollama_error: ${json.error}`);
    return json;
  }

  async function send(message: string, hooks?: SendHooks): Promise<string> {
    // Build the next-turn messages in a scratch array so a failed request or
    // a hop-cap abort doesn't leave a partial turn in persistent history.
    const pending: OllamaMessage[] = [{ role: 'user', content: message }];

    let safetyHops = 0;
    for (;;) {
      const response = await callOllama({
        model: opts.model,
        messages: [...messages, ...pending],
        tools: TOOLS_JSON,
        stream: false,
      });
      const msg = response.message ?? { role: 'assistant', content: '' };
      const toolCalls = msg.tool_calls ?? [];
      pending.push({
        role: 'assistant',
        content: msg.content ?? '',
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });

      if (toolCalls.length === 0) {
        messages.push(...pending);
        return msg.content ?? '';
      }

      if (++safetyHops > MAX_TOOL_HOPS) {
        // Discard the aborted turn; do not pollute future history.
        return '[agent stopped: too many tool-call hops]';
      }

      for (const call of toolCalls) {
        const name = call.function?.name ?? '';
        const args = normalizeArgs(call.function?.arguments);
        const resolved = await dispatchToolCall(name, args, opts, hooks);
        pending.push({
          role: 'tool',
          tool_name: name,
          content: JSON.stringify(resolved.result),
        });
      }
    }
  }

  async function evaluateCandidates(
    input: EvaluateCandidatesInput,
  ): Promise<EvaluateCandidatesResult> {
    const prompt = [
      `Max watchlist size: ${input.maxSize}`,
      '',
      'Current watchlist:',
      JSON.stringify(input.watchlist, null, 2),
      '',
      'Candidates to evaluate (each contains a summary of /report data):',
      JSON.stringify(input.candidates, null, 2),
    ].join('\n');

    const response = await callOllama({
      model: opts.model,
      messages: [
        { role: 'system', content: EVALUATION_INSTRUCTION },
        { role: 'user', content: prompt },
      ],
      stream: false,
      format: 'json',
    });
    const text = response.message?.content ?? '';
    debug('ollama evaluate raw', text.slice(0, 200));
    return parseEvaluationJson(text, 'ollama');
  }

  return {
    providerName: 'ollama',
    model: opts.model,
    send,
    reset() {
      messages = [{ role: 'system', content: SYSTEM_INSTRUCTION }];
    },
    evaluateCandidates,
  };
}
