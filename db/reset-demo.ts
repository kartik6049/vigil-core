// Wipes demo activity and restores the seed state. Run nightly by .github/workflows/reset-demo.yml.
// Needs the OWNER connection (DATABASE_URL): the app role cannot truncate the append-only audit log.
// Usage: tsx --env-file=.env db/reset-demo.ts
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query('begin');
  // TRUNCATE is statement-level, so the audit_log row triggers (which block UPDATE/DELETE) do not fire.
  // Only the owner role can do this; vigil_app has no TRUNCATE privilege.
  await client.query(
    'truncate table ground_truth, cases, transactions, audit_log, rules, model_metrics_daily restart identity cascade',
  );
  await client.query(`update accounts set status = 'active'`);
  await client.query('commit');
  await client.query('select refresh_hourly_stats()');
  console.log('demo activity cleared; reseeding rules');
} catch (err) {
  await client.query('rollback');
  throw err;
} finally {
  await client.end();
}

// seed.ts is idempotent and runs on import: it restores the default rules and any missing users or accounts.
await import('./seed.js');
