/**
 * Modalità Azure reale: le richieste ARM e Graph del portale (sessione con cookie)
 * vanno a management.azure.com e graph.microsoft.com con i token delegati dell'utente.
 * Gli strumenti con token emulati (Azure CLI, SDK, Terraform) restano sull'emulatore.
 */
import type { Context, Next } from 'hono';
import * as store from '../db/store.ts';
import { sha256 } from '../ids.ts';
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

// ------------------------------------------------------------------ Cost Management
/*
 * Azure limita Cost Management a poche query al minuto per scope (sottoscrizione) e risponde 429.
 * - una query alla volta per scope, e se Azure chiede di aspettare aspetta tutta la coda;
 * - risposte in cache, anche nel database (sopravvivono ai riavvii): dopo 10 minuti si mostra
 *   comunque il dato salvato e lo si aggiorna in coda in background;
 * - gli errori definitivi (400, 403, 404) si ricordano per 30 minuti invece di richiederli a ogni pagina.
 */
const FRESH = 10 * 60_000;
const KEEP = 7 * 24 * 3600_000;
interface CostEntry { body: string; at: number }
const costCache = new Map<string, CostEntry>();
const costErrors = new Map<string, { status: number; body: string; until: number }>();
const refreshing = new Set<string>();
const lanes = new Map<string, { tail: Promise<unknown>; blockedUntil: number }>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function cached(key: string): Promise<CostEntry | null> {
  const mem = costCache.get(key);
  if (mem) return mem;
  const row = await store.get<CostEntry>('costCache', sha256(key)).catch(() => null);
  if (row && Date.now() - row.at < KEEP) { costCache.set(key, row); return row; }
  return null;
}

function remember(key: string, body: string): void {
  const e = { body, at: Date.now() };
  costCache.set(key, e);
  void store.put('costCache', sha256(key), e).catch(() => undefined);
}

/** Secondi da aspettare indicati da Azure (il più lungo tra le intestazioni di Cost Management). */
function retryAfter(res: Response): number {
  const names = ['retry-after', 'x-ms-ratelimit-microsoft.costmanagement-qpu-retry-after', 'x-ms-ratelimit-microsoft.costmanagement-entity-retry-after', 'x-ms-ratelimit-microsoft.costmanagement-tenant-retry-after', 'x-ms-ratelimit-microsoft.costmanagement-clienttype-retry-after'];
  const secs = names.map((n) => Number(res.headers.get(n))).filter((n) => Number.isFinite(n) && n > 0);
  return secs.length ? Math.max(...secs) : 10;
}

/** Una query per volta per scope; sul 429 la coda dello scope si ferma per il tempo chiesto da Azure. */
export async function costFetch(lane: string, run: () => Promise<Response>, budgetMs = 60_000): Promise<Response> {
  const l = lanes.get(lane) ?? { tail: Promise.resolve(), blockedUntil: 0 };
  lanes.set(lane, l);
  let release!: () => void;
  const prev = l.tail;
  l.tail = new Promise<void>((r) => { release = r; });
  const start = Date.now();
  try {
    await prev.catch(() => undefined);
    for (;;) {
      const wait = l.blockedUntil - Date.now();
      if (wait > 0) await sleep(wait);
      const res = await run();
      if (res.status !== 429) return res;
      l.blockedUntil = Date.now() + Math.min(60, retryAfter(res)) * 1000;
      if (Date.now() + (l.blockedUntil - Date.now()) - start > budgetMs) return res;
    }
  } finally {
    release();
  }
}

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
  const costKey = !graph && method === 'POST' && /\/providers\/microsoft\.costmanagement\/(query|forecast)$/i.test(path) ? `${ctx.userId}|${ctx.directory.tenantId}|${path.toLowerCase()}|${body}` : null;
  if (costKey) {
    const dir = ctx.directory;
    const json = (b: string, extra: Record<string, string> = {}) => new Response(b, { status: 200, headers: { 'content-type': 'application/json', 'x-azzurro-directory': dir.tenantId, ...extra } });
    const scope = path.toLowerCase().split('/providers/microsoft.costmanagement/')[0];
    const lane = `${dir.tenantId}|${scope}`;
    const fetchCost = () => costFetch(lane, () => realFetch(ctx.userId, dir.tenantId, 'arm', `${path}${url.search}`, { method, body: body || undefined, headers }));
    const err = costErrors.get(costKey);
    if (err && err.until > Date.now()) return new Response(err.body, { status: err.status, headers: { 'content-type': 'application/json', 'x-azzurro-cache': 'error', 'x-azzurro-directory': dir.tenantId } });
    const hit = await cached(costKey);
    if (hit && Date.now() - hit.at < FRESH) return json(hit.body, { 'x-azzurro-cache': 'hit' });
    if (hit) {
      // dato salvato subito, aggiornamento in coda senza far aspettare la pagina
      if (!refreshing.has(costKey)) {
        refreshing.add(costKey);
        void fetchCost().then(async (r) => { if (r.ok) remember(costKey, await r.text()); }).catch(() => undefined).finally(() => refreshing.delete(costKey));
      }
      return json(hit.body, { 'x-azzurro-cache': 'stale', 'x-azzurro-cached-at': new Date(hit.at).toISOString() });
    }
    try {
      const res = await fetchCost();
      const text = await res.text();
      if (res.ok) { remember(costKey, text); return json(text); }
      if ([400, 403, 404].includes(res.status)) costErrors.set(costKey, { status: res.status, body: text, until: Date.now() + 30 * 60_000 });
      return new Response(text, { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json', 'x-azzurro-directory': dir.tenantId } });
    } catch (e) {
      if (e instanceof ConsentRequired) return c.json(consentError(e), 401);
      return c.json({ error: { code: 'AzureUnreachable', message: (e as Error).message } }, 502);
    }
  }
  let res: Response;
  try {
    res = await realFetch(ctx.userId, ctx.directory.tenantId, graph ? 'graph' : 'arm', `${path}${url.search}`, { method, body: body || undefined, headers });
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
