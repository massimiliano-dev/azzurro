/** Endpoint del portale per le directory reali: elenco, cambio directory, consenso, panoramica e ricerca. */
import type { Hono, Context, Next } from 'hono';
import { config } from '../config.ts';
import * as store from '../db/store.ts';
import { readJson } from '../http.ts';
import { HttpError } from '../errors.ts';
import { updateSessionData } from '../auth/session.ts';
import { beginMicrosoftLogin, msEnabled } from '../auth/microsoft.ts';
import { tenant as localTenant } from '../directory.ts';
import { typeDef } from '../arm/catalog.ts';
import { estimate } from '../costs/engine.ts';
import type { AppEnv } from '../types.ts';
import { accessToken, ConsentRequired, CONSENT_SCOPES, homeTenantOf, type Resource } from './tokens.ts';
import { consentError, realJson, sessionDirectory, type Directory } from './proxy.ts';

/** Nome leggibile dell'organizzazione dal dominio di accesso: utente@contoso.com → Contoso. */
function orgName(upn?: string): string | undefined {
  const label = upn?.split('@')[1]?.split('.')[0];
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : undefined;
}

async function tenantsOf(userId: string): Promise<{ tenantId: string; name: string; domain?: string }[]> {
  const home = await homeTenantOf(userId);
  if (!home) return [];
  try {
    const r = await realJson(userId, home, 'arm', '/tenants?api-version=2022-12-01');
    if (r.status === 200) return (r.json.value ?? []).map((t: any) => ({ tenantId: t.tenantId, name: t.displayName ?? t.defaultDomain ?? t.tenantId, domain: t.defaultDomain }));
  } catch { /* consenso ARM non ancora dato */ }
  const u = (await store.list('user', { match: { _msTenantId: home }, limit: 1 }))[0];
  return [{ tenantId: home, name: home === config.msTenantId ? orgName(u?.userPrincipalName) ?? home : home, domain: u?.userPrincipalName?.split('@')[1] }];
}

async function realReady(userId: string, tenantId: string): Promise<{ arm: boolean; graph: boolean; graphScopes: string; armError?: ConsentRequired }> {
  let arm = false, graph = false, graphScopes = '', armError: ConsentRequired | undefined;
  try { await accessToken(userId, tenantId, 'arm'); arm = true; } catch (e) { if (e instanceof ConsentRequired) armError = e; }
  // Graph serve per leggere la directory (IAM, Entra ID): basta il profilo personale non basta
  try { const g = await accessToken(userId, tenantId, 'graph'); graphScopes = g.scp; graph = /\b(Directory\.Read(Write)?\.All|User\.Read(Write)?\.All)\b/.test(g.scp); } catch { /* facoltativo */ }
  return { arm, graph, graphScopes, armError };
}

function realOnly(handler: (c: Context, d: { userId: string; directory: Directory }) => Promise<Response>) {
  return async (c: Context, next: Next) => {
    const ctx = await sessionDirectory(c);
    if (!ctx?.directory) return next();
    try {
      return await handler(c, { userId: ctx.userId, directory: ctx.directory });
    } catch (e) {
      if (e instanceof ConsentRequired) return c.json(consentError(e), 401);
      throw e;
    }
  };
}

const sinceIso = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

export function realRoutes(app: Hono<AppEnv>): void {
  app.get('/_portal/directories', async (c) => {
    const ctx = await sessionDirectory(c);
    if (!ctx) throw new HttpError(401, 'unauthorized', 'Sign in first.');
    const local = { tenantId: 'local', name: `${localTenant().displayName} (emulatore)`, domain: localTenant().defaultDomain, kind: 'local' };
    const real = msEnabled() ? await tenantsOf(ctx.userId) : [];
    const active = ctx.directory?.tenantId ?? 'local';
    let status = null;
    if (ctx.directory) {
      const r = await realReady(ctx.userId, ctx.directory.tenantId);
      status = { arm: r.arm, graph: r.graph, graphScopes: r.graphScopes };
    }
    return c.json({ active, status, microsoft: msEnabled(), value: [local, ...real.map((t) => ({ ...t, kind: 'azure' }))] });
  });

  app.post('/_portal/directories/switch', async (c) => {
    const ctx = await sessionDirectory(c);
    if (!ctx) throw new HttpError(401, 'unauthorized', 'Sign in first.');
    const body = await readJson(c);
    const tenantId = String(body.tenantId ?? 'local');
    const remember = async (v: string) => {
      const u = await store.get('user', ctx.userId);
      if (u) { u._lastDirectory = v; await store.put('user', u.id, u, localTenant().id); }
    };
    if (tenantId === 'local') {
      await updateSessionData(ctx.sessionId, { directory: null });
      await remember('local');
      return c.json({ status: 'ok', active: 'local' });
    }
    const known = (await tenantsOf(ctx.userId)).find((t) => t.tenantId === tenantId);
    const ready = await realReady(ctx.userId, tenantId);
    if (!ready.arm && ready.armError?.aadCode === 'AADSTS700016') {
      // app registration a tenant singolo: le altre directory non la conoscono
      return c.json({ status: 'app_not_multitenant', message: 'APP_NOT_MULTITENANT' });
    }
    if (!ready.arm) {
      const u = await store.get('user', ctx.userId);
      const url = await beginMicrosoftLogin(`/?directory=${encodeURIComponent(tenantId)}`, { purpose: 'consent', tenant: tenantId, scopes: CONSENT_SCOPES.arm, userId: ctx.userId, loginHint: u?.userPrincipalName });
      return c.json({ status: 'consent_required', resource: 'arm', redirect: url, message: ready.armError?.message ?? null });
    }
    await updateSessionData(ctx.sessionId, { directory: { tenantId, name: known?.name ?? tenantId, domain: known?.domain } });
    await remember(tenantId);
    return c.json({ status: 'ok', active: tenantId, graph: ready.graph });
  });

  /** Consenso interattivo per una risorsa (ARM o Graph) in un tenant: lo concede l'utente nella pagina Microsoft. */
  app.get('/_portal/auth/connect', async (c) => {
    const ctx = await sessionDirectory(c);
    if (!ctx) return c.redirect(`${config.portalUrl}/login`, 302);
    const tenantId = String(c.req.query('tenant') ?? '');
    const resource = (c.req.query('resource') === 'graph' ? 'graph' : 'arm') as Resource;
    if (!/^[0-9a-f-]{36}$/i.test(tenantId)) throw new HttpError(400, 'bad_tenant', 'Invalid tenant id.');
    const u = await store.get('user', ctx.userId);
    return c.redirect(await beginMicrosoftLogin(String(c.req.query('returnTo') ?? `/?directory=${tenantId}`), { purpose: 'consent', tenant: tenantId, scopes: CONSENT_SCOPES[resource], userId: ctx.userId, loginHint: u?.userPrincipalName }), 302);
  });

  app.get('/_portal/overview', realOnly(async (c, { userId, directory }) => {
    const t = directory.tenantId;
    const subsR = await realJson(userId, t, 'arm', '/subscriptions?api-version=2022-12-01');
    const subs: any[] = subsR.status === 200 ? subsR.json.value ?? [] : [];
    let rgCount = 0;
    const resources: any[] = [];
    await Promise.all(subs.slice(0, 20).map(async (s) => {
      const [rg, res] = await Promise.all([
        realJson(userId, t, 'arm', `/subscriptions/${s.subscriptionId}/resourcegroups?api-version=2021-04-01`),
        realJson(userId, t, 'arm', `/subscriptions/${s.subscriptionId}/resources?api-version=2021-04-01&$expand=changedTime,createdTime&$top=1000`),
      ]);
      rgCount += rg.json?.value?.length ?? 0;
      for (const r of res.json?.value ?? []) resources.push(r);
    }));
    const byType = Object.entries(resources.reduce((m: Record<string, number>, r) => ((m[r.type] = (m[r.type] ?? 0) + 1), m), {})).map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count);
    const recent = [...resources].sort((a, b) => String(b.changedTime ?? b.createdTime ?? '').localeCompare(String(a.changedTime ?? a.createdTime ?? ''))).slice(0, 8)
      .map((r) => ({ id: r.id, name: r.name, type: r.type, location: r.location, changedTime: r.changedTime ?? r.createdTime ?? null, resourceGroup: /\/resourceGroups\/([^/]+)/i.exec(r.id)?.[1] ?? null }));
    const count = async (path: string) => {
      try {
        const r = await realJson<number>(userId, t, 'graph', `/v1.0/${path}/$count`, { headers: { ConsistencyLevel: 'eventual' } });
        return r.status === 200 ? Number(r.json) : null;
      } catch { return null; }
    };
    const [applications, servicePrincipals, users, groups] = await Promise.all(['applications', 'servicePrincipals', 'users', 'groups'].map(count));
    const activity: any[] = [];
    await Promise.all(subs.slice(0, 3).map(async (s) => {
      const f = encodeURIComponent(`eventTimestamp ge '${sinceIso(24)}'`);
      const r = await realJson(userId, t, 'arm', `/subscriptions/${s.subscriptionId}/providers/Microsoft.Insights/eventtypes/management/values?api-version=2015-04-01&$filter=${f}&$select=eventDataId,operationName,status,resourceId,caller,eventTimestamp`);
      for (const e of r.json?.value ?? []) if (e.operationName?.value && /\/(write|delete|action)$/i.test(e.operationName.value)) activity.push(e);
    }));
    activity.sort((a, b) => String(b.eventTimestamp).localeCompare(String(a.eventTimestamp)));
    return c.json({
      directory,
      counts: { subscriptions: subs.length, resourceGroups: rgCount, resources: resources.length, applications, servicePrincipals, users, groups, deploymentsRunning: 0, deploymentsFailed: 0, unreadNotifications: 0 },
      byType, recentResources: recent, recentActivity: activity.slice(0, 10),
      subscriptions: subs.map((s) => ({ subscriptionId: s.subscriptionId, displayName: s.displayName, state: s.state })),
    });
  }));

  app.get('/_portal/search', realOnly(async (c, { userId, directory }) => {
    const term = String(c.req.query('q') ?? '').trim();
    if (term.length < 2) return c.json({ value: [] });
    const q = term.replace(/['"\\]/g, '');
    const rgq = (query: string) => realJson(userId, directory.tenantId, 'arm', '/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01', { method: 'POST', body: { query } });
    const [res, groups] = await Promise.all([
      rgq(`resources | where name contains '${q}' | project id, name, type, location | limit 15`),
      rgq(`resourcecontainers | where type =~ 'microsoft.resources/subscriptions/resourcegroups' and name contains '${q}' | project id, name, type, location | limit 8`),
    ]);
    const rows = (r: { json: any }) => (Array.isArray(r.json?.data) ? r.json.data : r.json?.data?.rows ?? []);
    const out = [
      ...rows(groups).map((x: any) => ({ kind: 'resourceGroup', id: x.id, name: x.name, subtitle: x.location })),
      ...rows(res).map((x: any) => ({ kind: 'resource', id: x.id, name: x.name, subtitle: x.type })),
    ];
    return c.json({ value: out });
  }));

  /** Stima di una risorsa reale: si legge il JSON da ARM e si applica il listino indicativo. */
  app.get('/_portal/pricing/estimate', realOnly(async (c, { userId, directory }) => {
    const id = String(c.req.query('id') ?? '');
    const apiVersion = String(c.req.query('api-version') ?? typeDef(/\/providers\/(.+)$/i.exec(id)?.[1].split('/').filter((_, i) => i % 2 === 0 || i === 0).join('/') ?? '')?.apiVersions[0] ?? '2021-04-01');
    const r = await realJson(userId, directory.tenantId, 'arm', `${id}?api-version=${apiVersion}`);
    if (r.status >= 400) return c.json(r.json, r.status as any);
    return c.json({ currency: 'EUR', estimate: estimate(r.json), monthToDate: null, forecast: null, createdAt: null, power: null, real: true });
  }));

  /** Versione API per un tipo non presente nel catalogo (metadati del provider reale). */
  app.get('/_portal/apiversion', async (c) => {
    const type = String(c.req.query('type') ?? '');
    const sub = String(c.req.query('sub') ?? '');
    const known = typeDef(type)?.apiVersions[0];
    const ctx = await sessionDirectory(c);
    if (known || !ctx?.directory || !sub) return c.json({ apiVersion: known ?? '2021-04-01' });
    const [ns, ...rest] = type.split('/');
    const r = await realJson(ctx.userId, ctx.directory.tenantId, 'arm', `/subscriptions/${sub}/providers/${ns}?api-version=2021-04-01`);
    const rt = (r.json?.resourceTypes ?? []).find((x: any) => String(x.resourceType).toLowerCase() === rest.join('/').toLowerCase());
    const versions: string[] = rt?.apiVersions ?? [];
    return c.json({ apiVersion: versions.find((v) => !/preview/i.test(v)) ?? versions[0] ?? '2021-04-01' });
  });

  /** Applica i valori predefiniti del catalogo a un corpo di creazione (in Azure reale nessuno li applica per te). */
  app.post('/_portal/prepare', async (c) => {
    const body = await readJson(c);
    const def = typeDef(String(body.type ?? ''));
    const res = structuredClone(body.resource ?? {});
    if (def?.defaults) {
      const name = String(body.name ?? '');
      def.defaults(res, { id: String(body.id ?? ''), name, names: [name], sub: String(body.sub ?? ''), rg: body.rg, location: res.location, tenantId: localTenant().id, now: new Date().toISOString() });
    }
    return c.json({ resource: res });
  });
}

/** Directory iniziale dopo l'accesso: l'ultima scelta, altrimenti quella aziendale se Azure è già autorizzato. */
export async function initialDirectory(userId: string): Promise<Directory | null> {
  const u = await store.get('user', userId);
  const target = u?._lastDirectory ?? (await homeTenantOf(userId));
  if (!target || target === 'local') return null;
  try {
    await accessToken(userId, target, 'arm');
  } catch {
    return null;
  }
  const known = (await tenantsOf(userId)).find((t) => t.tenantId === target);
  return { tenantId: target, name: known?.name ?? target, domain: known?.domain };
}
