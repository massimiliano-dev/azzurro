import { onConfigChange } from './overrides.ts';

const env = process.env;

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === '') return def;
  return !['0', 'false', 'off', 'no'].includes(v.toLowerCase());
}

function build() {
  return {
  port: Number(env.PORT ?? 4000),
  httpsPort: Number(env.HTTPS_PORT ?? 4443),
  tlsCert: env.AZZURRO_TLS_CERT ?? new URL('../../certs/azzurro.pem', import.meta.url).pathname,
  tlsKey: env.AZZURRO_TLS_KEY ?? new URL('../../certs/azzurro-key.pem', import.meta.url).pathname,
  publicUrl: (env.PUBLIC_URL ?? 'http://localhost:4000').replace(/\/+$/, ''),
  portalUrl: (env.PORTAL_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
  databaseUrl: env.DATABASE_URL ?? 'postgres://azzurro:azzurro@localhost:5433/azzurro',
  dbSchema: env.AZZURRO_DB_SCHEMA ?? 'public',
  tenantId: env.AZZURRO_TENANT_ID,
  tenantName: env.AZZURRO_TENANT_NAME ?? 'Azzurro',
  domain: (env.AZZURRO_DOMAIN ?? 'azzurro.local').toLowerCase(),
  adminPassword: env.AZZURRO_ADMIN_PASSWORD ?? 'Azzurro123!',
  authMode: (env.AZZURRO_AUTH ?? 'strict').toLowerCase() === 'lax' ? 'lax' : 'strict',
  rbac: bool(env.AZZURRO_RBAC, true),
  vapidSubject: env.AZZURRO_VAPID_SUBJECT ?? 'mailto:admin@azzurro.local',
  tokenLifetime: Number(env.AZZURRO_TOKEN_LIFETIME ?? 3599),
  sessionHours: Number(env.AZZURRO_SESSION_HOURS ?? 12),
  quiet: bool(env.AZZURRO_QUIET, false),
  /** accesso al portale con Microsoft Entra ID (tenant aziendale reale) */
  msTenantId: env.AZZURRO_MS_TENANT_ID ?? '',
  msClientId: env.AZZURRO_MS_CLIENT_ID ?? '',
  msClientSecret: env.AZZURRO_MS_CLIENT_SECRET ?? '',
  /** base del reindirizzamento Microsoft se diversa dal portale (Entra accetta http solo su localhost) */
  msRedirectBase: (env.AZZURRO_MS_REDIRECT_BASE ?? '').replace(/\/+$/, ''),
  /** login con utente e password della directory emulata; di default solo se Microsoft non è configurato */
  localLogin: bool(env.AZZURRO_LOCAL_LOGIN, !(env.AZZURRO_MS_TENANT_ID && env.AZZURRO_MS_CLIENT_ID && env.AZZURRO_MS_CLIENT_SECRET)),
} as const;
}

export const config = build();
export type Config = typeof config;

// i valori modificati dal portale (overrides.ts) si applicano a caldo
onConfigChange(() => Object.assign(config, build()));
