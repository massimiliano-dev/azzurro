/** Configurazione del server dal portale: solo amministratori globali (Azzurro.Owner). */
import type { Hono } from 'hono';
import { HttpError } from '../errors.ts';
import { readJson } from '../http.ts';
import { directoryRolesOf } from '../directory.ts';
import { GLOBAL_ADMIN } from '../firstParty.ts';
import { CONFIG_FILE, describeConfig, FIELDS, readOverrides, writeOverrides } from '../overrides.ts';
import { msEnabled, msRedirectUri } from '../auth/microsoft.ts';
import { config } from '../config.ts';
import * as store from '../db/store.ts';
import { claudeCodeAccount, claudeCodeOwner } from '../assistant/claudecode.ts';
import type { AppEnv } from '../types.ts';

async function requireGlobalAdmin(p: { kind: string; oid: string }): Promise<void> {
  if (p.kind !== 'user' || !(await directoryRolesOf(p.oid)).includes(GLOBAL_ADMIN)) {
    throw new HttpError(403, 'not_admin', 'Only a Global Administrator (Azzurro.Owner) can change the server configuration.');
  }
}

const view = async () => {
  const owner = claudeCodeOwner();
  const u = owner ? await store.get<any>('user', owner) : null;
  return {
    file: CONFIG_FILE,
    fields: describeConfig(),
    microsoft: { enabled: msEnabled(), redirectUri: msRedirectUri(), localLogin: config.localLogin },
    // account Claude Code del Mac: email e piano, mai i token
    claudeCode: { ...(await claudeCodeAccount(true)), owner: owner ? { id: owner, upn: u?.userPrincipalName ?? owner } : null },
  };
};

export function adminRoutes(app: Hono<AppEnv>): void {
  app.get('/_portal/admin/config', async (c) => {
    await requireGlobalAdmin(c.get('principal'));
    return c.json(await view());
  });

  app.put('/_portal/admin/config', async (c) => {
    await requireGlobalAdmin(c.get('principal'));
    const body = await readJson(c);
    const values = body.values && typeof body.values === 'object' ? body.values as Record<string, unknown> : {};
    const changes: Record<string, string | null> = {};
    for (const f of FIELDS) {
      if (!(f.key in values)) continue;
      const v = values[f.key];
      if (v !== null && typeof v !== 'string') throw new HttpError(400, 'invalid_value', `${f.key} must be a string or null.`);
      if (typeof v === 'string' && v.length > 4000) throw new HttpError(400, 'invalid_value', `${f.key} is too long.`);
      if (typeof v === 'string' && v.trim() && f.kind === 'url' && !/^https?:\/\/[^\s]+$/i.test(v.trim())) throw new HttpError(400, 'invalid_value', `${f.key} must be an http(s) URL.`);
      if (typeof v === 'string' && v.trim() && f.options && !f.options.includes(v.trim())) throw new HttpError(400, 'invalid_value', `${f.key} must be one of: ${f.options.filter(Boolean).join(', ')}.`);
      if (typeof v === 'string' && v.trim() && f.kind === 'bool' && !['on', 'off'].includes(v.trim())) throw new HttpError(400, 'invalid_value', `${f.key} must be on or off.`);
      if (f.key === 'AZZURRO_MS_TENANT_ID' || f.key === 'AZZURRO_MS_CLIENT_ID') {
        if (typeof v === 'string' && v.trim() && !/^[0-9a-f-]{36}$/i.test(v.trim())) throw new HttpError(400, 'invalid_value', `${f.key} must be a GUID.`);
      }
      // l'abbonamento Claude è personale: ognuno può associarlo solo a sé stesso
      if (f.kind === 'owner' && typeof v === 'string' && v && v !== c.get('principal').oid) throw new HttpError(400, 'invalid_value', 'You can link the Claude Code account of this Mac only to yourself.');
      changes[f.key] = v as string | null;
    }
    const before = readOverrides();
    try { writeOverrides(changes); } catch (e) { throw new HttpError(400, 'invalid_value', (e as Error).message); }
    // non togliere l'unico modo di entrare: senza Microsoft configurato il login locale resta
    if (!msEnabled() && !config.localLogin) {
      writeOverrides(Object.fromEntries(FIELDS.map((f) => [f.key, before[f.key] ?? null])));
      throw new HttpError(400, 'lockout', 'Turning off local sign-in needs Microsoft sign-in to be fully configured first.');
    }
    return c.json(await view());
  });
}
