import pg from 'pg';
import type { QueryResult, QueryResultRow } from 'pg';

// bigint (int8) columns, ids and count(*) come back as strings by default.
// All ours are far below 2^53, so parse them as numbers for cleaner JSON.
pg.types.setTypeParser(20, (v: string) => Number(v));

/** Anything that can run a query: the pool, or a client inside a transaction. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<QueryResult<QueryResultRow>>;
}

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
}

/**
 * Runs fn inside BEGIN/COMMIT on one connection; rolls back on any error.
 * Every multi-statement write in the API goes through here so it is atomic.
 */
export async function withTx<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    try {
      await client.query('rollback');
    } catch {
      /* the original error is the one worth reporting */
    }
    throw err;
  } finally {
    client.release();
  }
}
