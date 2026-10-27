import type { Hono, Context } from 'hono';
import { createHash } from 'node:crypto';
import { getConnInfo } from '@hono/node-server/conninfo';
import * as store from '../db/store.ts';
import { HttpError, oauthError } from '../errors.ts';
import { originOf, parseCookies, readForm, SESSION_COOKIE, sessionCookie } from '../http.ts';
import { pickLocale, t, type Locale } from '../i18n.ts';
import { resolveTenantSegment, tenant } from '../directory.ts';
import { hashPassword, nowIso, passwordIsComplex, randomToken, sha256, userCode } from '../ids.ts';
import type { AppEnv } from '../types.ts';
import { authenticateClient, authenticateUser, lookupClient, type Client } from './clients.ts';
import { issueTokens, redeemRefreshToken } from './issue.ts';
import { jwks } from './keys.ts';
import { createSession, deleteSession, getSession } from './session.ts';
import { recordSignIn } from './signins.ts';
import { changePasswordForm, deviceForm, formPost, loginForm, messagePage } from './pages.ts';
import { verifyJwt, v2Issuer } from './tokens.ts';

function ensureTenant(seg: string): string {
  const id = resolveTenantSegment(seg);
  if (!id) throw oauthError(400, 'invalid_tenant', 90002, `Tenant '${seg}' not found. Check to make sure you have the correct tenant ID and are signing into the correct cloud.`);
  return id;
}

export function clientIp(c: Context): string {
  const xff = c.req.header('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  try {
    return getConnInfo(c).remote.address?.replace(/^::ffff:/, '') ?? '127.0.0.1';
  } catch {
    return '127.0.0.1';
  }
}

function localeOf(c: Context, params?: Record<string, string | undefined>): Locale {
  const cookies = parseCookies(c.req.header('cookie'));
  return pickLocale(params?.ui_locales, params?.mkt, cookies.azzurro_locale, c.req.header('accept-language'));
}

function langHref(c: Context, locale: Locale): string {
  const u = new URL(c.req.url);
  u.searchParams.set('ui_locales', locale === 'it' ? 'en' : 'it');
  return u.pathname + u.search;
}

function oidcConfig(origin: string, tid: string, v2: boolean) {
  const base = `${origin}/${tid}`;
  const host = new URL(origin).host;
  return {
    token_endpoint: v2 ? `${base}/oauth2/v2.0/token` : `${base}/oauth2/token`,
    token_endpoint_auth_methods_supported: ['client_secret_post', 'private_key_jwt', 'client_secret_basic'],
    jwks_uri: v2 ? `${base}/discovery/v2.0/keys` : `${base}/discovery/keys`,
    response_modes_supported: ['query', 'fragment', 'form_post'],
    subject_types_supported: ['pairwise'],
    id_token_signing_alg_values_supported: ['RS256'],
    response_types_supported: ['code', 'id_token', 'code id_token', 'id_token token'],
    scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
    issuer: v2 ? v2Issuer(origin, tid) : `${origin}/${tid}/`,
    request_uri_parameter_supported: false,
    userinfo_endpoint: `${origin}/oidc/userinfo`,
    authorization_endpoint: v2 ? `${base}/oauth2/v2.0/authorize` : `${base}/oauth2/authorize`,
    device_authorization_endpoint: v2 ? `${base}/oauth2/v2.0/devicecode` : `${base}/oauth2/devicecode`,
    http_logout_supported: true,
    frontchannel_logout_supported: true,
    end_session_endpoint: v2 ? `${base}/oauth2/v2.0/logout` : `${base}/oauth2/logout`,
    claims_supported: ['sub', 'iss', 'cloud_instance_name', 'cloud_instance_host_name', 'cloud_graph_host_name', 'msgraph_host', 'aud', 'exp', 'iat', 'auth_time', 'acr', 'nonce', 'preferred_username', 'name', 'tid', 'ver', 'at_hash', 'c_hash', 'email'],
    kerberos_endpoint: `${base}/kerberos`,
    tenant_region_scope: 'EU',
    cloud_instance_name: host,
    cloud_graph_host_name: host,
    msgraph_host: host,
    rbac_url: origin,
  };
}

/** Confronta redirect URI: per localhost la porta viene ignorata, come in Entra ID. */
function sameRedirect(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  try {
    const a = new URL(registered);
    const b = new URL(requested);
    const local = (u: URL) => ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (local(a) && local(b)) return a.protocol === b.protocol && a.hostname === b.hostname && a.pathname.replace(/\/+$/, '') === b.pathname.replace(/\/+$/, '');
    return a.protocol === b.protocol && a.host.toLowerCase() === b.host.toLowerCase() && a.pathname === b.pathname && a.search === b.search;
  } catch {
    return registered.toLowerCase() === requested.toLowerCase();
  }
}

type RedirectKind = 'web' | 'spa' | 'public';

function matchRedirect(client: Client, uri: string | undefined): RedirectKind {
  if (client.firstParty) return 'public';
  const app = client.app;
  const lists: [RedirectKind, string[]][] = [
    ['web', app?.web?.redirectUris ?? []],
    ['spa', app?.spa?.redirectUris ?? []],
    ['public', app?.publicClient?.redirectUris ?? []],
  ];
  const all = lists.flatMap(([, l]) => l);
  if (!all.length) throw oauthError(400, 'invalid_request', 500113, 'No reply address is registered for the application.');
  if (!uri) {
    if (all.length === 1) return lists.find(([, l]) => l.length)![0];
    throw oauthError(400, 'invalid_request', 900144, "The request body must contain the following parameter: 'redirect_uri'.");
  }
  for (const [kind, l] of lists) if (l.some((r) => sameRedirect(r, uri))) return kind;
  throw oauthError(400, 'invalid_request', 50011, `The redirect URI '${uri}' specified in the request does not match the redirect URIs configured for the application '${client.appId}'. Make sure the redirect URI sent in the request matches one added to your application in the Azure portal.`);
}

function basicAuth(c: Context, form: Record<string, string>): void {
  const auth = c.req.header('authorization');
  if (auth?.startsWith('Basic ')) {
    const [id, secret] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
    form.client_id ??= decodeURIComponent(id);
    form.client_secret ??= decodeURIComponent(secret ?? '');
  }
}

async function sessionUser(c: Context): Promise<any | null> {
  const s = await getSession(parseCookies(c.req.header('cookie'))[SESSION_COOKIE]);
  if (!s) return null;
  const u = await store.get('user', s.userId);
  return u && u.accountEnabled !== false ? u : null;
}

function setSessionCookie(c: Context, id: string, maxAge: number) {
  c.header('Set-Cookie', sessionCookie(id, maxAge, originOf(c).startsWith('https')), { append: true });
}

async function tokenEndpoint(c: Context<AppEnv>, v1: boolean) {
  const origin = originOf(c);
  ensureTenant(c.req.param('tenant')!);
  const form = await readForm(c);
  basicAuth(c, form);
  const ip = clientIp(c);
  const ua = c.req.header('user-agent');
  const clientInfo = form.client_info === '1';
  const scope = v1 && form.resource ? undefined : form.scope;
  const resource = v1 ? form.resource : undefined;
  let res;
  switch (form.grant_type) {
    case 'client_credentials': {
      const client = await authenticateClient(form, origin, { requireConfidential: true });
      res = await issueTokens({ origin, client, scope, resource, v1Endpoint: v1, ip, userAgent: ua });
      break;
    }
    case 'password': {
      const client = await authenticateClient(form, origin, { allowPublic: true });
      const { user, mustChange } = await authenticateUser(form.username, form.password, { appId: client.appId, appName: client.displayName, ip, userAgent: ua, interactive: true });
      if (mustChange) throw oauthError(400, 'invalid_grant', 50055, 'The password is expired. The user must change the password at the next interactive sign-in.');
      await recordSignIn({ user, appId: client.appId, appName: client.displayName, ip, userAgent: ua, interactive: true });
      res = await issueTokens({ origin, client, user, scope: v1 && resource ? `${resource}/.default openid offline_access` : scope, v1Endpoint: v1, clientInfo, ip, userAgent: ua });
      break;
    }
    case 'authorization_code': {
      const rec = form.code ? await store.get('authCode', sha256(form.code)) : null;
      if (!rec || rec.used || new Date(rec.expires).getTime() < Date.now()) {
        throw oauthError(400, 'invalid_grant', 70008, 'The provided authorization code or refresh token has expired due to inactivity. Send a new interactive authorization request for this user and resource.');
      }
      if (rec.clientId !== form.client_id) throw oauthError(400, 'invalid_grant', 70002, 'The authorization code was issued to a different client.');
      if (form.redirect_uri && !sameRedirect(rec.redirectUri, form.redirect_uri)) throw oauthError(400, 'invalid_grant', 50148, 'The redirect_uri does not match the one used in the authorization request.');
      if (rec.codeChallenge) {
        const verifier = form.code_verifier ?? '';
        const ok = rec.method === 'plain' ? verifier === rec.codeChallenge : createHash('sha256').update(verifier).digest('base64url') === rec.codeChallenge;
        if (!ok) throw oauthError(400, 'invalid_grant', 501481, 'The Code_Verifier does not match the code_challenge supplied in the authorization request.');
      }
      const client = await authenticateClient(form, origin, { allowPublic: rec.kind !== 'web' });
      await store.remove('authCode', sha256(form.code));
      const user = await store.get('user', rec.userId);
      if (!user || user.accountEnabled === false) throw oauthError(400, 'invalid_grant', 50057, 'The user account is disabled.');
      res = await issueTokens({ origin, client, user, scope: form.scope ?? rec.scope, resource, nonce: rec.nonce, v1Endpoint: v1, clientInfo: clientInfo || rec.clientInfo, ip, userAgent: ua });
      break;
    }
    case 'refresh_token': {
      const client = await authenticateClient(form, origin, { allowPublic: true });
      const { user, family } = await redeemRefreshToken(form.refresh_token ?? '', client.appId);
      res = await issueTokens({ origin, client, user, scope: v1 && resource ? `${resource}/.default offline_access` : scope, v1Endpoint: v1, clientInfo, refreshFamily: family, ip, userAgent: ua });
      await recordSignIn({ user, appId: client.appId, appName: client.displayName, ip, userAgent: ua, interactive: false });
      break;
    }
    case 'urn:ietf:params:oauth:grant-type:device_code':
    case 'device_code': {
      const code = form.device_code ?? form.code;
      const rec = code ? await store.get('deviceCode', sha256(code)) : null;
      if (!rec || new Date(rec.expires).getTime() < Date.now()) throw oauthError(400, 'expired_token', 70020, 'The provided value for the input parameter \'device_code\' is not valid. This device code has expired.');
      if (rec.status === 'pending') throw oauthError(400, 'authorization_pending', 70016, 'OAuth 2.0 device flow error. Authorization is pending. Continue polling.');
      if (rec.status === 'denied') throw oauthError(400, 'authorization_declined', 70019, 'The end user denied the authorization request.');
      const client = await authenticateClient({ ...form, client_id: rec.clientId }, origin, { allowPublic: true });
      await store.remove('deviceCode', sha256(code));
      const user = await store.get('user', rec.userId);
      res = await issueTokens({ origin, client, user, scope: rec.scope, resource: rec.resource, v1Endpoint: v1, clientInfo: clientInfo || true, ip, userAgent: ua });
      break;
    }
    case 'urn:ietf:params:oauth:grant-type:jwt-bearer': {
      // On-Behalf-Of
      const client = await authenticateClient(form, origin, { requireConfidential: true });
      let claims;
      try {
        claims = await verifyJwt(form.assertion ?? '');
      } catch {
        throw oauthError(400, 'invalid_grant', 50013, 'Assertion failed signature validation.');
      }
      if (claims.idtyp !== 'user') throw oauthError(400, 'invalid_grant', 50013, 'The assertion must be a user token.');
      const user = await store.get('user', claims.oid);
      if (!user) throw oauthError(400, 'invalid_grant', 50034, 'The user account does not exist.');
      res = await issueTokens({ origin, client, user, scope, resource, v1Endpoint: v1, ip, userAgent: ua });
      break;
    }
    default:
      throw oauthError(400, 'unsupported_grant_type', 70003, `The app requested an unsupported grant type '${form.grant_type ?? ''}'.`);
  }
  c.header('Cache-Control', 'no-store, no-cache');
  c.header('Pragma', 'no-cache');
  return c.json(res);
}

const AUTH_PARAMS = ['client_id', 'response_type', 'redirect_uri', 'scope', 'state', 'nonce', 'code_challenge', 'code_challenge_method', 'prompt', 'login_hint', 'response_mode', 'resource', 'client_info', 'ui_locales', 'domain_hint'] as const;

async function completeAuthorize(c: Context, client: Client, p: Record<string, string | undefined>, kind: RedirectKind, user: any, v1: boolean) {
  const origin = originOf(c);
  const responseType = (p.response_type ?? 'code').split(/\s+/);
  const out: Record<string, string> = {};
  if (responseType.includes('code')) {
    const code = randomToken(48);
    await store.put('authCode', sha256(code), {
      clientId: client.appId,
      redirectUri: p.redirect_uri ?? '',
      scope: v1 && p.resource ? `${p.resource}/.default openid offline_access` : p.scope,
      userId: user.id,
      nonce: p.nonce,
      codeChallenge: p.code_challenge,
      method: p.code_challenge_method ?? (p.code_challenge ? 'plain' : undefined),
      kind,
      clientInfo: p.client_info === '1',
      expires: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    out.code = code;
    if (p.client_info === '1') out.client_info = Buffer.from(JSON.stringify({ uid: user.id, utid: tenant().id })).toString('base64url');
  }
  if (responseType.includes('id_token') || responseType.includes('token')) {
    const tok = await issueTokens({ origin, client, user, scope: `openid profile ${p.scope ?? ''}`, nonce: p.nonce, interactive: true });
    if (responseType.includes('id_token') && tok.id_token) out.id_token = tok.id_token;
    if (responseType.includes('token')) {
      out.access_token = tok.access_token;
      out.token_type = 'Bearer';
      out.expires_in = String(tok.expires_in);
      out.scope = tok.scope;
    }
  }
  if (p.state !== undefined) out.state = p.state;
  out.session_state = sha256(user.id).slice(0, 36);
  await recordSignIn({ user, appId: client.appId, appName: client.displayName, ip: clientIp(c), userAgent: c.req.header('user-agent'), interactive: true });
  return respond(c, p, out, responseType);
}

function respond(c: Context, p: Record<string, string | undefined>, out: Record<string, string>, responseType: string[]) {
  const mode = p.response_mode ?? (responseType.includes('token') || responseType.includes('id_token') ? 'fragment' : 'query');
  const redirect = p.redirect_uri ?? '';
  if (mode === 'form_post') return c.html(formPost(redirect, out));
  const qs = new URLSearchParams(out).toString();
  if (mode === 'fragment') return c.redirect(`${redirect}#${qs}`, 302);
  return c.redirect(`${redirect}${redirect.includes('?') ? '&' : '?'}${qs}`, 302);
}

async function authorize(c: Context<AppEnv>, v1: boolean) {
  const isPost = c.req.method === 'POST';
  const form = isPost ? await readForm(c) : {};
  const query = isPost ? Object.fromEntries(new URLSearchParams(form.q ?? '')) : c.req.query();
  const p: Record<string, string | undefined> = {};
  for (const k of AUTH_PARAMS) if (query[k] !== undefined) p[k] = query[k];
  const locale = localeOf(c, p);
  const lang = langHref(c, locale);
  let client: Client;
  let kind: RedirectKind;
  try {
    ensureTenant(c.req.param('tenant')!);
    client = await lookupClient(p.client_id);
    kind = matchRedirect(client, p.redirect_uri);
    if (!p.redirect_uri) {
      const app = client.app;
      p.redirect_uri = [...(app?.web?.redirectUris ?? []), ...(app?.spa?.redirectUris ?? []), ...(app?.publicClient?.redirectUris ?? [])][0];
    }
  } catch (e) {
    const msg = e instanceof HttpError ? e.message : String(e);
    return c.html(messagePage(locale, t(locale, 'l.error'), msg, lang), 400);
  }
  const responseType = (p.response_type ?? '').split(/\s+/).filter(Boolean);
  if (!responseType.length || responseType.some((r) => !['code', 'id_token', 'token'].includes(r))) {
    return respond(c, p, { error: 'unsupported_response_type', error_description: `AADSTS700054: response_type '${p.response_type ?? ''}' is not supported.`, ...(p.state ? { state: p.state } : {}) }, responseType);
  }
  const action = c.req.path;
  const fields = { q: new URLSearchParams(p as Record<string, string>).toString() };

  if (!isPost) {
    const su = await sessionUser(c);
    if (su && p.prompt !== 'login' && p.prompt !== 'select_account') return completeAuthorize(c, client, p, kind, su, v1);
    if (p.prompt === 'none') {
      return respond(c, p, { error: 'login_required', error_description: 'AADSTS50058: A silent sign-in request was sent but no user is signed in.', ...(p.state ? { state: p.state } : {}) }, responseType);
    }
    return c.html(loginForm({ locale, action, fields, appName: client.displayName, loginHint: p.login_hint, langHref: lang }));
  }

  if (form.action === 'changepw') {
    const ticket = form.ticket ? await store.get('pwTicket', sha256(form.ticket)) : null;
    if (!ticket || new Date(ticket.expires).getTime() < Date.now()) return c.html(loginForm({ locale, action, fields, appName: client.displayName, error: t(locale, 'l.invalid'), langHref: lang }), 400);
    const err = form.newpw !== form.newpw2 ? t(locale, 'l.mismatch') : !passwordIsComplex(form.newpw) ? t(locale, 'l.weak') : null;
    if (err) return c.html(changePasswordForm({ locale, action, fields: { ...fields, ticket: form.ticket }, error: err, langHref: lang }), 400);
    const user = await setPassword(ticket.userId, form.newpw);
    await store.remove('pwTicket', sha256(form.ticket));
    const s = await createSession(user.id, { source: 'authorize' });
    setSessionCookie(c, s.id, s.maxAge);
    return completeAuthorize(c, client, p, kind, user, v1);
  }

  try {
    const { user, mustChange } = await authenticateUser(form.login, form.passwd, { appId: client.appId, appName: client.displayName, ip: clientIp(c), userAgent: c.req.header('user-agent') });
    if (mustChange) {
      const ticket = randomToken(24);
      await store.put('pwTicket', sha256(ticket), { userId: user.id, expires: new Date(Date.now() + 10 * 60_000).toISOString() });
      return c.html(changePasswordForm({ locale, action, fields: { ...fields, ticket }, langHref: lang }));
    }
    const s = await createSession(user.id, { source: 'authorize' });
    setSessionCookie(c, s.id, s.maxAge);
    return completeAuthorize(c, client, p, kind, user, v1);
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    const msg = e.aadsts === 50057 ? t(locale, 'l.disabled') : t(locale, 'l.invalid');
    return c.html(loginForm({ locale, action, fields, appName: client.displayName, error: msg, loginHint: form.login, langHref: lang }), 400);
  }
}

export async function setPassword(userId: string, password: string): Promise<any> {
  const user = await store.get('user', userId);
  user._passwordHash = hashPassword(password);
  user._forceChange = false;
  user.lastPasswordChangeDateTime = nowIso();
  await store.put('user', user.id, user, tenant().id);
  return user;
}

async function deviceCode(c: Context<AppEnv>, v1: boolean) {
  ensureTenant(c.req.param('tenant')!);
  const origin = originOf(c);
  const form = await readForm(c);
  const client = await lookupClient(form.client_id);
  if (!client.publicClient && !client.firstParty) {
    throw oauthError(400, 'invalid_client', 7000218, "The request body must contain the following parameter: 'client_assertion' or 'client_secret'. Enable 'Allow public client flows' to use the device code flow.");
  }
  const device = randomToken(48);
  const user = userCode();
  const locale = localeOf(c, form);
  await store.put('deviceCode', sha256(device), {
    key: sha256(device),
    userCode: user,
    clientId: client.appId,
    appName: client.displayName,
    scope: v1 ? undefined : form.scope,
    resource: v1 ? form.resource : undefined,
    status: 'pending',
    expires: new Date(Date.now() + 15 * 60_000).toISOString(),
  });
  const uri = `${origin}/devicelogin`;
  const message = locale === 'it'
    ? `Per accedere, usa un browser web per aprire la pagina ${uri} e immetti il codice ${user} per l'autenticazione.`
    : `To sign in, use a web browser to open the page ${uri} and enter the code ${user} to authenticate.`;
  return c.json({ user_code: user, device_code: device, verification_uri: uri, ...(v1 ? { verification_url: uri } : {}), expires_in: 900, interval: 5, message });
}

async function deviceLogin(c: Context<AppEnv>) {
  const isPost = c.req.method === 'POST';
  const form = isPost ? await readForm(c) : c.req.query();
  const locale = localeOf(c, form);
  const lang = langHref(c, locale);
  const su = await sessionUser(c);
  if (!isPost) return c.html(deviceForm({ locale, code: form.otc, sessionUser: su ?? undefined, langHref: lang }));
  const code = String(form.otc ?? '').replace(/[\s-]/g, '').toUpperCase();
  const rec = code ? (await store.list('deviceCode', { match: { userCode: code, status: 'pending' }, limit: 1 }))[0] : null;
  if (!rec || new Date(rec.expires).getTime() < Date.now()) return c.html(deviceForm({ locale, code: form.otc, error: t(locale, 'l.badCode'), sessionUser: su ?? undefined, langHref: lang }), 400);
  let user = su;
  if (form.action === 'changepw') {
    const ticket = form.ticket ? await store.get('pwTicket', sha256(form.ticket)) : null;
    if (!ticket) return c.html(deviceForm({ locale, code: form.otc, error: t(locale, 'l.invalid'), langHref: lang }), 400);
    const err = form.newpw !== form.newpw2 ? t(locale, 'l.mismatch') : !passwordIsComplex(form.newpw) ? t(locale, 'l.weak') : null;
    if (err) return c.html(changePasswordForm({ locale, action: '/devicelogin', fields: { otc: form.otc, ticket: form.ticket }, error: err, langHref: lang }), 400);
    user = await setPassword(ticket.userId, form.newpw);
    await store.remove('pwTicket', sha256(form.ticket));
  } else if (!user || form.login) {
    try {
      const r = await authenticateUser(form.login, form.passwd, { appId: rec.clientId, appName: rec.appName, ip: clientIp(c), userAgent: c.req.header('user-agent') });
      if (r.mustChange) {
        const ticket = randomToken(24);
        await store.put('pwTicket', sha256(ticket), { userId: r.user.id, expires: new Date(Date.now() + 10 * 60_000).toISOString() });
        return c.html(changePasswordForm({ locale, action: '/devicelogin', fields: { otc: form.otc, ticket }, langHref: lang }));
      }
      user = r.user;
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      return c.html(deviceForm({ locale, code: form.otc, error: e.aadsts === 50057 ? t(locale, 'l.disabled') : t(locale, 'l.invalid'), langHref: lang }), 400);
    }
  }
  rec.status = 'approved';
  rec.userId = user.id;
  await store.put('deviceCode', rec.key, rec);
  await recordSignIn({ user, appId: rec.clientId, appName: rec.appName, ip: clientIp(c), userAgent: c.req.header('user-agent'), interactive: true });
  return c.html(messagePage(locale, t(locale, 'l.deviceDone'), t(locale, 'l.deviceDoneText', { app: rec.appName }), lang));
}

async function logout(c: Context<AppEnv>) {
  const sid = parseCookies(c.req.header('cookie'))[SESSION_COOKIE];
  await deleteSession(sid);
  c.header('Set-Cookie', sessionCookie('', 0, originOf(c).startsWith('https')));
  const target = c.req.query('post_logout_redirect_uri');
  if (target) return c.redirect(target, 302);
  const locale = localeOf(c, c.req.query());
  return c.html(messagePage(locale, t(locale, 'l.signedOut'), t(locale, 'l.signedOutText')));
}

/** Endpoint di Managed Identity (IMDS e App Service). */
async function managedIdentityToken(c: Context<AppEnv>, kind: 'imds' | 'appservice') {
  if (kind === 'imds' && c.req.header('metadata')?.toLowerCase() !== 'true') {
    return c.json({ error: 'invalid_request', error_description: 'Required metadata header not specified' }, 400);
  }
  if (kind === 'appservice' && c.req.header('x-identity-header') !== (process.env.AZZURRO_IDENTITY_HEADER ?? 'azzurro')) {
    return c.json({ statusCode: 401, message: 'Unauthorized: X-IDENTITY-HEADER is missing or invalid' }, 401);
  }
  const qy = c.req.query();
  const resource = qy.resource;
  if (!resource) return c.json({ error: 'invalid_request', error_description: 'Required query variable \'resource\' is missing' }, 400);
  const mis = await store.list('servicePrincipal', { match: { servicePrincipalType: 'ManagedIdentity' } });
  const clientId = qy.client_id;
  const objectId = qy.object_id ?? qy.principal_id;
  const resId = (qy.msi_res_id ?? qy.mi_res_id)?.toLowerCase();
  let sp = clientId ? mis.find((s) => s.appId === clientId)
    : objectId ? mis.find((s) => s.id === objectId)
    : resId ? mis.find((s) => s._miResourceId === resId)
    : process.env.AZZURRO_DEFAULT_MI_CLIENT_ID ? mis.find((s) => s.appId === process.env.AZZURRO_DEFAULT_MI_CLIENT_ID)
    : mis.length === 1 ? mis[0] : undefined;
  if (!sp) return c.json({ error: 'invalid_request', error_description: 'Identity not found' }, 400);
  const client: Client = { appId: sp.appId, displayName: sp.displayName, firstParty: false, publicClient: false, app: null, sp, authMethod: 'certificate' };
  const tok = await issueTokens({ origin: originOf(c), client, appSp: sp, resource, v1Endpoint: true, managedIdentityResourceId: sp._miResourceIdOriginal, ip: clientIp(c) });
  return c.json({
    access_token: tok.access_token,
    client_id: sp.appId,
    expires_in: String(tok.expires_in),
    expires_on: tok.expires_on,
    ext_expires_in: String(tok.ext_expires_in),
    not_before: tok.not_before,
    resource,
    token_type: 'Bearer',
  });
}

export function identityRoutes(app: Hono<AppEnv>): void {
  const cors = async (c: Context, next: () => Promise<void>) => {
    if (c.req.method === 'OPTIONS') {
      return c.body(null, 204, {
        'Access-Control-Allow-Origin': c.req.header('origin') ?? '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': c.req.header('access-control-request-headers') ?? '*',
        'Access-Control-Max-Age': '86400',
      });
    }
    await next();
    c.header('Access-Control-Allow-Origin', c.req.header('origin') ?? '*');
  };

  app.get('/common/discovery/instance', (c) => instanceDiscovery(c));
  app.get('/:tenant/discovery/instance', (c) => instanceDiscovery(c));
  app.use('/:tenant/v2.0/.well-known/openid-configuration', cors);
  app.use('/:tenant/.well-known/openid-configuration', cors);
  app.use('/:tenant/discovery/*', cors);
  app.use('/:tenant/oauth2/v2.0/token', cors);
  app.use('/:tenant/oauth2/token', cors);
  app.use('/:tenant/oauth2/v2.0/devicecode', cors);
  app.get('/:tenant/v2.0/.well-known/openid-configuration', (c) => c.json(oidcConfig(originOf(c), ensureTenant(c.req.param('tenant')), true)));
  app.get('/:tenant/.well-known/openid-configuration', (c) => c.json(oidcConfig(originOf(c), ensureTenant(c.req.param('tenant')), false)));
  app.get('/:tenant/discovery/v2.0/keys', (c) => c.json(jwks()));
  app.get('/:tenant/discovery/keys', (c) => c.json(jwks()));
  app.get('/:tenant/userrealm/:user', (c) => {
    const user = c.req.param('user');
    const domain = user.includes('@') ? user.split('@')[1] : tenant().defaultDomain;
    return c.json({ ver: '1.0', account_type: 'Managed', domain_name: domain, cloud_instance_name: new URL(originOf(c)).host, cloud_audience_urn: 'urn:federation:MicrosoftOnline' });
  });
  app.post('/:tenant/oauth2/v2.0/token', (c) => tokenEndpoint(c, false));
  app.post('/:tenant/oauth2/token', (c) => tokenEndpoint(c, true));
  app.on(['GET', 'POST'], '/:tenant/oauth2/v2.0/authorize', (c) => authorize(c, false));
  app.on(['GET', 'POST'], '/:tenant/oauth2/authorize', (c) => authorize(c, true));
  app.post('/:tenant/oauth2/v2.0/devicecode', (c) => deviceCode(c, false));
  app.post('/:tenant/oauth2/devicecode', (c) => deviceCode(c, true));
  app.on(['GET', 'POST'], '/devicelogin', (c) => deviceLogin(c));
  app.get('/:tenant/oauth2/v2.0/logout', (c) => logout(c));
  app.get('/:tenant/oauth2/logout', (c) => logout(c));
  app.get('/oidc/userinfo', async (c) => {
    const auth = c.req.header('authorization');
    const claims = auth?.startsWith('Bearer ') ? await verifyJwt(auth.slice(7)).catch(() => null) : null;
    const user = claims?.oid ? await store.get('user', claims.oid) : null;
    if (!user) return c.json({ error: { code: 'InvalidAuthenticationToken', message: 'Access token validation failure.' } }, 401);
    return c.json({ sub: claims!.sub, name: user.displayName, family_name: user.surname, given_name: user.givenName, email: user.mail ?? user.userPrincipalName });
  });
  app.get('/metadata/identity/oauth2/token', (c) => managedIdentityToken(c, 'imds'));
  app.get('/msi/token', (c) => managedIdentityToken(c, 'appservice'));
}

function instanceDiscovery(c: Context) {
  const origin = originOf(c);
  const host = new URL(origin).host;
  return c.json({
    tenant_discovery_endpoint: `${origin}/${tenant().id}/v2.0/.well-known/openid-configuration`,
    'api-version': '1.1',
    metadata: [{ preferred_network: host, preferred_cache: host, aliases: [host] }],
  });
}

