import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bearer, HIGH, ingest, login, makeCtx, minutesAgo, openCase, resetDb } from './helpers.js';
import type { Ctx } from './helpers.js';

let ctx: Ctx;
let analyst1: string;
let analyst2: string;
let admin: string;

beforeAll(() => {
  ctx = makeCtx();
});
afterAll(() => ctx.pool.end());
beforeEach(async () => {
  await resetDb(ctx.pool);
  analyst1 = await login(ctx.app, 'analyst1@test');
  analyst2 = await login(ctx.app, 'analyst2@test');
  admin = await login(ctx.app, 'admin@test');
});

const claimNext = (token: string) => request(ctx.app).post('/cases/next').set(bearer(token));
const claim = (token: string, id: number) => request(ctx.app).post(`/cases/${id}/claim`).set(bearer(token));
const resolve = (token: string, id: number, body: Record<string, unknown>) =>
  request(ctx.app).post(`/cases/${id}/resolve`).set(bearer(token)).send(body);
const auditActions = async () =>
  (await ctx.pool.query('select action from audit_log order by id')).rows.map((r) => r.action as string);

describe('case queue', () => {
  it('lists active cases ordered by priority, then age', async () => {
    const p2 = await openCase(ctx.app, 1, { created_at: minutesAgo(30) });
    for (let i = 4; i >= 1; i--) await ingest(ctx.app, { from_account_id: 2, created_at: minutesAgo(i) });
    const p1 = await openCase(ctx.app, 2, { created_at: minutesAgo(0) }); // velocity + high => priority 1
    const res = await request(ctx.app).get('/cases').set(bearer(analyst1));
    expect(res.status).toBe(200);
    expect(res.body.items.map((c: { id: number }) => c.id)).toEqual([p1, p2]);
    expect(res.body.items[0]).toMatchObject({ priority: 1, status: 'open', version: 0 });
    expect(res.body.items[0].transaction).toMatchObject({ amount: '150000.00', risk_band: 'high' });
  });

  it('filters by priority and status', async () => {
    const id = await openCase(ctx.app, 1);
    await claim(analyst1, id);
    expect((await request(ctx.app).get('/cases?status=open').set(bearer(analyst1))).body.items).toHaveLength(0);
    expect((await request(ctx.app).get('/cases?status=in_review').set(bearer(analyst1))).body.items).toHaveLength(1);
    expect((await request(ctx.app).get('/cases?priority=1').set(bearer(analyst1))).body.items).toHaveLength(0);
    expect((await request(ctx.app).get('/cases?priority=2').set(bearer(analyst1))).body.items).toHaveLength(1);
    expect((await request(ctx.app).get('/cases?status=bogus').set(bearer(analyst1))).status).toBe(400);
  });

  it('paginates with cursors without skipping or repeating cases', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push(await openCase(ctx.app, 1, { created_at: minutesAgo(1000 - i * 20) })); // 20 min apart: no velocity rule
    const seen: number[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const url: string = `/cases?limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await request(ctx.app).get(url).set(bearer(analyst1));
      seen.push(...res.body.items.map((c: { id: number }) => c.id));
      cursor = res.body.next_cursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(ids);
    expect((await request(ctx.app).get('/cases?cursor=garbage').set(bearer(analyst1))).status).toBe(400);
  });

  it('returns one case by id, or 404', async () => {
    const id = await openCase(ctx.app);
    expect((await request(ctx.app).get(`/cases/${id}`).set(bearer(analyst1))).body.id).toBe(id);
    expect((await request(ctx.app).get('/cases/9999').set(bearer(analyst1))).status).toBe(404);
    expect((await request(ctx.app).get('/cases/abc').set(bearer(analyst1))).status).toBe(400);
  });
});

describe('claiming', () => {
  it('claim-next takes the highest-priority case first and records the claim', async () => {
    await openCase(ctx.app, 1);
    for (let i = 4; i >= 1; i--) await ingest(ctx.app, { from_account_id: 2, created_at: minutesAgo(i) });
    const urgent = await openCase(ctx.app, 2, { created_at: minutesAgo(0) });
    const res = await claimNext(analyst1);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: urgent, status: 'in_review', version: 1, assigned_to_name: 'Analyst One' });
    expect(await auditActions()).toContain('case.claim');
  });

  it('claim-next returns 404 when nothing is open', async () => {
    const res = await claimNext(analyst1);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('no_open_cases');
  });

  it('CONCURRENCY: two analysts claim-next at the same moment, exactly one gets the only case', async () => {
    const id = await openCase(ctx.app);
    const [a, b] = await Promise.all([claimNext(analyst1), claimNext(analyst2)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 404]);

    const winner = a.status === 200 ? a : b;
    expect(winner.body.id).toBe(id);
    const row = (await ctx.pool.query('select status, version, assigned_to from cases where id = $1', [id])).rows[0];
    expect(row).toMatchObject({ status: 'in_review', version: 1, assigned_to: winner.body.assigned_to });
    expect((await auditActions()).filter((x) => x === 'case.claim')).toHaveLength(1);
  });

  it('CONCURRENCY: many simultaneous claim-next calls never hand out the same case twice', async () => {
    const ids = new Set<number>();
    for (let i = 0; i < 6; i++) ids.add(await openCase(ctx.app, 1));
    const tokens = [analyst1, analyst2, analyst1, analyst2, analyst1, analyst2];
    const results = await Promise.all(tokens.map((t) => claimNext(t)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const claimed = results.map((r) => r.body.id as number);
    expect(new Set(claimed).size).toBe(6);
    expect(new Set(claimed)).toEqual(ids);
  });

  it('CONCURRENCY: two analysts claim the SAME case: one 200, one 409', async () => {
    const id = await openCase(ctx.app);
    const [a, b] = await Promise.all([claim(analyst1, id), claim(analyst2, id)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.error.code).toBe('already_claimed');
    expect((await auditActions()).filter((x) => x === 'case.claim')).toHaveLength(1);
  });

  it('claiming a missing case is 404', async () => {
    expect((await claim(analyst1, 9999)).status).toBe(404);
  });
});

describe('resolving', () => {
  it('blocking updates the case, the transaction and the account, with audit rows, atomically', async () => {
    const id = await openCase(ctx.app, 1);
    const claimed = await claimNext(analyst1);
    const res = await resolve(analyst1, id, { decision: 'blocked', note: 'Confirmed mule account', version: claimed.body.version });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'blocked', version: 2, resolution_note: 'Confirmed mule account' });
    expect(res.body.resolved_at).toEqual(expect.any(String));

    expect((await ctx.pool.query('select status from transactions')).rows[0].status).toBe('blocked');
    expect((await ctx.pool.query('select status from accounts where id = 1')).rows[0].status).toBe('blocked');
    expect(await auditActions()).toEqual(['case.open', 'case.claim', 'case.block', 'account.block']);

    const block = (await ctx.pool.query(`select * from audit_log where action = 'case.block'`)).rows[0];
    expect(block.before).toMatchObject({ status: 'in_review' });
    expect(block.after).toMatchObject({ status: 'blocked', resolution_note: 'Confirmed mule account' });
  });

  it('clearing releases the transaction and leaves the account active', async () => {
    const id = await openCase(ctx.app, 1);
    const claimed = await claimNext(analyst1);
    const res = await resolve(analyst1, id, { decision: 'cleared', note: 'Customer confirmed by phone', version: claimed.body.version });
    expect(res.status).toBe(200);
    expect((await ctx.pool.query('select status from transactions')).rows[0].status).toBe('cleared');
    expect((await ctx.pool.query('select status from accounts where id = 1')).rows[0].status).toBe('active');
    expect(await auditActions()).toEqual(['case.open', 'case.claim', 'case.clear']);
  });

  it('a stale version returns 409 and changes nothing', async () => {
    const id = await openCase(ctx.app, 1);
    await claimNext(analyst1); // case is now version 1
    const before = (await ctx.pool.query('select * from cases where id = $1', [id])).rows[0];
    const auditBefore = (await ctx.pool.query('select count(*)::int as n from audit_log')).rows[0].n;

    const res = await resolve(analyst1, id, { decision: 'blocked', note: 'Using an old version', version: 0 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('version_conflict');

    expect((await ctx.pool.query('select * from cases where id = $1', [id])).rows[0]).toEqual(before);
    expect((await ctx.pool.query('select status from transactions')).rows[0].status).toBe('flagged');
    expect((await ctx.pool.query('select status from accounts where id = 1')).rows[0].status).toBe('active');
    expect((await ctx.pool.query('select count(*)::int as n from audit_log')).rows[0].n).toBe(auditBefore);
  });

  it('only the assignee can resolve, and only a case that is in review', async () => {
    const id = await openCase(ctx.app, 1);
    const unclaimed = await resolve(analyst1, id, { decision: 'cleared', note: 'Not claimed yet', version: 0 });
    expect(unclaimed.status).toBe(409);
    expect(unclaimed.body.error.code).toBe('not_in_review');

    const claimed = await claimNext(analyst1);
    const other = await resolve(analyst2, id, { decision: 'cleared', note: 'Not my case', version: claimed.body.version });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('not_assignee');
  });

  it('cannot be resolved twice', async () => {
    const id = await openCase(ctx.app, 1);
    const claimed = await claimNext(analyst1);
    await resolve(analyst1, id, { decision: 'cleared', note: 'First decision', version: claimed.body.version });
    const again = await resolve(analyst1, id, { decision: 'blocked', note: 'Second decision', version: claimed.body.version + 1 });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('not_in_review');
  });

  it('requires a note and a valid decision', async () => {
    const id = await openCase(ctx.app, 1);
    await claimNext(analyst1);
    expect((await resolve(analyst1, id, { decision: 'blocked', version: 1 })).status).toBe(400);
    expect((await resolve(analyst1, id, { decision: 'blocked', note: ' ', version: 1 })).status).toBe(400);
    expect((await resolve(analyst1, id, { decision: 'maybe', note: 'hmm hmm', version: 1 })).status).toBe(400);
    expect((await resolve(admin, id, { decision: 'blocked', note: 'admins cannot', version: 1 })).status).toBe(403);
  });

  it('a later transaction from a blocked account is flagged', async () => {
    const id = await openCase(ctx.app, 1);
    const claimed = await claimNext(analyst1);
    await resolve(analyst1, id, { decision: 'blocked', note: 'Block this account', version: claimed.body.version });
    const next = await ingest(ctx.app, { from_account_id: 1 });
    expect(next.body.transaction.status).toBe('flagged');
    expect(next.body.transaction.reasons).toContainEqual({ source: 'system', feature: 'account_blocked' });
  });
});

describe('live stream (SSE)', () => {
  it('pushes new flagged transactions and case updates to connected clients', async () => {
    const server = ctx.app.listen(0);
    await new Promise<void>((r) => server.once('listening', r));
    const port = (server.address() as AddressInfo).port;
    const abort = new AbortController();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/stream`, { headers: bearer(analyst1), signal: abort.signal });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      await vi.waitFor(() => expect(ctx.hub.size).toBe(1));

      const created = await ingest(ctx.app, { ...HIGH });
      await claimNext(analyst1);

      let text = '';
      const deadline = Date.now() + 5000;
      while ((!text.includes('event: txn.flagged') || !text.includes('event: case.updated')) && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
      expect(text).toContain('event: txn.new');
      expect(text).toContain('event: txn.flagged');
      expect(text).toContain('event: case.updated');
      expect(text).toContain(`"external_ref":"${created.body.transaction.external_ref}"`);
    } finally {
      abort.abort();
      server.closeAllConnections();
      server.close();
    }
  });
});
