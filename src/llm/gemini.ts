import { GoogleGenAI, type Chat, type FunctionCall } from '@google/genai';
import { TOOL_DECLARATIONS } from '../oracle/tools.js';
import { dispatchToolCall, MAX_TOOL_HOPS } from './toolLoop.js';
import { SYSTEM_INSTRUCTION, EVALUATION_INSTRUCTION } from './prompts.js';
import { parseEvaluationJson } from './evaluation.js';
import type {
  EvaluateCandidatesInput,
  EvaluateCandidatesResult,
  LlmProvider,
  ProviderDeps,
  SendHooks,
} from './types.js';

export interface GeminiProviderOptions extends ProviderDeps {
  apiKey: string;
}

export function createGeminiProvider(opts: GeminiProviderOptions): LlmProvider {
  const ai = new GoogleGenAI({ apiKey: opts.apiKey });
  const buildChat = (): Chat =>
    ai.chats.create({
      model: opts.model,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
      },
    });
  let chat = buildChat();

  async function send(message: string, hooks?: SendHooks): Promise<string> {
    let response = await chat.sendMessage({ message });
    let safetyHops = 0;
    while (response.functionCalls && response.functionCalls.length > 0) {
      if (++safetyHops > MAX_TOOL_HOPS) {
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
        const resolved = await dispatchToolCall(name, args, opts, hooks);
        functionResponses.push({
          name,
          response: resolved.result as unknown as Record<string, unknown>,
        });
      }
      response = await chat.sendMessage({
        message: functionResponses.map((fr) => ({
          functionResponse: { name: fr.name, response: fr.response },
        })),
      });
    }
    return response.text ?? '';
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

    const response = await ai.models.generateContent({
      model: opts.model,
      contents: prompt,
      config: {
        systemInstruction: EVALUATION_INSTRUCTION,
        responseMimeType: 'application/json',
      },
    });
    return parseEvaluationJson(response.text ?? '', 'gemini');
  }

  return {
    providerName: 'gemini',
    model: opts.model,
    send,
    reset() {
      chat = buildChat();
    },
    evaluateCandidates,
  };
}
