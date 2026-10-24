import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://vigil:vigil@localhost:5432/vigil_test';

/**
 * Runs once before the whole suite: rebuilds the schema from the real migration files
 * in a dedicated test database, so tests always run against the production schema.
 */
export default async function setup(): Promise<void> {
  // This drops the public schema. Never let it point at a database that is not clearly a test one.
  const dbName = new URL(TEST_DB_URL).pathname;
  if (!/test/i.test(dbName)) {
    throw new Error(`Refusing to reset "${dbName}": TEST_DATABASE_URL must point at a database with "test" in its name`);
  }

  const root = fileURLToPath(new URL('../../db', import.meta.url));
  const client = new pg.Client({ connectionString: TEST_DB_URL });
  await client.connect();
  try {
    await client.query('drop schema public cascade; create schema public;');

    const files = (await readdir(path.join(root, 'migrations'))).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const sql = await readFile(path.join(root, 'migrations', file), 'utf8');
      const up = sql.split('-- Down Migration')[0].replace('-- Up Migration', '');
      await client.query(up);
    }

    // Apply grants too when the app role exists (it does in Docker Compose and in CI).
    const role = await client.query(`select 1 from pg_roles where rolname = 'vigil_app'`);
    if (role.rowCount) await client.query(await readFile(path.join(root, 'grants.sql'), 'utf8'));
  } finally {
    await client.end();
  }
}
