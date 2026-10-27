import * as store from '../db/store.ts';
import { config } from '../config.ts';
import { oauthError } from '../errors.ts';
import { directoryRolesOf, groupsOf, spByResource, tenant } from '../directory.ts';
import { GRAPH_APP_ID, GRAPH_RESOURCE, ARM_APP_ID } from '../firstParty.ts';
import { randomToken, sha256, uuid, nowIso } from '../ids.ts';
import { signJwt, v1Issuer, v2Issuer } from './tokens.ts';
import type { Client } from './clients.ts';
import { recordSignIn } from './signins.ts';

const OIDC = new Set(['openid', 'profile', 'email', 'offline_access']);

export interface ParsedScopes {
  oidc: Set<string>;
  resource: string | null;
  names: string[];
}

/** Separa gli scope OIDC dagli scope di risorsa: "https://x//.default", "api://id/read", "User.Read". */
export function parseScopes(scope: string | undefined, resourceParam?: string): ParsedScopes {
  const oidc = new Set<string>();
  let resource: string | null = resourceParam ?? null;
  const names: string[] = [];
  for (const raw of (scope ?? '').split(/[\s+]+/).filter(Boolean)) {
    if (OIDC.has(raw.toLowerCase())) { oidc.add(raw.toLowerCase()); continue; }
    const i = raw.lastIndexOf('/');
    if (i > 0 && (raw.includes('://') || /^[0-9a-f-]{36}\//i.test(raw))) {
      const res = raw.slice(0, i);
      const name = raw.slice(i + 1);
      if (resource && resource.replace(/\/+$/, '').toLowerCase() !== res.replace(/\/+$/, '').toLowerCase()) {
        throw oauthError(400, 'invalid_scope', 28000, `Provided value for the input parameter scope is not valid because it contains more than one resource. Scope ${scope} is not valid.`);
      }
      resource = res;
      names.push(name);
    } else {
      if (resource && resource !== GRAPH_RESOURCE && !resourceParam) {
        throw oauthError(400, 'invalid_scope', 28000, `Provided value for the input parameter scope is not valid because it contains more than one resource. Scope ${scope} is not valid.`);
      }
      resource = resource ?? GRAPH_RESOURCE;
      names.push(raw);
    }
  }
  if (resourceParam && !names.length) names.push('.default');
  return { oidc, resource, names };
}

export interface ResolvedResource {
  sp: any;
  /** valore dell'audience nel token */
  aud: string;
  version: '1.0' | '2.0';
  requested: string;
}

export async function resolveResource(resource: string, origin: string): Promise<ResolvedResource> {
  let sp = await spByResource(resource);
  const sameHost = (() => {
    try {
      const u = new URL(resource);
      return u.origin === origin || u.origin === config.publicUrl;
    } catch {
      return false;
    }
  })();
  if (!sp && sameHost) sp = await store.list('servicePrincipal', { match: { appId: GRAPH_APP_ID }, limit: 1 }).then((r) => r[0]);
  if (!sp) {
    throw oauthError(400, 'invalid_resource', 500011, `The resource principal named ${resource} was not found in the tenant named ${tenant().displayName}. This can happen if the application has not been installed by the administrator of the tenant or consented to by any user in the tenant. You might have sent your authentication request to the wrong tenant.`);
  }
  if (sp.accountEnabled === false) throw oauthError(400, 'invalid_resource', 7000112, `Application '${sp.appId}'(${sp.displayName}) is disabled.`);
  if (sp.appId === GRAPH_APP_ID) return { sp, aud: sameHost ? resource.replace(/\/+$/, '') : GRAPH_RESOURCE, version: '1.0', requested: resource };
  if (sp.appId === ARM_APP_ID) return { sp, aud: resource.endsWith('/') ? resource : resource + '/', version: '1.0', requested: resource };
  const app = sp.appOwnerOrganizationId === tenant().id ? (await store.list('application', { match: { appId: sp.appId }, limit: 1 }))[0] : null;
  const v2 = app?.api?.requestedAccessTokenVersion === 2;
  return { sp, aud: v2 ? sp.appId : resource, version: v2 ? '2.0' : '1.0', requested: resource };
}

async function appRoleValues(principalIds: string[], resourceSp: any): Promise<string[]> {
  const all = await store.list('appRoleAssignment', { match: { resourceId: resourceSp.id } });
  const ids = new Set(principalIds);
  const roles = new Set<string>();
  for (const a of all) {
    if (!ids.has(a.principalId)) continue;
    const role = (resourceSp.appRoles ?? []).find((r: any) => r.id === a.appRoleId);
    if (role?.value && role.isEnabled !== false) roles.add(role.value);
  }
  return [...roles];
}

async function delegatedScopes(client: Client, user: any, res: ResolvedResource, names: string[]): Promise<string[]> {
  const available: any[] = (res.sp.oauth2PermissionScopes ?? []).filter((s: any) => s.isEnabled !== false);
  const byValue = new Map(available.map((s) => [s.value.toLowerCase(), s.value as string]));
  const explicit = names.filter((n) => n !== '.default');
  if (explicit.length) {
    const out: string[] = [];
    for (const n of explicit) {
      const v = byValue.get(n.toLowerCase());
      if (!v) throw oauthError(400, 'invalid_scope', 70011, `The provided value for the input parameter 'scope' is not valid. The scope ${n} is not valid.`);
      out.push(v);
    }
    if (!client.firstParty && client.sp) await recordConsent(client.sp.id, res.sp.id, user.id, out);
    return out;
  }
  // .default: consenso già concesso, o permessi configurati sull'app client
  if (client.firstParty) return available.map((s) => s.value);
  const grants = client.sp ? await store.list('oauth2PermissionGrant', { match: { clientId: client.sp.id, resourceId: res.sp.id } }) : [];
  const granted = new Set<string>();
  for (const g of grants) {
    if (g.consentType === 'AllPrincipals' || g.principalId === user.id) for (const s of String(g.scope ?? '').split(' ').filter(Boolean)) granted.add(s);
  }
  if (granted.size) return [...granted];
  const rra = (client.app?.requiredResourceAccess ?? []).find((r: any) => r.resourceAppId === res.sp.appId);
  const configured = (rra?.resourceAccess ?? []).filter((a: any) => a.type === 'Scope').map((a: any) => available.find((s) => s.id === a.id)?.value).filter(Boolean);
  if (configured.length) {
    if (client.sp) await recordConsent(client.sp.id, res.sp.id, user.id, configured);
    return configured;
  }
  if (client.appId === res.sp.appId) return available.map((s) => s.value);
  throw oauthError(400, 'invalid_grant', 65001, `The user or administrator has not consented to use the application with ID '${client.appId}' named '${client.displayName}'. Send an interactive authorization request for this user and resource.`);
}

/** Consenso utente implicito (in Azure richiederebbe il prompt): registra un oauth2PermissionGrant. */
async function recordConsent(clientSpId: string, resourceSpId: string, userId: string, scopes: string[]): Promise<void> {
  const existing = (await store.list('oauth2PermissionGrant', { match: { clientId: clientSpId, resourceId: resourceSpId } }))
    .find((g) => g.consentType === 'AllPrincipals' || g.principalId === userId);
  if (existing) {
    const have = new Set(String(existing.scope ?? '').split(' ').filter(Boolean));
    const missing = scopes.filter((s) => !have.has(s));
    if (!missing.length) return;
    if (existing.consentType === 'AllPrincipals') return;
    existing.scope = [...have, ...missing].join(' ');
    await store.put('oauth2PermissionGrant', existing.id, existing, tenant().id);
    return;
  }
  const id = randomToken(24);
  await store.put('oauth2PermissionGrant', id, { id, clientId: clientSpId, consentType: 'Principal', principalId: userId, resourceId: resourceSpId, scope: scopes.join(' ') }, tenant().id);
}

export interface IssueInput {
  origin: string;
  client: Client;
  user?: any;
  /** service principal che agisce come se stesso (client credentials / managed identity) */
  appSp?: any;
  scope?: string;
  resource?: string;
  nonce?: string;
  clientInfo?: boolean;
  v1Endpoint?: boolean;
  ip?: string;
  userAgent?: string;
  interactive?: boolean;
  managedIdentityResourceId?: string;
  /** refresh token esistente da ruotare */
  refreshFamily?: string;
}

export interface TokenResponse {
  token_type: 'Bearer';
  scope: string;
  expires_in: number;
  ext_expires_in: number;
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  client_info?: string;
  expires_on?: string;
  not_before?: string;
  resource?: string;
  foci?: string;
}

export async function issueTokens(inp: IssueInput): Promise<TokenResponse> {
  const t = tenant();
  const parsed = parseScopes(inp.scope, inp.resource);
  const resourceStr = parsed.resource ?? GRAPH_RESOURCE;
  if (!parsed.names.length) parsed.names.push(parsed.resource ? '.default' : 'User.Read');
  const res = await resolveResource(resourceStr, inp.origin);
  const iss = res.version === '2.0' ? v2Issuer(inp.origin, t.id) : v1Issuer(inp.origin, t.id);
  const ttl = config.tokenLifetime;
  const now = Math.floor(Date.now() / 1000);
  const base: Record<string, unknown> = {
    aud: res.aud,
    iss,
    tid: t.id,
    ver: res.version,
    rh: '0.AAAA' + randomToken(9),
    aio: randomToken(12),
  };

  let claims: Record<string, unknown>;
  let scopeOut: string;

  if (inp.user) {
    const u = inp.user;
    const groups = await groupsOf(u.id);
    const scopes = await delegatedScopes(inp.client, u, res, parsed.names);
    const roles = await appRoleValues([u.id, ...groups], res.sp);
    const wids = await directoryRolesOf(u.id, groups);
    claims = {
      ...base,
      oid: u.id,
      sub: sha256(`${u.id}:${inp.client.appId}`).slice(0, 43),
      name: u.displayName,
      given_name: u.givenName ?? undefined,
      family_name: u.surname ?? undefined,
      idtyp: 'user',
      scp: scopes.join(' '),
      amr: ['pwd'],
      wids,
      ...(roles.length ? { roles } : {}),
      ...(res.version === '2.0'
        ? { azp: inp.client.appId, azpacr: inp.client.authMethod === 'none' ? '0' : inp.client.authMethod === 'secret' ? '1' : '2', preferred_username: u.userPrincipalName }
        : { appid: inp.client.appId, appidacr: inp.client.authMethod === 'none' ? '0' : inp.client.authMethod === 'secret' ? '1' : '2', upn: u.userPrincipalName, unique_name: u.userPrincipalName, ipaddr: inp.ip ?? '127.0.0.1' }),
    };
    const sep = res.sp.appId === GRAPH_APP_ID && !res.requested.startsWith('http') ? '' : res.requested.replace(/\/+$/, '') + '/';
    scopeOut = scopes.map((s) => (res.sp.appId === GRAPH_APP_ID ? s : `${sep}${s}`)).join(' ');
  } else {
    const sp = inp.appSp ?? inp.client.sp;
    if (!sp) throw oauthError(400, 'unauthorized_client', 7000229, `The client application ${inp.client.appId} is missing service principal in the tenant ${t.id}.`);
    if (parsed.names.some((n) => n !== '.default')) {
      throw oauthError(400, 'invalid_scope', 1002012, `The provided value for scope ${inp.scope} is not valid. Client credential flows must have a scope value with /.default suffixed to the resource identifier (application ID URI).`);
    }
    const groups = await groupsOf(sp.id);
    const roles = await appRoleValues([sp.id, ...groups], res.sp);
    claims = {
      ...base,
      oid: sp.id,
      sub: sp.id,
      idtyp: 'app',
      ...(roles.length ? { roles } : {}),
      ...(inp.managedIdentityResourceId ? { xms_mirid: inp.managedIdentityResourceId } : {}),
      ...(res.version === '2.0'
        ? { azp: sp.appId, azpacr: inp.client.authMethod === 'secret' ? '1' : '2' }
        : { appid: sp.appId, appidacr: inp.client.authMethod === 'secret' ? '1' : '2' }),
    };
    scopeOut = `${res.requested.replace(/\/+$/, '')}/.default`;
    await recordSignIn({ sp, appId: sp.appId, appName: sp.displayName, resourceId: res.sp.appId, resourceName: res.sp.displayName, ip: inp.ip, userAgent: inp.userAgent, interactive: false });
  }

  const out: TokenResponse = {
    token_type: 'Bearer',
    scope: scopeOut,
    expires_in: ttl,
    ext_expires_in: ttl,
    access_token: await signJwt(claims, ttl),
  };

  if (inp.user) {
    const u = inp.user;
    if (parsed.oidc.has('offline_access') || inp.v1Endpoint || inp.refreshFamily) {
      const rt = randomToken(48);
      await store.put('refreshToken', sha256(rt), {
        userId: u.id,
        clientId: inp.client.appId,
        family: inp.refreshFamily ?? uuid(),
        created: nowIso(),
        expires: new Date(Date.now() + 90 * 86400_000).toISOString(),
      });
      out.refresh_token = rt;
      if (inp.client.firstParty) out.foci = '1';
    }
    if (parsed.oidc.has('openid') || inp.v1Endpoint) {
      out.id_token = await signJwt({
        aud: inp.client.appId,
        iss: v2Issuer(inp.origin, t.id),
        tid: t.id,
        oid: u.id,
        sub: sha256(`${u.id}:${inp.client.appId}`).slice(0, 43),
        name: u.displayName,
        preferred_username: u.userPrincipalName,
        ...(parsed.oidc.has('email') && u.mail ? { email: u.mail } : {}),
        ...(inp.nonce ? { nonce: inp.nonce } : {}),
        ver: '2.0',
        rh: '0.AAAA' + randomToken(9),
      }, 3600);
    }
    if (inp.clientInfo) out.client_info = Buffer.from(JSON.stringify({ uid: u.id, utid: t.id })).toString('base64url');
  }
  if (inp.v1Endpoint) {
    out.expires_on = String(now + ttl);
    out.not_before = String(now);
    out.resource = resourceStr;
  }
  return out;
}

export async function redeemRefreshToken(rt: string, clientId: string): Promise<{ user: any; family: string }> {
  const rec = await store.get('refreshToken', sha256(rt));
  if (!rec || new Date(rec.expires).getTime() < Date.now()) {
    throw oauthError(400, 'invalid_grant', 700082, 'The refresh token has expired or is invalid due to sign-in frequency checks by conditional access.');
  }
  if (rec.clientId !== clientId) {
    const { firstPartyByAppId } = await import('../firstParty.ts');
    if (!(firstPartyByAppId.has(rec.clientId) && firstPartyByAppId.has(clientId))) {
      throw oauthError(400, 'invalid_grant', 70000, 'Provided grant is invalid or malformed: the refresh token was issued to a different client.');
    }
  }
  const user = await store.get('user', rec.userId);
  if (!user || user.accountEnabled === false) throw oauthError(400, 'invalid_grant', 50057, 'The user account is disabled.');
  if (user._tokensRevokedAt && new Date(user._tokensRevokedAt).getTime() > new Date(rec.created).getTime()) {
    throw oauthError(400, 'invalid_grant', 50173, 'The provided grant has expired due to it being revoked, a fresh auth token is needed.');
  }
  return { user, family: rec.family };
}
