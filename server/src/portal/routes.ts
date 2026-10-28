import type { Hono } from 'hono';
import { config } from '../config.ts';
import { q } from '../db/pool.ts';
import * as store from '../db/store.ts';
import { HttpError } from '../errors.ts';
import { originOf, parseCookies, readJson, SESSION_COOKIE, sessionCookie } from '../http.ts';
import { authenticate } from '../auth/middleware.ts';
import { authenticateUser, type Client } from '../auth/clients.ts';
import { createSession, deleteSession } from '../auth/session.ts';
import { recordSignIn } from '../auth/signins.ts';
import { setPassword, clientIp } from '../auth/routes.ts';
import { issueTokens } from '../auth/issue.ts';
import { directoryRolesOf, roleTemplate, spByAppId, tenant } from '../directory.ts';
import { AZURE_CLI_APP_ID, GLOBAL_ADMIN } from '../firstParty.ts';
import { passwordIsComplex, randomToken, sha256 } from '../ids.ts';
import { queryEvents } from '../events.ts';
import { vapidKeys } from '../auth/keys.ts';
import { CATEGORIES, getSettings, notify, saveSettings, sendToUser } from '../push.ts';
import { TYPES } from '../arm/catalog.ts';
import { LOCATIONS } from '../arm/locations.ts';
import { loadAccess, can, hasAnyAccessWithin } from '../arm/rbac.ts';
import { existsSync } from 'node:fs';
import { pricingRoutes } from '../costs/portal.ts';
import { initialDirectory, realRoutes } from '../real/routes.ts';
import { assistantRoutes } from '../assistant/routes.ts';
import { adminRoutes } from './admin.ts';
import { operationRoutes } from '../ops/routes.ts';
import { beginMicrosoftLogin, completeMicrosoftLogin, LoginError, msEnabled, needsHandoff, safeReturn } from '../auth/microsoft.ts';
import type { AppEnv } from '../types.ts';

const bad = (code: string, message: string, status = 400) => new HttpError(status, code, message);

async function userPayload(userId: string) {
  const u = await store.get('user', userId);
  const roles = await directoryRolesOf(userId);
  const settings = await getSettings(userId);
  return {
    user: {
      id: u.id, displayName: u.displayName, userPrincipalName: u.userPrincipalName, mail: u.mail, jobTitle: u.jobTitle,
      givenName: u.givenName, surname: u.surname, preferredLanguage: u.preferredLanguage, lastPasswordChangeDateTime: u.lastPasswordChangeDateTime,
    },
    tenant: { id: tenant().id, displayName: tenant().displayName, defaultDomain: tenant().defaultDomain, domains: tenant().domains },
    directoryRoles: roles.map((r) => ({ id: r, displayName: roleTemplate(r)?.displayName ?? r })),
    isGlobalAdmin: roles.includes(GLOBAL_ADMIN),
    microsoftHome: u._msTenantId ?? null,
    signIn: u._msOid ? { provider: 'microsoft', appRoles: u._loginRoles ?? [], tenantId: u._msTenantId, at: u._lastMicrosoftSignIn } : { provider: 'local', appRoles: [] },
    settings,
  };
}

export function portalRoutes(app: Hono<AppEnv>): void {
  const secure = (c: any) => originOf(c).startsWith('https');

  app.get('/_portal/auth/microsoft', async (c) => {
    if (!msEnabled()) throw bad('microsoft_not_configured', 'Microsoft sign-in is not configured on this server.', 404);
    return c.redirect(await beginMicrosoftLogin(safeReturn(c.req.query('returnTo'))), 302);
  });

  app.get('/_portal/auth/callback', async (c) => {
    const back = (code: string, detail?: string) => c.redirect(`${config.portalUrl}/login?error=${encodeURIComponent(code)}${detail ? `&detail=${encodeURIComponent(detail.slice(0, 300))}` : ''}`, 302);
    const err = c.req.query('error');
    if (err) {
      const desc = String(c.req.query('error_description') ?? '');
      return back(/AADSTS50105/.test(desc) ? 'no_role' : err === 'access_denied' ? 'cancelled' : 'microsoft_error', desc.split('\r\n')[0].split('\n')[0]);
    }
    try {
      const r = await completeMicrosoftLogin(String(c.req.query('code') ?? ''), String(c.req.query('state') ?? ''));
      if (r.purpose === 'consent') {
        // directory collegata: si torna al portale, che completa il cambio di directory
        return c.redirect(`${config.portalUrl}${r.returnTo}`, 302);
      }
      const u = await store.get('user', r.userId);
      await recordSignIn({ user: u, appId: config.msClientId, appName: 'Azzurro Portal (Microsoft)', ip: clientIp(c), userAgent: c.req.header('user-agent'), interactive: true });
      const data = { source: 'microsoft', roles: r.roles, directory: await initialDirectory(r.userId) };
      if (needsHandoff()) {
        // il cookie va creato sull'host del portale: biglietto monouso valido 60 secondi
        const ticket = randomToken(32);
        await store.put('loginHandoff', sha256(ticket), { userId: r.userId, data, returnTo: r.returnTo, expires: new Date(Date.now() + 60_000).toISOString() });
        return c.redirect(`${config.portalUrl}/api/portal/auth/handoff?t=${ticket}`, 302);
      }
      const s = await createSession(r.userId, data);
      c.header('Set-Cookie', sessionCookie(s.id, s.maxAge, config.portalUrl.startsWith('https')));
      return c.redirect(`${config.portalUrl}${r.returnTo}`, 302);
    } catch (e) {
      if (e instanceof LoginError) return back(e.code, e.message);
      if (!config.quiet) console.warn('[microsoft] login non riuscito:', (e as Error).message);
      return back('microsoft_error', (e as Error).message);
    }
  });

  app.get('/_portal/auth/handoff', async (c) => {
    const key = sha256(String(c.req.query('t') ?? ''));
    const h = await store.get('loginHandoff', key);
    await store.remove('loginHandoff', key);
    if (!h || Date.parse(h.expires) < Date.now()) return c.redirect(`${config.portalUrl}/login?error=state_expired`, 302);
    const s = await createSession(h.userId, h.data);
    c.header('Set-Cookie', sessionCookie(s.id, s.maxAge, config.portalUrl.startsWith('https')));
    return c.redirect(`${config.portalUrl}${safeReturn(h.returnTo)}`, 302);
  });

  app.post('/_portal/login', async (c) => {
    if (!config.localLogin) throw bad('local_login_disabled', 'Sign in with your Microsoft work account.', 403);
    const body = await readJson(c);
    const ctx = { appId: AZURE_CLI_APP_ID, appName: 'Azzurro Portal', ip: clientIp(c), userAgent: c.req.header('user-agent'), interactive: true };
    let res;
    try {
      res = await authenticateUser(String(body.username ?? ''), String(body.password ?? ''), ctx);
    } catch (e) {
      if (e instanceof HttpError) {
        const disabled = e.aadsts === 50057;
        throw bad(disabled ? 'account_disabled' : 'invalid_credentials', disabled ? 'The user account is disabled.' : 'Invalid username or password.', 401);
      }
      throw e;
    }
    if (res.mustChange) {
      const ticket = randomToken(24);
      await store.put('pwTicket', sha256(ticket), { userId: res.user.id, expires: new Date(Date.now() + 10 * 60_000).toISOString() });
      return c.json({ status: 'password_change_required', ticket });
    }
    await recordSignIn({ user: res.user, ...ctx });
    const s = await createSession(res.user.id, { source: 'portal' });
    c.header('Set-Cookie', sessionCookie(s.id, s.maxAge, secure(c)));
    return c.json({ status: 'ok', ...(await userPayload(res.user.id)) });
  });

  app.post('/_portal/change-password', async (c) => {
    const body = await readJson(c);
    const ticket = body.ticket ? await store.get('pwTicket', sha256(String(body.ticket))) : null;
    if (!ticket || new Date(ticket.expires).getTime() < Date.now()) throw bad('invalid_ticket', 'The password change request has expired. Sign in again.', 401);
    if (!passwordIsComplex(String(body.newPassword ?? ''))) throw bad('weak_password', 'The password does not meet complexity requirements.');
    const user = await setPassword(ticket.userId, String(body.newPassword));
    await store.remove('pwTicket', sha256(String(body.ticket)));
    await recordSignIn({ user, appId: AZURE_CLI_APP_ID, appName: 'Azzurro Portal', ip: clientIp(c), userAgent: c.req.header('user-agent'), interactive: true });
    const s = await createSession(user.id, { source: 'portal' });
    c.header('Set-Cookie', sessionCookie(s.id, s.maxAge, secure(c)));
    return c.json({ status: 'ok', ...(await userPayload(user.id)) });
  });

  app.post('/_portal/logout', async (c) => {
    await deleteSession(parseCookies(c.req.header('cookie'))[SESSION_COOKIE]);
    c.header('Set-Cookie', sessionCookie('', 0, secure(c)));
    return c.json({ status: 'ok' });
  });

  app.get('/_portal/config', (c) => {
    const base = config.publicUrl;
    const httpsAvailable = existsSync(config.tlsCert) && existsSync(config.tlsKey);
    const httpsUrl = `https://localhost:${config.httpsPort}`;
    return c.json({
      apiUrl: base,
      httpsAvailable,
      httpsUrl,
      tenantId: tenant().id,
      tenantName: tenant().displayName,
      defaultDomain: tenant().defaultDomain,
      authMode: config.authMode,
      login: { microsoft: msEnabled(), local: config.localLogin },
      rbac: config.rbac,
      locations: LOCATIONS.map((l) => ({ name: l.name, displayName: l.displayName, geography: l.geography })),
    });
  });

  // --- tutto ciò che segue richiede sessione o token ---
  const auth = authenticate('portal');
  for (const p of ['/_portal/session', '/_portal/token', '/_portal/settings', '/_portal/push/*', '/_portal/notifications', '/_portal/notifications/*', '/_portal/overview', '/_portal/catalog', '/_portal/search', '/_portal/pricing', '/_portal/pricing/*', '/_portal/assistant', '/_portal/assistant/*', '/_portal/directories', '/_portal/directories/*', '/_portal/apiversion', '/_portal/prepare', '/_portal/admin/*', '/_portal/operations', '/_portal/operations/*']) app.use(p, auth);
  realRoutes(app);
  pricingRoutes(app);
  assistantRoutes(app);
  adminRoutes(app);
  operationRoutes(app);

  app.get('/_portal/session', async (c) => {
    const p = c.get('principal');
    if (p.kind !== 'user') throw bad('not_a_user', 'The portal requires a user account.', 403);
    return c.json(await userPayload(p.oid));
  });

  app.post('/_portal/token', async (c) => {
    const p = c.get('principal');
    if (p.kind !== 'user') throw bad('not_a_user', 'The portal requires a user account.', 403);
    const body = await readJson(c);
    const target = String(body.resource ?? 'arm');
    const scope = target === 'arm' ? 'https://management.core.windows.net//.default' : target === 'graph' ? 'https://graph.microsoft.com/.default' : `${target.replace(/\/+$/, '')}/.default`;
    const sp = await spByAppId(AZURE_CLI_APP_ID);
    const client: Client = { appId: AZURE_CLI_APP_ID, displayName: 'Microsoft Azure CLI', firstParty: true, publicClient: true, app: null, sp, authMethod: 'none' };
    const user = await store.get('user', p.oid);
    const tok = await issueTokens({ origin: config.publicUrl, client, user, scope });
    return c.json({ access_token: tok.access_token, expires_in: tok.expires_in, scope: tok.scope, token_type: 'Bearer' });
  });

  app.get('/_portal/settings', async (c) => c.json(await getSettings(c.get('principal').oid)));
  app.put('/_portal/settings', async (c) => {
    const p = c.get('principal');
    const body = await readJson(c);
    const patch: any = {};
    if (body.locale !== undefined) {
      if (!['it', 'en'].includes(body.locale)) throw bad('invalid_locale', 'Supported locales: it, en.');
      patch.locale = body.locale;
      const u = await store.get('user', p.oid);
      if (u) {
        u.preferredLanguage = body.locale === 'it' ? 'it-IT' : 'en-US';
        await store.put('user', u.id, u, tenant().id);
      }
    }
    if (body.theme !== undefined) {
      if (!['system', 'light', 'dark'].includes(body.theme)) throw bad('invalid_theme', 'Supported themes: system, light, dark.');
      patch.theme = body.theme;
    }
    if (body.notifyOwnActions !== undefined) patch.notifyOwnActions = !!body.notifyOwnActions;
    if (body.push && typeof body.push === 'object') {
      patch.push = {};
      for (const k of CATEGORIES) if (body.push[k] !== undefined) patch.push[k] = !!body.push[k];
    }
    return c.json(await saveSettings(p.oid, patch));
  });

  app.get('/_portal/push/vapid', (c) => c.json({ publicKey: vapidKeys().publicKey }));
  app.post('/_portal/push/subscribe', async (c) => {
    const p = c.get('principal');
    const body = await readJson(c);
    const sub = body.subscription ?? body;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) throw bad('invalid_subscription', 'A PushSubscription with endpoint and keys is required.');
    await q(
      `INSERT INTO push_subscriptions (endpoint, user_id, data, user_agent) VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, data = EXCLUDED.data, user_agent = EXCLUDED.user_agent`,
      [sub.endpoint, p.oid, JSON.stringify({ endpoint: sub.endpoint, keys: sub.keys }), c.req.header('user-agent') ?? null],
    );
    return c.json({ status: 'ok' }, 201);
  });
  app.post('/_portal/push/unsubscribe', async (c) => {
    const body = await readJson(c);
    await q('DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2', [String(body.endpoint ?? ''), c.get('principal').oid]);
    return c.json({ status: 'ok' });
  });
  app.get('/_portal/push/devices', async (c) => {
    const rows = await q('SELECT endpoint, user_agent, created_at FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at DESC', [c.get('principal').oid]);
    return c.json({ value: rows.map((r) => ({ endpoint: r.endpoint, service: new URL(r.endpoint).host, userAgent: r.user_agent, createdAt: r.created_at })) });
  });
  app.post('/_portal/push/test', async (c) => {
    const p = c.get('principal');
    await notify([p.oid], { category: 'system', key: 'test', url: '/notifications' });
    const devices = await q('SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id = $1', [p.oid]);
    return c.json({ status: 'ok', devices: devices[0].n });
  });

  app.get('/_portal/notifications', async (c) => {
    const p = c.get('principal');
    const unread = c.req.query('unread') === '1';
    const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 200);
    const rows = await q(`SELECT id, ts, category, title, body, url, read_at FROM notifications WHERE user_id = $1 ${unread ? 'AND read_at IS NULL' : ''} ORDER BY ts DESC LIMIT ${limit}`, [p.oid]);
    const count = await q('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [p.oid]);
    return c.json({ unread: count[0].n, value: rows.map((r) => ({ id: r.id, ts: r.ts, category: r.category, title: r.title, body: r.body, url: r.url, read: !!r.read_at })) });
  });
  app.post('/_portal/notifications/read', async (c) => {
    const body = await readJson(c);
    const p = c.get('principal');
    if (Array.isArray(body.ids) && body.ids.length) await q('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2) AND read_at IS NULL', [p.oid, body.ids.map(Number)]);
    else await q('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [p.oid]);
    return c.json({ status: 'ok' });
  });
  app.delete('/_portal/notifications', async (c) => {
    await q('DELETE FROM notifications WHERE user_id = $1', [c.get('principal').oid]);
    return c.json({ status: 'ok' });
  });

  app.get('/_portal/catalog', (c) => c.json({
    value: TYPES.filter((t) => !t.ui?.hidden).flatMap((t) => {
      const base = {
        type: t.type, label: t.label, category: t.category, apiVersion: t.apiVersions[0], apiVersions: t.apiVersions, global: !!t.global,
        icon: t.ui?.icon ?? null, fields: t.ui?.fields ?? [], nameRule: t.nameRule ? { pattern: t.nameRule.pattern.source, message: t.nameRule.message } : null,
        actions: Object.keys(t.actions ?? {}),
      };
      return [...(t.ui?.presets ?? []).map((p) => ({ ...base, preset: p.key, label: p.label, description: p.description ?? null, presetBody: p.body, fields: p.fields ?? base.fields })), base];
    }),
    all: TYPES.map((t) => ({ type: t.type, label: t.label, category: t.category, apiVersion: t.apiVersions[0], actions: Object.keys(t.actions ?? {}) })),
  }));

  app.get('/_portal/overview', async (c) => {
    const p = c.get('principal');
    const access = await loadAccess(p);
    const subs = (await store.list('subscription')).filter((s) => hasAnyAccessWithin(access, `/subscriptions/${s.subscriptionId}`));
    const rgs = (await store.list('resourceGroup')).filter((r) => can(access, 'Microsoft.Resources/subscriptions/resourceGroups/read', r.id) || hasAnyAccessWithin(access, r.id));
    const resources = (await store.list('resource', { match: { _child: false, _ext: false } })).filter((r) => can(access, `${r.type}/read`, r.id));
    const deployments = (await store.list('deployment')).filter((d) => hasAnyAccessWithin(access, d.id.split('/providers/Microsoft.Resources/deployments/')[0] || '/'));
    const recent = [...resources].sort((a, b) => String(b._changed).localeCompare(String(a._changed))).slice(0, 8).map((r) => ({ id: r.id, name: r.name, type: r.type, location: r.location, changedTime: r._changed, resourceGroup: r._rg }));
    const activity = (await queryEvents({ kind: 'activity', limit: 200 })).filter((e) => hasAnyAccessWithin(access, e.resourceId)).slice(0, 10);
    const unread = await q('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [p.oid]);
    return c.json({
      counts: {
        subscriptions: subs.length, resourceGroups: rgs.length, resources: resources.length,
        applications: await store.count('application'), servicePrincipals: await store.count('servicePrincipal'),
        users: await store.count('user'), groups: await store.count('group'),
        deploymentsRunning: deployments.filter((d) => ['Accepted', 'Running'].includes(d.properties.provisioningState)).length,
        deploymentsFailed: deployments.filter((d) => d.properties.provisioningState === 'Failed').length,
        unreadNotifications: unread[0].n,
      },
      byType: Object.entries(resources.reduce((m: Record<string, number>, r) => ((m[r.type] = (m[r.type] ?? 0) + 1), m), {})).map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
      recentResources: recent,
      recentActivity: activity,
      subscriptions: subs.map((s) => ({ subscriptionId: s.subscriptionId, displayName: s.displayName, state: s.state })),
    });
  });

  app.get('/_portal/search', async (c) => {
    const term = String(c.req.query('q') ?? '').trim().toLowerCase();
    if (term.length < 2) return c.json({ value: [] });
    const p = c.get('principal');
    const access = await loadAccess(p);
    const out: any[] = [];
    const match = (s: unknown) => typeof s === 'string' && s.toLowerCase().includes(term);
    for (const r of await store.list('resourceGroup')) if (match(r.name) && (can(access, 'Microsoft.Resources/subscriptions/resourceGroups/read', r.id) || hasAnyAccessWithin(access, r.id))) out.push({ kind: 'resourceGroup', id: r.id, name: r.name, subtitle: r.location });
    for (const r of await store.list('resource', { match: { _ext: false } })) if (match(r.name) && can(access, `${r.type}/read`, r.id)) out.push({ kind: 'resource', id: r.id, name: r.name, subtitle: r.type });
    for (const a of await store.list('application')) if (match(a.displayName) || match(a.appId)) out.push({ kind: 'application', id: a.id, name: a.displayName, subtitle: a.appId });
    for (const u of await store.list('user')) if (match(u.displayName) || match(u.userPrincipalName)) out.push({ kind: 'user', id: u.id, name: u.displayName, subtitle: u.userPrincipalName });
    for (const g of await store.list('group')) if (match(g.displayName)) out.push({ kind: 'group', id: g.id, name: g.displayName, subtitle: g.description ?? '' });
    for (const s of await store.list('subscription')) if ((match(s.displayName) || match(s.subscriptionId)) && hasAnyAccessWithin(access, s.id)) out.push({ kind: 'subscription', id: s.subscriptionId, name: s.displayName, subtitle: s.subscriptionId });
    return c.json({ value: out.slice(0, 25) });
  });
}
