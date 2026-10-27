import * as jose from 'jose';
import { X509Certificate, createHash } from 'node:crypto';
import * as store from '../db/store.ts';
import { oauthError } from '../errors.ts';
import { appByAppId, spByAppId, tenant, userByUpn } from '../directory.ts';
import { firstPartyByAppId } from '../firstParty.ts';
import { safeEqual, sha256, verifyPassword } from '../ids.ts';
import { recordSignIn } from './signins.ts';

export interface Client {
  appId: string;
  displayName: string;
  firstParty: boolean;
  publicClient: boolean;
  app: any | null;
  sp: any | null;
  authMethod: 'none' | 'secret' | 'certificate' | 'federated';
}

export async function lookupClient(clientId: string | undefined): Promise<Client> {
  if (!clientId) throw oauthError(400, 'invalid_request', 900144, "The request body must contain the following parameter: 'client_id'.");
  const fp = firstPartyByAppId.get(clientId);
  const sp = await spByAppId(clientId);
  if (fp) return { appId: clientId, displayName: fp.displayName, firstParty: true, publicClient: fp.publicClient, app: null, sp, authMethod: 'none' };
  const app = await appByAppId(clientId);
  if (!app && !sp) {
    throw oauthError(400, 'unauthorized_client', 700016, `Application with identifier '${clientId}' was not found in the directory '${tenant().displayName}'. This can happen if the application has not been installed by the administrator of the tenant or consented to by any user in the tenant. You may have sent your authentication request to the wrong tenant.`);
  }
  const publicClient = !!app?.isFallbackPublicClient || (app?.publicClient?.redirectUris?.length ?? 0) > 0 || (app?.spa?.redirectUris?.length ?? 0) > 0;
  return { appId: clientId, displayName: app?.displayName ?? sp?.displayName, firstParty: false, publicClient, app, sp, authMethod: 'none' };
}

function credentialsOf(obj: any): any[] {
  return [...(obj?._secrets ?? [])];
}

function certsOf(obj: any): any[] {
  return [...(obj?._certs ?? [])];
}

async function verifyClientAssertion(client: Client, assertion: string, origin: string): Promise<'certificate' | 'federated'> {
  let header: jose.ProtectedHeaderParameters;
  let claims: jose.JWTPayload;
  try {
    header = jose.decodeProtectedHeader(assertion);
    claims = jose.decodeJwt(assertion);
  } catch {
    throw oauthError(401, 'invalid_client', 50027, 'JWT token is invalid or malformed.');
  }
  // 1) certificato caricato sull'app o sul service principal
  const thumb = (header.x5t as string | undefined) ?? undefined;
  const thumb256 = (header['x5t#S256'] as string | undefined) ?? undefined;
  const certs = [...certsOf(client.app), ...certsOf(client.sp)];
  const cert = certs.find((c) => (thumb && c.x5t === thumb) || (thumb256 && c.x5tS256 === thumb256) || (header.kid && (c.kid === header.kid || c.thumbprintHex?.toLowerCase() === String(header.kid).toLowerCase())));
  if (cert) {
    if (new Date(cert.endDateTime).getTime() < Date.now()) throw oauthError(401, 'invalid_client', 700027, 'Client assertion failed signature validation: the certificate is expired.');
    const key = await jose.importSPKI(cert.publicKeyPem, String(header.alg ?? 'RS256'));
    try {
      await jose.jwtVerify(assertion, key, { clockTolerance: 300 });
    } catch {
      throw oauthError(401, 'invalid_client', 700027, 'Client assertion failed signature validation.');
    }
    if (claims.iss !== client.appId || claims.sub !== client.appId) throw oauthError(401, 'invalid_client', 700023, 'Client assertion audience/issuer claim does not match the client.');
    return 'certificate';
  }
  // 2) credenziali federate (workload identity federation)
  const fics: any[] = client.app?._fics ?? [];
  const fic = fics.find((f) => f.issuer === claims.iss && f.subject === claims.sub);
  if (!fic) throw oauthError(401, 'invalid_client', 700213, `No matching federated identity record found for presented assertion subject '${claims.sub}'. Please check your federated identity credential Subject, Audience and Issuer against the presented assertion.`);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!fic.audiences?.some((a: string) => aud.includes(a))) throw oauthError(401, 'invalid_client', 700212, `No matching federated identity record found for presented assertion audience '${aud.join(',')}'.`);
  if (String(claims.iss).startsWith(origin)) {
    const { verifyJwt } = await import('./tokens.ts');
    await verifyJwt(assertion);
  } else {
    try {
      const meta = await fetch(`${String(claims.iss).replace(/\/+$/, '')}/.well-known/openid-configuration`).then((r) => r.json() as Promise<any>);
      await jose.jwtVerify(assertion, jose.createRemoteJWKSet(new URL(meta.jwks_uri)), { clockTolerance: 300 });
    } catch (e) {
      throw oauthError(401, 'invalid_client', 700211, `Unable to verify the federated assertion issued by '${claims.iss}': ${(e as Error).message}`);
    }
  }
  return 'federated';
}

/** Autentica il client secondo il tipo (pubblico/riservato) e le credenziali presentate. */
export async function authenticateClient(form: Record<string, string>, origin: string, opts: { requireConfidential?: boolean; allowPublic?: boolean } = {}): Promise<Client> {
  const client = await lookupClient(form.client_id);
  if (form.client_secret) {
    const secrets = [...credentialsOf(client.app), ...credentialsOf(client.sp)];
    const h = sha256(form.client_secret);
    const match = secrets.find((s) => safeEqual(s.hash, h));
    if (!match) throw oauthError(401, 'invalid_client', 7000215, `Invalid client secret provided. Ensure the secret being sent in the request is the client secret value, not the client secret ID, for a secret added to app '${client.appId}'.`);
    if (match.endDateTime && new Date(match.endDateTime).getTime() < Date.now()) throw oauthError(401, 'invalid_client', 7000222, `The provided client secret keys for app '${client.appId}' are expired.`);
    client.authMethod = 'secret';
  } else if (form.client_assertion) {
    if (form.client_assertion_type !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer') throw oauthError(400, 'invalid_request', 90014, "The request body must contain the following parameter: 'client_assertion_type'.");
    client.authMethod = await verifyClientAssertion(client, form.client_assertion, origin);
  } else if (opts.requireConfidential || !(opts.allowPublic && (client.publicClient || client.firstParty))) {
    throw oauthError(401, 'invalid_client', 7000218, "The request body must contain the following parameter: 'client_assertion' or 'client_secret'.");
  }
  if (client.sp && client.sp.accountEnabled === false) throw oauthError(400, 'unauthorized_client', 7000112, `Application '${client.appId}'(${client.displayName}) is disabled.`);
  return client;
}

export interface AuthUserResult { user: any; mustChange: boolean }

export async function authenticateUser(username: string, password: string, ctx: { appId?: string; appName?: string; ip?: string; userAgent?: string; interactive?: boolean }): Promise<AuthUserResult> {
  const user = username ? await userByUpn(username.trim()) : null;
  const fail = async (code: number, error: string, desc: string) => {
    await recordSignIn({ user, upn: username, appId: ctx.appId, appName: ctx.appName, ip: ctx.ip, userAgent: ctx.userAgent, interactive: ctx.interactive ?? true, errorCode: code, failureReason: desc });
    return oauthError(400, error, code, desc);
  };
  if (!user) throw await fail(50034, 'invalid_grant', `The user account {EUII Hidden} does not exist in the ${tenant().displayName} directory. To sign into this application, the account must be added to the directory.`);
  if (!verifyPassword(password ?? '', user._passwordHash)) throw await fail(50126, 'invalid_grant', 'Error validating credentials due to invalid username or password.');
  if (user.accountEnabled === false) throw await fail(50057, 'invalid_grant', 'The user account is disabled.');
  return { user, mustChange: !!user._forceChange };
}

/** Importa un certificato (DER/PEM base64) per keyCredentials. */
export function parseCertificate(keyB64OrPem: string): { publicKeyPem: string; x5t: string; x5tS256: string; thumbprintHex: string; notBefore: string; notAfter: string; subject: string } {
  const pem = keyB64OrPem.includes('BEGIN CERTIFICATE') ? keyB64OrPem : Buffer.from(keyB64OrPem, 'base64');
  const cert = new X509Certificate(pem);
  const der = cert.raw;
  const sha1 = createHash('sha1').update(der).digest();
  const s256 = createHash('sha256').update(der).digest();
  return {
    publicKeyPem: cert.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    x5t: sha1.toString('base64url'),
    x5tS256: s256.toString('base64url'),
    thumbprintHex: sha1.toString('hex').toUpperCase(),
    notBefore: new Date(cert.validFrom).toISOString(),
    notAfter: new Date(cert.validTo).toISOString(),
    subject: cert.subject,
  };
}

export async function loadUser(id: string): Promise<any | null> {
  return store.get('user', id);
}
