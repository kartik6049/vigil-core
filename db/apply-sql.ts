// Runs one .sql file against DATABASE_URL (the owner role).
// Usage: tsx --env-file=.env db/apply-sql.ts db/grants.sql
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const file = process.argv[2];
if (!file) throw new Error('Usage: apply-sql.ts <file.sql>');
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query(await readFile(file, 'utf8'));
  console.log(`applied ${file}`);
} finally {
  await client.end();
}
