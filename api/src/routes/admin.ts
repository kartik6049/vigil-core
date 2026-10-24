import { Router } from 'express';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { requireAuth, requireRole, requireServiceKey } from '../auth.js';
import { withTx } from '../db.js';
import { asyncHandler, HttpError } from '../errors.js';
import { ruleParamSchemas } from '../rules/schemas.js';
import type { AppDeps } from '../types.js';
import { decodeCursor, encodeCursor, isoDate, limitParam, paginate, parseId } from '../util.js';

const auditQuery = z.object({
  actor_id: z.string().uuid().optional(),
  entity_type: z.string().max(40).optional(),
  entity_id: z.string().max(64).optional(),
  action: z.string().max(60).optional(),
  limit: limitParam(50, 200),
  cursor: z.string().optional(),
});

const patchRuleBody = z
  .object({ enabled: z.boolean().optional(), params: z.record(z.unknown()).optional() })
  .refine((b) => b.enabled !== undefined || b.params !== undefined, 'provide enabled and/or params');

const metricsQuery = z.object({ from: isoDate.optional(), to: isoDate.optional() });
const deviceBody = z.object({ fcm_token: z.string().min(10).max(4096) });
const labelsBody = z.object({
  labels: z
    .array(z.object({ external_ref: z.string().min(1).max(128), is_fraud: z.boolean(), reported_at: z.string().datetime({ offset: true }).optional() }))
    .min(1)
    .max(500),
});

export function adminRoutes(deps: AppDeps): Router {
  const { pool, config } = deps;
  const router = Router();
  const auth = requireAuth(config);
  const adminOnly = requireRole('admin');

  /* ---------- audit log (admin) ---------- */
  router.get(
    '/audit',
    auth,
    adminOnly,
    asyncHandler(async (req, res) => {
      const q = auditQuery.parse(req.query);
      const cursor = decodeCursor(q.cursor, z.object({ id: z.number() }));
      const where: string[] = [];
      const params: unknown[] = [];
      if (q.actor_id) where.push(`a.actor_id = $${params.push(q.actor_id)}::uuid`);
      if (q.entity_type) where.push(`a.entity_type = $${params.push(q.entity_type)}`);
      if (q.entity_id) where.push(`a.entity_id = $${params.push(q.entity_id)}`);
      if (q.action) where.push(`a.action = $${params.push(q.action)}`);
      if (cursor) where.push(`a.id < $${params.push(cursor.id)}::bigint`);
      const r = await pool.query(
        `select a.id, a.actor_id, u.email as actor_email, u.name as actor_name,
                a.action, a.entity_type, a.entity_id, a.before, a.after, a.created_at
           from audit_log a left join users u on u.id = a.actor_id
          ${where.length ? `where ${where.join(' and ')}` : ''}
          order by a.id desc
          limit $${params.push(q.limit + 1)}`,
        params,
      );
      const { page, hasMore } = paginate(r.rows, q.limit);
      res.json({
        items: page.map((x) => ({ ...x, created_at: new Date(x.created_at).toISOString() })),
        next_cursor: hasMore ? encodeCursor({ id: page[page.length - 1].id }) : null,
      });
    }),
  );

  /* ---------- rules (admin) ---------- */
  router.get(
    '/rules',
    auth,
    adminOnly,
    asyncHandler(async (_req, res) => {
      const r = await pool.query('select id, name, params, enabled from rules order by id');
      res.json({ items: r.rows });
    }),
  );

  router.patch(
    '/rules/:id',
    auth,
    adminOnly,
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      const body = patchRuleBody.parse(req.body);
      const updated = await withTx(pool, async (c) => {
        const cur = await c.query('select id, name, params, enabled from rules where id = $1 for update', [id]);
        const before = cur.rows[0];
        if (!before) throw new HttpError(404, 'not_found', 'Rule not found');

        let params = before.params as unknown;
        if (body.params !== undefined) {
          const schema = ruleParamSchemas[before.name as string];
          if (!schema) throw new HttpError(422, 'unknown_rule', `No parameter schema for rule ${before.name}`);
          const parsed = schema.safeParse(body.params);
          if (!parsed.success) {
            throw new HttpError(400, 'validation_error', parsed.error.issues.map((i) => `params.${i.path.join('.')}: ${i.message}`).join('; '));
          }
          params = parsed.data;
        }
        const enabled = body.enabled ?? (before.enabled as boolean);
        const upd = await c.query(
          'update rules set params = $2::jsonb, enabled = $3 where id = $1 returning id, name, params, enabled',
          [id, JSON.stringify(params), enabled],
        );
        await writeAudit(c, {
          actorId: req.user!.id,
          action: 'rule.update',
          entityType: 'rule',
          entityId: String(id),
          before: { name: before.name, params: before.params, enabled: before.enabled },
          after: { name: before.name, params, enabled },
        });
        return upd.rows[0];
      });
      res.json(updated);
    }),
  );

  /* ---------- model health ---------- */
  router.get(
    '/model/metrics',
    auth,
    asyncHandler(async (req, res) => {
      const q = metricsQuery.parse(req.query);
      const params: unknown[] = [];
      const where: string[] = [];
      if (q.from) where.push(`day >= $${params.push(q.from)}::date`);
      if (q.to) where.push(`day <= $${params.push(q.to)}::date`);
      const r = await pool.query(
        `select day::text as day, model_version,
                precision_at_t::float8 as precision_at_t, recall_at_t::float8 as recall_at_t,
                pr_auc::float8 as pr_auc, psi_amount::float8 as psi_amount, psi_score::float8 as psi_score
           from model_metrics_daily
          ${where.length ? `where ${where.join(' and ')}` : ''}
          order by day, model_version
          limit 730`,
        params,
      );
      res.json({ items: r.rows });
    }),
  );

  /* ---------- push tokens ---------- */
  router.post(
    '/devices/register',
    auth,
    asyncHandler(async (req, res) => {
      const { fcm_token } = deviceBody.parse(req.body);
      await pool.query(
        `insert into device_tokens (fcm_token, user_id) values ($1, $2)
         on conflict (fcm_token) do update set user_id = excluded.user_id, updated_at = now()`,
        [fcm_token, req.user!.id],
      );
      res.json({ ok: true });
    }),
  );

  /* ---------- delayed fraud labels (service key; the simulator's chargeback feed) ---------- */
  router.post(
    '/ground-truth',
    requireServiceKey(config),
    asyncHandler(async (req, res) => {
      const { labels } = labelsBody.parse(req.body);
      const r = await pool.query(
        `insert into ground_truth (transaction_id, is_fraud, reported_at)
         select t.id, l.is_fraud, coalesce(l.reported_at, now())
           from unnest($1::text[], $2::boolean[], $3::timestamptz[]) as l(ref, is_fraud, reported_at)
           join transactions t on t.external_ref = l.ref
         on conflict (transaction_id) do nothing`,
        [labels.map((l) => l.external_ref), labels.map((l) => l.is_fraud), labels.map((l) => l.reported_at ?? null)],
      );
      res.json({ received: labels.length, inserted: r.rowCount ?? 0 });
    }),
  );

  return router;
}
