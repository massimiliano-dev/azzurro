import { q } from './db/pool.ts';

export type EventKind = 'activity' | 'audit' | 'signin';

export async function recordEvent(kind: EventKind, data: Record<string, any>, meta: { subscriptionId?: string | null; resourceId?: string | null; actorId?: string | null } = {}): Promise<void> {
  await q('INSERT INTO events (kind, subscription_id, resource_id, actor_id, data) VALUES ($1, $2, $3, $4, $5)', [
    kind,
    meta.subscriptionId?.toLowerCase() ?? null,
    meta.resourceId?.toLowerCase() ?? null,
    meta.actorId ?? null,
    JSON.stringify(data),
  ]);
}

export interface EventQuery {
  kind: EventKind;
  subscriptionId?: string;
  resourcePrefix?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}

export async function queryEvents(qy: EventQuery): Promise<any[]> {
  const where = ['kind = $1'];
  const params: unknown[] = [qy.kind];
  if (qy.subscriptionId) {
    params.push(qy.subscriptionId.toLowerCase());
    where.push(`subscription_id = $${params.length}`);
  }
  if (qy.resourcePrefix) {
    params.push(qy.resourcePrefix.toLowerCase());
    where.push(`(resource_id = $${params.length} OR starts_with(resource_id, $${params.length} || '/'))`);
  }
  if (qy.from) {
    params.push(qy.from);
    where.push(`ts >= $${params.length}`);
  }
  if (qy.to) {
    params.push(qy.to);
    where.push(`ts <= $${params.length}`);
  }
  const limit = Math.min(Math.max(qy.limit ?? 500, 1), 5000);
  const rows = await q(`SELECT data FROM events WHERE ${where.join(' AND ')} ORDER BY ts DESC, id DESC LIMIT ${limit}`, params);
  return rows.map((r) => r.data);
}
