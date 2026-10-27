import { config } from './config.ts';
import * as store from './db/store.ts';
import { setTenant, spByAppId, userByUpn, type Tenant } from './directory.ts';
import { FIRST_PARTY, GLOBAL_ADMIN } from './firstParty.ts';
import { createServicePrincipal, createUser } from './graph/objects.ts';
import { nowIso, randomToken, uuid } from './ids.ts';
import { createSubscription } from './arm/handlers.ts';

export async function seed(): Promise<{ created: boolean; adminUpn: string }> {
  let created = false;
  let t: Tenant | undefined = (await store.list<Tenant>('tenant'))[0];
  if (!t) {
    t = {
      id: (config.tenantId ?? uuid()).toLowerCase(),
      displayName: config.tenantName,
      defaultDomain: config.domain,
      domains: [config.domain],
      countryCode: 'IT',
      createdDateTime: nowIso(),
    };
    await store.put('tenant', t.id, t);
    created = true;
  }
  setTenant({ id: t.id, displayName: t.displayName, defaultDomain: t.defaultDomain, domains: t.domains, countryCode: t.countryCode, createdDateTime: t.createdDateTime });

  for (const fp of FIRST_PARTY) {
    if (!(await spByAppId(fp.appId))) await createServicePrincipal({ appId: fp.appId });
  }

  const adminUpn = `admin@${t.defaultDomain}`;
  let admin = await userByUpn(adminUpn);
  if (!admin) {
    admin = await createUser({
      accountEnabled: true,
      displayName: 'Amministratore Azzurro',
      givenName: 'Amministratore',
      surname: 'Azzurro',
      mailNickname: 'admin',
      userPrincipalName: adminUpn,
      mail: adminUpn,
      jobTitle: 'Global Administrator',
      preferredLanguage: 'it-IT',
      usageLocation: 'IT',
      passwordProfile: { password: config.adminPassword, forceChangePasswordNextSignIn: false },
    });
    const a = { id: randomToken(32).slice(0, 43), principalId: admin.id, roleDefinitionId: GLOBAL_ADMIN, directoryScopeId: '/', appScopeId: null, createdDateTime: nowIso() };
    await store.put('dirRoleAssignment', a.id, a, t.id);
    created = true;
  }

  if (!(await store.count('subscription'))) {
    await createSubscription(
      { principal: { kind: 'user', oid: admin.id, tid: t.id, upn: admin.userPrincipalName, name: admin.displayName, roles: [], scopes: [], via: 'session' }, origin: config.publicUrl, correlationId: uuid() },
      'Azzurro Subscription',
    );
    created = true;
  }
  return { created, adminUpn };
}
