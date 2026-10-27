/**
 * Accesso al portale con Microsoft Entra ID (tenant aziendale reale).
 * Flusso authorization code + PKCE come client confidenziale. Dal token ID arrivano
 * identità e ruoli dell'app (Azzurro.Owner / Contributor / Reader): l'utente viene
 * replicato nella directory emulata e i suoi permessi (RBAC e ruoli di directory)
 * vengono riallineati a ogni accesso.
 */
import { createHash } from 'node:crypto';
import * as jose from 'jose';
import { config } from '../config.ts';
import * as store from '../db/store.ts';
import { setTenant, tenant } from '../directory.ts';
import { APP_DEVELOPER, GLOBAL_ADMIN, GLOBAL_READER } from '../firstParty.ts';
import { createUser } from '../graph/objects.ts';
import { generatePassword, nowIso, randomToken, sha256, uuidV5 } from '../ids.ts';
import { roleAssignmentRecord } from '../arm/handlers.ts';
import { forgetTokens, saveRefreshToken } from '../real/tokens.ts';

export const msEnabled = (): boolean => !!(config.msTenantId && config.msClientId && config.msClientSecret);
const authority = (tenant = config.msTenantId) => `https://login.microsoftonline.com/${tenant}`;
const LOGIN_SCOPE = 'openid profile email offline_access User.Read';
export const msRedirectUri = (): string => `${config.msRedirectBase || config.portalUrl}/api/portal/auth/callback`;
/** il ritorno da Microsoft arriva su un host diverso dal portale: la sessione va passata con un ticket */
export const needsHandoff = (): boolean => !!config.msRedirectBase && new URL(config.msRedirectBase).host !== new URL(config.portalUrl).host;

/** Ruoli dell'app Entra → ruolo Azure RBAC (scope radice) e ruolo di directory emulato */
export const LOGIN_ROLES: Record<string, { arm: string; armName: string; dir: string }> = {
  'Azzurro.Owner': { arm: '8e3af657-a8ff-443c-a75c-2fe8c4bcb635', armName: 'Owner', dir: GLOBAL_ADMIN },
  'Azzurro.Contributor': { arm: 'b24988ac-6180-42a0-ab88-20f7382dd24c', armName: 'Contributor', dir: APP_DEVELOPER },
  'Azzurro.Reader': { arm: 'acdd72a7-3385-48ef-bd42-f606fba81ae7', armName: 'Reader', dir: GLOBAL_READER },
};
const NS = '6f1c2a4e-7b1d-4c55-9e0a-3d2f9b8a1c00';

const b64url = (b: Buffer) => b.toString('base64url');

export interface BeginOptions {
  /** 'login' = accesso aziendale; 'consent' = collegare una directory/risorsa per la modalità Azure reale */
  purpose?: 'login' | 'consent';
  tenant?: string;
  scopes?: string;
  userId?: string;
  loginHint?: string;
}

export async function beginMicrosoftLogin(returnTo: string, opts: BeginOptions = {}): Promise<string> {
  const purpose = opts.purpose ?? 'login';
  const tenant = opts.tenant ?? config.msTenantId;
  const scope = purpose === 'login' ? LOGIN_SCOPE : `openid profile offline_access ${opts.scopes ?? ''}`.trim();
  const state = randomToken(24);
  const nonce = randomToken(24);
  const verifier = randomToken(48);
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  await store.put('msAuthState', sha256(state), { verifier, nonce, returnTo: safeReturn(returnTo), purpose, tenant, scope, userId: opts.userId ?? null, expires: new Date(Date.now() + 10 * 60_000).toISOString() });
  const u = new URL(`${authority(tenant)}/oauth2/v2.0/authorize`);
  u.search = new URLSearchParams({
    client_id: config.msClientId, response_type: 'code', redirect_uri: msRedirectUri(), response_mode: 'query',
    scope, state, nonce, code_challenge: challenge, code_challenge_method: 'S256',
    ...(purpose === 'login' ? { prompt: 'select_account' } : opts.loginHint ? { login_hint: opts.loginHint } : {}),
  }).toString();
  return u.toString();
}

export function safeReturn(v: unknown): string {
  const s = String(v ?? '/');
  return s.startsWith('/') && !s.startsWith('//') && !s.startsWith('/\\') ? s : '/';
}

let jwks: ReturnType<typeof jose.createRemoteJWKSet> | undefined;

export class LoginError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface MsLogin {
  purpose: 'login' | 'consent';
  tenant: string;
  userId: string;
  returnTo: string;
  roles: string[];
  claims: jose.JWTPayload & Record<string, any>;
}

export async function completeMicrosoftLogin(code: string, state: string): Promise<MsLogin> {
  const key = sha256(state);
  const st = await store.get('msAuthState', key);
  await store.remove('msAuthState', key);
  if (!st || Date.parse(st.expires) < Date.now()) throw new LoginError('state_expired', 'The sign-in request expired. Try again.');

  const purpose: 'login' | 'consent' = st.purpose ?? 'login';
  const tenant: string = st.tenant ?? config.msTenantId;
  const res = await fetch(`${authority(tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.msClientId, client_secret: config.msClientSecret, grant_type: 'authorization_code',
      code, redirect_uri: msRedirectUri(), code_verifier: st.verifier, scope: st.scope ?? LOGIN_SCOPE,
    }),
  });
  const tok = (await res.json()) as any;
  if (!res.ok || !tok.id_token) throw new LoginError('token_failed', String(tok.error_description ?? tok.error ?? `HTTP ${res.status}`).split('\r\n')[0]);

  jwks ??= jose.createRemoteJWKSet(new URL('https://login.microsoftonline.com/common/discovery/v2.0/keys'));
  const { payload } = await jose.jwtVerify(tok.id_token, jwks, { audience: config.msClientId });
  const claims = payload as MsLogin['claims'];
  if (claims.iss !== `https://login.microsoftonline.com/${claims.tid}/v2.0`) throw new LoginError('bad_issuer', 'Invalid token issuer.');
  if (claims.nonce !== st.nonce) throw new LoginError('bad_nonce', 'Invalid sign-in response.');

  if (purpose === 'consent') {
    // collegamento di una directory: stesso account dell'utente già connesso
    const user = st.userId ? await store.get('user', st.userId) : null;
    const who = String(claims.preferred_username ?? claims.email ?? '').toLowerCase();
    if (!user || (who && who !== String(user.userPrincipalName).toLowerCase() && who !== String(user.mail ?? '').toLowerCase())) {
      throw new LoginError('wrong_account', `Signed in as ${who}; use the same account you used for Azzurro.`);
    }
    if (tok.refresh_token) await saveRefreshToken(user.id, tok.refresh_token, String(user._msTenantId ?? config.msTenantId));
    forgetTokens(user.id); // i nuovi permessi valgono subito
    return { purpose, tenant: String(claims.tid), userId: user.id, returnTo: st.returnTo, roles: user._loginRoles ?? [], claims };
  }

  // accesso aziendale: solo account del tenant dell'azienda, anche se l'app è multi-tenant
  if (String(claims.tid) !== config.msTenantId) throw new LoginError('wrong_tenant', 'Use your company work account.');
  const roles = (Array.isArray(claims.roles) ? claims.roles : []).filter((r: string) => r in LOGIN_ROLES);
  if (!roles.length) throw new LoginError('no_role', 'Your account has no Azzurro role. Ask an administrator to assign one in Microsoft Entra ID.');

  let profile: any = {};
  if (tok.access_token) {
    try {
      const r = await fetch('https://graph.microsoft.com/v1.0/me?$select=jobTitle,department,officeLocation,mobilePhone,givenName,surname,preferredLanguage,mail', { headers: { Authorization: `Bearer ${tok.access_token}` } });
      if (r.ok) profile = await r.json();
    } catch { /* profilo facoltativo */ }
  }
  const user = await mirrorUser(claims, profile, roles);
  await syncRoles(user, roles);
  if (tok.refresh_token) await saveRefreshToken(user.id, tok.refresh_token, String(claims.tid));
  return { purpose, tenant: String(claims.tid), userId: user.id, returnTo: st.returnTo, roles, claims };
}

async function ensureDomain(domain: string) {
  const t = tenant();
  if (t.domains.includes(domain)) return;
  const rec = await store.get('tenant', t.id);
  const domains = [...t.domains, domain];
  await store.put('tenant', t.id, { ...rec, domains });
  setTenant({ ...t, domains });
}

async function mirrorUser(claims: MsLogin['claims'], profile: any, roles: string[]): Promise<any> {
  const oid = String(claims.oid);
  const upn = String(claims.preferred_username ?? claims.upn ?? claims.email ?? `${oid}@${tenant().defaultDomain}`).toLowerCase();
  const domain = upn.split('@')[1];
  if (domain) await ensureDomain(domain);
  let user = (await store.list('user', { match: { _msOid: oid }, limit: 1 }))[0] ?? (await store.list('user', { match: { _upn: upn }, limit: 1 }))[0];
  const fields = {
    displayName: String(claims.name ?? upn),
    givenName: profile.givenName ?? user?.givenName ?? null,
    surname: profile.surname ?? user?.surname ?? null,
    mail: profile.mail ?? claims.email ?? upn,
    jobTitle: profile.jobTitle ?? user?.jobTitle ?? null,
    department: profile.department ?? user?.department ?? null,
    officeLocation: profile.officeLocation ?? user?.officeLocation ?? null,
    mobilePhone: profile.mobilePhone ?? user?.mobilePhone ?? null,
  };
  if (!user) {
    user = await createUser({
      accountEnabled: true, userPrincipalName: upn, mailNickname: upn.split('@')[0].replace(/[^a-z0-9._-]/gi, ''), ...fields,
      preferredLanguage: profile.preferredLanguage ?? 'it-IT', usageLocation: 'IT',
      passwordProfile: { password: generatePassword(), forceChangePasswordNextSignIn: false },
    });
  }
  Object.assign(user, fields, {
    _msOid: oid,
    _msTenantId: String(claims.tid),
    _loginRoles: roles,
    _lastMicrosoftSignIn: nowIso(),
    identities: [{ signInType: 'federated', issuer: `login.microsoftonline.com/${claims.tid}`, issuerAssignedId: oid }],
    creationType: null,
    externalUserState: null,
  });
  await store.put('user', user.id, user, tenant().id);
  return user;
}

/** Riallinea ruoli RBAC (scope radice) e ruoli di directory gestiti dal login. */
async function syncRoles(user: any, roles: string[]) {
  const wanted = roles.map((r) => LOGIN_ROLES[r]);
  const armIds = new Set<string>();
  for (const w of wanted) {
    const name = uuidV5(`${user.id}|${w.arm}`, NS);
    const rec = { ...roleAssignmentRecord('/', name, w.arm, user.id, 'User', 'Microsoft Entra ID', `Ruolo app «${w.armName}» dal login Microsoft`), _managedBy: 'login' };
    armIds.add(rec.id.toLowerCase());
    if (!(await store.get('roleAssignment', rec.id))) await store.put('roleAssignment', rec.id, rec, '/');
  }
  for (const a of await store.list('roleAssignment', { match: { _managedBy: 'login' } })) {
    if (a.properties.principalId === user.id && !armIds.has(a.id.toLowerCase())) await store.remove('roleAssignment', a.id);
  }
  const dirIds = new Set<string>();
  for (const w of wanted) {
    const id = uuidV5(`${user.id}|dir|${w.dir}`, NS);
    dirIds.add(id);
    if (!(await store.get('dirRoleAssignment', id))) {
      await store.put('dirRoleAssignment', id, { id, principalId: user.id, roleDefinitionId: w.dir, directoryScopeId: '/', appScopeId: null, createdDateTime: nowIso(), _managedBy: 'login' }, tenant().id);
    }
  }
  for (const a of await store.list('dirRoleAssignment', { match: { principalId: user.id, _managedBy: 'login' } })) {
    if (!dirIds.has(a.id)) await store.remove('dirRoleAssignment', a.id);
  }
}
