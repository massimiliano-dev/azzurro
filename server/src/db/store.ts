import { q } from './pool.ts';

/**
 * Store documentale generico sopra la tabella `objects`.
 * Le chiavi (id, parent, prefix) vengono sempre normalizzate in minuscolo.
 */

const k = (s: string) => s.toLowerCase();

export interface ListOptions {
  parent?: string | string[];
  prefix?: string;
  match?: Record<string, unknown>;
  limit?: number;
  newestFirst?: boolean;
}

export async function get<T = any>(collection: string, id: string): Promise<T | null> {
  const rows = await q('SELECT data FROM objects WHERE collection = $1 AND id = $2', [collection, k(id)]);
  return (rows[0]?.data as T) ?? null;
}

export async function getMany<T = any>(collection: string, ids: string[]): Promise<T[]> {
  if (!ids.length) return [];
  const rows = await q('SELECT data FROM objects WHERE collection = $1 AND id = ANY($2)', [collection, ids.map(k)]);
  return rows.map((r) => r.data as T);
}

export async function put<T>(collection: string, id: string, data: T, parent?: string | null): Promise<T> {
  await q(
    `INSERT INTO objects (collection, id, parent, data) VALUES ($1, $2, $3, $4)
     ON CONFLICT (collection, id) DO UPDATE SET data = EXCLUDED.data, parent = EXCLUDED.parent, updated_at = now()`,
    [collection, k(id), parent == null ? null : k(parent), JSON.stringify(data)],
  );
  return data;
}

/** Inserisce solo se non esiste. Ritorna false se esisteva già. */
export async function insert<T>(collection: string, id: string, data: T, parent?: string | null): Promise<boolean> {
  const rows = await q(
    `INSERT INTO objects (collection, id, parent, data) VALUES ($1, $2, $3, $4)
     ON CONFLICT (collection, id) DO NOTHING RETURNING id`,
    [collection, k(id), parent == null ? null : k(parent), JSON.stringify(data)],
  );
  return rows.length > 0;
}

type RemoveHook = (removed: any[]) => Promise<void>;
const removeHooks = new Map<string, RemoveHook>();
/** Chiamato dopo ogni eliminazione nella collezione (es. per conservare lo storico dei costi). */
export function onRemove(collection: string, hook: RemoveHook): void {
  removeHooks.set(collection, hook);
}
async function afterRemove(collection: string, rows: any[]) {
  const hook = removeHooks.get(collection);
  if (hook && rows.length) await hook(rows.map((r) => r.data));
}

export async function remove(collection: string, id: string): Promise<boolean> {
  const rows = await q('DELETE FROM objects WHERE collection = $1 AND id = $2 RETURNING id, data', [collection, k(id)]);
  await afterRemove(collection, rows);
  return rows.length > 0;
}

/** Elimina l'oggetto `prefix` e tutti quelli il cui id inizia con `prefix/`. */
export async function removeTree(collection: string, prefix: string): Promise<number> {
  const p = k(prefix);
  const rows = await q(
    `DELETE FROM objects WHERE collection = $1 AND (id = $2 OR starts_with(id, $3)) RETURNING id, data`,
    [collection, p, p + '/'],
  );
  await afterRemove(collection, rows);
  return rows.length;
}

export async function list<T = any>(collection: string, opts: ListOptions = {}): Promise<T[]> {
  const where = ['collection = $1'];
  const params: unknown[] = [collection];
  if (opts.parent !== undefined) {
    if (Array.isArray(opts.parent)) {
      params.push(opts.parent.map(k));
      where.push(`parent = ANY($${params.length})`);
    } else {
      params.push(k(opts.parent));
      where.push(`parent = $${params.length}`);
    }
  }
  if (opts.prefix !== undefined) {
    params.push(k(opts.prefix));
    where.push(`starts_with(id, $${params.length})`);
  }
  if (opts.match) {
    params.push(JSON.stringify(opts.match));
    where.push(`data @> $${params.length}::jsonb`);
  }
  let sql = `SELECT data FROM objects WHERE ${where.join(' AND ')} ORDER BY created_at ${opts.newestFirst ? 'DESC' : 'ASC'}, id`;
  if (opts.limit) sql += ` LIMIT ${Math.max(1, Math.floor(opts.limit))}`;
  const rows = await q(sql, params);
  return rows.map((r) => r.data as T);
}

export async function count(collection: string, opts: Omit<ListOptions, 'limit'> = {}): Promise<number> {
  const where = ['collection = $1'];
  const params: unknown[] = [collection];
  if (opts.prefix !== undefined) {
    params.push(k(opts.prefix));
    where.push(`starts_with(id, $${params.length})`);
  }
  if (opts.match) {
    params.push(JSON.stringify(opts.match));
    where.push(`data @> $${params.length}::jsonb`);
  }
  const rows = await q(`SELECT count(*)::int AS n FROM objects WHERE ${where.join(' AND ')}`, params);
  return rows[0].n;
}

/** Sposta un oggetto (e il suo sottoalbero) da un id a un altro, riscrivendo id/parent. */
export async function rekeyTree(
  collection: string,
  fromPrefix: string,
  toPrefix: string,
  rewrite: (data: any, newId: string) => any,
): Promise<void> {
  const from = k(fromPrefix);
  const rows = await q(
    `SELECT id, parent, data FROM objects WHERE collection = $1 AND (id = $2 OR starts_with(id, $3))`,
    [collection, from, from + '/'],
  );
  for (const r of rows) {
    const suffix = r.id.slice(from.length);
    const origId: string = r.data?.id ?? r.id;
    const newId = toPrefix + origId.slice(fromPrefix.length);
    const newParent = r.parent && (r.parent === from || r.parent.startsWith(from + '/'))
      ? k(toPrefix) + r.parent.slice(from.length)
      : r.parent;
    await q('DELETE FROM objects WHERE collection = $1 AND id = $2', [collection, r.id]);
    await put(collection, k(toPrefix) + suffix, rewrite(r.data, newId), newParent);
  }
}
