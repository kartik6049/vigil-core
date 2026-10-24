import type { Queryable } from '../db.js';
import { ruleParamSchemas } from './schemas.js';

export interface RuleRow {
  id: number;
  name: string;
  params: unknown;
  enabled: boolean;
}

/** The transaction being evaluated. It is not in the database yet. */
export interface TxnInput {
  fromAccountId: number;
  type: string;
  amount: string;
  ipCity: string | null;
  createdAt: string; // ISO 8601
}

export interface RuleHit {
  rule: string;
  detail: string;
}

type Evaluator = (db: Queryable, txn: TxnInput, params: unknown) => Promise<string | null>;

const parse = <T>(name: string, params: unknown): T => ruleParamSchemas[name].parse(params) as T;

/**
 * One evaluator per rule name. Each returns a human-readable detail when the rule fires,
 * otherwise null. All windows are measured back from the transaction's own timestamp,
 * so replaying or back-dating transactions behaves the same as live traffic.
 */
const evaluators: Record<string, Evaluator> = {
  // 5+ transactions from one account in 10 minutes (counting this one).
  velocity_5_in_10m: async (db, txn, raw) => {
    const p = parse<{ count: number; window_minutes: number }>('velocity_5_in_10m', raw);
    const r = await db.query(
      `select count(*)::int as n
         from transactions
        where from_account_id = $1
          and created_at >  $2::timestamptz - make_interval(mins => $3::int)
          and created_at <= $2::timestamptz`,
      [txn.fromAccountId, txn.createdAt, p.window_minutes],
    );
    const n = (r.rows[0].n as number) + 1;
    return n >= p.count ? `${n} transactions in ${p.window_minutes} minutes` : null;
  },

  // City differs from the account's last N transactions inside the window.
  new_city: async (db, txn, raw) => {
    if (!txn.ipCity) return null;
    const p = parse<{ compare_last_n: number; window_minutes: number }>('new_city', raw);
    const r = await db.query(
      `select ip_city
         from transactions
        where from_account_id = $1
          and ip_city is not null
          and created_at >= $2::timestamptz - make_interval(mins => $3::int)
          and created_at <= $2::timestamptz
        order by created_at desc
        limit $4::int`,
      [txn.fromAccountId, txn.createdAt, p.window_minutes, p.compare_last_n],
    );
    const cities = [...new Set(r.rows.map((row) => row.ip_city as string))];
    if (cities.length === 0 || cities.includes(txn.ipCity)) return null;
    return `${txn.ipCity} differs from recent ${cities.join(', ')}`;
  },

  // Amount over multiplier x the account's average in the window (needs some history).
  amount_spike: async (db, txn, raw) => {
    const p = parse<{ multiplier: number; window_days: number; min_history?: number }>('amount_spike', raw);
    const r = await db.query(
      `select count(*)::int as n, avg(amount)::float8 as avg
         from transactions
        where from_account_id = $1
          and created_at >= $2::timestamptz - make_interval(days => $3::int)
          and created_at <  $2::timestamptz`,
      [txn.fromAccountId, txn.createdAt, p.window_days],
    );
    const { n, avg } = r.rows[0] as { n: number; avg: number | null };
    if (avg === null || n < (p.min_history ?? 3)) return null;
    const amount = Number(txn.amount);
    return amount > p.multiplier * avg
      ? `amount ${amount.toFixed(2)} is ${(amount / avg).toFixed(1)}x the ${p.window_days}-day average`
      : null;
  },

  // Quiet for N days, then a large transfer.
  dormant_account: async (db, txn, raw) => {
    const p = parse<{ inactive_days: number; min_amount: number }>('dormant_account', raw);
    if (txn.type !== 'TRANSFER' || Number(txn.amount) < p.min_amount) return null;
    const r = await db.query(
      `select max(created_at) as last_seen
         from transactions
        where from_account_id = $1 and created_at < $2::timestamptz`,
      [txn.fromAccountId, txn.createdAt],
    );
    const last = r.rows[0].last_seen as Date | null;
    if (!last) return null; // a brand-new account is not "dormant"
    const idleDays = (Date.parse(txn.createdAt) - last.getTime()) / 86_400_000;
    return idleDays >= p.inactive_days ? `large transfer after ${Math.floor(idleDays)} idle days` : null;
  },
};

/** Evaluates every enabled rule in parallel. A rule that errors is logged and skipped, never fatal. */
export async function runRules(db: Queryable, rules: RuleRow[], txn: TxnInput): Promise<RuleHit[]> {
  const results = await Promise.all(
    rules
      .filter((r) => r.enabled && evaluators[r.name])
      .map(async (r): Promise<RuleHit | null> => {
        try {
          const detail = await evaluators[r.name](db, txn, r.params);
          return detail ? { rule: r.name, detail } : null;
        } catch (err) {
          console.error(`rule ${r.name} failed`, err);
          return null;
        }
      }),
  );
  return results.filter((h): h is RuleHit => h !== null);
}
