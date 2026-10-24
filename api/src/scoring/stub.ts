export type RiskBand = 'low' | 'medium' | 'high';

export interface ScoreRequest {
  transaction_id: string;
  type: string;
  amount: number;
  hour_of_day: number;
  old_balance_orig: number | null;
  new_balance_orig: number | null;
  old_balance_dest: number | null;
  new_balance_dest: number | null;
}

export interface ScoreReason {
  feature: string;
  value: number;
  contribution: number;
}

export interface ScoreResult {
  risk_score: number;
  risk_band: RiskBand;
  model_version: string;
  reasons: ScoreReason[];
}

/** low < 0.30, medium 0.30-0.70, high >= 0.70 (shared contract; tuned later in vigil-ml). */
export function bandFor(score: number): RiskBand {
  if (score >= 0.7) return 'high';
  if (score >= 0.3) return 'medium';
  return 'low';
}

/**
 * Heuristic stand-in for the ML model, used until vigil-ml is deployed.
 * It mirrors the real response shape so the rest of the system cannot tell the difference.
 */
export function stubScore(req: ScoreRequest): ScoreResult {
  const parts: ScoreReason[] = [];
  const add = (feature: string, value: number, contribution: number) => {
    if (contribution > 0) parts.push({ feature, value, contribution });
  };

  add('amount', req.amount, req.amount >= 100_000 ? 0.3 : req.amount >= 20_000 ? 0.18 : req.amount >= 5_000 ? 0.06 : 0);

  const risky = req.type === 'TRANSFER' || req.type === 'CASH_OUT';
  add(`type_${req.type}`, 1, risky ? 0.2 : 0);

  const { old_balance_orig: oldO, new_balance_orig: newO, old_balance_dest: oldD, new_balance_dest: newD } = req;
  const drained = oldO !== null && newO !== null && oldO > 0 && newO <= oldO * 0.01;
  add('balance_drained', drained ? 1 : 0, drained ? 0.25 : 0);

  const emptyDest = oldD === 0 && newD === 0 && risky;
  add('dest_balance_unchanged', emptyDest ? 1 : 0, emptyDest ? 0.12 : 0);

  const night = req.hour_of_day >= 0 && req.hour_of_day < 6;
  add('hour_of_day', req.hour_of_day, night ? 0.08 : 0);

  const raw = 0.05 + parts.reduce((sum, p) => sum + p.contribution, 0);
  const score = Math.min(0.99, Math.max(0.01, raw));
  parts.sort((a, b) => b.contribution - a.contribution);

  return {
    risk_score: Math.round(score * 10_000) / 10_000,
    risk_band: bandFor(score),
    model_version: 'stub-v1',
    reasons: parts.slice(0, 5),
  };
}
