'use client';

import { traceBegin, traceEnd } from './trace';
import { cached, invalidate } from './cache';

export class ApiError extends Error {
  status: number;
  code: string;
  details?: { code: string; message: string; target?: string }[];
  constructor(status: number, code: string, message: string, details?: ApiError['details']) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface ApiResponse<T> {
  data: T;
  status: number;
  headers: Headers;
}

/** Quanto può restare in cache una lettura (0 = mai). Le azioni che restituiscono segreti non si conservano. */
function cacheTtl(method: string, url: string): number {
  const path = url.split('?')[0].toLowerCase();
  if (method === 'POST') return /\/providers\/microsoft\.costmanagement\/(query|forecast)$/.test(path) ? 5 * 60_000 : 0;
  if (method !== 'GET') return 0;
  if (path.startsWith('/api/portal/')) {
    if (/^\/api\/portal\/(assistant|notifications|session|settings|push|auth|token)/.test(path)) return 0;
    if (path.startsWith('/api/portal/overview')) return 20_000;
    if (path.startsWith('/api/portal/config') || path.startsWith('/api/portal/catalog') || path.startsWith('/api/portal/pricing')) return 10 * 60_000;
    return 30_000;
  }
  return 60_000;
}

/** Dopo una modifica: via le letture della stessa famiglia e i riepiloghi che ne dipendono. */
function invalidateAfter(method: string, url: string): void {
  const path = url.split('?')[0].toLowerCase();
  if (method === 'GET') return;
  if (method === 'POST' && (/\/providers\/microsoft\.costmanagement\/(query|forecast)$/.test(path) || /\/(list\w*|check\w*|validate\w*|whatif|getbyids)$/.test(path))) return;
  const family = path.startsWith('/api/arm/') ? 'arm' : path.startsWith('/api/graph/') ? 'graph' : 'portal';
  invalidate((k) => {
    const kp = k.split(' ')[1]?.toLowerCase() ?? '';
    if (kp.startsWith('/api/portal/overview') || kp.startsWith('/api/portal/search')) return true;
    if (family === 'arm') return kp.startsWith('/api/arm/') || kp.startsWith('/api/portal/pricing/estimate');
    if (family === 'graph') return kp.startsWith('/api/graph/');
    return kp.startsWith(path.split('/').slice(0, 4).join('/'));
  });
}

async function request<T>(method: string, url: string, body?: unknown, opts: { noRedirect?: boolean; raw?: boolean } = {}): Promise<ApiResponse<T>> {
  const ttl = cacheTtl(method, url);
  if (ttl > 0) return cached(`${method} ${url} ${body === undefined ? '' : JSON.stringify(body)}`, ttl, () => send<T>(method, url, body, opts));
  const res = await send<T>(method, url, body, opts);
  invalidateAfter(method, url);
  return res;
}

async function send<T>(method: string, url: string, body?: unknown, opts: { noRedirect?: boolean; raw?: boolean } = {}): Promise<ApiResponse<T>> {
  let res: Response;
  const traceId = traceBegin(method, url, body);
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'X-Azzurro-Portal': '1', Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    traceEnd(traceId, 0, null, 'Network error');
    throw new ApiError(0, 'NetworkError', 'Network error');
  }
  const peek = res.clone();
  void peek.text().then((txt) => {
    let parsed: unknown = txt;
    try { parsed = txt ? JSON.parse(txt) : null; } catch { /* testo */ }
    traceEnd(traceId, res.status, parsed);
  });
  const text = await res.text();
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  // 401 di consenso per una directory Azure reale: non è una sessione scaduta
  const consent = data?.error?.code === 'DirectoryConsentRequired';
  if (res.status === 401 && !consent && !opts.noRedirect && typeof window !== 'undefined' && !location.pathname.startsWith('/login')) {
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
    throw new ApiError(401, 'Unauthorized', 'Session expired');
  }
  if (!res.ok) {
    const err = data?.error;
    const code = typeof err === 'string' ? err : err?.code ?? `HTTP${res.status}`;
    const message = typeof err === 'object' && err ? err.message : data?.error_description ?? res.statusText;
    throw new ApiError(res.status, code, message, err?.details);
  }
  return { data: data as T, status: res.status, headers: res.headers };
}

const DEFAULT_API = '2021-04-01';

function armUrl(path: string, apiVersion: string, extra?: Record<string, string | undefined>) {
  const qs = new URLSearchParams({ 'api-version': apiVersion });
  for (const [k, v] of Object.entries(extra ?? {})) if (v !== undefined) qs.set(k, v);
  const p = path.startsWith('/') ? path : `/${path}`;
  return `/api/arm${p.split('/').map((s) => encodeURIComponent(s).replace(/%24/g, '$')).join('/')}?${qs}`;
}

/** Azure rifiuta una versione API e indica quelle supportate: si riprova una volta con la più recente stabile. */
export function supportedApiVersion(e: unknown): string | null {
  if (!(e instanceof ApiError) || e.status !== 400) return null;
  const m = /supported api-versions are '([^']+)'/i.exec(e.message ?? '');
  if (!m) return null;
  const versions = m[1].split(',').map((v) => v.trim()).filter(Boolean).sort().reverse();
  return versions.find((v) => !/preview/i.test(v)) ?? versions[0] ?? null;
}

async function armCall<T>(method: string, path: string, apiVersion: string, body?: unknown, query?: Record<string, string | undefined>) {
  try {
    return await request<T>(method, armUrl(path, apiVersion, query), body);
  } catch (e) {
    const v = supportedApiVersion(e);
    if (!v || v === apiVersion) throw e;
    return request<T>(method, armUrl(path, v, query), body);
  }
}

export const arm = {
  get: async <T = any>(path: string, apiVersion = DEFAULT_API, query?: Record<string, string | undefined>) => (await armCall<T>('GET', path, apiVersion, undefined, query)).data,
  put: async <T = any>(path: string, body: unknown, apiVersion = DEFAULT_API) => (await armCall<T>('PUT', path, apiVersion, body)).data,
  putRaw: <T = any>(path: string, body: unknown, apiVersion = DEFAULT_API) => armCall<T>('PUT', path, apiVersion, body),
  patch: async <T = any>(path: string, body: unknown, apiVersion = DEFAULT_API) => (await armCall<T>('PATCH', path, apiVersion, body)).data,
  post: async <T = any>(path: string, body: unknown = {}, apiVersion = DEFAULT_API) => (await armCall<T>('POST', path, apiVersion, body)).data,
  del: async (path: string, apiVersion = DEFAULT_API) => { await armCall('DELETE', path, apiVersion); },
};

function graphUrl(path: string) {
  return `/api/graph${path.startsWith('/') ? path : `/${path}`}`;
}

export const graph = {
  get: async <T = any>(path: string) => (await request<T>('GET', graphUrl(path))).data,
  list: async <T = any>(path: string) => (await request<{ value: T[] }>('GET', graphUrl(path))).data.value,
  /** Graph beta: alcune proprietà (es. signInEventTypes dei log di accesso) esistono solo lì */
  listBeta: async <T = any>(path: string) => (await request<{ value: T[] }>('GET', `/api/graph-beta${path.startsWith('/') ? path : `/${path}`}`)).data.value,
  post: async <T = any>(path: string, body: unknown = {}) => (await request<T>('POST', graphUrl(path), body)).data,
  patch: async (path: string, body: unknown) => { await request('PATCH', graphUrl(path), body); },
  del: async (path: string) => { await request('DELETE', graphUrl(path)); },
};

export const portal = {
  get: async <T = any>(path: string, opts?: { noRedirect?: boolean }) => (await request<T>('GET', `/api/portal${path}`, undefined, opts)).data,
  post: async <T = any>(path: string, body: unknown = {}, opts?: { noRedirect?: boolean }) => (await request<T>('POST', `/api/portal${path}`, body, opts)).data,
  put: async <T = any>(path: string, body: unknown) => (await request<T>('PUT', `/api/portal${path}`, body)).data,
  del: async (path: string) => { await request('DELETE', `/api/portal${path}`); },
};
