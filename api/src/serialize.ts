import type { QueryResultRow } from 'pg';
import type { Queryable } from './db.js';
import { iso } from './util.js';

/** Column list shared by every query that returns a transaction. `_cur_ts` keeps microsecond precision for cursors. */
export const TXN_SELECT = `
  select t.id, t.external_ref, t.from_account_id, t.to_account_id, t.type, t.channel, t.amount,
         t.old_balance_orig, t.new_balance_orig, t.old_balance_dest, t.new_balance_dest,
         t.ip_city, t.device_id, t.created_at, t.created_at::text as _cur_ts,
         t.risk_score, t.risk_band, t.model_version, t.reasons, t.status
    from transactions t`;

export function txnOut(r: QueryResultRow) {
  return {
    id: r.id as number,
    external_ref: r.external_ref as string,
    from_account_id: r.from_account_id as number,
    to_account_id: r.to_account_id as number,
    type: r.type as string,
    channel: r.channel as string,
    amount: r.amount as string, // numeric comes back as an exact decimal string
    old_balance_orig: (r.old_balance_orig ?? null) as string | null,
    new_balance_orig: (r.new_balance_orig ?? null) as string | null,
    old_balance_dest: (r.old_balance_dest ?? null) as string | null,
    new_balance_dest: (r.new_balance_dest ?? null) as string | null,
    ip_city: (r.ip_city ?? null) as string | null,
    device_id: (r.device_id ?? null) as string | null,
    created_at: iso(r.created_at),
    risk_score: r.risk_score === null || r.risk_score === undefined ? null : Number(r.risk_score),
    risk_band: (r.risk_band ?? null) as string | null,
    model_version: (r.model_version ?? null) as string | null,
    reasons: r.reasons as unknown[],
    status: r.status as string,
  };
}

export type TxnOut = ReturnType<typeof txnOut>;

export async function getTransaction(db: Queryable, id: number): Promise<TxnOut | null> {
  const r = await db.query(`${TXN_SELECT} where t.id = $1`, [id]);
  return r.rows[0] ? txnOut(r.rows[0]) : null;
}

export async function getTransactionByRef(db: Queryable, ref: string): Promise<TxnOut | null> {
  const r = await db.query(`${TXN_SELECT} where t.external_ref = $1`, [ref]);
  return r.rows[0] ? txnOut(r.rows[0]) : null;
}
