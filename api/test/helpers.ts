import bcrypt from 'bcrypt';
import type { Express } from 'express';
import type pg from 'pg';
import request from 'supertest';
import { createApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { createPool } from '../src/db.js';
import { EventHub } from '../src/events.js';
import { stubScore } from '../src/scoring/stub.js';
import type { Scorer } from '../src/scoring/client.js';

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://vigil:vigil@localhost:5432/vigil_test';
export const PASSWORD = 'pw-test-1234';
export const SERVICE_KEY = 'test-service-key';

export const baseConfig: Config = {
  port: 0,
  databaseUrl: TEST_DB_URL,
  jwtSecret: 'test-secret-test-secret',
  serviceKey: SERVICE_KEY,
  corsOrigins: ['http://localhost:8080'],
  mlTimeoutMs: 800,
  trustProxy: 0,
  rateLimitDisabled: true,
  mvRefreshSeconds: 300,
};

export interface Ctx {
  app: Express;
  pool: pg.Pool;
  hub: EventHub;
  config: Config;
}

export function makeCtx(opts: { scorer?: Scorer; config?: Partial<Config> } = {}): Ctx {
  const config = { ...baseConfig, ...opts.config };
  const pool = createPool(config.databaseUrl);
  const hub = new EventHub();
  const scorer: Scorer = opts.scorer ?? (async (req) => stubScore(req));
  const app = createApp({ config, pool, scorer, hub, notifier: { async priorityCaseOpened() {} } });
  return { app, pool, hub, config };
}

const hash = bcrypt.hashSync(PASSWORD, 4); // low cost: tests only

/** Empties every table and inserts a small fixed world. Account ids: 1-2 customers, 3-4 merchants. */
export async function resetDb(pool: pg.Pool): Promise<void> {
  await pool.query(
    `truncate table audit_log, ground_truth, cases, transactions, device_tokens, model_metrics_daily,
                    rules, accounts, users restart identity cascade`,
  );
  await pool.query(
    `insert into users (email, name, password_hash, role) values
       ('analyst1@test', 'Analyst One', $1, 'analyst'),
       ('analyst2@test', 'Analyst Two', $1, 'analyst'),
       ('admin@test', 'Admin', $1, 'admin')`,
    [hash],
  );
  await pool.query(
    `insert into accounts (holder_name, kind, merchant_category, city) values
       ('Customer One', 'customer', null, 'Pune'),
       ('Customer Two', 'customer', null, 'Mumbai'),
       ('Fuel Merchant', 'merchant', 'fuel', 'Delhi'),
       ('Gaming Merchant', 'merchant', 'gaming', 'Delhi')`,
  );
  await pool.query(
    `insert into rules (name, params) values
       ('velocity_5_in_10m', '{"count":5,"window_minutes":10}'),
       ('new_city', '{"compare_last_n":3,"window_minutes":60}'),
       ('amount_spike', '{"multiplier":5,"window_days":30}'),
       ('dormant_account', '{"inactive_days":90,"min_amount":50000}')`,
  );
}

export async function login(app: Express, email: string): Promise<string> {
  const res = await request(app).post('/auth/login').send({ email, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.token as string;
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** A transfer that the stub scorer rates "high" (drained balance, empty destination, big amount). */
export const HIGH = {
  type: 'TRANSFER',
  channel: 'UPI',
  amount: 150000,
  old_balance_orig: 150000,
  new_balance_orig: 0,
  old_balance_dest: 0,
  new_balance_dest: 0,
};

/** An everyday payment the stub scorer rates "low". */
export const LOW = { type: 'PAYMENT', channel: 'UPI', amount: 250 };

let counter = 0;
export const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
export const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

export async function ingest(app: Express, body: Record<string, unknown> = {}) {
  return request(app)
    .post('/transactions')
    .set('X-Service-Key', SERVICE_KEY)
    .send({
      external_ref: `test-${Date.now()}-${++counter}`,
      from_account_id: 1,
      to_account_id: 3,
      ...LOW,
      ...body,
    });
}

/** Opens a flagged case via a high-risk transfer from the given account and returns the case id. */
export async function openCase(app: Express, from = 1, extra: Record<string, unknown> = {}): Promise<number> {
  const res = await ingest(app, { ...HIGH, from_account_id: from, ...extra });
  if (res.status !== 201 || !res.body.case) throw new Error(`expected a case: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.case.id as number;
}
