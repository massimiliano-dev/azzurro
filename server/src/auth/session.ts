import { q } from '../db/pool.ts';
import { config } from '../config.ts';
import { randomToken, sha256 } from '../ids.ts';

export async function createSession(userId: string, data: Record<string, unknown> = {}): Promise<{ id: string; maxAge: number }> {
  const id = randomToken(32);
  const maxAge = Math.round(config.sessionHours * 3600);
  await q('INSERT INTO sessions (id, user_id, expires_at, data) VALUES ($1, $2, now() + make_interval(secs => $3), $4)', [
    sha256(id), userId, maxAge, JSON.stringify(data),
  ]);
  return { id, maxAge };
}

export async function getSession(id: string | undefined): Promise<{ hash: string; userId: string; data: any } | null> {
  if (!id) return null;
  const rows = await q('SELECT id, user_id, data FROM sessions WHERE id = $1 AND expires_at > now()', [sha256(id)]);
  return rows[0] ? { hash: rows[0].id, userId: rows[0].user_id, data: rows[0].data } : null;
}

export async function deleteSession(id: string | undefined): Promise<void> {
  if (!id) return;
  await q('DELETE FROM sessions WHERE id = $1', [sha256(id)]);
}

export async function deleteUserSessions(userId: string): Promise<void> {
  await q('DELETE FROM sessions WHERE user_id = $1', [userId]);
}

export async function purgeExpired(): Promise<void> {
  await q('DELETE FROM sessions WHERE expires_at < now()');
  await q(`DELETE FROM objects WHERE collection IN ('authCode', 'deviceCode', 'refreshToken', 'pwTicket', 'loginHandoff', 'msAuthState') AND (data->>'expires')::timestamptz < now()`);
}

export async function updateSessionData(id: string, patch: Record<string, unknown>): Promise<void> {
  await q(`UPDATE sessions SET data = coalesce(data, '{}'::jsonb) || $2::jsonb WHERE id = $1`, [sha256(id), JSON.stringify(patch)]);
}
