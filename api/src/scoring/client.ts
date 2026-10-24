import { z } from 'zod';
import type { Config } from '../config.js';
import { stubScore } from './stub.js';
import type { ScoreRequest, ScoreResult } from './stub.js';

/** Resolves to null when the model could not be reached in time: callers fall back to rules only. */
export type Scorer = (req: ScoreRequest) => Promise<ScoreResult | null>;

const responseSchema = z.object({
  risk_score: z.number().min(0).max(1),
  risk_band: z.enum(['low', 'medium', 'high']),
  model_version: z.string(),
  reasons: z.array(z.object({ feature: z.string(), value: z.number(), contribution: z.number() })),
});

/**
 * With ML_SCORE_URL unset, uses the built-in heuristic stub.
 * With it set, calls POST {url}/score and gives up after ML_TIMEOUT_MS (default 800 ms).
 * Any failure (network, timeout, non-2xx, malformed body) returns null, never throws.
 */
export function createScorer(config: Config): Scorer {
  const base = config.mlScoreUrl;
  if (!base) return async (req) => stubScore(req);

  const url = `${base.replace(/\/+$/, '')}/score`;
  return async (req) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.mlTimeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      return responseSchema.parse(await res.json());
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}
