import * as store from '../db/store.ts';
import { HttpError } from '../errors.ts';
import { tenant } from '../directory.ts';
import { firstPartyByAppId, MICROSOFT_TENANT } from '../firstParty.ts';
import { clientSecret, hashPassword, isGuid, nowIso, passwordIsComplex, sha256, uuid } from '../ids.ts';
import { parseCertificate } from '../auth/clients.ts';
import { recordEvent } from '../events.ts';
import type { Principal } from '../types.ts';

export const graphBad = (message: string, code = 'Request_BadRequest') => new HttpError(400, code, message);
export const graphNotFound = (id: string) => new HttpError(404, 'Request_ResourceNotFound', `Resource '${id}' does not exist or one of its queried reference-property objects are not present.`);

/** Rimuove i campi interni (prefisso "_") prima di restituire un oggetto. */
export function publicView<T extends Record<string, any>>(o: T): T {
  const out: any = {};
  for (const [k, v] of Object.entries(o)) if (!k.startsWith('_')) out[k] = v;
  return out;
}

const nullInfo = () => ({ logoUrl: null, marketingUrl: null, privacyStatementUrl: null, supportUrl: null, termsOfServiceUrl: null });
const nullPublisher = () => ({ displayName: null, verifiedPublisherId: null, addedDateTime: null });

function ensureIds<T extends { id?: string }>(items: T[] | undefined): T[] {
  return (items ?? []).map((x) => ({ ...x, id: x.id && isGuid(x.id) ? x.id : uuid() }));
}

function assertUnique(values: string[], what: string) {
  const seen = new Set<string>();
  for (const v of values) {
    const k = v.toLowerCase();
    if (seen.has(k)) throw graphBad(`${what} values must be unique: '${v}' is duplicated.`);
    seen.add(k);
  }
}

async function assertIdentifierUrisFree(uris: string[], selfId?: string) {
  for (const uri of uris) {
    try {
      new URL(uri);
    } catch {
      throw graphBad(`Values of identifierUris property must follow one of the following formats: api://{appId}, api://{tenantId}/{appId}, api://{tenantId}/{string}, https://{verifiedCustomerDomain}/{string}. Value '${uri}' is not valid.`, 'Request_BadRequest');
    }
    const others = await store.list('application', { match: { identifierUris: [uri] } });
    if (others.some((o) => o.id !== selfId)) throw graphBad('Another object with the same value for property identifierUris already exists.', 'Request_MultipleObjectsWithSameKeyValue');
  }
}

const APP_WRITABLE = new Set([
  'displayName', 'description', 'notes', 'signInAudience', 'identifierUris', 'web', 'spa', 'publicClient', 'isFallbackPublicClient',
  'api', 'appRoles', 'requiredResourceAccess', 'tags', 'info', 'optionalClaims', 'groupMembershipClaims', 'keyCredentials',
  'serviceManagementReference', 'tokenEncryptionKeyId', 'isDeviceOnlyAuthSupported', 'defaultRedirectUri', 'parentalControlSettings', 'uniqueName', 'samlMetadataUrl',
]);

function normalizeAppSections(app: any) {
  app.web = { homePageUrl: null, logoutUrl: null, redirectUris: [], redirectUriSettings: [], ...(app.web ?? {}) };
  app.web.implicitGrantSettings = { enableAccessTokenIssuance: false, enableIdTokenIssuance: false, ...(app.web.implicitGrantSettings ?? {}) };
  app.spa = { redirectUris: [], ...(app.spa ?? {}) };
  app.publicClient = { redirectUris: [], ...(app.publicClient ?? {}) };
  app.api = { acceptMappedClaims: null, knownClientApplications: [], requestedAccessTokenVersion: null, oauth2PermissionScopes: [], preAuthorizedApplications: [], ...(app.api ?? {}) };
  app.api.oauth2PermissionScopes = ensureIds(app.api.oauth2PermissionScopes).map((s: any) => ({ adminConsentDescription: null, adminConsentDisplayName: null, isEnabled: true, type: 'User', userConsentDescription: null, userConsentDisplayName: null, ...s }));
  app.appRoles = ensureIds(app.appRoles).map((r: any) => ({ allowedMemberTypes: ['User'], description: null, displayName: null, isEnabled: true, origin: 'Application', value: null, ...r }));
  assertUnique(app.api.oauth2PermissionScopes.map((s: any) => s.value).filter(Boolean), 'oauth2PermissionScopes');
  assertUnique(app.appRoles.map((r: any) => r.value).filter(Boolean), 'appRoles');
  app.requiredResourceAccess = (app.requiredResourceAccess ?? []).map((r: any) => ({ resourceAppId: r.resourceAppId, resourceAccess: (r.resourceAccess ?? []).map((a: any) => ({ id: a.id, type: a.type })) }));
  for (const list of [app.web.redirectUris, app.spa.redirectUris, app.publicClient.redirectUris]) {
    for (const u of list) {
      if (typeof u !== 'string' || !/^[a-z][a-z0-9+.-]*:/i.test(u)) throw graphBad(`Invalid value specified for property 'redirectUris' of resource 'Application': '${u}'.`);
    }
  }
}

function applyKeyCredentials(app: any, keyCredentials: any[]) {
  const certs: any[] = [];
  const out: any[] = [];
  for (const kc of keyCredentials ?? []) {
    const keyId = kc.keyId && isGuid(kc.keyId) ? kc.keyId : uuid();
    if (kc.key) {
      const info = parseCertificate(kc.key);
      certs.push({ keyId, ...info, endDateTime: kc.endDateTime ?? info.notAfter });
      out.push({
        customKeyIdentifier: kc.customKeyIdentifier ?? info.thumbprintHex,
        displayName: kc.displayName ?? info.subject.replace(/\n/g, ', '),
        endDateTime: kc.endDateTime ?? info.notAfter,
        key: null,
        keyId,
        startDateTime: kc.startDateTime ?? info.notBefore,
        type: kc.type ?? 'AsymmetricX509Cert',
        usage: kc.usage ?? 'Verify',
      });
    } else {
      const existing = (app.keyCredentials ?? []).find((k: any) => k.keyId === keyId);
      const existingCert = (app._certs ?? []).find((k: any) => k.keyId === keyId);
      if (!existing || !existingCert) throw graphBad(`Key credential '${keyId}' must include the 'key' property.`);
      out.push(existing);
      certs.push(existingCert);
    }
  }
  app.keyCredentials = out;
  app._certs = certs;
}

export async function createApplication(input: any, ownerId?: string): Promise<any> {
  if (!input.displayName || typeof input.displayName !== 'string') throw graphBad("Property 'displayName' is required.");
  const app: any = {
    id: uuid(),
    appId: uuid(),
    applicationTemplateId: null,
    disabledByMicrosoftStatus: null,
    createdDateTime: nowIso(),
    deletedDateTime: null,
    description: null,
    displayName: input.displayName,
    groupMembershipClaims: null,
    identifierUris: [],
    isDeviceOnlyAuthSupported: null,
    isFallbackPublicClient: null,
    notes: null,
    publisherDomain: tenant().defaultDomain,
    serviceManagementReference: null,
    signInAudience: 'AzureADMyOrg',
    tags: [],
    tokenEncryptionKeyId: null,
    samlMetadataUrl: null,
    defaultRedirectUri: null,
    certification: null,
    optionalClaims: null,
    addIns: [],
    info: nullInfo(),
    keyCredentials: [],
    passwordCredentials: [],
    parentalControlSettings: { countriesBlockedForMinors: [], legalAgeGroupRule: 'Allow' },
    verifiedPublisher: nullPublisher(),
    _owners: ownerId ? [ownerId] : [],
    _secrets: [],
    _certs: [],
    _fics: [],
  };
  for (const [k, v] of Object.entries(input)) {
    if (APP_WRITABLE.has(k) && k !== 'keyCredentials') app[k] = v;
  }
  normalizeAppSections(app);
  if (input.keyCredentials) applyKeyCredentials(app, input.keyCredentials);
  await assertIdentifierUrisFree(app.identifierUris ?? []);
  await store.put('application', app.id, app, tenant().id);
  return app;
}

export async function updateApplication(app: any, patch: any): Promise<any> {
  for (const k of Object.keys(patch)) {
    if (k === 'passwordCredentials') throw graphBad("Property 'passwordCredentials' cannot be updated with PATCH. Use the addPassword and removePassword actions.");
    if (!APP_WRITABLE.has(k) && !k.startsWith('@odata')) throw graphBad(`Property '${k}' is read-only and cannot be set.`);
  }
  const before = { displayName: app.displayName };
  for (const [k, v] of Object.entries(patch)) {
    if (k.startsWith('@odata') || k === 'keyCredentials') continue;
    if (['web', 'spa', 'publicClient', 'api', 'info'].includes(k) && v && typeof v === 'object') app[k] = { ...(app[k] ?? {}), ...(v as object) };
    else app[k] = v;
  }
  if (patch.keyCredentials) applyKeyCredentials(app, patch.keyCredentials);
  normalizeAppSections(app);
  if (patch.identifierUris) await assertIdentifierUrisFree(app.identifierUris, app.id);
  await store.put('application', app.id, app, tenant().id);
  await syncServicePrincipal(app, before.displayName);
  return app;
}

/** Riflette le modifiche dell'app sul service principal associato. */
export async function syncServicePrincipal(app: any, previousName?: string): Promise<void> {
  const sp = (await store.list('servicePrincipal', { match: { appId: app.appId }, limit: 1 }))[0];
  if (!sp) return;
  sp.appDisplayName = app.displayName;
  if (!previousName || sp.displayName === previousName) sp.displayName = app.displayName;
  sp.appRoles = app.appRoles;
  sp.oauth2PermissionScopes = app.api?.oauth2PermissionScopes ?? [];
  sp.servicePrincipalNames = [app.appId, ...(app.identifierUris ?? [])];
  sp.replyUrls = [...(app.web?.redirectUris ?? []), ...(app.spa?.redirectUris ?? []), ...(app.publicClient?.redirectUris ?? [])];
  sp.signInAudience = app.signInAudience;
  sp.homepage = app.web?.homePageUrl ?? null;
  sp.info = app.info;
  await store.put('servicePrincipal', sp.id, sp, tenant().id);
}

export function addPassword(owner: any, input: any): { credential: any; secretText: string } {
  const secretText = clientSecret();
  const start = input?.startDateTime ?? nowIso();
  const end = input?.endDateTime ?? new Date(Date.now() + 2 * 365 * 86400_000).toISOString();
  if (Number.isNaN(Date.parse(end))) throw graphBad("Invalid value specified for property 'endDateTime'.");
  const keyId = uuid();
  const credential = {
    customKeyIdentifier: null,
    displayName: input?.displayName ?? null,
    endDateTime: new Date(end).toISOString(),
    hint: secretText.slice(0, 3),
    keyId,
    secretText: null,
    startDateTime: new Date(start).toISOString(),
  };
  owner.passwordCredentials = [...(owner.passwordCredentials ?? []), credential];
  owner._secrets = [...(owner._secrets ?? []), { keyId, hash: sha256(secretText), endDateTime: credential.endDateTime }];
  return { credential, secretText };
}

export function removePassword(owner: any, keyId: string): void {
  const before = (owner.passwordCredentials ?? []).length;
  owner.passwordCredentials = (owner.passwordCredentials ?? []).filter((p: any) => p.keyId !== keyId);
  owner._secrets = (owner._secrets ?? []).filter((p: any) => p.keyId !== keyId);
  if (owner.passwordCredentials.length === before) throw graphBad(`No password credential found with keyId '${keyId}'.`, 'Request_ResourceNotFound');
}

export async function createServicePrincipal(input: any): Promise<any> {
  const appId = input?.appId;
  if (!appId) throw graphBad("Property 'appId' is required.");
  const existing = (await store.list('servicePrincipal', { match: { appId }, limit: 1 }))[0];
  if (existing) throw new HttpError(409, 'Request_MultipleObjectsWithSameKeyValue', 'The service principal cannot be created, updated, or restored because the service principal name is already in use.');
  const app = (await store.list('application', { match: { appId }, limit: 1 }))[0];
  const fp = firstPartyByAppId.get(appId);
  if (!app && !fp) throw graphBad(`When using this permission, the backing application of the service principal being created must in the local tenant`, 'Request_BadRequest');
  const sp: any = {
    id: uuid(),
    deletedDateTime: null,
    accountEnabled: true,
    alternativeNames: [],
    appDisplayName: app?.displayName ?? fp!.displayName,
    appDescription: app?.description ?? null,
    appId,
    applicationTemplateId: null,
    appOwnerOrganizationId: app ? tenant().id : MICROSOFT_TENANT,
    appRoleAssignmentRequired: false,
    createdDateTime: nowIso(),
    description: null,
    disabledByMicrosoftStatus: null,
    displayName: app?.displayName ?? fp!.displayName,
    homepage: app?.web?.homePageUrl ?? null,
    loginUrl: null,
    logoutUrl: null,
    notes: null,
    notificationEmailAddresses: [],
    preferredSingleSignOnMode: null,
    preferredTokenSigningKeyThumbprint: null,
    replyUrls: app ? [...(app.web?.redirectUris ?? []), ...(app.spa?.redirectUris ?? []), ...(app.publicClient?.redirectUris ?? [])] : [],
    servicePrincipalNames: app ? [appId, ...(app.identifierUris ?? [])] : [...fp!.servicePrincipalNames],
    servicePrincipalType: 'Application',
    signInAudience: app?.signInAudience ?? 'AzureADMultipleOrgs',
    tags: app ? ['WindowsAzureActiveDirectoryIntegratedApp'] : [],
    tokenEncryptionKeyId: null,
    samlSingleSignOnSettings: null,
    addIns: [],
    appRoles: app?.appRoles ?? fp?.appRoles?.map((r) => ({ allowedMemberTypes: ['Application'], description: r.description, displayName: r.displayName, id: r.id, isEnabled: true, origin: 'Application', value: r.value })) ?? [],
    info: app?.info ?? nullInfo(),
    keyCredentials: [],
    oauth2PermissionScopes: app?.api?.oauth2PermissionScopes ?? fp?.scopes ?? [],
    passwordCredentials: [],
    resourceSpecificApplicationPermissions: [],
    verifiedPublisher: nullPublisher(),
    _owners: [],
    _secrets: [],
    _certs: [],
  };
  for (const k of ['accountEnabled', 'appRoleAssignmentRequired', 'tags', 'notes', 'description', 'notificationEmailAddresses', 'preferredSingleSignOnMode', 'loginUrl', 'logoutUrl', 'homepage']) {
    if (input[k] !== undefined) sp[k] = input[k];
  }
  await store.put('servicePrincipal', sp.id, sp, tenant().id);
  return sp;
}

/** Service principal di un'identità gestita (system o user assigned). */
export async function createManagedIdentity(displayName: string, resourceId: string, explicit: boolean): Promise<any> {
  const appId = uuid();
  const sp: any = {
    id: uuid(),
    deletedDateTime: null,
    accountEnabled: true,
    alternativeNames: [`isExplicit=${explicit ? 'True' : 'False'}`, resourceId],
    appDisplayName: null,
    appId,
    appOwnerOrganizationId: null,
    appRoleAssignmentRequired: false,
    createdDateTime: nowIso(),
    displayName,
    servicePrincipalNames: [appId, `https://identity.azure.net/${Buffer.from(resourceId).toString('base64url').slice(0, 40)}=`],
    servicePrincipalType: 'ManagedIdentity',
    signInAudience: 'AzureADMyOrg',
    tags: [],
    appRoles: [],
    oauth2PermissionScopes: [],
    keyCredentials: [],
    passwordCredentials: [],
    replyUrls: [],
    info: nullInfo(),
    verifiedPublisher: nullPublisher(),
    _owners: [],
    _miResourceId: resourceId.toLowerCase(),
    _miResourceIdOriginal: resourceId,
  };
  await store.put('servicePrincipal', sp.id, sp, tenant().id);
  return sp;
}

export async function deleteServicePrincipal(id: string): Promise<void> {
  await store.remove('servicePrincipal', id);
  for (const a of await store.list('appRoleAssignment')) {
    if (a.principalId === id || a.resourceId === id) await store.remove('appRoleAssignment', a.id);
  }
  for (const g of await store.list('oauth2PermissionGrant')) {
    if (g.clientId === id || g.resourceId === id) await store.remove('oauth2PermissionGrant', g.id);
  }
  await removeFromAllGroups(id);
}

export async function removeFromAllGroups(id: string): Promise<string[]> {
  const groups = await store.list('group', { match: { _members: [id] } });
  for (const g of groups) {
    g._members = (g._members ?? []).filter((m: string) => m !== id);
    await store.put('group', g.id, g, tenant().id);
  }
  for (const g of await store.list('group', { match: { _owners: [id] } })) {
    g._owners = (g._owners ?? []).filter((m: string) => m !== id);
    await store.put('group', g.id, g, tenant().id);
  }
  return groups.map((g) => g.id);
}

const USER_DEFAULTS = {
  businessPhones: [], givenName: null, jobTitle: null, mail: null, mobilePhone: null, officeLocation: null, preferredLanguage: null, surname: null,
  department: null, companyName: null, employeeId: null, usageLocation: null, city: null, country: null, state: null, streetAddress: null, postalCode: null,
  otherMails: [], proxyAddresses: [], ageGroup: null, consentProvidedForMinor: null, onPremisesSyncEnabled: null, externalUserState: null, faxNumber: null,
};

export const USER_WRITABLE = new Set(['accountEnabled', 'displayName', 'givenName', 'surname', 'jobTitle', 'department', 'companyName', 'officeLocation', 'mobilePhone', 'businessPhones', 'preferredLanguage', 'usageLocation', 'employeeId', 'city', 'country', 'state', 'streetAddress', 'postalCode', 'mail', 'mailNickname', 'userPrincipalName', 'otherMails', 'passwordProfile', 'faxNumber', 'ageGroup']);
export const USER_SELF_WRITABLE = new Set(['businessPhones', 'mobilePhone', 'officeLocation', 'preferredLanguage', 'aboutMe', 'faxNumber']);

async function assertUpn(upn: string, selfId?: string) {
  const at = upn.indexOf('@');
  if (at < 1) throw graphBad(`Invalid value specified for property 'userPrincipalName' of resource 'User'.`);
  const domain = upn.slice(at + 1).toLowerCase();
  if (!tenant().domains.includes(domain)) throw graphBad(`The domain portion of the userPrincipalName property is invalid. You must use one of the verified domain names in your organization.`);
  const existing = (await store.list('user', { match: { _upn: upn.toLowerCase() }, limit: 1 }))[0];
  if (existing && existing.id !== selfId) throw graphBad('Another object with the same value for property userPrincipalName already exists.', 'Request_MultipleObjectsWithSameKeyValue');
}

export async function createUser(input: any): Promise<any> {
  for (const k of ['accountEnabled', 'displayName', 'mailNickname', 'userPrincipalName', 'passwordProfile']) {
    if (input[k] === undefined || input[k] === null || input[k] === '') throw graphBad(`Property '${k}' is required.`);
  }
  await assertUpn(input.userPrincipalName);
  const pw = input.passwordProfile?.password;
  if (!passwordIsComplex(pw)) throw graphBad('The specified password does not comply with password complexity requirements. Please provide a different password.');
  const user: any = {
    ...USER_DEFAULTS,
    id: uuid(),
    createdDateTime: nowIso(),
    creationType: null,
    deletedDateTime: null,
    userType: 'Member',
    identities: [{ signInType: 'userPrincipalName', issuer: tenant().defaultDomain, issuerAssignedId: input.userPrincipalName }],
    lastPasswordChangeDateTime: nowIso(),
    signInActivity: null,
  };
  for (const [k, v] of Object.entries(input)) if (USER_WRITABLE.has(k) && k !== 'passwordProfile') user[k] = v;
  user.mail = user.mail ?? null;
  user._upn = String(user.userPrincipalName).toLowerCase();
  user._passwordHash = hashPassword(pw);
  user._forceChange = input.passwordProfile?.forceChangePasswordNextSignIn !== false;
  await store.put('user', user.id, user, tenant().id);
  return user;
}

export async function updateUser(user: any, patch: any, selfOnly: boolean): Promise<{ user: any; passwordReset: boolean }> {
  const allowed = selfOnly ? USER_SELF_WRITABLE : USER_WRITABLE;
  let passwordReset = false;
  for (const [k, v] of Object.entries(patch)) {
    if (k.startsWith('@odata')) continue;
    if (!allowed.has(k)) throw selfOnly ? new HttpError(403, 'Authorization_RequestDenied', 'Insufficient privileges to complete the operation.') : graphBad(`Property '${k}' is read-only and cannot be set.`);
    if (k === 'passwordProfile') {
      const pv = (v as any)?.password;
      if (pv !== undefined) {
        if (!passwordIsComplex(pv)) throw graphBad('The specified password does not comply with password complexity requirements. Please provide a different password.');
        user._passwordHash = hashPassword(pv);
        user.lastPasswordChangeDateTime = nowIso();
        passwordReset = true;
      }
      user._forceChange = (v as any)?.forceChangePasswordNextSignIn ?? user._forceChange;
      continue;
    }
    if (k === 'userPrincipalName') {
      await assertUpn(String(v), user.id);
      user._upn = String(v).toLowerCase();
    }
    user[k] = v;
  }
  await store.put('user', user.id, user, tenant().id);
  return { user, passwordReset };
}

export async function createGroup(input: any, ownerId?: string): Promise<any> {
  for (const k of ['displayName', 'mailEnabled', 'mailNickname', 'securityEnabled']) {
    if (input[k] === undefined) throw graphBad(`Property '${k}' is required.`);
  }
  const group: any = {
    id: uuid(),
    deletedDateTime: null,
    classification: null,
    createdDateTime: nowIso(),
    description: null,
    displayName: input.displayName,
    expirationDateTime: null,
    groupTypes: [],
    isAssignableToRole: null,
    mail: input.mailEnabled ? `${input.mailNickname}@${tenant().defaultDomain}` : null,
    mailEnabled: !!input.mailEnabled,
    mailNickname: input.mailNickname,
    membershipRule: null,
    membershipRuleProcessingState: null,
    onPremisesSyncEnabled: null,
    proxyAddresses: [],
    renewedDateTime: nowIso(),
    securityEnabled: !!input.securityEnabled,
    securityIdentifier: `S-1-12-1-${Math.floor(Math.random() * 4e9)}-${Math.floor(Math.random() * 4e9)}`,
    theme: null,
    visibility: input.visibility ?? null,
    _members: [],
    _owners: ownerId ? [ownerId] : [],
  };
  for (const k of ['description', 'groupTypes', 'isAssignableToRole', 'visibility', 'membershipRule', 'classification']) if (input[k] !== undefined) group[k] = input[k];
  const bind = (key: string) => (input[key] ?? []).map((u: string) => u.split('/').pop()!.replace(/[()']/g, ''));
  group._members = [...new Set([...bind('members@odata.bind')])];
  if (input['owners@odata.bind']) group._owners = [...new Set(bind('owners@odata.bind'))];
  await store.put('group', group.id, group, tenant().id);
  return group;
}

export const GROUP_WRITABLE = new Set(['displayName', 'description', 'mailNickname', 'visibility', 'groupTypes', 'membershipRule', 'membershipRuleProcessingState', 'classification', 'securityEnabled', 'mailEnabled']);

export async function audit(actor: Principal | null, a: {
  category: 'ApplicationManagement' | 'UserManagement' | 'GroupManagement' | 'RoleManagement' | 'Policy' | 'DirectoryManagement';
  activity: string;
  operationType: 'Add' | 'Update' | 'Delete' | 'Assign' | 'Unassign';
  target: { id: string; displayName?: string | null; type: string; userPrincipalName?: string | null };
  modified?: { displayName: string; oldValue?: unknown; newValue?: unknown }[];
  result?: 'success' | 'failure';
}): Promise<void> {
  const data = {
    id: `Directory_${uuid()}`,
    category: a.category,
    correlationId: uuid(),
    result: a.result ?? 'success',
    resultReason: '',
    activityDisplayName: a.activity,
    activityDateTime: nowIso(),
    loggedByService: 'Core Directory',
    operationType: a.operationType,
    initiatedBy: actor?.kind === 'app'
      ? { user: null, app: { appId: actor.appId, displayName: actor.name, servicePrincipalId: actor.oid, servicePrincipalName: null } }
      : { app: null, user: actor ? { id: actor.oid, displayName: actor.name, userPrincipalName: actor.upn ?? null, ipAddress: null, userType: 'Member', homeTenantId: actor.tid, homeTenantName: null } : null },
    targetResources: [{
      id: a.target.id,
      displayName: a.target.displayName ?? null,
      type: a.target.type,
      userPrincipalName: a.target.userPrincipalName ?? null,
      groupType: null,
      modifiedProperties: (a.modified ?? []).map((m) => ({ displayName: m.displayName, oldValue: m.oldValue === undefined ? null : JSON.stringify(m.oldValue), newValue: m.newValue === undefined ? null : JSON.stringify(m.newValue) })),
    }],
    additionalDetails: [],
  };
  await recordEvent('audit', data, { actorId: actor?.oid ?? null, resourceId: a.target.id });
}
