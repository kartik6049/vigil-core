import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireUserOrServiceKey } from '../auth.js';
import { asyncHandler, HttpError } from '../errors.js';
import { TXN_SELECT, txnOut } from '../serialize.js';
import type { AppDeps } from '../types.js';
import { decodeCursor, encodeCursor, limitParam, paginate, parseId } from '../util.js';

const listQuery = z.object({ limit: limitParam(100, 500), cursor: z.string().optional() });
const historyQuery = z.object({ limit: limitParam(20, 200), cursor: z.string().optional() });

export function accountRoutes(deps: AppDeps): Router {
  const { pool, config } = deps;
  const router = Router();

  // Not in the original contract: the simulator needs to know which accounts exist.
  router.get(
    '/',
    requireUserOrServiceKey(config),
    asyncHandler(async (req, res) => {
      const q = listQuery.parse(req.query);
      const cursor = decodeCursor(q.cursor, z.object({ id: z.number() }));
      const params: unknown[] = [cursor?.id ?? 0, q.limit + 1];
      const r = await pool.query(
        `select id, holder_name, kind, merchant_category, city, status
           from accounts where id > $1 order by id limit $2`,
        params,
      );
      const { page, hasMore } = paginate(r.rows, q.limit);
      res.json({
        items: page,
        next_cursor: hasMore ? encodeCursor({ id: page[page.length - 1].id }) : null,
      });
    }),
  );

  // One account, for the case detail page.
  router.get(
    '/:id',
    requireAuth(config),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      const r = await pool.query(
        'select id, holder_name, kind, merchant_category, city, status from accounts where id = $1',
        [id],
      );
      if (!r.rowCount) throw new HttpError(404, 'not_found', 'Account not found');
      res.json(r.rows[0]);
    }),
  );

  // Outgoing history, newest first. Backed by (from_account_id, created_at desc).
  router.get(
    '/:id/transactions',
    requireAuth(config),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      const q = historyQuery.parse(req.query);
      const cursor = decodeCursor(q.cursor, z.object({ ts: z.string(), id: z.number() }));

      const exists = await pool.query('select 1 from accounts where id = $1', [id]);
      if (!exists.rowCount) throw new HttpError(404, 'not_found', 'Account not found');

      const params: unknown[] = [id];
      let cursorSql = '';
      if (cursor) {
        cursorSql = `and (t.created_at, t.id) < ($${params.push(cursor.ts)}::timestamptz, $${params.push(cursor.id)}::bigint)`;
      }
      const r = await pool.query(
        `${TXN_SELECT}
          where t.from_account_id = $1 ${cursorSql}
          order by t.created_at desc, t.id desc
          limit $${params.push(q.limit + 1)}`,
        params,
      );
      const { page, hasMore } = paginate(r.rows, q.limit);
      const last = page[page.length - 1];
      res.json({
        items: page.map(txnOut),
        next_cursor: hasMore && last ? encodeCursor({ ts: last._cur_ts, id: last.id }) : null,
      });
    }),
  );

  return router;
}
