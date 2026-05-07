import { describe, it, expect } from 'vitest';
import { assertOllamaModelAvailable } from '../../src/llm/ollama.js';

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number; statusText?: string } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  } as unknown as Response;
}

describe('assertOllamaModelAvailable', () => {
  it('resolves when the exact tag is present', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ models: [{ name: 'llama3.2:3b' }, { name: 'mistral:latest' }] })) as unknown as typeof fetch;
    await expect(
      assertOllamaModelAvailable({ host: 'http://localhost:11434', model: 'llama3.2:3b', fetchImpl }),
    ).resolves.toBeUndefined();
  });

  it('resolves when bare name matches "<name>:latest"', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ models: [{ name: 'llama3.2:latest' }] })) as unknown as typeof fetch;
    await expect(
      assertOllamaModelAvailable({ host: 'http://localhost:11434', model: 'llama3.2', fetchImpl }),
    ).resolves.toBeUndefined();
  });

  it('throws an actionable error listing available tags when the model is missing', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ models: [{ name: 'llama3.2:latest' }, { name: 'mistral:7b' }] })) as unknown as typeof fetch;
    await expect(
      assertOllamaModelAvailable({ host: 'http://localhost:11434', model: 'llama3.2:3b', fetchImpl }),
    ).rejects.toThrow(/llama3\.2:3b.*not available[\s\S]*ollama pull llama3\.2:3b[\s\S]*llama3\.2:latest/);
  });

  it('throws a host-unreachable error when fetch rejects', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(
      assertOllamaModelAvailable({ host: 'http://localhost:11434', model: 'llama3.2', fetchImpl }),
    ).rejects.toThrow(/Cannot reach Ollama.*ECONNREFUSED.*ollama serve/s);
  });

  it('throws when the tags endpoint returns non-OK', async () => {
    const fetchImpl = (async () =>
      jsonResponse({}, { ok: false, status: 500, statusText: 'Internal Server Error' })) as unknown as typeof fetch;
    await expect(
      assertOllamaModelAvailable({ host: 'http://localhost:11434', model: 'llama3.2', fetchImpl }),
    ).rejects.toThrow(/tag listing failed.*500/);
  });

  it('resolves when an explicit :latest tag matches a bare available name', async () => {
    // Symmetric of the bare-vs-:latest case: user sets OLLAMA_MODEL=llama3.2:latest
    // and /api/tags happens to return a bare "llama3.2" entry.
    const fetchImpl = (async () =>
      jsonResponse({ models: [{ name: 'llama3.2' }] })) as unknown as typeof fetch;
    await expect(
      assertOllamaModelAvailable({ host: 'http://localhost:11434', model: 'llama3.2:latest', fetchImpl }),
    ).resolves.toBeUndefined();
  });

  it('throws a clear payload-shape error when /api/tags returns the JSON literal null', async () => {
    // res.json() resolves (does not reject) to null; must not crash with a
    // raw TypeError. Caller should see an actionable diagnostic.
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      async json() {
        return null;
      },
      async text() {
        return 'null';
      },
    })) as unknown as typeof fetch;
    await expect(
      assertOllamaModelAvailable({ host: 'http://localhost:11434', model: 'llama3.2', fetchImpl }),
    ).rejects.toThrow(/unexpected payload/i);
  });

  it('throws a clear payload-shape error when "models" is not an array', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ models: { 'llama3.2': true } })) as unknown as typeof fetch;
    await expect(
      assertOllamaModelAvailable({ host: 'http://localhost:11434', model: 'llama3.2', fetchImpl }),
    ).rejects.toThrow(/"models" was not an array/);
  });

  it('throws a clear non-JSON error when the body is not parseable', async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      async json() {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
      async text() {
        return '<html>...</html>';
      },
    })) as unknown as typeof fetch;
    await expect(
      assertOllamaModelAvailable({ host: 'http://localhost:11434', model: 'llama3.2', fetchImpl }),
    ).rejects.toThrow(/non-JSON response/i);
  });
});
