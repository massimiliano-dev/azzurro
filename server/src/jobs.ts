import * as store from './db/store.ts';
import { config } from './config.ts';
import { purgeExpired } from './auth/session.ts';
import { notifyLater } from './push.ts';
import { tenant } from './directory.ts';
import { GLOBAL_ADMIN } from './firstParty.ts';
import { checkBudgets } from './costs/budgets.ts';

/** Avvisa gli owner delle app quando segreti o certificati stanno per scadere (entro 30 giorni). */
export async function checkExpiringCredentials(): Promise<void> {
  const horizon = Date.now() + 30 * 86400_000;
  const admins = (await store.list('dirRoleAssignment', { match: { roleDefinitionId: GLOBAL_ADMIN } })).map((a) => a.principalId);
  for (const app of await store.list('application')) {
    const notified = new Set<string>(app._expiryNotified ?? []);
    let changed = false;
    for (const cred of [...(app.passwordCredentials ?? []), ...(app.keyCredentials ?? [])]) {
      const end = Date.parse(cred.endDateTime);
      if (!end || end < Date.now() || end > horizon || notified.has(cred.keyId)) continue;
      notified.add(cred.keyId);
      changed = true;
      const owners = app._owners?.length ? app._owners : admins;
      notifyLater(owners, { category: 'apps', key: 'secretExpiring', params: { name: cred.displayName ?? cred.hint ?? cred.keyId.slice(0, 8), app: app.displayName, date: cred.endDateTime.slice(0, 10) }, url: `/entra/apps/${app.id}?tab=credentials` });
    }
    if (changed) {
      app._expiryNotified = [...notified];
      await store.put('application', app.id, app, tenant().id);
    }
  }
}

export function startJobs(): void {
  const run = () => {
    purgeExpired().catch((e) => !config.quiet && console.warn('[jobs] pulizia:', e.message));
    checkExpiringCredentials().catch((e) => !config.quiet && console.warn('[jobs] scadenze:', e.message));
  };
  setTimeout(run, 5_000).unref();
  setInterval(run, 60 * 60_000).unref();
  const budgets = () => checkBudgets().catch((e) => !config.quiet && console.warn('[jobs] budget:', e.message));
  setTimeout(budgets, 15_000).unref();
  setInterval(budgets, 10 * 60_000).unref();
}
