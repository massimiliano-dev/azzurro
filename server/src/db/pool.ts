import pg from 'pg';
import { readFileSync } from 'node:fs';

// bigint (bigserial) come number
pg.types.setTypeParser(20, (v) => Number(v));

let _pool: pg.Pool | undefined;

export function pool(): pg.Pool {
  if (!_pool) throw new Error('Database non inizializzato');
  return _pool;
}

export async function initDb(url: string, schema = 'public'): Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`Nome schema non valido: ${schema}`);
  _pool = new pg.Pool({ connectionString: url, max: 10, options: `-c search_path=${schema}` });
  const sql = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
  const client = await _pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(7351)');
    try {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      await client.query(sql);
    } finally {
      await client.query('SELECT pg_advisory_unlock(7351)');
    }
  } finally {
    client.release();
  }
}

export async function closeDb(): Promise<void> {
  await _pool?.end();
  _pool = undefined;
}

export async function q<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const r = await pool().query<T>(text, params);
  return r.rows;
}
