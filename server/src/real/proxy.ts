/**
 * Modalità Azure reale: le richieste ARM e Graph del portale (sessione con cookie)
 * vanno a management.azure.com e graph.microsoft.com con i token delegati dell'utente.
 * Gli strumenti con token emulati (Azure CLI, SDK, Terraform) restano sull'emulatore.
 */
import type { Context, Next } from 'hono';
import { parseCookies, SESSION_COOKIE } from '../http.ts';
import { getSession } from '../auth/session.ts';
import { accessToken, ConsentRequired, forgetToken, type Resource } from './tokens.ts';

export interface Directory { tenantId: string; name: string; domain?: string }

export async function sessionDirectory(c: Context): Promise<{ userId: string; directory: Directory | null; sessionId: string } | null> {
  if (c.req.header('authorization')) return null;
  const sid = parseCookies(c.req.header('cookie'))[SESSION_COOKIE];
  if (!sid) return null;
  const s = await getSession(sid);
  if (!s) return null;
  const d = s.data?.directory;
  return { userId: s.userId, sessionId: sid, directory: d && d.tenantId ? d : null };
}

const ARM = 'https://management.azure.com';
const GRAPH = 'https://graph.microsoft.com';

export function consentError(e: ConsentRequired) {
  return { error: { code: 'DirectoryConsentRequired', message: e.message, tenant: e.tenant, resource: e.resource, aadCode: e.aadCode ?? null, consentUrl: `/api/portal/auth/connect?tenant=${encodeURIComponent(e.tenant)}&resource=${e.resource}` } };
}

/** Chiamata diretta ad Azure reale (usata anche dagli endpoint del portale in modalità reale). */
export async function realFetch(userId: string, tenant: string, resource: Resource, pathAndQuery: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}): Promise<Response> {
  const { token } = await accessToken(userId, tenant, resource);
  return fetch(`${resource === 'arm' ? ARM : GRAPH}${pathAndQuery}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) },
    body: init.body,
  });
}

export async function realJson<T = any>(userId: string, tenant: string, resource: Resource, pathAndQuery: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; json: T }> {
  const r = await realFetch(userId, tenant, resource, pathAndQuery, { ...init, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const text = await r.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: r.status, json };
}

const costCache = new Map<string, { body: string; until: number; stale: number }>();

const ARM_PATH = /^\/(subscriptions|providers|tenants|resources)(\/|$)/i;
const GRAPH_PATH = /^\/(v1\.0|beta)(\/|$)/i;

export async function realProxy(c: Context, next: Next) {
  const path = c.req.path;
  const graph = GRAPH_PATH.test(path);
  if (!graph && !ARM_PATH.test(path)) return next();
  const ctx = await sessionDirectory(c);
  if (!ctx?.directory) return next();
  const method = c.req.method;
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && c.req.header('x-azzurro-portal') !== '1') {
    return c.json({ error: { code: 'CsrfCheckFailed', message: 'Missing X-Azzurro-Portal header.' } }, 403);
  }
  const url = new URL(c.req.url);
  const body = ['GET', 'HEAD', 'DELETE'].includes(method) ? undefined : await c.req.text();
  const headers: Record<string, string> = {};
  for (const h of ['consistencylevel', 'prefer', 'if-match', 'if-none-match']) {
    const v = c.req.header(h);
    if (v) headers[h] = v;
  }
  // Cost Management è molto limitato (poche richieste al minuto per scope): cache e un tentativo dopo il 429
  const costKey = !graph && method === 'POST' && /\/providers\/microsoft\.costmanagement\/(query|forecast)$/i.test(path) ? `${ctx.userId}|${ctx.directory.tenantId}|${path.toLowerCase()}|${body}` : null;
  if (costKey) {
    const hit = costCache.get(costKey);
    if (hit && hit.until > Date.now()) return new Response(hit.body, { status: 200, headers: { 'content-type': 'application/json', 'x-azzurro-cache': 'hit', 'x-azzurro-directory': ctx.directory.tenantId } });
  }
  let res: Response;
  try {
    res = await realFetch(ctx.userId, ctx.directory.tenantId, graph ? 'graph' : 'arm', `${path}${url.search}`, { method, body: body || undefined, headers });
    if (costKey && res.status === 429) {
      const wait = Math.min(12, Number(res.headers.get('retry-after') ?? res.headers.get('x-ms-ratelimit-microsoft.costmanagement-entity-retry-after') ?? 5)) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      res = await realFetch(ctx.userId, ctx.directory.tenantId, 'arm', `${path}${url.search}`, { method, body: body || undefined, headers });
    }
    if (costKey) {
      const text = await res.text();
      if (res.ok) {
        costCache.set(costKey, { body: text, until: Date.now() + 10 * 60_000, stale: Date.now() + 24 * 3600_000 });
        return new Response(text, { status: 200, headers: { 'content-type': 'application/json', 'x-azzurro-directory': ctx.directory.tenantId } });
      }
      const old = costCache.get(costKey);
      if (old && old.stale > Date.now()) return new Response(old.body, { status: 200, headers: { 'content-type': 'application/json', 'x-azzurro-cache': 'stale', 'x-azzurro-directory': ctx.directory.tenantId } });
      return new Response(text, { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json', 'x-azzurro-directory': ctx.directory.tenantId } });
    }
  } catch (e) {
    if (e instanceof ConsentRequired) return c.json(consentError(e), 401);
    return c.json({ error: { code: 'AzureUnreachable', message: (e as Error).message } }, 502);
  }
  // 403 da Graph: al prossimo giro si chiede un token nuovo, che include eventuali consensi appena dati
  if (graph && res.status === 403) forgetToken(ctx.userId, ctx.directory.tenantId, 'graph');
  const out = new Headers();
  for (const h of ['content-type', 'retry-after', 'x-ms-request-id', 'x-ms-correlation-request-id', 'etag']) {
    const v = res.headers.get(h);
    if (v) out.set(h, v);
  }
  for (const h of ['azure-asyncoperation', 'location']) {
    const v = res.headers.get(h);
    if (v) out.set(h, v.replace(ARM, '').replace(GRAPH, ''));
  }
  out.set('x-azzurro-directory', ctx.directory.tenantId);
  return new Response(method === 'HEAD' ? null : res.body, { status: res.status, headers: out });
}
