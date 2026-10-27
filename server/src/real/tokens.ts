/**
 * Token delegati dell'utente per Azure reale: refresh token cifrato nel database,
 * token di accesso per tenant e risorsa (ARM, Graph) in memoria fino alla scadenza.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config.ts';
import * as store from '../db/store.ts';
import { loadOrCreate } from '../auth/keys.ts';

export type Resource = 'arm' | 'graph';
export const RESOURCE_SCOPE: Record<Resource, string> = {
  arm: 'https://management.azure.com/user_impersonation',
  graph: 'https://graph.microsoft.com/.default',
};
/** ambiti chiesti al consenso interattivo per ciascuna risorsa */
export const CONSENT_SCOPES: Record<Resource, string> = {
  arm: 'https://management.azure.com/user_impersonation',
  graph: ['Directory.Read.All', 'User.ReadWrite.All', 'Group.ReadWrite.All', 'Application.ReadWrite.All', 'AuditLog.Read.All', 'RoleManagement.Read.Directory'].map((s) => `https://graph.microsoft.com/${s}`).join(' '),
};

let key: Buffer | undefined;
async function encKey(): Promise<Buffer> {
  if (key) return key;
  const k = await loadOrCreate<{ k: string }>('tokenEncryption', () => ({ k: randomBytes(32).toString('base64') }));
  return (key = Buffer.from(k.k, 'base64'));
}
async function seal(text: string): Promise<string> {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', await encKey(), iv);
  const out = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), out].map((b) => b.toString('base64')).join('.');
}
async function open(sealed: string): Promise<string> {
  const [iv, tag, data] = sealed.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = createDecipheriv('aes-256-gcm', await encKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

export async function saveRefreshToken(userId: string, refreshToken: string, homeTenant: string): Promise<void> {
  const prev = await store.get('msToken', userId);
  await store.put('msToken', userId, { ...(prev ?? {}), rt: await seal(refreshToken), homeTenant: prev?.homeTenant ?? homeTenant, updatedAt: new Date().toISOString() });
}

export async function homeTenantOf(userId: string): Promise<string | null> {
  return (await store.get('msToken', userId))?.homeTenant ?? null;
}

export class ConsentRequired extends Error {
  tenant: string;
  resource: Resource;
  aadCode?: string;
  constructor(tenant: string, resource: Resource, message: string, aadCode?: string) {
    super(message);
    this.tenant = tenant;
    this.resource = resource;
    this.aadCode = aadCode;
  }
}

const cache = new Map<string, { token: string; exp: number; scp: string }>();

/** Token di accesso per (utente, tenant, risorsa). Lancia ConsentRequired se serve un passaggio interattivo. */
export async function accessToken(userId: string, tenant: string, resource: Resource): Promise<{ token: string; scp: string }> {
  const k = `${userId}|${tenant}|${resource}`;
  const hit = cache.get(k);
  if (hit && hit.exp > Date.now() + 60_000) return hit;
  const rec = await store.get('msToken', userId);
  if (!rec?.rt) throw new ConsentRequired(tenant, resource, 'Sign in again with Microsoft to connect your Azure directories.', 'no_refresh_token');
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.msClientId, client_secret: config.msClientSecret, grant_type: 'refresh_token',
      refresh_token: await open(rec.rt), scope: `${RESOURCE_SCOPE[resource]} offline_access`,
    }),
  });
  const j = (await res.json()) as any;
  if (!res.ok || !j.access_token) {
    const code = /AADSTS\d+/.exec(String(j.error_description ?? ''))?.[0];
    throw new ConsentRequired(tenant, resource, String(j.error_description ?? j.error ?? `HTTP ${res.status}`).split(/\r?\n/)[0], code ?? j.error);
  }
  if (j.refresh_token) await saveRefreshToken(userId, j.refresh_token, rec.homeTenant);
  let scp = '';
  try { scp = JSON.parse(Buffer.from(j.access_token.split('.')[1], 'base64url').toString()).scp ?? ''; } catch { /* token opaco */ }
  const v = { token: j.access_token as string, exp: Date.now() + Number(j.expires_in ?? 3600) * 1000, scp };
  cache.set(k, v);
  return v;
}

export function forgetTokens(userId: string): void {
  for (const k of cache.keys()) if (k.startsWith(`${userId}|`)) cache.delete(k);
}

/** Dimentica il token di una risorsa (es. Graph rifiuta con 403: forse è appena stato dato il consenso). */
export function forgetToken(userId: string, tenant: string, resource: Resource): void {
  cache.delete(`${userId}|${tenant}|${resource}`);
}
