import { describe, it, expect, vi } from 'vitest';
import { createOllamaProvider } from '../../src/llm/ollama.js';
import type { OracleClient } from '../../src/oracle/client.js';
import type { SpendTracker } from '../../src/oracle/handlers.js';
import { TOOL_DECLARATIONS } from '../../src/oracle/tools.js';
import { toJsonSchemaTools } from '../../src/llm/toolSchema.js';

function fakeDeps(): { oracle: OracleClient; spend: SpendTracker } {
  return {
    oracle: {
      receipts: [],
      async get<T = unknown>(_p: string) {
        return {
          data: {
            address: '0x1111111111111111111111111111111111111111',
            symbol: 'TEST',
            name: 'Test',
            decimals: 18,
            holders_count: 100,
            top10_concentration_pct: 5,
            top_holders: [],
            flags: [],
          } as T,
          paymentReceipt: undefined,
        };
      },
    } as unknown as OracleClient,
    spend: {
      total: 0,
      cap: 1,
      add() {},
      wouldExceed() {
        return false;
      },
    },
  };
}

interface MockResponse {
  message?: { role: string; content?: string; tool_calls?: unknown[] };
}

function makeFetch(responses: MockResponse[]): {
  fetchImpl: typeof fetch;
  bodies: unknown[];
} {
  const bodies: unknown[] = [];
  let i = 0;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const body = responses[i++] ?? { message: { role: 'assistant', content: '' } };
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      async json() {
        return body;
      },
      async text() {
        return '';
      },
    } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, bodies };
}

describe('OllamaProvider', () => {
  it('exposes provider/model labels', () => {
    const deps = fakeDeps();
    const provider = createOllamaProvider({
      model: 'llama3.2:3b',
      host: 'http://x',
      fetchImpl: makeFetch([{ message: { role: 'assistant', content: '' } }]).fetchImpl,
      ...deps,
    });
    expect(provider.providerName).toBe('ollama');
    expect(provider.model).toBe('llama3.2:3b');
  });

  it('passes JSON-Schema tools (converted from Gemini decls) on every chat call', async () => {
    const deps = fakeDeps();
    const { fetchImpl, bodies } = makeFetch([
      { message: { role: 'assistant', content: 'hi' } },
    ]);
    const provider = createOllamaProvider({
      model: 'llama3.2:3b',
      host: 'http://x',
      fetchImpl,
      ...deps,
    });
    const out = await provider.send('hello');
    expect(out).toBe('hi');
    const body = bodies[0] as { tools: unknown[]; model: string; messages: unknown[]; stream: boolean };
    expect(body.model).toBe('llama3.2:3b');
    expect(body.stream).toBe(false);
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools).toEqual(toJsonSchemaTools(TOOL_DECLARATIONS));
    // First message is system, second is the user prompt.
    const msgs = body.messages as Array<{ role: string }>;
    expect(msgs[0].role).toBe('system');
    expect(msgs[msgs.length - 1].role).toBe('user');
  });

  it('dispatches tool calls and feeds the tool result back as a follow-up message', async () => {
    const deps = fakeDeps();
    const oracleGet = vi.spyOn(deps.oracle, 'get');
    const { fetchImpl, bodies } = makeFetch([
      // First reply: a tool call.
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              function: {
                name: 'get_report',
                arguments: { address: '0x1111111111111111111111111111111111111111' },
              },
            },
          ],
        },
      },
      // Second reply: final answer.
      { message: { role: 'assistant', content: 'final answer' } },
    ]);
    const provider = createOllamaProvider({
      model: 'llama3.2:3b',
      host: 'http://x',
      fetchImpl,
      ...deps,
    });
    const out = await provider.send('hello');
    expect(out).toBe('final answer');
    expect(oracleGet).toHaveBeenCalledTimes(1);
    // Second request should include a tool message with the dispatched result.
    const second = bodies[1] as { messages: Array<{ role: string; content?: string; tool_name?: string }> };
    const toolMsg = second.messages.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.tool_name).toBe('get_report');
    expect(toolMsg?.content).toContain('"ok":true');
  });

  it('parses string-encoded tool arguments (some models emit JSON strings)', async () => {
    const deps = fakeDeps();
    const oracleGet = vi.spyOn(deps.oracle, 'get');
    const { fetchImpl } = makeFetch([
      {
        message: {
          role: 'assistant',
          tool_calls: [
            {
              function: {
                name: 'get_report',
                // Some llama variants return the args as a JSON string.
                arguments: '{"address":"0x1111111111111111111111111111111111111111"}',
              },
            },
          ],
        },
      },
      { message: { role: 'assistant', content: 'done' } },
    ]);
    const provider = createOllamaProvider({
      model: 'llama3.2:3b',
      host: 'http://x',
      fetchImpl,
      ...deps,
    });
    const out = await provider.send('hello');
    expect(out).toBe('done');
    expect(oracleGet).toHaveBeenCalledOnce();
  });

  it('caps the tool-call hop count', async () => {
    const deps = fakeDeps();
    const replies: MockResponse[] = Array.from({ length: 20 }, () => ({
      message: {
        role: 'assistant',
        tool_calls: [
          {
            function: {
              name: 'get_report',
              arguments: { address: '0x1111111111111111111111111111111111111111' },
            },
          },
        ],
      },
    }));
    const { fetchImpl } = makeFetch(replies);
    const provider = createOllamaProvider({
      model: 'llama3.2:3b',
      host: 'http://x',
      fetchImpl,
      ...deps,
    });
    const out = await provider.send('hello');
    expect(out).toMatch(/too many tool-call hops/);
  });

  it('evaluateCandidates sends format:json and parses the response', async () => {
    const deps = fakeDeps();
    const { fetchImpl, bodies } = makeFetch([
      {
        message: {
          role: 'assistant',
          content: JSON.stringify({
            ranked: [{ address: '0xAAA', score: 80, reasoning: 'ok' }],
            replacements: [],
          }),
        },
      },
    ]);
    const provider = createOllamaProvider({
      model: 'llama3.2:3b',
      host: 'http://x',
      fetchImpl,
      ...deps,
    });
    const result = await provider.evaluateCandidates({
      candidates: [],
      watchlist: [],
      maxSize: 5,
    });
    expect(result.ranked).toHaveLength(1);
    expect(result.ranked[0].address).toBe('0xaaa');
    const body = bodies[0] as { format?: string };
    expect(body.format).toBe('json');
  });

  it('evaluateCandidates returns empty result on invalid JSON', async () => {
    const deps = fakeDeps();
    const { fetchImpl } = makeFetch([
      { message: { role: 'assistant', content: 'not json at all' } },
    ]);
    const provider = createOllamaProvider({
      model: 'llama3.2:3b',
      host: 'http://x',
      fetchImpl,
      ...deps,
    });
    const result = await provider.evaluateCandidates({
      candidates: [],
      watchlist: [],
      maxSize: 5,
    });
    expect(result).toEqual({ ranked: [], replacements: [] });
  });

  it('resets clear chat history but preserves the system prompt', async () => {
    const deps = fakeDeps();
    const { fetchImpl, bodies } = makeFetch([
      { message: { role: 'assistant', content: 'a' } },
      { message: { role: 'assistant', content: 'b' } },
    ]);
    const provider = createOllamaProvider({
      model: 'llama3.2:3b',
      host: 'http://x',
      fetchImpl,
      ...deps,
    });
    await provider.send('first');
    provider.reset();
    await provider.send('second');
    const second = bodies[1] as { messages: Array<{ role: string; content: string }> };
    // After reset, the second call should NOT include the first user message.
    expect(second.messages.some((m) => m.content === 'first')).toBe(false);
    expect(second.messages.some((m) => m.content === 'second')).toBe(true);
    expect(second.messages[0].role).toBe('system');
  });
});

describe('toJsonSchemaTools', () => {
  it('produces valid OpenAI-style tool definitions for the registered tools', () => {
    const tools = toJsonSchemaTools(TOOL_DECLARATIONS);
    expect(tools.length).toBe(TOOL_DECLARATIONS.length);
    const t = tools[0];
    expect(t.type).toBe('function');
    expect(t.function.name).toBe(TOOL_DECLARATIONS[0].name);
    expect(t.function.parameters.type).toBe('object');
    expect(t.function.parameters.properties.address.type).toBe('string');
    expect(t.function.parameters.required).toContain('address');
  });
});
