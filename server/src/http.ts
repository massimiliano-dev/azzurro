import type { Context } from 'hono';

/** Origine con cui il client ha raggiunto il server (rispetta i proxy). */
export function originOf(c: Context): string {
  const u = new URL(c.req.url);
  const xfh = c.req.header('x-forwarded-host')?.split(',')[0].trim();
  const xfp = c.req.header('x-forwarded-proto')?.split(',')[0].trim();
  return `${xfp || u.protocol.replace(':', '')}://${xfh || u.host}`;
}

export async function readJson(c: Context): Promise<any> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    const { HttpError } = await import('./errors.ts');
    throw new HttpError(400, 'InvalidRequestContent', 'The request content was invalid and could not be deserialized.');
  }
}

export async function readForm(c: Context): Promise<Record<string, string>> {
  const ct = c.req.header('content-type') ?? '';
  if (ct.includes('application/json')) {
    const j = await readJson(c);
    return Object.fromEntries(Object.entries(j).map(([k, v]) => [k, String(v)]));
  }
  const text = await c.req.text();
  return Object.fromEntries(new URLSearchParams(text));
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export const SESSION_COOKIE = 'azzurro_session';

export function sessionCookie(value: string, maxAgeSec: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
}

export function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}
