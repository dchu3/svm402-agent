import { existsSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { BoostedToken } from './types.js';
import { debug } from '../util/log.js';

export interface DexscreenerMcpClientOptions {
  serverPath: string;
  nodeBin?: string;
}

export interface DexscreenerMcpClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  getTopBoostedTokens(): Promise<BoostedToken[]>;
  getLatestBoostedTokens(): Promise<BoostedToken[]>;
}

function extractTextPayload(content: unknown): string {
  if (!Array.isArray(content)) return '';
  for (const item of content) {
    if (item && typeof item === 'object' && (item as { type?: string }).type === 'text') {
      const text = (item as { text?: unknown }).text;
      if (typeof text === 'string') return text;
    }
  }
  return '';
}

function parseBoostedTokens(text: string): BoostedToken[] {
  if (!text) return [];
  if (text.startsWith('Error:')) {
    throw new Error(text);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `dexscreener: failed to parse JSON response: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!Array.isArray(parsed)) return [];
  const out: BoostedToken[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.chainId !== 'string' || typeof e.tokenAddress !== 'string') continue;
    out.push(e as unknown as BoostedToken);
  }
  return out;
}

export function createDexscreenerMcpClient(opts: DexscreenerMcpClientOptions): DexscreenerMcpClient {
  const serverPath = path.resolve(opts.serverPath);
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  let connecting: Promise<void> | undefined;

  async function ensureConnected(): Promise<void> {
    if (client) return;
    if (connecting) return connecting;
    connecting = (async () => {
      if (!existsSync(serverPath)) {
        throw new Error(
          `dexscreener-mcp build not found at ${serverPath}. Build it with \`cd dex-screener-mcp && npm run build\` or set DEXSCREENER_MCP_PATH.`,
        );
      }
      const c = new Client({ name: 'svm402-agent', version: '0.1.0' }, { capabilities: {} });
      const t = new StdioClientTransport({
        command: opts.nodeBin ?? process.execPath,
        args: [serverPath],
        stderr: 'pipe',
      });
      transport = t;
      try {
        await c.connect(t);
      } catch (err) {
        try {
          await t.close();
        } catch (closeErr) {
          debug('dexscreener-mcp', 'transport close after failed connect', closeErr);
        }
        transport = undefined;
        throw err;
      }
      client = c;
      debug('dexscreener-mcp', 'connected');
    })().finally(() => {
      connecting = undefined;
    });
    return connecting;
  }

  async function callBoostedTool(
    name: 'get_top_boosted_tokens' | 'get_latest_boosted_tokens',
  ): Promise<BoostedToken[]> {
    await ensureConnected();
    if (!client) throw new Error('dexscreener-mcp client not connected');
    const result = await client.callTool({ name, arguments: {} });
    if ((result as { isError?: boolean }).isError) {
      throw new Error(`dexscreener-mcp: ${name} returned isError`);
    }
    const text = extractTextPayload((result as { content?: unknown }).content);
    return parseBoostedTokens(text);
  }

  return {
    connect: ensureConnected,
    async close() {
      try {
        await client?.close();
      } catch (err) {
        debug('dexscreener-mcp close', err);
      }
      try {
        await transport?.close();
      } catch (err) {
        debug('dexscreener-mcp transport close', err);
      }
      client = undefined;
      transport = undefined;
    },
    getTopBoostedTokens: () => callBoostedTool('get_top_boosted_tokens'),
    getLatestBoostedTokens: () => callBoostedTool('get_latest_boosted_tokens'),
  };
}
