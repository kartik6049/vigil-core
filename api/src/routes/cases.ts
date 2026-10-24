import { Router } from 'express';
import type { QueryResultRow } from 'pg';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { requireAuth, requireRole } from '../auth.js';
import { withTx } from '../db.js';
import type { Queryable } from '../db.js';
import { asyncHandler, HttpError } from '../errors.js';
import type { AppDeps } from '../types.js';
import { decodeCursor, encodeCursor, iso, limitParam, paginate, parseId } from '../util.js';

/** A case joined with its transaction and assignee: the shape the console and Android app render. */
const CASE_SELECT = `
  select c.id, c.transaction_id, c.status, c.priority, c.assigned_to, u.name as assigned_to_name,
         c.opened_at, c.opened_at::text as _cur_ts, c.resolved_at, c.resolution_note, c.version,
         t.amount, t.type, t.channel, t.risk_score, t.risk_band, t.status as txn_status,
         t.created_at as txn_created_at, t.reasons, t.from_account_id, t.to_account_id, t.ip_city
    from cases c
    join transactions t on t.id = c.transaction_id
    left join users u on u.id = c.assigned_to`;

export function caseOut(r: QueryResultRow) {
  return {
    id: r.id as number,
    transaction_id: r.transaction_id as number,
    status: r.status as string,
    priority: r.priority as number,
    assigned_to: (r.assigned_to ?? null) as string | null,
    assigned_to_name: (r.assigned_to_name ?? null) as string | null,
    opened_at: iso(r.opened_at),
    resolved_at: r.resolved_at ? iso(r.resolved_at) : null,
    resolution_note: (r.resolution_note ?? null) as string | null,
    version: r.version as number,
    transaction: {
      id: r.transaction_id as number,
      amount: r.amount as string,
      type: r.type as string,
      channel: r.channel as string,
      risk_score: r.risk_score === null || r.risk_score === undefined ? null : Number(r.risk_score),
      risk_band: (r.risk_band ?? null) as string | null,
      status: r.txn_status as string,
      created_at: iso(r.txn_created_at),
      reasons: r.reasons as unknown[],
      from_account_id: r.from_account_id as number,
      to_account_id: r.to_account_id as number,
      ip_city: (r.ip_city ?? null) as string | null,
    },
  };
}

async function getCase(db: Queryable, id: number) {
  const r = await db.query(`${CASE_SELECT} where c.id = $1`, [id]);
  return r.rows[0] ? caseOut(r.rows[0]) : null;
}

const listQuery = z.object({
  status: z.enum(['active', 'open', 'in_review', 'blocked', 'cleared']).default('active'),
  priority: z.coerce.number().int().min(1).max(5).optional(),
  limit: limitParam(50, 200),
  cursor: z.string().optional(),
});
const cursorShape = z.object({ p: z.number(), ts: z.string(), id: z.number() });

const resolveBody = z.object({
  decision: z.enum(['blocked', 'cleared']),
  note: z.string().trim().min(3, 'a note of at least 3 characters is required').max(1000),
  version: z.number().int().min(0),
});

export function caseRoutes(deps: AppDeps): Router {
  const { pool, config, hub } = deps;
  const router = Router();
  const auth = requireAuth(config);
  const analystOnly = requireRole('analyst');

  const publishUpdate = (c: ReturnType<typeof caseOut>) => hub.publish('case.updated', c);

  // The work queue. 'active' (default) = open + in_review, served by the partial index cases_queue_idx.
  router.get(
    '/',
    auth,
    asyncHandler(async (req, res) => {
      const q = listQuery.parse(req.query);
      const cursor = decodeCursor(q.cursor, cursorShape);
      const where: string[] = [];
      const params: unknown[] = [];

      if (q.status === 'active') where.push(`c.status in ('open', 'in_review')`);
      else where.push(`c.status = $${params.push(q.status)}::case_status`);
      if (q.priority) where.push(`c.priority = $${params.push(q.priority)}::smallint`);
      if (cursor) {
        where.push(
          `(c.priority, c.opened_at, c.id) > ($${params.push(cursor.p)}::smallint, $${params.push(cursor.ts)}::timestamptz, $${params.push(cursor.id)}::bigint)`,
        );
      }
      const r = await pool.query(
        `${CASE_SELECT}
          where ${where.join(' and ')}
          order by c.priority, c.opened_at, c.id
          limit $${params.push(q.limit + 1)}`,
        params,
      );
      const { page, hasMore } = paginate(r.rows, q.limit);
      const last = page[page.length - 1];
      res.json({
        items: page.map(caseOut),
        next_cursor: hasMore && last ? encodeCursor({ p: last.priority, ts: last._cur_ts, id: last.id }) : null,
      });
    }),
  );

  // Atomically claim the highest-priority, oldest open case.
  // FOR UPDATE SKIP LOCKED: if another analyst's transaction already holds a row lock,
  // we skip that row and take the next one instead of waiting or double-claiming.
  router.post(
    '/next',
    auth,
    analystOnly,
    asyncHandler(async (req, res) => {
      const userId = req.user!.id;
      const claimedId = await withTx(pool, async (c) => {
        const r = await c.query(
          `with next as (
             select id from cases
              where status = 'open'
              order by priority, opened_at
              for update skip locked
              limit 1
           )
           update cases c
              set status = 'in_review', assigned_to = $1, version = c.version + 1
             from next
            where c.id = next.id
        returning c.id, c.version`,
          [userId],
        );
        if (!r.rowCount) return null;
        const { id, version } = r.rows[0] as { id: number; version: number };
        await writeAudit(c, {
          actorId: userId,
          action: 'case.claim',
          entityType: 'case',
          entityId: String(id),
          before: { status: 'open', assigned_to: null },
          after: { status: 'in_review', assigned_to: userId, version },
        });
        return id;
      });
      if (claimedId === null) throw new HttpError(404, 'no_open_cases', 'There are no open cases to claim');

      const out = (await getCase(pool, claimedId))!;
      publishUpdate(out);
      res.json(out);
    }),
  );

  router.get(
    '/:id',
    auth,
    asyncHandler(async (req, res) => {
      const out = await getCase(pool, parseId(req.params.id));
      if (!out) throw new HttpError(404, 'not_found', 'Case not found');
      res.json(out);
    }),
  );

  // Claim a specific case. The row lock makes two simultaneous claims serialise:
  // the second one waits, then sees status = in_review and gets 409.
  router.post(
    '/:id/claim',
    auth,
    analystOnly,
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      const userId = req.user!.id;
      await withTx(pool, async (c) => {
        const cur = await c.query('select status, version from cases where id = $1 for update', [id]);
        const row = cur.rows[0] as { status: string; version: number } | undefined;
        if (!row) throw new HttpError(404, 'not_found', 'Case not found');
        if (row.status !== 'open') {
          throw new HttpError(409, 'already_claimed', `Case is already ${row.status.replace('_', ' ')}`);
        }
        const upd = await c.query(
          `update cases set status = 'in_review', assigned_to = $1, version = version + 1
            where id = $2 returning version`,
          [userId, id],
        );
        await writeAudit(c, {
          actorId: userId,
          action: 'case.claim',
          entityType: 'case',
          entityId: String(id),
          before: { status: 'open', assigned_to: null },
          after: { status: 'in_review', assigned_to: userId, version: upd.rows[0].version },
        });
      });
      const out = (await getCase(pool, id))!;
      publishUpdate(out);
      res.json(out);
    }),
  );

  // Resolve in one transaction: lock the case, verify version and assignee, update the case,
  // update the transaction, block the account if needed, write the audit rows, commit.
  // Any failed check throws, so nothing is written (409 for conflicts).
  router.post(
    '/:id/resolve',
    auth,
    analystOnly,
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      const body = resolveBody.parse(req.body);
      const userId = req.user!.id;

      await withTx(pool, async (c) => {
        const cur = await c.query(
          `select c.status, c.version, c.assigned_to, c.resolution_note, t.id as txn_id, t.from_account_id
             from cases c join transactions t on t.id = c.transaction_id
            where c.id = $1
              for update of c`,
          [id],
        );
        const row = cur.rows[0] as
          | { status: string; version: number; assigned_to: string | null; resolution_note: string | null; txn_id: number; from_account_id: number }
          | undefined;
        if (!row) throw new HttpError(404, 'not_found', 'Case not found');
        if (row.version !== body.version) {
          throw new HttpError(409, 'version_conflict', 'Case was changed by someone else; reload and try again');
        }
        if (row.status !== 'in_review') {
          throw new HttpError(409, 'not_in_review', `Case is ${row.status.replace('_', ' ')}, not in review`);
        }
        if (row.assigned_to !== userId) {
          throw new HttpError(409, 'not_assignee', 'Case is assigned to another analyst');
        }

        const upd = await c.query(
          `update cases
              set status = $2::case_status, resolved_at = now(), resolution_note = $3, version = version + 1
            where id = $1
        returning version`,
          [id, body.decision, body.note],
        );
        await c.query('update transactions set status = $2::txn_status where id = $1', [row.txn_id, body.decision]);

        await writeAudit(c, {
          actorId: userId,
          action: body.decision === 'blocked' ? 'case.block' : 'case.clear',
          entityType: 'case',
          entityId: String(id),
          before: { status: 'in_review', version: row.version, resolution_note: row.resolution_note },
          after: { status: body.decision, version: upd.rows[0].version, resolution_note: body.note },
        });

        if (body.decision === 'blocked') {
          const acc = await c.query(
            `update accounts set status = 'blocked' where id = $1 and status <> 'blocked' returning id`,
            [row.from_account_id],
          );
          if (acc.rowCount) {
            await writeAudit(c, {
              actorId: userId,
              action: 'account.block',
              entityType: 'account',
              entityId: String(row.from_account_id),
              before: { status: 'active' },
              after: { status: 'blocked', reason: `case ${id}` },
            });
          }
        }
      });

      const out = (await getCase(pool, id))!;
      publishUpdate(out);
      res.json(out);
    }),
  );

  return router;
}
