import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createScorer } from '../src/scoring/client.js';
import { baseConfig, daysAgo, HIGH, ingest, LOW, makeCtx, minutesAgo, resetDb } from './helpers.js';
import type { Ctx } from './helpers.js';

let ctx: Ctx;
beforeAll(() => {
  ctx = makeCtx();
});
afterAll(() => ctx.pool.end());
beforeEach(() => resetDb(ctx.pool));

const ruleNames = (reasons: Array<{ source: string; rule?: string }>) =>
  reasons.filter((r) => r.source === 'rule').map((r) => r.rule);

describe('POST /transactions: decisions', () => {
  it('approves an ordinary payment without opening a case', async () => {
    const res = await ingest(ctx.app, { ...LOW });
    expect(res.status).toBe(201);
    expect(res.body.transaction).toMatchObject({ status: 'approved', risk_band: 'low', model_version: 'stub-v1' });
    expect(res.body.transaction.amount).toBe('250.00');
    expect(res.body.case).toBeNull();
    expect((await ctx.pool.query('select count(*)::int as n from cases')).rows[0].n).toBe(0);
  });

  it('flags a high-risk transaction and opens a priority-2 case when no rule fires', async () => {
    const res = await ingest(ctx.app, { ...HIGH });
    expect(res.status).toBe(201);
    expect(res.body.transaction).toMatchObject({ status: 'flagged', risk_band: 'high' });
    expect(res.body.case).toMatchObject({ priority: 2, status: 'open' });
    const audit = await ctx.pool.query(`select action, actor_id from audit_log`);
    expect(audit.rows).toEqual([{ action: 'case.open', actor_id: null }]);
  });

  it('opens a priority-1 case when the model is high AND a rule fires', async () => {
    for (let i = 4; i >= 1; i--) await ingest(ctx.app, { ...LOW, created_at: minutesAgo(i) });
    const res = await ingest(ctx.app, { ...HIGH, created_at: minutesAgo(0) });
    expect(res.body.case.priority).toBe(1);
    expect(ruleNames(res.body.transaction.reasons)).toContain('velocity_5_in_10m');
  });

  it('stores model reasons with their source', async () => {
    const res = await ingest(ctx.app, { ...HIGH });
    const model = res.body.transaction.reasons.filter((r: { source: string }) => r.source === 'model');
    expect(model.length).toBeGreaterThan(0);
    expect(model[0]).toMatchObject({ feature: expect.any(String), contribution: expect.any(Number) });
  });
});

describe('POST /transactions: rules', () => {
  it('velocity: the 5th transaction in 10 minutes fires, the 4th does not', async () => {
    const results = [];
    for (let i = 4; i >= 0; i--) results.push(await ingest(ctx.app, { ...LOW, created_at: minutesAgo(i) }));
    expect(ruleNames(results[3].body.transaction.reasons)).toEqual([]);
    expect(results[3].body.transaction.status).toBe('approved');
    expect(ruleNames(results[4].body.transaction.reasons)).toEqual(['velocity_5_in_10m']);
    expect(results[4].body.transaction.status).toBe('flagged');
    expect(results[4].body.case.priority).toBe(2); // rule only, model is low
  });

  it('new city: a different city within an hour fires', async () => {
    await ingest(ctx.app, { ...LOW, ip_city: 'Pune', created_at: minutesAgo(30) });
    const same = await ingest(ctx.app, { ...LOW, ip_city: 'Pune', created_at: minutesAgo(10) });
    const moved = await ingest(ctx.app, { ...LOW, ip_city: 'Mumbai', created_at: minutesAgo(1) });
    expect(ruleNames(same.body.transaction.reasons)).toEqual([]);
    expect(ruleNames(moved.body.transaction.reasons)).toEqual(['new_city']);
  });

  it('amount spike: over 5x the 30-day average fires, given enough history', async () => {
    for (const d of [5, 4, 3]) await ingest(ctx.app, { ...LOW, amount: 100, created_at: daysAgo(d) });
    const normal = await ingest(ctx.app, { ...LOW, amount: 400 });
    const spike = await ingest(ctx.app, { ...LOW, amount: 1000 });
    expect(ruleNames(normal.body.transaction.reasons)).toEqual([]);
    expect(ruleNames(spike.body.transaction.reasons)).toEqual(['amount_spike']);
  });

  it('dormant account: a large transfer after 90+ idle days fires', async () => {
    await ingest(ctx.app, { ...LOW, created_at: daysAgo(100) });
    const res = await ingest(ctx.app, { type: 'TRANSFER', channel: 'NETBANKING', amount: 60000 });
    expect(ruleNames(res.body.transaction.reasons)).toEqual(['dormant_account']);
    expect(res.body.transaction.status).toBe('flagged');
  });

  it('a brand-new account is not treated as dormant', async () => {
    const res = await ingest(ctx.app, { type: 'TRANSFER', channel: 'NETBANKING', amount: 60000 });
    expect(ruleNames(res.body.transaction.reasons)).toEqual([]);
  });

  it('disabled rules do not fire', async () => {
    await ctx.pool.query(`update rules set enabled = false where name = 'velocity_5_in_10m'`);
    let last;
    for (let i = 4; i >= 0; i--) last = await ingest(ctx.app, { ...LOW, created_at: minutesAgo(i) });
    expect(ruleNames(last!.body.transaction.reasons)).toEqual([]);
    expect(last!.body.transaction.status).toBe('approved');
  });

  it('a threshold edited in the rules table takes effect', async () => {
    await ctx.pool.query(`update rules set params = '{"count":2,"window_minutes":10}' where name = 'velocity_5_in_10m'`);
    await ingest(ctx.app, { ...LOW, created_at: minutesAgo(2) });
    const second = await ingest(ctx.app, { ...LOW, created_at: minutesAgo(1) });
    expect(ruleNames(second.body.transaction.reasons)).toEqual(['velocity_5_in_10m']);
  });

  it('flags transactions from an already-blocked account', async () => {
    await ctx.pool.query(`update accounts set status = 'blocked' where id = 1`);
    const res = await ingest(ctx.app, { ...LOW });
    expect(res.body.transaction.status).toBe('flagged');
    expect(res.body.transaction.reasons).toContainEqual({ source: 'system', feature: 'account_blocked' });
  });
});

describe('POST /transactions: model unavailable', () => {
  it('still runs rules and records model_unavailable when the scorer returns null', async () => {
    const down = makeCtx({ scorer: async () => null });
    try {
      let last;
      for (let i = 4; i >= 0; i--) last = await ingest(down.app, { ...LOW, created_at: minutesAgo(i) });
      const t = last!.body.transaction;
      expect(t.risk_score).toBeNull();
      expect(t.risk_band).toBeNull();
      expect(t.reasons).toContainEqual({ source: 'system', feature: 'model_unavailable' });
      expect(ruleNames(t.reasons)).toEqual(['velocity_5_in_10m']);
      expect(t.status).toBe('flagged');
      expect(last!.body.case.priority).toBe(2);
    } finally {
      await down.pool.end();
    }
  });

  it('createScorer returns the model result when the service answers in time', async () => {
    const server = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ risk_score: 0.91, risk_band: 'high', model_version: 'lgbm-test', reasons: [{ feature: 'amount', value: 1, contribution: 0.3 }] }));
      req.resume();
    });
    await new Promise<void>((r) => server.listen(0, r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const scorer = createScorer({ ...baseConfig, mlScoreUrl: url });
      const out = await scorer({ transaction_id: '1', type: 'TRANSFER', amount: 1, hour_of_day: 2, old_balance_orig: null, new_balance_orig: null, old_balance_dest: null, new_balance_dest: null });
      expect(out).toMatchObject({ risk_band: 'high', model_version: 'lgbm-test' });
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it('createScorer gives up after the timeout and on bad responses', async () => {
    let mode: 'slow' | 'bad' | 'error' = 'slow';
    const server = createServer((req, res) => {
      req.resume();
      if (mode === 'slow') return void setTimeout(() => res.end('{}'), 1500);
      if (mode === 'error') {
        res.statusCode = 500;
        return void res.end('boom');
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ unexpected: true }));
    });
    await new Promise<void>((r) => server.listen(0, r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const scorer = createScorer({ ...baseConfig, mlScoreUrl: url, mlTimeoutMs: 200 });
      const req = { transaction_id: '1', type: 'PAYMENT', amount: 1, hour_of_day: 1, old_balance_orig: null, new_balance_orig: null, old_balance_dest: null, new_balance_dest: null };
      const started = Date.now();
      expect(await scorer(req)).toBeNull();
      expect(Date.now() - started).toBeLessThan(1200);
      mode = 'bad';
      expect(await scorer(req)).toBeNull();
      mode = 'error';
      expect(await scorer(req)).toBeNull();
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe('POST /transactions: idempotency and validation', () => {
  it('returns the original on a repeated external_ref and writes nothing twice', async () => {
    const first = await ingest(ctx.app, { ...HIGH, external_ref: 'dup-1' });
    const second = await ingest(ctx.app, { ...HIGH, external_ref: 'dup-1' });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.transaction.id).toBe(first.body.transaction.id);
    expect(second.body.case.id).toBe(first.body.case.id);
    expect((await ctx.pool.query('select count(*)::int as n from transactions')).rows[0].n).toBe(1);
    expect((await ctx.pool.query('select count(*)::int as n from cases')).rows[0].n).toBe(1);
  });

  it('survives simultaneous retries of the same external_ref: exactly one insert', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => ingest(ctx.app, { ...HIGH, external_ref: 'race-1' })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(5);
    expect((await ctx.pool.query('select count(*)::int as n from transactions')).rows[0].n).toBe(1);
    expect((await ctx.pool.query('select count(*)::int as n from cases')).rows[0].n).toBe(1);
  });

  it('rejects invalid bodies', async () => {
    expect((await ingest(ctx.app, { amount: 0 })).status).toBe(400);
    expect((await ingest(ctx.app, { amount: -5 })).status).toBe(400);
    expect((await ingest(ctx.app, { amount: '12.345' })).status).toBe(400);
    expect((await ingest(ctx.app, { type: 'WIRE' })).status).toBe(400);
    expect((await ingest(ctx.app, { channel: 'FAX' })).status).toBe(400);
    expect((await ingest(ctx.app, { external_ref: '' })).status).toBe(400);
  });

  it('rejects unknown or identical accounts with 422', async () => {
    expect((await ingest(ctx.app, { from_account_id: 999 })).status).toBe(422);
    expect((await ingest(ctx.app, { from_account_id: 1, to_account_id: 1 })).status).toBe(422);
  });

  it('accepts money as a number or a decimal string and keeps exact precision', async () => {
    const a = await ingest(ctx.app, { amount: 18500 });
    const b = await ingest(ctx.app, { amount: '18500.10' });
    expect(a.body.transaction.amount).toBe('18500.00');
    expect(b.body.transaction.amount).toBe('18500.10');
  });
});
