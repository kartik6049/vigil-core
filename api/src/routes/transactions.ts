import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireServiceKey } from '../auth.js';
import { asyncHandler, HttpError } from '../errors.js';
import { TXN_SELECT, txnOut } from '../serialize.js';
import { ingestTransaction } from '../services/ingest.js';
import type { AppDeps } from '../types.js';
import { decodeCursor, encodeCursor, isoDate, limitParam, moneyString, paginate, parseId } from '../util.js';

const ingestBody = z.object({
  external_ref: z.string().trim().min(1).max(128),
  from_account_id: z.number().int().positive(),
  to_account_id: z.number().int().positive(),
  type: z.enum(['PAYMENT', 'TRANSFER', 'CASH_OUT', 'CASH_IN', 'DEBIT']),
  channel: z.enum(['UPI', 'CARD', 'NETBANKING', 'WALLET']),
  amount: moneyString.refine((v) => Number(v) > 0, 'must be greater than 0'),
  old_balance_orig: moneyString.nullish(),
  new_balance_orig: moneyString.nullish(),
  old_balance_dest: moneyString.nullish(),
  new_balance_dest: moneyString.nullish(),
  ip_city: z.string().trim().max(80).nullish(),
  device_id: z.string().trim().max(128).nullish(),
  created_at: z.string().datetime({ offset: true }).optional(),
});

const listQuery = z.object({
  status: z.enum(['approved', 'flagged', 'blocked', 'cleared']).optional(),
  band: z.enum(['low', 'medium', 'high']).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: limitParam(50, 200),
  cursor: z.string().optional(),
});

const cursorShape = z.object({ ts: z.string(), id: z.number() });

export function transactionRoutes(deps: AppDeps): Router {
  const { pool, config } = deps;
  const router = Router();

  // Ingest (service key). 201 when new, 200 when the external_ref was already processed.
  router.post(
    '/',
    requireServiceKey(config),
    asyncHandler(async (req, res) => {
      const result = await ingestTransaction(deps, ingestBody.parse(req.body));
      res.status(result.created ? 201 : 200).json({
        transaction: result.transaction,
        case: result.case,
        duplicate: !result.created,
      });
    }),
  );

  router.get(
    '/',
    requireAuth(config),
    asyncHandler(async (req, res) => {
      const q = listQuery.parse(req.query);
      const cursor = decodeCursor(q.cursor, cursorShape);

      const where: string[] = [];
      const params: unknown[] = [];
      if (q.status) where.push(`t.status = $${params.push(q.status)}::txn_status`);
      if (q.band) where.push(`t.risk_band = $${params.push(q.band)}::risk_band`);
      if (q.from) where.push(`t.created_at >= $${params.push(q.from)}::timestamptz`);
      if (q.to) where.push(`t.created_at <= $${params.push(q.to)}::timestamptz`);
      if (cursor) {
        where.push(`(t.created_at, t.id) < ($${params.push(cursor.ts)}::timestamptz, $${params.push(cursor.id)}::bigint)`);
      }
      const sql = `${TXN_SELECT}
        ${where.length ? `where ${where.join(' and ')}` : ''}
        order by t.created_at desc, t.id desc
        limit $${params.push(q.limit + 1)}`;

      const { page, hasMore } = paginate((await pool.query(sql, params)).rows, q.limit);
      const last = page[page.length - 1];
      res.json({
        items: page.map(txnOut),
        next_cursor: hasMore && last ? encodeCursor({ ts: last._cur_ts, id: last.id }) : null,
      });
    }),
  );

  router.get(
    '/:id',
    requireAuth(config),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      const r = await pool.query(
        `select t.id, t.external_ref, t.from_account_id, t.to_account_id, t.type, t.channel, t.amount,
                t.old_balance_orig, t.new_balance_orig, t.old_balance_dest, t.new_balance_dest,
                t.ip_city, t.device_id, t.created_at, t.risk_score, t.risk_band, t.model_version,
                t.reasons, t.status,
                fa.holder_name as from_name, fa.city as from_city, fa.status as from_status, fa.kind as from_kind,
                ta.holder_name as to_name, ta.city as to_city, ta.status as to_status, ta.kind as to_kind,
                ta.merchant_category as to_category,
                c.id as case_id, c.status as case_status, c.priority as case_priority, c.version as case_version
           from transactions t
           join accounts fa on fa.id = t.from_account_id
           join accounts ta on ta.id = t.to_account_id
           left join cases c on c.transaction_id = t.id
          where t.id = $1`,
        [id],
      );
      const row = r.rows[0];
      if (!row) throw new HttpError(404, 'not_found', 'Transaction not found');
      res.json({
        ...txnOut(row),
        from_account: { id: row.from_account_id, holder_name: row.from_name, city: row.from_city, kind: row.from_kind, status: row.from_status },
        to_account: {
          id: row.to_account_id, holder_name: row.to_name, city: row.to_city, kind: row.to_kind,
          merchant_category: row.to_category ?? null, status: row.to_status,
        },
        case: row.case_id
          ? { id: row.case_id, status: row.case_status, priority: row.case_priority, version: row.case_version }
          : null,
      });
    }),
  );

  return router;
}
