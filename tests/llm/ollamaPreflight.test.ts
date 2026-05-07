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
});
