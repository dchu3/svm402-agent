import { z } from 'zod';
import type { EvaluateCandidatesResult } from './types.js';
import { warnWatchlist } from '../util/log.js';

const RankedCandidateSchema = z.object({
  address: z.string().transform((s) => s.toLowerCase()),
  score: z.number(),
  reasoning: z.string().default(''),
});

const ReplacementProposalSchema = z.object({
  add: z.string().transform((s) => s.toLowerCase()),
  remove: z.string().transform((s) => s.toLowerCase()),
});

export const EvaluationResponseSchema = z.object({
  ranked: z.array(RankedCandidateSchema).default([]),
  replacements: z.array(ReplacementProposalSchema).default([]),
});

/**
 * Parse the LLM's JSON evaluation reply with the same fall-back behaviour
 * regardless of which provider produced it. Invalid JSON or schema
 * violations log a warning and return an empty result so the scheduler
 * keeps running.
 */
export function parseEvaluationJson(text: string, provider: string): EvaluateCandidatesResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    warnWatchlist('evaluateCandidates JSON parse failed; treating result as empty', {
      provider,
      error: err instanceof Error ? err.message : String(err),
      snippet: text.slice(0, 200),
    });
    return { ranked: [], replacements: [] };
  }
  const result = EvaluationResponseSchema.safeParse(parsed);
  if (!result.success) {
    warnWatchlist('evaluateCandidates schema validation failed; treating result as empty', {
      provider,
      error: result.error.message,
      snippet: text.slice(0, 500),
    });
    return { ranked: [], replacements: [] };
  }
  return result.data;
}
