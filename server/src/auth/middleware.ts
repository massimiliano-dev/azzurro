import type { MiddlewareHandler } from 'hono';
import { config } from '../config.ts';
import * as store from '../db/store.ts';
import { HttpError } from '../errors.ts';
import { originOf, parseCookies, SESSION_COOKIE } from '../http.ts';
import { tenant, userByUpn } from '../directory.ts';
import type { AppEnv, Principal } from '../types.ts';
import { getSession } from './session.ts';
import { verifyJwt } from './tokens.ts';

export type Family = 'arm' | 'graph' | 'portal';

function unauthorized(family: Family, origin: string, code: string, message: string): HttpError {
  const graph = family === 'graph';
  return new HttpError(401, graph ? 'InvalidAuthenticationToken' : code, message, {
    headers: {
      'WWW-Authenticate': `Bearer authorization_uri="${origin}/${tenant().id}", error="invalid_token", error_description="${message.replace(/"/g, "'")}"`,
    },
  });
}

export async function principalFromToken(token: string, family: Family, origin: string): Promise<Principal> {
  let claims;
  try {
    claims = await verifyJwt(token);
  } catch (e: any) {
    if (e?.code === 'ERR_JWT_EXPIRED') {
      const exp = new Date((e.payload?.exp ?? 0) * 1000).toISOString();
      throw unauthorized(family, origin, 'ExpiredAuthenticationToken', family === 'graph'
        ? 'Lifetime validation failed, the token is expired.'
        : `The access token expiry UTC time '${exp}' is earlier than current UTC time '${new Date().toISOString()}'.`);
    }
    throw unauthorized(family, origin, 'InvalidAuthenticationToken', family === 'graph' ? 'Access token validation failure. Invalid audience.' : 'The access token is invalid.');
  }
  if (claims.tid !== tenant().id) throw unauthorized(family, origin, 'InvalidAuthenticationTokenTenant', `The access token is from the wrong issuer '${claims.iss}'. It must match the tenant '${origin}/${tenant().id}/'.`);
  if (claims.idtyp === 'user') {
    const user = await store.get('user', claims.oid);
    if (!user || user.accountEnabled === false) throw unauthorized(family, origin, 'InvalidAuthenticationToken', 'The user account is disabled or does not exist.');
    if (user._tokensRevokedAt && new Date(user._tokensRevokedAt).getTime() / 1000 > Number(claims.iat ?? 0)) {
      throw unauthorized(family, origin, 'InvalidAuthenticationToken', 'The access token has been revoked.');
    }
    return {
      kind: 'user',
      oid: user.id,
      tid: claims.tid,
      appId: claims.appid ?? claims.azp,
      upn: user.userPrincipalName,
      name: user.displayName,
      roles: claims.roles ?? [],
      scopes: String(claims.scp ?? '').split(' ').filter(Boolean),
      via: 'token',
    };
  }
  const sp = await store.get('servicePrincipal', claims.oid);
  if (!sp || sp.accountEnabled === false) throw unauthorized(family, origin, 'InvalidAuthenticationToken', 'The service principal is disabled or does not exist.');
  return {
    kind: 'app',
    oid: sp.id,
    tid: claims.tid,
    appId: sp.appId,
    name: sp.displayName,
    roles: claims.roles ?? [],
    scopes: [],
    via: 'token',
  };
}

let laxAdmin: Principal | undefined;

async function laxPrincipal(): Promise<Principal> {
  if (laxAdmin) return laxAdmin;
  const admin = await userByUpn(`admin@${tenant().defaultDomain}`);
  laxAdmin = {
    kind: 'user',
    oid: admin?.id ?? '00000000-0000-0000-0000-000000000000',
    tid: tenant().id,
    upn: admin?.userPrincipalName,
    name: admin?.displayName ?? 'Administrator',
    roles: [],
    scopes: [],
    via: 'lax',
  };
  return laxAdmin;
}

export async function principalFromSession(sessionId: string | undefined): Promise<Principal | null> {
  const s = await getSession(sessionId);
  if (!s) return null;
  const user = await store.get('user', s.userId);
  if (!user || user.accountEnabled === false) return null;
  return {
    kind: 'user',
    oid: user.id,
    tid: tenant().id,
    upn: user.userPrincipalName,
    name: user.displayName,
    roles: [],
    scopes: [],
    via: 'session',
    sessionId: s.hash,
  };
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export function authenticate(family: Family): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const origin = originOf(c);
    const auth = c.req.header('authorization');
    if (auth && /^bearer\s+/i.test(auth)) {
      c.set('principal', await principalFromToken(auth.replace(/^bearer\s+/i, '').trim(), family, origin));
      return next();
    }
    const sid = parseCookies(c.req.header('cookie'))[SESSION_COOKIE];
    if (sid) {
      const p = await principalFromSession(sid);
      if (p) {
        if (!SAFE.has(c.req.method) && c.req.header('x-azzurro-portal') !== '1') {
          throw new HttpError(403, family === 'graph' ? 'Authorization_RequestDenied' : 'AuthorizationFailed', 'Cookie-authenticated requests must include the X-Azzurro-Portal header.');
        }
        c.set('principal', p);
        return next();
      }
    }
    if (config.authMode === 'lax') {
      c.set('principal', await laxPrincipal());
      return next();
    }
    throw unauthorized(
      family,
      origin,
      'AuthenticationFailed',
      family === 'graph' ? 'Access token is empty.' : "Authentication failed. The 'Authorization' header is missing.",
    );
  };
}
