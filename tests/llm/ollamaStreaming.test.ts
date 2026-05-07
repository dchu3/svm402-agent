import { describe, it, expect, vi } from 'vitest';
import { createOllamaProvider } from '../../src/llm/ollama.js';
import type { OracleClient } from '../../src/oracle/client.js';
import type { SpendTracker } from '../../src/oracle/handlers.js';

function fakeDeps(): { oracle: OracleClient; spend: SpendTracker } {
  return {
    oracle: { receipts: [], async get<T = unknown>() { return { data: {} as T, paymentReceipt: undefined }; } } as unknown as OracleClient,
    spend: { total: 0, cap: 1, add() {}, wouldExceed() { return false; } },
  };
}

function streamingResponse(chunks: string[]): Response {
  const encoded = chunks.map((c) => new TextEncoder().encode(c));
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < encoded.length) {
        controller.enqueue(encoded[i++]);
      } else {
        controller.close();
      }
    },
  });
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body,
    async json() {
      throw new Error('not used');
    },
    async text() {
      return chunks.join('');
    },
  } as unknown as Response;
}

describe('Ollama streaming', () => {
  it('aggregates content across multiple NDJSON chunks', async () => {
    // Three chunks: "hel", "lo ", "world" — and a final done line.
    const chunks = [
      JSON.stringify({ message: { role: 'assistant', content: 'hel' }, done: false }) + '\n',
      JSON.stringify({ message: { role: 'assistant', content: 'lo ' }, done: false }) + '\n',
      JSON.stringify({ message: { role: 'assistant', content: 'world' }, done: false }) + '\n',
      JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }) + '\n',
    ];
    const fetchImpl = (async () => streamingResponse(chunks)) as unknown as typeof fetch;
    const provider = createOllamaProvider({ model: 'llama3.2', host: 'http://x', fetchImpl, ...fakeDeps() });
    const out = await provider.send('hi');
    expect(out).toBe('hello world');
  });

  it('buffers partial JSON lines split across chunk boundaries', async () => {
    // Split a single JSON object in half mid-string.
    const full = JSON.stringify({ message: { role: 'assistant', content: 'pieces' }, done: true }) + '\n';
    const half = Math.floor(full.length / 2);
    const chunks = [full.slice(0, half), full.slice(half)];
    const fetchImpl = (async () => streamingResponse(chunks)) as unknown as typeof fetch;
    const provider = createOllamaProvider({ model: 'llama3.2', host: 'http://x', fetchImpl, ...fakeDeps() });
    const out = await provider.send('hi');
    expect(out).toBe('pieces');
  });

  it('preserves tool_calls emitted in a non-final streaming chunk', async () => {
    const deps = fakeDeps();
    const oracleGet = vi.spyOn(deps.oracle, 'get');
    let nthCall = 0;
    const fetchImpl = (async () => {
      nthCall++;
      if (nthCall === 1) {
        // First request: tool call carried in an early chunk, then a done chunk.
        return streamingResponse([
          JSON.stringify({
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
            done: false,
          }) + '\n',
          JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }) + '\n',
        ]);
      }
      // Second request: final assistant content.
      return streamingResponse([
        JSON.stringify({ message: { role: 'assistant', content: 'final' }, done: true }) + '\n',
      ]);
    }) as unknown as typeof fetch;
    const provider = createOllamaProvider({ model: 'llama3.2', host: 'http://x', fetchImpl, ...deps });
    const out = await provider.send('hello');
    expect(out).toBe('final');
    expect(oracleGet).toHaveBeenCalledOnce();
  });

  it('throws ollama_error when a stream chunk contains an error field', async () => {
    const chunks = [
      JSON.stringify({ message: { role: 'assistant', content: 'partial' }, done: false }) + '\n',
      JSON.stringify({ error: 'model crashed mid-stream' }) + '\n',
    ];
    const fetchImpl = (async () => streamingResponse(chunks)) as unknown as typeof fetch;
    const provider = createOllamaProvider({ model: 'llama3.2', host: 'http://x', fetchImpl, ...fakeDeps() });
    await expect(provider.send('hi')).rejects.toThrow(/ollama_error: model crashed mid-stream/);
  });

  it('throws a clear timeout error when AbortSignal.timeout fires', async () => {
    // Mock fetch that respects the AbortSignal: rejects with TimeoutError when
    // the signal's abort reason is a TimeoutError (Node's actual behavior).
    const fetchImpl = ((async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        const onAbort = () => {
          const err = new Error('The operation was aborted due to timeout');
          err.name = 'TimeoutError';
          reject(err);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort);
      });
    }) as unknown) as typeof fetch;
    const provider = createOllamaProvider({
      model: 'llama3.2',
      host: 'http://x',
      fetchImpl,
      requestTimeoutMs: 25,
      ...fakeDeps(),
    });
    await expect(provider.send('hi')).rejects.toThrow(
      /ollama_request_timeout.*OLLAMA_REQUEST_TIMEOUT_MS/s,
    );
  });

  it('translates body-phase timeout (during stream read) to ollama_request_timeout', async () => {
    // fetch resolves immediately with a streaming body that NEVER emits
    // anything; reader.read() will reject when the AbortSignal fires.
    const fetchImpl = ((async (_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (!signal) return;
          const onAbort = () => {
            const err = new Error('The operation was aborted due to timeout');
            err.name = 'TimeoutError';
            controller.error(err);
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort);
        },
      });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        body,
        async json() { throw new Error('not used'); },
        async text() { return ''; },
      } as unknown as Response;
    }) as unknown) as typeof fetch;
    const provider = createOllamaProvider({
      model: 'llama3.2',
      host: 'http://x',
      fetchImpl,
      requestTimeoutMs: 25,
      ...fakeDeps(),
    });
    await expect(provider.send('hi')).rejects.toThrow(
      /ollama_request_timeout.*OLLAMA_REQUEST_TIMEOUT_MS/s,
    );
  });

  it('throws ollama_stream_failed when the stream closes before done=true', async () => {
    const chunks = [
      JSON.stringify({ message: { role: 'assistant', content: 'partial' }, done: false }) + '\n',
    ];
    const fetchImpl = (async () => streamingResponse(chunks)) as unknown as typeof fetch;
    const provider = createOllamaProvider({ model: 'llama3.2', host: 'http://x', fetchImpl, ...fakeDeps() });
    await expect(provider.send('hi')).rejects.toThrow(/ollama_stream_failed.*done=true/);
  });

  it('invokes onStreamChunk for each non-empty content delta in order', async () => {
    const deltas = ['hel', 'lo ', 'world'];
    const chunks = [
      ...deltas.map(
        (d) => JSON.stringify({ message: { role: 'assistant', content: d }, done: false }) + '\n',
      ),
      // empty content delta — should NOT be reported as a chunk
      JSON.stringify({ message: { role: 'assistant', content: '' }, done: false }) + '\n',
      JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }) + '\n',
    ];
    const fetchImpl = (async () => streamingResponse(chunks)) as unknown as typeof fetch;
    const provider = createOllamaProvider({
      model: 'llama3.2',
      host: 'http://x',
      fetchImpl,
      ...fakeDeps(),
    });
    const seen: string[] = [];
    const out = await provider.send('hi', { onStreamChunk: (d) => seen.push(d) });
    expect(seen).toEqual(deltas);
    expect(out).toBe('hello world');
  });

  it('does not let onStreamChunk errors break the stream', async () => {
    const chunks = [
      JSON.stringify({ message: { role: 'assistant', content: 'a' }, done: false }) + '\n',
      JSON.stringify({ message: { role: 'assistant', content: 'b' }, done: true }) + '\n',
    ];
    const fetchImpl = (async () => streamingResponse(chunks)) as unknown as typeof fetch;
    const provider = createOllamaProvider({
      model: 'llama3.2',
      host: 'http://x',
      fetchImpl,
      ...fakeDeps(),
    });
    const out = await provider.send('hi', {
      onStreamChunk: () => {
        throw new Error('boom');
      },
    });
    expect(out).toBe('ab');
  });

  it('omits `tools` from /api/chat when disableTools is true', async () => {
    let captured: unknown;
    const chunks = [
      JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: true }) + '\n',
    ];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body ?? '{}'));
      return streamingResponse(chunks);
    }) as unknown as typeof fetch;
    const provider = createOllamaProvider({
      model: 'llama3.2',
      host: 'http://x',
      fetchImpl,
      disableTools: true,
      ...fakeDeps(),
    });
    await provider.send('hi');
    const body = captured as Record<string, unknown>;
    expect(body.tools).toBeUndefined();
    expect(body.stream).toBe(true);
  });

  it('includes `tools` by default when disableTools is not set', async () => {
    let captured: unknown;
    const chunks = [
      JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: true }) + '\n',
    ];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body ?? '{}'));
      return streamingResponse(chunks);
    }) as unknown as typeof fetch;
    const provider = createOllamaProvider({
      model: 'llama3.2',
      host: 'http://x',
      fetchImpl,
      ...fakeDeps(),
    });
    await provider.send('hi');
    const body = captured as Record<string, unknown>;
    expect(Array.isArray(body.tools)).toBe(true);
    expect((body.tools as unknown[]).length).toBeGreaterThan(0);
  });
});
