import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bearer, baseConfig, ingest, login, makeCtx, PASSWORD, resetDb } from './helpers.js';
import type { Ctx } from './helpers.js';

let ctx: Ctx;
beforeAll(() => {
  ctx = makeCtx();
});
afterAll(() => ctx.pool.end());
beforeEach(() => resetDb(ctx.pool));

describe('authentication', () => {
  it('logs in and returns a token plus the user, never the password hash', async () => {
    const res = await request(ctx.app).post('/auth/login').send({ email: 'analyst1@test', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.user).toMatchObject({ email: 'analyst1@test', role: 'analyst' });
    expect(JSON.stringify(res.body)).not.toContain('password');
  });

  it('gives the same 401 for a wrong password and an unknown email', async () => {
    const wrong = await request(ctx.app).post('/auth/login').send({ email: 'analyst1@test', password: 'nope' });
    const unknown = await request(ctx.app).post('/auth/login').send({ email: 'ghost@test', password: PASSWORD });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body.error.code).toBe('invalid_credentials');
  });

  it('rejects a malformed login body with 400', async () => {
    const res = await request(ctx.app).post('/auth/login').send({ email: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('rate limits repeated login attempts', async () => {
    const limited = makeCtx({ config: { rateLimitDisabled: false } });
    try {
      let last = 0;
      for (let i = 0; i < 11; i++) {
        last = (await request(limited.app).post('/auth/login').send({ email: 'analyst1@test', password: 'bad' })).status;
      }
      expect(last).toBe(429);
    } finally {
      await limited.pool.end();
    }
  });
});

describe('protected routes', () => {
  it('requires a token', async () => {
    expect((await request(ctx.app).get('/me')).status).toBe(401);
    expect((await request(ctx.app).get('/cases')).status).toBe(401);
    expect((await request(ctx.app).get('/stream')).status).toBe(401);
  });

  it('returns the current user for a valid token', async () => {
    const token = await login(ctx.app, 'admin@test');
    const res = await request(ctx.app).get('/me').set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email: 'admin@test', role: 'admin' });
  });

  it('rejects tampered, wrongly signed, expired and alg=none tokens', async () => {
    const good = await login(ctx.app, 'analyst1@test');
    const tampered = `${good.slice(0, -4)}AAAA`;
    const wrongKey = jwt.sign({ role: 'admin' }, 'a-different-secret-entirely', { subject: 'x' });
    const expired = jwt.sign({ role: 'admin' }, baseConfig.jwtSecret, { subject: 'x', expiresIn: -10 });
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from('{"sub":"x","role":"admin"}').toString('base64url')}.`;
    for (const token of [tampered, wrongKey, expired, none]) {
      expect((await request(ctx.app).get('/me').set(bearer(token))).status).toBe(401);
    }
  });

  it('enforces roles: analysts cannot read the audit log or rules', async () => {
    const analyst = await login(ctx.app, 'analyst1@test');
    const admin = await login(ctx.app, 'admin@test');
    expect((await request(ctx.app).get('/audit').set(bearer(analyst))).status).toBe(403);
    expect((await request(ctx.app).get('/rules').set(bearer(analyst))).status).toBe(403);
    expect((await request(ctx.app).get('/audit').set(bearer(admin))).status).toBe(200);
    expect((await request(ctx.app).get('/rules').set(bearer(admin))).status).toBe(200);
  });

  it('enforces roles: admins cannot claim or resolve cases', async () => {
    const admin = await login(ctx.app, 'admin@test');
    expect((await request(ctx.app).post('/cases/next').set(bearer(admin))).status).toBe(403);
  });

  it('ingest needs the service key, and a user token is not a substitute', async () => {
    const token = await login(ctx.app, 'analyst1@test');
    const body = { external_ref: 'k1', from_account_id: 1, to_account_id: 3, type: 'PAYMENT', channel: 'UPI', amount: 10 };
    expect((await request(ctx.app).post('/transactions').send(body)).status).toBe(401);
    expect((await request(ctx.app).post('/transactions').set(bearer(token)).send(body)).status).toBe(401);
    expect((await request(ctx.app).post('/transactions').set('X-Service-Key', 'wrong').send(body)).status).toBe(401);
    expect((await ingest(ctx.app, { external_ref: 'k1' })).status).toBe(201);
  });
});

describe('error format and routing', () => {
  it('returns { error: { code, message } } for unknown routes and bad JSON', async () => {
    const missing = await request(ctx.app).get('/nope');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('not_found');

    const bad = await request(ctx.app).post('/auth/login').set('Content-Type', 'application/json').send('{not json');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_json');
  });

  it('sends security headers and answers /health', async () => {
    const res = await request(ctx.app).get('/health');
    expect(res.status).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('only allows the configured CORS origin', async () => {
    const ok = await request(ctx.app).get('/health').set('Origin', 'http://localhost:8080');
    const other = await request(ctx.app).get('/health').set('Origin', 'https://evil.example');
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:8080');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });
});
