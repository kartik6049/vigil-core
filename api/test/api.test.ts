import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bearer, HIGH, ingest, login, LOW, makeCtx, minutesAgo, openCase, resetDb, SERVICE_KEY } from './helpers.js';
import type { Ctx } from './helpers.js';

let ctx: Ctx;
let analyst: string;
let admin: string;

beforeAll(() => {
  ctx = makeCtx();
});
afterAll(() => ctx.pool.end());
beforeEach(async () => {
  await resetDb(ctx.pool);
  analyst = await login(ctx.app, 'analyst1@test');
  admin = await login(ctx.app, 'admin@test');
});

const get = (token: string, path: string) => request(ctx.app).get(path).set(bearer(token));

describe('transaction queries', () => {
  it('lists newest first and filters by status and band', async () => {
    await ingest(ctx.app, { ...LOW, created_at: minutesAgo(5) });
    await ingest(ctx.app, { ...HIGH, created_at: minutesAgo(3) });
    await ingest(ctx.app, { ...LOW, created_at: minutesAgo(1) });

    const all = await get(analyst, '/transactions');
    expect(all.body.items).toHaveLength(3);
    expect(all.body.items.map((t: { amount: string }) => t.amount)).toEqual(['250.00', '150000.00', '250.00']);

    expect((await get(analyst, '/transactions?status=flagged')).body.items).toHaveLength(1);
    expect((await get(analyst, '/transactions?band=high')).body.items).toHaveLength(1);
    expect((await get(analyst, '/transactions?band=low')).body.items).toHaveLength(2);
    expect((await get(analyst, `/transactions?from=${encodeURIComponent(minutesAgo(2))}`)).body.items).toHaveLength(1);
    expect((await get(analyst, '/transactions?status=nonsense')).status).toBe(400);
  });

  it('paginates by cursor with no gaps or repeats, including rows with identical timestamps', async () => {
    const sameInstant = minutesAgo(10);
    const refs: string[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await ingest(ctx.app, { ...LOW, created_at: sameInstant });
      refs.push(res.body.transaction.external_ref);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: request.Response = await get(analyst, `/transactions?limit=3${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...page.body.items.map((t: { external_ref: string }) => t.external_ref));
      cursor = page.body.next_cursor;
    } while (cursor);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(seen).toEqual([...refs].reverse()); // same timestamp: ties broken by id, newest first
  });

  it('returns full detail with reasons, both accounts and the linked case', async () => {
    const created = await ingest(ctx.app, { ...HIGH });
    const res = await get(analyst, `/transactions/${created.body.transaction.id}`);
    expect(res.status).toBe(200);
    expect(res.body.reasons.length).toBeGreaterThan(0);
    expect(res.body.from_account).toMatchObject({ holder_name: 'Customer One', city: 'Pune', status: 'active' });
    expect(res.body.to_account).toMatchObject({ holder_name: 'Fuel Merchant', merchant_category: 'fuel' });
    expect(res.body.case).toMatchObject({ id: created.body.case.id, status: 'open' });
    expect((await get(analyst, '/transactions/99999')).status).toBe(404);
  });

  it("returns an account's recent outgoing history", async () => {
    for (let i = 0; i < 3; i++) await ingest(ctx.app, { ...LOW, from_account_id: 1, created_at: minutesAgo(50 - i * 20) });
    await ingest(ctx.app, { ...LOW, from_account_id: 2 });
    const res = await get(analyst, '/accounts/1/transactions?limit=2');
    expect(res.body.items).toHaveLength(2);
    expect(res.body.next_cursor).toEqual(expect.any(String));
    expect((await get(analyst, '/accounts/999/transactions')).status).toBe(404);
  });

  it('lists accounts for a user or the service key, but not anonymously', async () => {
    expect((await get(analyst, '/accounts')).body.items).toHaveLength(4);
    const svc = await request(ctx.app).get('/accounts').set('X-Service-Key', SERVICE_KEY);
    expect(svc.status).toBe(200);
    expect((await request(ctx.app).get('/accounts')).status).toBe(401);
  });
});

describe('stats', () => {
  it('overview reports counts, blocked amount, open cases and median resolve time', async () => {
    await ingest(ctx.app, { ...LOW });
    await openCase(ctx.app, 1);
    await openCase(ctx.app, 2);
    const claimed = await request(ctx.app).post('/cases/next').set(bearer(analyst));
    await request(ctx.app)
      .post(`/cases/${claimed.body.id}/resolve`)
      .set(bearer(analyst))
      .send({ decision: 'blocked', note: 'Confirmed fraud', version: claimed.body.version });

    const res = await get(analyst, '/stats/overview?range=24h');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ range: '24h', txn_count: 3, flagged_count: 2, blocked_amount: '150000.00', open_cases: 1 });
    expect(res.body.median_time_to_resolve_seconds).toEqual(expect.any(Number));
    expect((await get(analyst, '/stats/overview?range=3y')).status).toBe(400);
  });

  it('hourly reads the materialized view (stale until refreshed, then current)', async () => {
    await ingest(ctx.app, { ...LOW });
    await ingest(ctx.app, { ...HIGH });
    expect((await get(analyst, '/stats/hourly')).body.items).toHaveLength(0);

    await ctx.pool.query('select refresh_hourly_stats()');
    const res = await get(analyst, '/stats/hourly');
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ txn_count: 2, flagged_count: 1, blocked_amount: '0.00' });
    expect(res.body.items[0].avg_risk).toEqual(expect.any(Number));
    expect((await get(analyst, '/stats/hourly?from=2020-01-01&to=2026-01-01')).status).toBe(400);
  });

  it('merchants and cities aggregate flagged transactions', async () => {
    await ingest(ctx.app, { ...HIGH, to_account_id: 4, ip_city: 'Jaipur' });
    await ingest(ctx.app, { ...LOW, to_account_id: 4, from_account_id: 2 });
    await ingest(ctx.app, { ...LOW, to_account_id: 3 });

    const merchants = await get(analyst, '/stats/merchants?range=7d');
    const gaming = merchants.body.items.find((m: { category: string }) => m.category === 'gaming');
    expect(gaming).toMatchObject({ txn_count: 2, flagged_count: 1, flag_rate: 0.5, confirmed_fraud_count: 0 });

    const cities = await get(analyst, '/stats/cities');
    expect(cities.body.items).toEqual([expect.objectContaining({ city: 'Jaipur', flagged_count: 1 })]);
  });

  it('delayed ground-truth labels flow into confirmed fraud counts, idempotently', async () => {
    const t = await ingest(ctx.app, { ...HIGH, to_account_id: 4 });
    const ref = t.body.transaction.external_ref;
    const body = { labels: [{ external_ref: ref, is_fraud: true }, { external_ref: 'unknown-ref', is_fraud: false }] };
    const first = await request(ctx.app).post('/ground-truth').set('X-Service-Key', SERVICE_KEY).send(body);
    const again = await request(ctx.app).post('/ground-truth').set('X-Service-Key', SERVICE_KEY).send(body);
    expect(first.body).toEqual({ received: 2, inserted: 1 });
    expect(again.body).toEqual({ received: 2, inserted: 0 });
    expect((await request(ctx.app).post('/ground-truth').send(body)).status).toBe(401);

    const merchants = await get(analyst, '/stats/merchants');
    expect(merchants.body.items[0]).toMatchObject({ category: 'gaming', confirmed_fraud_count: 1 });
  });

  it('model metrics returns stored daily rows as numbers', async () => {
    await ctx.pool.query(
      `insert into model_metrics_daily (day, model_version, precision_at_t, recall_at_t, pr_auc, psi_amount, psi_score)
       values ('2026-10-01', 'lgbm-test', 0.91, 0.72, 0.8, 0.05, 0.07), ('2026-10-02', 'lgbm-test', 0.9, 0.7, 0.79, 0.06, 0.08)`,
    );
    const res = await get(analyst, '/model/metrics?from=2026-10-02');
    expect(res.body.items).toEqual([
      { day: '2026-10-02', model_version: 'lgbm-test', precision_at_t: 0.9, recall_at_t: 0.7, pr_auc: 0.79, psi_amount: 0.06, psi_score: 0.08 },
    ]);
  });
});

describe('admin: rules and audit', () => {
  it('lists rules and applies a validated patch, writing an audit row with before and after', async () => {
    const list = await get(admin, '/rules');
    expect(list.body.items.map((r: { name: string }) => r.name)).toContain('velocity_5_in_10m');
    const rule = list.body.items.find((r: { name: string }) => r.name === 'velocity_5_in_10m');

    const res = await request(ctx.app)
      .patch(`/rules/${rule.id}`)
      .set(bearer(admin))
      .send({ params: { count: 3, window_minutes: 5 }, enabled: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: false, params: { count: 3, window_minutes: 5 } });

    const audit = await get(admin, '/audit?entity_type=rule');
    expect(audit.body.items).toHaveLength(1);
    expect(audit.body.items[0]).toMatchObject({ action: 'rule.update', actor_email: 'admin@test' });
    expect(audit.body.items[0].before.params).toEqual({ count: 5, window_minutes: 10 });
    expect(audit.body.items[0].after.params).toEqual({ count: 3, window_minutes: 5 });
  });

  it('rejects invalid rule parameters and unknown rules', async () => {
    const rule = (await get(admin, '/rules')).body.items[0];
    const patch = (body: unknown, id: number = rule.id) => request(ctx.app).patch(`/rules/${id}`).set(bearer(admin)).send(body as object);
    expect((await patch({ params: { count: 1, window_minutes: 10 } })).status).toBe(400);
    expect((await patch({ params: { nonsense: true } })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
    expect((await patch({ enabled: true }, 9999)).status).toBe(404);
    expect((await request(ctx.app).patch(`/rules/${rule.id}`).set(bearer(analyst)).send({ enabled: false })).status).toBe(403);
  });

  it('audit log filters by actor and entity and paginates newest first', async () => {
    const id = await openCase(ctx.app, 1);
    const claimed = await request(ctx.app).post('/cases/next').set(bearer(analyst));
    await request(ctx.app).post(`/cases/${id}/resolve`).set(bearer(analyst))
      .send({ decision: 'cleared', note: 'All good here', version: claimed.body.version });

    const entity = await get(admin, `/audit?entity_type=case&entity_id=${id}`);
    expect(entity.body.items.map((a: { action: string }) => a.action)).toEqual(['case.clear', 'case.claim', 'case.open']);

    const actor = claimed.body.assigned_to as string;
    const byActor = await get(admin, `/audit?actor_id=${actor}`);
    expect(byActor.body.items.every((a: { actor_id: string }) => a.actor_id === actor)).toBe(true);

    const page1 = await get(admin, '/audit?limit=2');
    expect(page1.body.items).toHaveLength(2);
    const page2 = await get(admin, `/audit?limit=2&cursor=${page1.body.next_cursor}`);
    expect(page2.body.items).toHaveLength(1);
    expect(page2.body.next_cursor).toBeNull();
    expect((await get(admin, '/audit?actor_id=not-a-uuid')).status).toBe(400);
  });
});

describe('devices', () => {
  it('registers an FCM token and moves it to the latest user without duplicating', async () => {
    const token = 'fcm-token-1234567890';
    await request(ctx.app).post('/devices/register').set(bearer(analyst)).send({ fcm_token: token });
    await request(ctx.app).post('/devices/register').set(bearer(admin)).send({ fcm_token: token });
    const rows = (await ctx.pool.query('select u.email from device_tokens d join users u on u.id = d.user_id')).rows;
    expect(rows).toEqual([{ email: 'admin@test' }]);
    expect((await request(ctx.app).post('/devices/register').set(bearer(analyst)).send({ fcm_token: 'x' })).status).toBe(400);
  });
});

describe('database guarantees', () => {
  it('audit_log is append-only even for the table owner (trigger)', async () => {
    await openCase(ctx.app, 1);
    await expect(ctx.pool.query(`update audit_log set action = 'tampered'`)).rejects.toThrow(/append-only/);
    await expect(ctx.pool.query('delete from audit_log')).rejects.toThrow(/append-only/);
    expect((await ctx.pool.query('select count(*)::int as n from audit_log')).rows[0].n).toBe(1);
  });

  it.skipIf(!process.env.TEST_APP_DATABASE_URL)('the app role has no UPDATE or DELETE privilege on audit_log (grants)', async () => {
    const app = new pg.Client({ connectionString: process.env.TEST_APP_DATABASE_URL });
    await app.connect();
    try {
      await expect(app.query(`update audit_log set action = 'x'`)).rejects.toThrow(/permission denied/);
      await expect(app.query('delete from audit_log')).rejects.toThrow(/permission denied/);
      await app.query(`insert into audit_log (action, entity_type, entity_id) values ('test', 'x', '1')`);
    } finally {
      await app.end();
    }
  });
});
