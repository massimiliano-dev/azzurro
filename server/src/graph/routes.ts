import type { Hono } from 'hono';
import * as store from '../db/store.ts';
import { HttpError } from '../errors.ts';
import { originOf, readJson } from '../http.ts';
import { authenticate } from '../auth/middleware.ts';
import {
  appByAppId, directoryRolesOf, getDirectoryObject, groupsOf, ODATA_TYPE, roleTemplate, setTenant, spByAppId, tenant, userByUpn, type DirType,
} from '../directory.ts';
import { DIRECTORY_ROLES, GLOBAL_ADMIN } from '../firstParty.ts';
import { nowIso, randomToken, uuid, verifyPassword, hashPassword, passwordIsComplex } from '../ids.ts';
import { applyFilter, applyOrderBy, applySelect } from '../odata.ts';
import { queryEvents } from '../events.ts';
import { notifyLater } from '../push.ts';
import { deleteUserSessions } from '../auth/session.ts';
import type { AppEnv, Ctx } from '../types.ts';
import { assertCreate, assertRead, assertWrite, caller, canWrite, denied, type Caller, type Kind } from './authz.ts';
import {
  addPassword, audit, createApplication, createGroup, createServicePrincipal, createUser, deleteServicePrincipal, graphBad, graphNotFound,
  GROUP_WRITABLE, publicView, removeFromAllGroups, removePassword, syncServicePrincipal, updateApplication, updateUser,
} from './objects.ts';

interface Req {
  c: Ctx;
  p: Record<string, string>;
  gc: Caller;
  ver: string;
  base: string;
  q: Record<string, string>;
  body: () => Promise<any>;
}

type Handler = (r: Req) => Promise<Response>;
const routes: { method: string; pattern: string[]; h: Handler }[] = [];
function route(method: string, pattern: string, h: Handler) {
  routes.push({ method, pattern: pattern.split('/').filter(Boolean), h });
}

// ---------- shaping ----------

const USER_DEFAULT_SELECT = ['businessPhones', 'displayName', 'givenName', 'jobTitle', 'mail', 'mobilePhone', 'officeLocation', 'preferredLanguage', 'surname', 'userPrincipalName', 'id'];

function shape(type: DirType | 'directoryRole', o: any, r?: Req, withType = false): any {
  const v = publicView(o);
  if (type === 'user' && r && r.ver === 'v1.0' && !r.q.$select) {
    const out: any = {};
    for (const k of USER_DEFAULT_SELECT) out[k] = v[k] ?? (k === 'businessPhones' ? [] : null);
    return withType ? { '@odata.type': ODATA_TYPE.user, ...out } : out;
  }
  if (type === 'group') v.members = undefined;
  if (withType) return { '@odata.type': type === 'directoryRole' ? '#microsoft.graph.directoryRole' : ODATA_TYPE[type], ...v };
  return v;
}

function dirRoleObject(id: string) {
  const t = roleTemplate(id)!;
  return { id: t.id, deletedDateTime: null, description: t.description, displayName: t.displayName, roleTemplateId: t.id };
}

function ctxUrl(r: Req, set: string) {
  return `${r.base}/${r.ver}/$metadata#${set}`;
}

function entity(r: Req, set: string, obj: any, status = 200) {
  const selected = applySelect(obj, r.q.$select);
  return r.c.json({ '@odata.context': `${ctxUrl(r, set)}/$entity`, ...selected }, status as any);
}

async function expandItems(r: Req, items: any[]): Promise<any[]> {
  const expand = (r.q.$expand ?? '').split(',').map((s) => s.trim().split('(')[0].toLowerCase()).filter(Boolean);
  if (!expand.length) return items;
  const brief = async (ids: string[]) => {
    const out = [];
    for (const id of ids) {
      const o = await getDirectoryObject(id);
      if (o) out.push({ '@odata.type': ODATA_TYPE[o.type], id: o.obj.id, displayName: o.obj.displayName, userPrincipalName: o.obj.userPrincipalName, appId: o.obj.appId, mail: o.obj.mail });
    }
    return out;
  };
  return Promise.all(items.map(async (it) => {
    const raw = it.__raw ?? it;
    const out = { ...it };
    delete out.__raw;
    if (expand.includes('owners')) out.owners = await brief(raw._owners ?? []);
    if (expand.includes('members')) out.members = await brief(raw._members ?? []);
    if (expand.includes('memberof')) out.memberOf = (await Promise.all((await store.list('group', { match: { _members: [raw.id] } })).map((g) => ({ '@odata.type': ODATA_TYPE.group, id: g.id, displayName: g.displayName }))));
    if (expand.includes('principal')) {
      const o = await getDirectoryObject(raw.principalId);
      out.principal = o ? { '@odata.type': ODATA_TYPE[o.type], id: o.obj.id, displayName: o.obj.displayName, userPrincipalName: o.obj.userPrincipalName } : null;
    }
    if (expand.includes('roledefinition')) out.roleDefinition = roleDefinitionObject(raw.roleDefinitionId);
    return out;
  }));
}

/** Risposta di collezione con $filter, $search, $orderby, $top, $skiptoken, $count, $select, $expand. */
async function collection(r: Req, set: string, raw: any[], toPublic: (o: any) => any): Promise<Response> {
  let items = raw.map((o) => ({ ...toPublic(o), __raw: o }));
  const filterSrc = r.q.$filter;
  if (filterSrc) items = applyFilter(items, filterSrc);
  const search = r.q.$search?.replace(/^"|"$/g, '');
  if (search) {
    const clauses = search.split(/\s+OR\s+/i).map((s) => s.replace(/^"|"$/g, '').split(':'));
    items = items.filter((it) => clauses.some(([prop, val]) => val === undefined
      ? JSON.stringify(it).toLowerCase().includes(prop.toLowerCase())
      : String(it[prop] ?? '').toLowerCase().includes(val.toLowerCase())));
  }
  items = applyOrderBy(items, r.q.$orderby);
  const total = items.length;
  const top = Math.min(Math.max(Number(r.q.$top ?? 100) || 100, 1), 999);
  const skip = Number(r.q.$skiptoken ?? 0) || 0;
  const page = await expandItems(r, items.slice(skip, skip + top));
  const out: any = { '@odata.context': ctxUrl(r, set) };
  if (r.q.$count === 'true') out['@odata.count'] = total;
  out.value = page.map((it) => applySelect(it, r.q.$select));
  if (skip + top < total) {
    const u = new URL(r.c.req.url);
    u.searchParams.set('$skiptoken', String(skip + top));
    out['@odata.nextLink'] = `${r.base}${u.pathname}${u.search}`;
  }
  return r.c.json(out);
}

function countResponse(r: Req, n: number) {
  return r.c.text(String(n), 200, { 'Content-Type': 'text/plain' });
}

const noContent = (r: Req) => r.c.body(null, 204);

// ---------- resolvers ----------

function altKey(id: string): [string, string] | null {
  const m = /^(\w+)=(.*)$/.exec(id);
  return m ? [m[1], m[2]] : null;
}

async function getApp(id: string): Promise<any> {
  const k = altKey(id);
  const app = k ? (k[0] === 'appId' ? await appByAppId(k[1]) : (await store.list('application', { match: { [k[0]]: k[1] }, limit: 1 }))[0]) : await store.get('application', id);
  if (!app) throw graphNotFound(k ? k[1] : id);
  return app;
}

async function getSp(id: string): Promise<any> {
  const k = altKey(id);
  const sp = k ? await spByAppId(k[1]) : await store.get('servicePrincipal', id);
  if (!sp) throw graphNotFound(k ? k[1] : id);
  return sp;
}

async function getUser(id: string, r?: Req): Promise<any> {
  if (id === 'me' && r) id = r.gc.p.oid;
  const u = id.includes('@') ? await userByUpn(id) : await store.get('user', id);
  if (!u) throw graphNotFound(id);
  return u;
}

async function getGroup(id: string): Promise<any> {
  const g = await store.get('group', id);
  if (!g) throw graphNotFound(id);
  return g;
}

function getDirRole(id: string): string {
  const k = altKey(id);
  const rid = k ? k[1] : id;
  if (!roleTemplate(rid)) throw graphNotFound(rid);
  return rid;
}

function refId(body: any): string {
  const ref = body?.['@odata.id'];
  if (!ref || typeof ref !== 'string') throw graphBad("The request body must contain '@odata.id'.");
  const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:'?\)?)?$/i.exec(ref);
  if (!m) throw graphBad(`Invalid object identifier '${ref}'.`);
  return m[1];
}

async function briefObjects(r: Req, ids: string[]): Promise<any[]> {
  const out = [];
  for (const id of ids) {
    const o = await getDirectoryObject(id);
    if (o) out.push(shape(o.type, o.obj, r, true));
    else if (roleTemplate(id)) out.push({ '@odata.type': '#microsoft.graph.directoryRole', ...dirRoleObject(id) });
  }
  return out;
}

async function memberOf(id: string, transitive: boolean): Promise<string[]> {
  const groups = transitive ? await groupsOf(id) : (await store.list('group', { match: { _members: [id] } })).map((g) => g.id);
  const roles = transitive ? await directoryRolesOf(id, groups) : (await store.list('dirRoleAssignment', { match: { principalId: id } })).map((a) => a.roleDefinitionId);
  return [...groups, ...new Set(roles)];
}

// ---------- applications ----------

route('GET', 'applications', async (r) => {
  assertRead(r.gc, 'application');
  return collection(r, 'applications', await store.list('application'), (o) => publicView(o));
});
route('GET', 'applications/$count', async (r) => countResponse(r, await store.count('application')));
route('POST', 'applications', async (r) => {
  assertCreate(r.gc, 'application');
  const body = await r.body();
  const app = await createApplication(body, r.gc.p.kind === 'user' || r.gc.p.roles.includes('Application.ReadWrite.OwnedBy') ? r.gc.p.oid : undefined);
  await audit(r.gc.p, { category: 'ApplicationManagement', activity: 'Add application', operationType: 'Add', target: { id: app.id, displayName: app.displayName, type: 'Application' } });
  notifyLater(app._owners, { category: 'apps', key: 'appCreated', params: { actor: r.gc.p.name, app: app.displayName }, url: `/entra/apps/${app.id}`, actorId: r.gc.p.oid });
  return entity(r, 'applications', publicView(app), 201);
});
route('GET', 'applications/:id', async (r) => {
  assertRead(r.gc, 'application');
  const app = await getApp(r.p.id);
  const [it] = await expandItems(r, [{ ...publicView(app), __raw: app }]);
  return entity(r, 'applications', it);
});
route('PATCH', 'applications/:id', async (r) => {
  const app = await getApp(r.p.id);
  assertWrite(r.gc, 'application', app);
  const body = await r.body();
  await updateApplication(app, body);
  await audit(r.gc.p, { category: 'ApplicationManagement', activity: 'Update application', operationType: 'Update', target: { id: app.id, displayName: app.displayName, type: 'Application' }, modified: Object.keys(body).map((k) => ({ displayName: k, newValue: body[k] })) });
  return noContent(r);
});
route('DELETE', 'applications/:id', async (r) => {
  const app = await getApp(r.p.id);
  assertWrite(r.gc, 'application', app);
  await store.remove('application', app.id);
  const sp = await spByAppId(app.appId);
  if (sp) await deleteServicePrincipal(sp.id);
  await store.put('deletedItem', app.id, { ...app, '@odata.type': ODATA_TYPE.application, deletedDateTime: nowIso() }, tenant().id);
  await audit(r.gc.p, { category: 'ApplicationManagement', activity: 'Delete application', operationType: 'Delete', target: { id: app.id, displayName: app.displayName, type: 'Application' } });
  return noContent(r);
});
route('POST', 'applications/:id/addPassword', async (r) => {
  const app = await getApp(r.p.id);
  assertWrite(r.gc, 'application', app);
  const body = await r.body();
  const { credential, secretText } = addPassword(app, body.passwordCredential ?? body);
  await store.put('application', app.id, app, tenant().id);
  await audit(r.gc.p, { category: 'ApplicationManagement', activity: 'Update application – Certificates and secrets management ', operationType: 'Update', target: { id: app.id, displayName: app.displayName, type: 'Application' }, modified: [{ displayName: 'KeyDescription', newValue: [`[KeyIdentifier=${credential.keyId},KeyType=Password,KeyUsage=Verify,DisplayName=${credential.displayName ?? ''}]`] }] });
  notifyLater(app._owners ?? [], { category: 'apps', key: 'secretCreated', params: { actor: r.gc.p.name, name: credential.displayName ?? credential.hint + '…', app: app.displayName, date: credential.endDateTime.slice(0, 10) }, url: `/entra/apps/${app.id}?tab=credentials`, actorId: r.gc.p.oid });
  return r.c.json({ '@odata.context': `${ctxUrl(r, 'microsoft.graph.passwordCredential')}`, ...credential, secretText });
});
route('POST', 'applications/:id/removePassword', async (r) => {
  const app = await getApp(r.p.id);
  assertWrite(r.gc, 'application', app);
  const { keyId } = await r.body();
  removePassword(app, keyId);
  await store.put('application', app.id, app, tenant().id);
  await audit(r.gc.p, { category: 'ApplicationManagement', activity: 'Update application – Certificates and secrets management ', operationType: 'Update', target: { id: app.id, displayName: app.displayName, type: 'Application' }, modified: [{ displayName: 'KeyDescription', oldValue: [`[KeyIdentifier=${keyId},KeyType=Password]`], newValue: [] }] });
  return noContent(r);
});
route('POST', 'applications/:id/removeKey', async (r) => {
  const app = await getApp(r.p.id);
  assertWrite(r.gc, 'application', app);
  const { keyId } = await r.body();
  app.keyCredentials = (app.keyCredentials ?? []).filter((k: any) => k.keyId !== keyId);
  app._certs = (app._certs ?? []).filter((k: any) => k.keyId !== keyId);
  await store.put('application', app.id, app, tenant().id);
  return noContent(r);
});
for (const kind of ['applications', 'servicePrincipals', 'groups'] as const) {
  const kindKey: Kind = kind === 'applications' ? 'application' : kind === 'servicePrincipals' ? 'servicePrincipal' : 'group';
  const coll = kind === 'applications' ? 'application' : kind === 'servicePrincipals' ? 'servicePrincipal' : 'group';
  const load = (id: string) => (kind === 'applications' ? getApp(id) : kind === 'servicePrincipals' ? getSp(id) : getGroup(id));
  route('GET', `${kind}/:id/owners`, async (r) => {
    assertRead(r.gc, kindKey);
    const o = await load(r.p.id);
    return collection(r, 'directoryObjects', await briefObjects(r, o._owners ?? []), (x) => x);
  });
  route('POST', `${kind}/:id/owners/$ref`, async (r) => {
    const o = await load(r.p.id);
    assertWrite(r.gc, kindKey, o);
    const id = refId(await r.body());
    const target = await getDirectoryObject(id);
    if (!target || (target.type !== 'user' && target.type !== 'servicePrincipal')) throw graphNotFound(id);
    if ((o._owners ?? []).includes(id)) throw graphBad('One or more added object references already exist for the following modified properties: \'owners\'.');
    o._owners = [...(o._owners ?? []), id];
    await store.put(coll, o.id, o, tenant().id);
    await audit(r.gc.p, { category: kind === 'groups' ? 'GroupManagement' : 'ApplicationManagement', activity: `Add owner to ${kind === 'applications' ? 'application' : kind === 'groups' ? 'group' : 'service principal'}`, operationType: 'Update', target: { id: o.id, displayName: o.displayName, type: kindKey } });
    return noContent(r);
  });
  route('DELETE', `${kind}/:id/owners/:owner/$ref`, async (r) => {
    const o = await load(r.p.id);
    assertWrite(r.gc, kindKey, o);
    if (!(o._owners ?? []).includes(r.p.owner)) throw graphNotFound(r.p.owner);
    o._owners = o._owners.filter((x: string) => x !== r.p.owner);
    await store.put(coll, o.id, o, tenant().id);
    return noContent(r);
  });
}

// federated identity credentials
route('GET', 'applications/:id/federatedIdentityCredentials', async (r) => {
  assertRead(r.gc, 'application');
  const app = await getApp(r.p.id);
  return collection(r, `applications('${app.id}')/federatedIdentityCredentials`, app._fics ?? [], (f) => f);
});
route('POST', 'applications/:id/federatedIdentityCredentials', async (r) => {
  const app = await getApp(r.p.id);
  assertWrite(r.gc, 'application', app);
  const b = await r.body();
  for (const k of ['name', 'issuer', 'subject', 'audiences']) if (!b[k]) throw graphBad(`Property '${k}' is required.`);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,119}$/.test(b.name)) throw graphBad("Property 'name' must be 3-120 alphanumeric characters, dashes or underscores.");
  if ((app._fics ?? []).some((f: any) => f.name.toLowerCase() === String(b.name).toLowerCase())) throw new HttpError(409, 'Request_MultipleObjectsWithSameKeyValue', 'FederatedIdentityCredential with name ' + b.name + ' already exists.');
  if ((app._fics ?? []).length >= 20) throw graphBad('An application can have at most 20 federated identity credentials.');
  const fic = { id: uuid(), name: b.name, issuer: b.issuer, subject: b.subject, audiences: b.audiences, description: b.description ?? null };
  app._fics = [...(app._fics ?? []), fic];
  await store.put('application', app.id, app, tenant().id);
  return entity(r, `applications('${app.id}')/federatedIdentityCredentials`, fic, 201);
});
route('GET', 'applications/:id/federatedIdentityCredentials/:fic', async (r) => {
  const app = await getApp(r.p.id);
  const fic = (app._fics ?? []).find((f: any) => f.id === r.p.fic || f.name === r.p.fic);
  if (!fic) throw graphNotFound(r.p.fic);
  return entity(r, `applications('${app.id}')/federatedIdentityCredentials`, fic);
});
route('PATCH', 'applications/:id/federatedIdentityCredentials/:fic', async (r) => {
  const app = await getApp(r.p.id);
  assertWrite(r.gc, 'application', app);
  const fic = (app._fics ?? []).find((f: any) => f.id === r.p.fic || f.name === r.p.fic);
  if (!fic) throw graphNotFound(r.p.fic);
  const b = await r.body();
  for (const k of ['issuer', 'subject', 'audiences', 'description']) if (b[k] !== undefined) fic[k] = b[k];
  await store.put('application', app.id, app, tenant().id);
  return noContent(r);
});
route('DELETE', 'applications/:id/federatedIdentityCredentials/:fic', async (r) => {
  const app = await getApp(r.p.id);
  assertWrite(r.gc, 'application', app);
  const before = (app._fics ?? []).length;
  app._fics = (app._fics ?? []).filter((f: any) => f.id !== r.p.fic && f.name !== r.p.fic);
  if (app._fics.length === before) throw graphNotFound(r.p.fic);
  await store.put('application', app.id, app, tenant().id);
  return noContent(r);
});

// ---------- service principals ----------

route('GET', 'servicePrincipals', async (r) => {
  assertRead(r.gc, 'servicePrincipal');
  return collection(r, 'servicePrincipals', await store.list('servicePrincipal'), (o) => publicView(o));
});
route('GET', 'servicePrincipals/$count', async (r) => countResponse(r, await store.count('servicePrincipal')));
route('POST', 'servicePrincipals', async (r) => {
  assertCreate(r.gc, 'servicePrincipal');
  const body = await r.body();
  const app = await appByAppId(body.appId);
  if (app && r.gc.p.kind === 'user' && !canWrite(r.gc, 'application', app) && !r.gc.isGlobalAdmin) throw denied();
  const sp = await createServicePrincipal(body);
  if (app && r.gc.p.kind === 'user') {
    sp._owners = [r.gc.p.oid];
    await store.put('servicePrincipal', sp.id, sp, tenant().id);
  }
  await audit(r.gc.p, { category: 'ApplicationManagement', activity: 'Add service principal', operationType: 'Add', target: { id: sp.id, displayName: sp.displayName, type: 'ServicePrincipal' } });
  return entity(r, 'servicePrincipals', publicView(sp), 201);
});
route('GET', 'servicePrincipals/:id', async (r) => {
  assertRead(r.gc, 'servicePrincipal');
  const sp = await getSp(r.p.id);
  const [it] = await expandItems(r, [{ ...publicView(sp), __raw: sp }]);
  return entity(r, 'servicePrincipals', it);
});
route('PATCH', 'servicePrincipals/:id', async (r) => {
  const sp = await getSp(r.p.id);
  assertWrite(r.gc, 'servicePrincipal', sp);
  const body = await r.body();
  const allowed = ['accountEnabled', 'appRoleAssignmentRequired', 'tags', 'notes', 'description', 'displayName', 'notificationEmailAddresses', 'preferredSingleSignOnMode', 'loginUrl', 'logoutUrl', 'homepage', 'replyUrls', 'servicePrincipalNames', 'alternativeNames', 'appRoles', 'oauth2PermissionScopes'];
  for (const [k, v] of Object.entries(body)) {
    if (k.startsWith('@odata')) continue;
    if (!allowed.includes(k)) throw graphBad(`Property '${k}' is read-only and cannot be set.`);
    sp[k] = v;
  }
  await store.put('servicePrincipal', sp.id, sp, tenant().id);
  await audit(r.gc.p, { category: 'ApplicationManagement', activity: 'Update service principal', operationType: 'Update', target: { id: sp.id, displayName: sp.displayName, type: 'ServicePrincipal' }, modified: Object.keys(body).map((k) => ({ displayName: k, newValue: body[k] })) });
  return noContent(r);
});
route('DELETE', 'servicePrincipals/:id', async (r) => {
  const sp = await getSp(r.p.id);
  assertWrite(r.gc, 'servicePrincipal', sp);
  if (sp.servicePrincipalType === 'ManagedIdentity') throw graphBad('Managed identity service principals are managed by Azure Resource Manager and cannot be deleted directly.');
  await deleteServicePrincipal(sp.id);
  await audit(r.gc.p, { category: 'ApplicationManagement', activity: 'Remove service principal', operationType: 'Delete', target: { id: sp.id, displayName: sp.displayName, type: 'ServicePrincipal' } });
  return noContent(r);
});
route('POST', 'servicePrincipals/:id/addPassword', async (r) => {
  const sp = await getSp(r.p.id);
  assertWrite(r.gc, 'servicePrincipal', sp);
  const body = await r.body();
  const { credential, secretText } = addPassword(sp, body.passwordCredential ?? body);
  await store.put('servicePrincipal', sp.id, sp, tenant().id);
  return r.c.json({ '@odata.context': ctxUrl(r, 'microsoft.graph.passwordCredential'), ...credential, secretText });
});
route('POST', 'servicePrincipals/:id/removePassword', async (r) => {
  const sp = await getSp(r.p.id);
  assertWrite(r.gc, 'servicePrincipal', sp);
  removePassword(sp, (await r.body()).keyId);
  await store.put('servicePrincipal', sp.id, sp, tenant().id);
  return noContent(r);
});

// ---------- app role assignments ----------

function assignmentObject(a: any) {
  return { id: a.id, deletedDateTime: null, appRoleId: a.appRoleId, createdDateTime: a.createdDateTime, principalDisplayName: a.principalDisplayName, principalId: a.principalId, principalType: a.principalType, resourceDisplayName: a.resourceDisplayName, resourceId: a.resourceId };
}

async function createAssignment(r: Req, body: any, fixed: { principalId?: string; resourceId?: string }) {
  const principalId = fixed.principalId ?? body.principalId;
  const resourceId = fixed.resourceId ?? body.resourceId;
  if (fixed.principalId && body.principalId && body.principalId !== fixed.principalId) throw graphBad('principalId in the body must match the principal in the URL.');
  if (!principalId || !resourceId || !body.appRoleId) throw graphBad("Properties 'principalId', 'resourceId' and 'appRoleId' are required.");
  const resource = await getSp(resourceId);
  const principal = await getDirectoryObject(principalId);
  if (!principal || principal.type === 'application') throw graphNotFound(principalId);
  const ptype = principal.type === 'user' ? 'User' : principal.type === 'group' ? 'Group' : 'ServicePrincipal';
  if (!(r.gc.isGlobalAdmin || canWrite(r.gc, 'grants') || (ptype !== 'ServicePrincipal' && (resource._owners ?? []).includes(r.gc.p.oid)))) throw denied();
  const defaultRole = body.appRoleId === '00000000-0000-0000-0000-000000000000';
  const role = (resource.appRoles ?? []).find((x: any) => x.id === body.appRoleId);
  if (!defaultRole && !role) throw graphBad(`Permission (scope or role) cannot be assigned to the resource: the appRoleId '${body.appRoleId}' does not exist on '${resource.displayName}'.`);
  if (role) {
    const need = ptype === 'ServicePrincipal' ? 'Application' : 'User';
    if (!(role.allowedMemberTypes ?? []).includes(need)) throw graphBad(`The app role '${role.value}' cannot be assigned to a principal of type ${ptype}.`);
  }
  const dup = (await store.list('appRoleAssignment', { match: { principalId, resourceId: resource.id, appRoleId: body.appRoleId } }))[0];
  if (dup) throw graphBad('Permission being assigned already exists on the object');
  const a = {
    id: randomToken(32).slice(0, 43),
    appRoleId: body.appRoleId,
    createdDateTime: nowIso(),
    principalDisplayName: principal.obj.displayName,
    principalId,
    principalType: ptype,
    resourceDisplayName: resource.displayName,
    resourceId: resource.id,
  };
  await store.put('appRoleAssignment', a.id, a, tenant().id);
  await audit(r.gc.p, { category: 'ApplicationManagement', activity: ptype === 'ServicePrincipal' ? 'Add app role assignment to service principal' : 'Add app role assignment grant to user', operationType: 'Assign', target: { id: resource.id, displayName: resource.displayName, type: 'ServicePrincipal' }, modified: [{ displayName: 'AppRole.Value', newValue: role?.value ?? 'default' }, { displayName: 'Principal', newValue: principal.obj.displayName }] });
  return entity(r, 'appRoleAssignments', assignmentObject(a), 201);
}

async function deleteAssignment(r: Req, id: string, check: (a: any) => boolean) {
  const a = await store.get('appRoleAssignment', id);
  if (!a || !check(a)) throw graphNotFound(id);
  const resource = await store.get('servicePrincipal', a.resourceId);
  if (!(r.gc.isGlobalAdmin || canWrite(r.gc, 'grants') || (resource?._owners ?? []).includes(r.gc.p.oid))) throw denied();
  await store.remove('appRoleAssignment', id);
  await audit(r.gc.p, { category: 'ApplicationManagement', activity: 'Remove app role assignment', operationType: 'Unassign', target: { id: a.resourceId, displayName: a.resourceDisplayName, type: 'ServicePrincipal' } });
  return noContent(r);
}

route('GET', 'servicePrincipals/:id/appRoleAssignedTo', async (r) => {
  assertRead(r.gc, 'grants');
  const sp = await getSp(r.p.id);
  return collection(r, 'appRoleAssignments', await store.list('appRoleAssignment', { match: { resourceId: sp.id } }), assignmentObject);
});
route('POST', 'servicePrincipals/:id/appRoleAssignedTo', async (r) => createAssignment(r, await r.body(), { resourceId: (await getSp(r.p.id)).id }));
route('DELETE', 'servicePrincipals/:id/appRoleAssignedTo/:aid', async (r) => {
  const sp = await getSp(r.p.id);
  return deleteAssignment(r, r.p.aid, (a) => a.resourceId === sp.id);
});
for (const [seg, loader] of [['servicePrincipals', getSp], ['users', (id: string) => getUser(id)], ['groups', getGroup]] as const) {
  route('GET', `${seg}/:id/appRoleAssignments`, async (r) => {
    assertRead(r.gc, 'grants');
    const o = await (loader as any)(r.p.id === 'me' ? r.gc.p.oid : r.p.id);
    return collection(r, 'appRoleAssignments', await store.list('appRoleAssignment', { match: { principalId: o.id } }), assignmentObject);
  });
  route('POST', `${seg}/:id/appRoleAssignments`, async (r) => {
    const o = await (loader as any)(r.p.id);
    return createAssignment(r, await r.body(), { principalId: o.id });
  });
  route('DELETE', `${seg}/:id/appRoleAssignments/:aid`, async (r) => {
    const o = await (loader as any)(r.p.id);
    return deleteAssignment(r, r.p.aid, (a) => a.principalId === o.id);
  });
}
route('GET', 'me/appRoleAssignments', async (r) => collection(r, 'appRoleAssignments', await store.list('appRoleAssignment', { match: { principalId: r.gc.p.oid } }), assignmentObject));

// ---------- oauth2PermissionGrants ----------

route('GET', 'oauth2PermissionGrants', async (r) => {
  assertRead(r.gc, 'grants');
  return collection(r, 'oauth2PermissionGrants', await store.list('oauth2PermissionGrant'), (g) => ({ ...g }));
});
route('GET', 'servicePrincipals/:id/oauth2PermissionGrants', async (r) => {
  assertRead(r.gc, 'grants');
  const sp = await getSp(r.p.id);
  return collection(r, 'oauth2PermissionGrants', await store.list('oauth2PermissionGrant', { match: { clientId: sp.id } }), (g) => ({ ...g }));
});
route('POST', 'oauth2PermissionGrants', async (r) => {
  const b = await r.body();
  if (!b.clientId || !b.resourceId || !b.consentType) throw graphBad("Properties 'clientId', 'resourceId' and 'consentType' are required.");
  if (!['AllPrincipals', 'Principal'].includes(b.consentType)) throw graphBad("consentType must be 'AllPrincipals' or 'Principal'.");
  if (b.consentType === 'Principal' && !b.principalId) throw graphBad("principalId is required when consentType is 'Principal'.");
  const client = await getSp(b.clientId);
  const resource = await getSp(b.resourceId);
  const selfConsent = b.consentType === 'Principal' && b.principalId === r.gc.p.oid;
  if (!selfConsent && !(r.gc.isGlobalAdmin || canWrite(r.gc, 'grants'))) throw denied();
  const scopes = String(b.scope ?? '').split(' ').filter(Boolean);
  for (const s of scopes) {
    if (!(resource.oauth2PermissionScopes ?? []).some((x: any) => x.value === s)) throw graphBad(`Scope '${s}' does not exist on resource '${resource.displayName}'.`);
  }
  const dup = (await store.list('oauth2PermissionGrant', { match: { clientId: client.id, resourceId: resource.id, consentType: b.consentType } }))
    .find((g) => b.consentType === 'AllPrincipals' || g.principalId === b.principalId);
  if (dup) throw new HttpError(409, 'Request_MultipleObjectsWithSameKeyValue', 'Permission entry already exists.');
  const g = { id: randomToken(32).slice(0, 43), clientId: client.id, consentType: b.consentType, principalId: b.consentType === 'Principal' ? b.principalId : null, resourceId: resource.id, scope: scopes.join(' ') };
  await store.put('oauth2PermissionGrant', g.id, g, tenant().id);
  await audit(r.gc.p, { category: 'ApplicationManagement', activity: 'Add delegated permission grant', operationType: 'Add', target: { id: client.id, displayName: client.displayName, type: 'ServicePrincipal' }, modified: [{ displayName: 'DelegatedPermissionGrant.Scope', newValue: g.scope }] });
  return entity(r, 'oauth2PermissionGrants', g, 201);
});
route('GET', 'oauth2PermissionGrants/:id', async (r) => {
  const g = await store.get('oauth2PermissionGrant', r.p.id);
  if (!g) throw graphNotFound(r.p.id);
  return entity(r, 'oauth2PermissionGrants', g);
});
route('PATCH', 'oauth2PermissionGrants/:id', async (r) => {
  const g = await store.get('oauth2PermissionGrant', r.p.id);
  if (!g) throw graphNotFound(r.p.id);
  if (!(r.gc.isGlobalAdmin || canWrite(r.gc, 'grants'))) throw denied();
  const b = await r.body();
  if (b.scope !== undefined) g.scope = String(b.scope).split(' ').filter(Boolean).join(' ');
  await store.put('oauth2PermissionGrant', g.id, g, tenant().id);
  return noContent(r);
});
route('DELETE', 'oauth2PermissionGrants/:id', async (r) => {
  const g = await store.get('oauth2PermissionGrant', r.p.id);
  if (!g) throw graphNotFound(r.p.id);
  if (!(r.gc.isGlobalAdmin || canWrite(r.gc, 'grants') || g.principalId === r.gc.p.oid)) throw denied();
  await store.remove('oauth2PermissionGrant', g.id);
  return noContent(r);
});

// ---------- users ----------

const userPublic = (r: Req) => (u: any) => shape('user', u, r);

route('GET', 'users', async (r) => {
  assertRead(r.gc, 'user');
  return collection(r, 'users', await store.list('user'), userPublic(r));
});
route('GET', 'users/$count', async (r) => countResponse(r, await store.count('user')));
route('POST', 'users', async (r) => {
  assertCreate(r.gc, 'user');
  const u = await createUser(await r.body());
  await audit(r.gc.p, { category: 'UserManagement', activity: 'Add user', operationType: 'Add', target: { id: u.id, displayName: u.displayName, type: 'User', userPrincipalName: u.userPrincipalName } });
  return entity(r, 'users', shape('user', u, { ...r, q: { ...r.q, $select: 'x' } } as Req), 201);
});
for (const base of ['users/:id', 'me']) {
  const idOf = (r: Req) => r.p.id ?? r.gc.p.oid;
  route('GET', base, async (r) => {
    if (base === 'me' && r.gc.p.kind === 'app') throw graphBad('/me request is only valid with delegated authentication flow.', 'BadRequest');
    const u = await getUser(idOf(r), r);
    if (u.id !== r.gc.p.oid) assertRead(r.gc, 'user');
    const [it] = await expandItems(r, [{ ...shape('user', u, r), __raw: u }]);
    return entity(r, 'users', it);
  });
  route('PATCH', base, async (r) => {
    const u = await getUser(idOf(r), r);
    const isSelf = u.id === r.gc.p.oid;
    const privileged = canWrite(r.gc, 'user');
    if (!privileged && !isSelf) throw denied();
    const targetRoles = await directoryRolesOf(u.id);
    if (!r.gc.isGlobalAdmin && targetRoles.includes(GLOBAL_ADMIN) && !isSelf) throw denied();
    const body = await r.body();
    const { passwordReset } = await updateUser(u, body, !privileged);
    await audit(r.gc.p, { category: 'UserManagement', activity: passwordReset ? 'Reset user password' : 'Update user', operationType: 'Update', target: { id: u.id, displayName: u.displayName, type: 'User', userPrincipalName: u.userPrincipalName }, modified: Object.keys(body).filter((k) => k !== 'passwordProfile').map((k) => ({ displayName: k, newValue: body[k] })) });
    if (passwordReset && !isSelf) notifyLater([u.id], { category: 'security', key: 'passwordReset', params: { actor: r.gc.p.name }, url: '/settings' });
    if (body.accountEnabled === false) await deleteUserSessions(u.id);
    return noContent(r);
  });
  route('GET', `${base}/memberOf`, async (r) => collection(r, 'directoryObjects', await briefObjects(r, await memberOf((await getUser(idOf(r), r)).id, false)), (x) => x));
  route('GET', `${base}/transitiveMemberOf`, async (r) => collection(r, 'directoryObjects', await briefObjects(r, await memberOf((await getUser(idOf(r), r)).id, true)), (x) => x));
  route('GET', `${base}/ownedObjects`, async (r) => {
    const u = await getUser(idOf(r), r);
    const ids: string[] = [];
    for (const coll of ['application', 'servicePrincipal', 'group']) ids.push(...(await store.list(coll, { match: { _owners: [u.id] } })).map((o) => o.id));
    return collection(r, 'directoryObjects', await briefObjects(r, ids), (x) => x);
  });
  route('POST', `${base}/revokeSignInSessions`, async (r) => {
    const u = await getUser(idOf(r), r);
    if (u.id !== r.gc.p.oid) assertWrite(r.gc, 'user', u);
    u._tokensRevokedAt = nowIso();
    await store.put('user', u.id, u, tenant().id);
    await deleteUserSessions(u.id);
    return r.c.json({ '@odata.context': ctxUrl(r, 'Edm.Boolean'), value: true });
  });
}
route('DELETE', 'users/:id', async (r) => {
  const u = await getUser(r.p.id, r);
  assertWrite(r.gc, 'user', u);
  if (u.id === r.gc.p.oid) throw graphBad('You cannot delete your own account.');
  if (!r.gc.isGlobalAdmin && (await directoryRolesOf(u.id)).includes(GLOBAL_ADMIN)) throw denied();
  const groups = await removeFromAllGroups(u.id);
  await store.remove('user', u.id);
  await store.put('deletedItem', u.id, { ...u, '@odata.type': ODATA_TYPE.user, deletedDateTime: nowIso(), _memberOf: groups }, tenant().id);
  await deleteUserSessions(u.id);
  await audit(r.gc.p, { category: 'UserManagement', activity: 'Delete user', operationType: 'Delete', target: { id: u.id, displayName: u.displayName, type: 'User', userPrincipalName: u.userPrincipalName } });
  return noContent(r);
});
route('POST', 'me/changePassword', async (r) => {
  const u = await getUser(r.gc.p.oid);
  const b = await r.body();
  if (!verifyPassword(b.currentPassword ?? '', u._passwordHash)) throw graphBad('The current password is incorrect.', 'Authorization_RequestDenied');
  if (!passwordIsComplex(b.newPassword)) throw graphBad('The specified password does not comply with password complexity requirements. Please provide a different password.');
  u._passwordHash = hashPassword(b.newPassword);
  u._forceChange = false;
  u.lastPasswordChangeDateTime = nowIso();
  await store.put('user', u.id, u, tenant().id);
  await audit(r.gc.p, { category: 'UserManagement', activity: 'Change user password', operationType: 'Update', target: { id: u.id, displayName: u.displayName, type: 'User', userPrincipalName: u.userPrincipalName } });
  return noContent(r);
});

// membership checks (users, groups, servicePrincipals, directoryObjects, me)
for (const base of ['users/:id', 'groups/:id', 'servicePrincipals/:id', 'directoryObjects/:id', 'me']) {
  const idOf = async (r: Req) => {
    if (!r.p.id) return r.gc.p.oid;
    if (base.startsWith('users')) return (await getUser(r.p.id, r)).id;
    if (base.startsWith('servicePrincipals')) return (await getSp(r.p.id)).id;
    return r.p.id;
  };
  route('POST', `${base}/checkMemberGroups`, async (r) => {
    const groups = new Set(await groupsOf(await idOf(r)));
    const { groupIds } = await r.body();
    return r.c.json({ '@odata.context': ctxUrl(r, 'Collection(Edm.String)'), value: (groupIds ?? []).filter((g: string) => groups.has(g)) });
  });
  route('POST', `${base}/getMemberGroups`, async (r) => r.c.json({ '@odata.context': ctxUrl(r, 'Collection(Edm.String)'), value: await groupsOf(await idOf(r)) }));
  route('POST', `${base}/getMemberObjects`, async (r) => r.c.json({ '@odata.context': ctxUrl(r, 'Collection(Edm.String)'), value: await memberOf(await idOf(r), true) }));
}
route('GET', 'servicePrincipals/:id/memberOf', async (r) => collection(r, 'directoryObjects', await briefObjects(r, await memberOf((await getSp(r.p.id)).id, false)), (x) => x));
route('GET', 'servicePrincipals/:id/transitiveMemberOf', async (r) => collection(r, 'directoryObjects', await briefObjects(r, await memberOf((await getSp(r.p.id)).id, true)), (x) => x));

// ---------- groups ----------

route('GET', 'groups', async (r) => {
  assertRead(r.gc, 'group');
  return collection(r, 'groups', await store.list('group'), (g) => shape('group', g));
});
route('GET', 'groups/$count', async (r) => countResponse(r, await store.count('group')));
route('POST', 'groups', async (r) => {
  assertCreate(r.gc, 'group');
  const body = await r.body();
  if (body.isAssignableToRole && !r.gc.isGlobalAdmin && !r.gc.roles.has(DIRECTORY_ROLES[7].id)) throw denied();
  const g = await createGroup(body, r.gc.p.kind === 'user' ? r.gc.p.oid : undefined);
  await audit(r.gc.p, { category: 'GroupManagement', activity: 'Add group', operationType: 'Add', target: { id: g.id, displayName: g.displayName, type: 'Group' } });
  return entity(r, 'groups', shape('group', g), 201);
});
route('GET', 'groups/:id', async (r) => {
  assertRead(r.gc, 'group');
  const g = await getGroup(r.p.id);
  const [it] = await expandItems(r, [{ ...shape('group', g), __raw: g }]);
  return entity(r, 'groups', it);
});
route('PATCH', 'groups/:id', async (r) => {
  const g = await getGroup(r.p.id);
  assertWrite(r.gc, 'group', g);
  const body = await r.body();
  for (const [k, v] of Object.entries(body)) {
    if (k.startsWith('@odata')) continue;
    if (!GROUP_WRITABLE.has(k)) throw graphBad(`Property '${k}' is read-only and cannot be set.`);
    g[k] = v;
  }
  await store.put('group', g.id, g, tenant().id);
  await audit(r.gc.p, { category: 'GroupManagement', activity: 'Update group', operationType: 'Update', target: { id: g.id, displayName: g.displayName, type: 'Group' } });
  return noContent(r);
});
route('DELETE', 'groups/:id', async (r) => {
  const g = await getGroup(r.p.id);
  assertWrite(r.gc, 'group', g);
  await store.remove('group', g.id);
  await removeFromAllGroups(g.id);
  for (const a of await store.list('dirRoleAssignment', { match: { principalId: g.id } })) await store.remove('dirRoleAssignment', a.id);
  await audit(r.gc.p, { category: 'GroupManagement', activity: 'Delete group', operationType: 'Delete', target: { id: g.id, displayName: g.displayName, type: 'Group' } });
  return noContent(r);
});
route('GET', 'groups/:id/members', async (r) => {
  assertRead(r.gc, 'groupMembers');
  const g = await getGroup(r.p.id);
  return collection(r, 'directoryObjects', await briefObjects(r, g._members ?? []), (x) => x);
});
route('GET', 'groups/:id/members/$count', async (r) => countResponse(r, ((await getGroup(r.p.id))._members ?? []).length));
route('GET', 'groups/:id/transitiveMembers', async (r) => {
  assertRead(r.gc, 'groupMembers');
  const seen = new Set<string>();
  const queue = [...((await getGroup(r.p.id))._members ?? [])];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const sub = await store.get('group', id);
    if (sub) queue.push(...(sub._members ?? []));
  }
  return collection(r, 'directoryObjects', await briefObjects(r, [...seen]), (x) => x);
});
route('GET', 'groups/:id/memberOf', async (r) => collection(r, 'directoryObjects', await briefObjects(r, await memberOf((await getGroup(r.p.id)).id, false)), (x) => x));
route('GET', 'groups/:id/transitiveMemberOf', async (r) => collection(r, 'directoryObjects', await briefObjects(r, await memberOf((await getGroup(r.p.id)).id, true)), (x) => x));
route('POST', 'groups/:id/members/$ref', async (r) => {
  const g = await getGroup(r.p.id);
  assertWrite(r.gc, 'groupMembers', g);
  const id = refId(await r.body());
  const target = await getDirectoryObject(id);
  if (!target || target.type === 'application') throw graphNotFound(id);
  if (id === g.id) throw graphBad('A group cannot be a member of itself.');
  if (target.type === 'group' && (await groupsOf(g.id)).includes(id)) throw graphBad('Adding this member would create a circular group membership.');
  if ((g._members ?? []).includes(id)) throw graphBad("One or more added object references already exist for the following modified properties: 'members'.");
  g._members = [...(g._members ?? []), id];
  await store.put('group', g.id, g, tenant().id);
  await audit(r.gc.p, { category: 'GroupManagement', activity: 'Add member to group', operationType: 'Assign', target: { id: g.id, displayName: g.displayName, type: 'Group' }, modified: [{ displayName: 'Member', newValue: target.obj.displayName }] });
  return noContent(r);
});
route('DELETE', 'groups/:id/members/:member/$ref', async (r) => {
  const g = await getGroup(r.p.id);
  assertWrite(r.gc, 'groupMembers', g);
  if (!(g._members ?? []).includes(r.p.member)) throw graphNotFound(r.p.member);
  g._members = g._members.filter((m: string) => m !== r.p.member);
  await store.put('group', g.id, g, tenant().id);
  await audit(r.gc.p, { category: 'GroupManagement', activity: 'Remove member from group', operationType: 'Unassign', target: { id: g.id, displayName: g.displayName, type: 'Group' } });
  return noContent(r);
});

// ---------- directory objects ----------

route('GET', 'directoryObjects/:id', async (r) => {
  const o = await getDirectoryObject(r.p.id);
  if (!o) throw graphNotFound(r.p.id);
  return entity(r, 'directoryObjects', shape(o.type, o.obj, r, true));
});
route('POST', 'directoryObjects/getByIds', async (r) => {
  const { ids, types } = await r.body();
  const wanted = (types ?? []).map((t: string) => t.toLowerCase().replace('microsoft.graph.', ''));
  const objs = (await briefObjects(r, ids ?? [])).filter((o) => !wanted.length || wanted.includes(String(o['@odata.type']).replace('#microsoft.graph.', '').toLowerCase()));
  return r.c.json({ '@odata.context': ctxUrl(r, 'directoryObjects'), value: objs });
});

// ---------- directory roles ----------

route('GET', 'directoryRoles', async (r) => collection(r, 'directoryRoles', DIRECTORY_ROLES.map((x) => dirRoleObject(x.id)), (x) => x));
route('GET', 'directoryRoleTemplates', async (r) => collection(r, 'directoryRoleTemplates', DIRECTORY_ROLES.map((x) => ({ id: x.id, deletedDateTime: null, description: x.description, displayName: x.displayName })), (x) => x));
route('GET', 'directoryRoles/:id', async (r) => entity(r, 'directoryRoles', dirRoleObject(getDirRole(r.p.id))));
route('GET', 'directoryRoles/:id/members', async (r) => {
  const rid = getDirRole(r.p.id);
  const ids = (await store.list('dirRoleAssignment', { match: { roleDefinitionId: rid } })).map((a) => a.principalId);
  return collection(r, 'directoryObjects', await briefObjects(r, ids), (x) => x);
});
route('POST', 'directoryRoles/:id/members/$ref', async (r) => {
  const rid = getDirRole(r.p.id);
  const id = refId(await r.body());
  await addDirRoleAssignment(r, id, rid);
  return noContent(r);
});
route('DELETE', 'directoryRoles/:id/members/:member/$ref', async (r) => {
  const rid = getDirRole(r.p.id);
  const a = (await store.list('dirRoleAssignment', { match: { roleDefinitionId: rid, principalId: r.p.member } }))[0];
  if (!a) throw graphNotFound(r.p.member);
  await removeDirRoleAssignment(r, a);
  return noContent(r);
});

function roleDefinitionObject(id: string) {
  const t = roleTemplate(id);
  if (!t) return null;
  return { id: t.id, description: t.description, displayName: t.displayName, isBuiltIn: true, isEnabled: true, resourceScopes: ['/'], templateId: t.id, version: '1', rolePermissions: [{ allowedResourceActions: t.id === GLOBAL_ADMIN ? ['microsoft.directory/*'] : [], condition: null }], inheritsPermissionsFrom: [] };
}

async function addDirRoleAssignment(r: Req, principalId: string, roleId: string) {
  if (!(r.gc.isGlobalAdmin || canWrite(r.gc, 'roles'))) throw denied();
  if (roleId === GLOBAL_ADMIN && !r.gc.isGlobalAdmin && r.gc.p.kind === 'user') throw denied();
  const target = await getDirectoryObject(principalId);
  if (!target || target.type === 'application') throw graphNotFound(principalId);
  if (target.type === 'group' && !target.obj.isAssignableToRole) throw graphBad('Only groups with isAssignableToRole set to true can be assigned to directory roles.');
  const dup = (await store.list('dirRoleAssignment', { match: { roleDefinitionId: roleId, principalId } }))[0];
  if (dup) throw graphBad("One or more added object references already exist for the following modified properties: 'members'.");
  const a = { id: randomToken(32).slice(0, 43), principalId, roleDefinitionId: roleId, directoryScopeId: '/', appScopeId: null, createdDateTime: nowIso() };
  await store.put('dirRoleAssignment', a.id, a, tenant().id);
  const role = roleTemplate(roleId)!;
  await audit(r.gc.p, { category: 'RoleManagement', activity: 'Add member to role', operationType: 'Assign', target: { id: principalId, displayName: target.obj.displayName, type: target.type, userPrincipalName: target.obj.userPrincipalName }, modified: [{ displayName: 'Role.DisplayName', newValue: role.displayName }] });
  const admins = (await store.list('dirRoleAssignment', { match: { roleDefinitionId: GLOBAL_ADMIN } })).map((x) => x.principalId);
  const { expandToUsers } = await import('../directory.ts');
  notifyLater(await expandToUsers([principalId, ...admins]), { category: 'security', key: 'dirRoleAssigned', params: { actor: r.gc.p.name, role: role.displayName, principal: target.obj.displayName }, url: '/entra/roles', actorId: r.gc.p.oid });
  return a;
}

async function removeDirRoleAssignment(r: Req, a: any) {
  if (!(r.gc.isGlobalAdmin || canWrite(r.gc, 'roles'))) throw denied();
  if (a.roleDefinitionId === GLOBAL_ADMIN) {
    const remaining = (await store.list('dirRoleAssignment', { match: { roleDefinitionId: GLOBAL_ADMIN } })).filter((x) => x.id !== a.id);
    if (!remaining.length) throw graphBad('At least one Global Administrator must remain in the tenant.');
  }
  await store.remove('dirRoleAssignment', a.id);
  const target = await getDirectoryObject(a.principalId);
  await audit(r.gc.p, { category: 'RoleManagement', activity: 'Remove member from role', operationType: 'Unassign', target: { id: a.principalId, displayName: target?.obj.displayName, type: target?.type ?? 'Unknown' }, modified: [{ displayName: 'Role.DisplayName', oldValue: roleTemplate(a.roleDefinitionId)?.displayName }] });
}

route('GET', 'roleManagement/directory/roleDefinitions', async (r) => collection(r, 'roleManagement/directory/roleDefinitions', DIRECTORY_ROLES.map((x) => roleDefinitionObject(x.id)), (x) => x));
route('GET', 'roleManagement/directory/roleDefinitions/:id', async (r) => {
  const d = roleDefinitionObject(r.p.id);
  if (!d) throw graphNotFound(r.p.id);
  return entity(r, 'roleManagement/directory/roleDefinitions', d);
});
route('GET', 'roleManagement/directory/roleAssignments', async (r) => {
  assertRead(r.gc, 'roles');
  return collection(r, 'roleManagement/directory/roleAssignments', await store.list('dirRoleAssignment'), (a) => ({ id: a.id, principalId: a.principalId, roleDefinitionId: a.roleDefinitionId, directoryScopeId: a.directoryScopeId, appScopeId: a.appScopeId ?? null }));
});
route('POST', 'roleManagement/directory/roleAssignments', async (r) => {
  const b = await r.body();
  if (!b.principalId || !b.roleDefinitionId) throw graphBad("Properties 'principalId' and 'roleDefinitionId' are required.");
  if (!roleTemplate(b.roleDefinitionId)) throw graphNotFound(b.roleDefinitionId);
  const a = await addDirRoleAssignment(r, b.principalId, b.roleDefinitionId);
  return entity(r, 'roleManagement/directory/roleAssignments', { id: a.id, principalId: a.principalId, roleDefinitionId: a.roleDefinitionId, directoryScopeId: '/', appScopeId: null }, 201);
});
route('GET', 'roleManagement/directory/roleAssignments/:id', async (r) => {
  const a = await store.get('dirRoleAssignment', r.p.id);
  if (!a) throw graphNotFound(r.p.id);
  const [it] = await expandItems(r, [{ id: a.id, principalId: a.principalId, roleDefinitionId: a.roleDefinitionId, directoryScopeId: a.directoryScopeId, appScopeId: null, __raw: a }]);
  return entity(r, 'roleManagement/directory/roleAssignments', it);
});
route('DELETE', 'roleManagement/directory/roleAssignments/:id', async (r) => {
  const a = await store.get('dirRoleAssignment', r.p.id);
  if (!a) throw graphNotFound(r.p.id);
  await removeDirRoleAssignment(r, a);
  return noContent(r);
});

// ---------- organization & domains ----------

async function organizationObject() {
  const t = tenant();
  const org = (await store.get('tenant', t.id)) ?? {};
  return {
    id: t.id,
    deletedDateTime: null,
    businessPhones: org.businessPhones ?? [],
    city: org.city ?? null,
    country: org.country ?? null,
    countryLetterCode: t.countryCode,
    createdDateTime: t.createdDateTime,
    defaultUsageLocation: org.defaultUsageLocation ?? null,
    displayName: t.displayName,
    marketingNotificationEmails: [],
    onPremisesSyncEnabled: null,
    postalCode: org.postalCode ?? null,
    preferredLanguage: org.preferredLanguage ?? 'it-IT',
    privacyProfile: null,
    state: null,
    street: org.street ?? null,
    technicalNotificationMails: org.technicalNotificationMails ?? [],
    tenantType: 'AAD',
    assignedPlans: [],
    provisionedPlans: [],
    verifiedDomains: t.domains.map((d) => ({ capabilities: 'Email, OfficeCommunicationsOnlineService', isDefault: d === t.defaultDomain, isInitial: d === t.domains[0], name: d, type: 'Managed' })),
  };
}

route('GET', 'organization', async (r) => collection(r, 'organization', [await organizationObject()], (x) => x));
route('GET', 'organization/:id', async (r) => {
  if (r.p.id !== tenant().id) throw graphNotFound(r.p.id);
  return entity(r, 'organization', await organizationObject());
});
route('PATCH', 'organization/:id', async (r) => {
  if (r.p.id !== tenant().id) throw graphNotFound(r.p.id);
  if (!r.gc.isGlobalAdmin) throw denied();
  const b = await r.body();
  const t = await store.get('tenant', tenant().id);
  for (const k of ['displayName', 'preferredLanguage', 'technicalNotificationMails', 'businessPhones', 'street', 'city', 'postalCode', 'country', 'defaultUsageLocation']) if (b[k] !== undefined) t[k] = b[k];
  await store.put('tenant', t.id, t);
  setTenant({ ...tenant(), displayName: t.displayName });
  await audit(r.gc.p, { category: 'DirectoryManagement', activity: 'Update company settings', operationType: 'Update', target: { id: t.id, displayName: t.displayName, type: 'Company' } });
  return noContent(r);
});
const domainObject = (d: string) => ({ id: d, authenticationType: 'Managed', availabilityStatus: null, isAdminManaged: true, isDefault: d === tenant().defaultDomain, isInitial: d === tenant().domains[0], isRoot: true, isVerified: true, supportedServices: ['Email', 'OfficeCommunicationsOnlineService'], passwordValidityPeriodInDays: 2147483647, passwordNotificationWindowInDays: 14, state: null });
route('GET', 'domains', async (r) => collection(r, 'domains', tenant().domains.map(domainObject), (x) => x));
route('GET', 'domains/:id', async (r) => {
  const d = r.p.id.toLowerCase();
  if (!tenant().domains.includes(d)) throw graphNotFound(r.p.id);
  return entity(r, 'domains', domainObject(d));
});
route('POST', 'domains', async (r) => {
  if (!r.gc.isGlobalAdmin) throw denied();
  const { id } = await r.body();
  const d = String(id ?? '').toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) throw graphBad('Invalid domain name.');
  if (tenant().domains.includes(d)) throw new HttpError(409, 'Request_MultipleObjectsWithSameKeyValue', 'Another object with the same value for property id already exists.');
  const t = await store.get('tenant', tenant().id);
  t.domains = [...t.domains, d];
  await store.put('tenant', t.id, t);
  setTenant({ ...tenant(), domains: t.domains });
  return entity(r, 'domains', domainObject(d), 201);
});
route('PATCH', 'domains/:id', async (r) => {
  if (!r.gc.isGlobalAdmin) throw denied();
  const d = r.p.id.toLowerCase();
  if (!tenant().domains.includes(d)) throw graphNotFound(r.p.id);
  const b = await r.body();
  if (b.isDefault === true) {
    const t = await store.get('tenant', tenant().id);
    t.defaultDomain = d;
    await store.put('tenant', t.id, t);
    setTenant({ ...tenant(), defaultDomain: d });
  }
  return noContent(r);
});
route('DELETE', 'domains/:id', async (r) => {
  if (!r.gc.isGlobalAdmin) throw denied();
  const d = r.p.id.toLowerCase();
  if (!tenant().domains.includes(d)) throw graphNotFound(r.p.id);
  if (d === tenant().defaultDomain || d === tenant().domains[0]) throw graphBad('The default or initial domain cannot be deleted.');
  if ((await store.list('user')).some((u) => u._upn.endsWith('@' + d))) throw graphBad(`Domain '${d}' cannot be deleted because it is referenced by users.`);
  const t = await store.get('tenant', tenant().id);
  t.domains = t.domains.filter((x: string) => x !== d);
  await store.put('tenant', t.id, t);
  setTenant({ ...tenant(), domains: t.domains });
  return noContent(r);
});
route('GET', 'subscribedSkus', async (r) => collection(r, 'subscribedSkus', [], (x) => x));

// ---------- audit logs ----------

route('GET', 'auditLogs/directoryAudits', async (r) => {
  assertRead(r.gc, 'audit');
  return collection(r, 'auditLogs/directoryAudits', await queryEvents({ kind: 'audit', limit: 2000 }), (x) => x);
});
route('GET', 'auditLogs/directoryAudits/:id', async (r) => {
  assertRead(r.gc, 'audit');
  const e = (await queryEvents({ kind: 'audit', limit: 5000 })).find((x) => x.id === r.p.id);
  if (!e) throw graphNotFound(r.p.id);
  return entity(r, 'auditLogs/directoryAudits', e);
});
route('GET', 'auditLogs/signIns', async (r) => {
  assertRead(r.gc, 'audit');
  let all = (await queryEvents({ kind: 'signin', limit: 2000 })).map((e) => ({ ...e, signInEventTypes: [e.signInType] }));
  if (!/signInEventTypes/i.test(r.q.$filter ?? '')) all = all.filter((e) => e.signInType === 'interactiveUser');
  return collection(r, 'auditLogs/signIns', all, (x) => x);
});

// ---------- deleted items ----------

route('GET', 'directory/deletedItems/:type', async (r) => {
  const type = r.p.type.toLowerCase().replace('microsoft.graph.', '');
  const map: Record<string, Kind> = { application: 'application', user: 'user', group: 'group', serviceprincipal: 'servicePrincipal' };
  if (!map[type]) {
    const item = await store.get('deletedItem', r.p.type);
    if (!item) throw graphNotFound(r.p.type);
    return entity(r, 'directoryObjects', publicView(item));
  }
  assertRead(r.gc, map[type]);
  const items = (await store.list('deletedItem')).filter((i) => i['@odata.type'].toLowerCase() === `#microsoft.graph.${type}`);
  return collection(r, `directory/deletedItems/microsoft.graph.${type}`, items, (o) => publicView(o));
});
route('POST', 'directory/deletedItems/:id/restore', async (r) => {
  const item = await store.get('deletedItem', r.p.id);
  if (!item) throw graphNotFound(r.p.id);
  const type = String(item['@odata.type']).replace('#microsoft.graph.', '') as DirType;
  assertWrite(r.gc, type === 'user' ? 'user' : 'application', item);
  const { '@odata.type': _t, _memberOf, ...obj } = item;
  obj.deletedDateTime = null;
  await store.put(type, obj.id, obj, tenant().id);
  await store.remove('deletedItem', obj.id);
  for (const gid of _memberOf ?? []) {
    const g = await store.get('group', gid);
    if (g && !(g._members ?? []).includes(obj.id)) {
      g._members = [...(g._members ?? []), obj.id];
      await store.put('group', g.id, g, tenant().id);
    }
  }
  if (type === 'application') await syncServicePrincipal(obj);
  await audit(r.gc.p, { category: type === 'user' ? 'UserManagement' : 'ApplicationManagement', activity: `Restore ${type}`, operationType: 'Add', target: { id: obj.id, displayName: obj.displayName, type } });
  return entity(r, 'directoryObjects', { '@odata.type': _t, ...publicView(obj) });
});
route('DELETE', 'directory/deletedItems/:id', async (r) => {
  const item = await store.get('deletedItem', r.p.id);
  if (!item) throw graphNotFound(r.p.id);
  const type = String(item['@odata.type']).replace('#microsoft.graph.', '');
  assertWrite(r.gc, type === 'user' ? 'user' : 'application', item);
  await store.remove('deletedItem', item.id);
  return noContent(r);
});

// ---------- misc ----------

route('GET', 'me/photo/$value', async () => {
  throw new HttpError(404, 'ImageNotFound', 'Exception of type \'Microsoft.Fast.Profile.Core.Exception.ImageNotFoundException\' was thrown.');
});

// ---------- dispatcher ----------

function splitSegments(path: string): string[] {
  const out: string[] = [];
  for (const raw of path.split('/').filter(Boolean)) {
    const seg = decodeURIComponent(raw);
    const m = /^([A-Za-z]+)\((?:(\w+)=)?'([^']*)'\)$/.exec(seg);
    if (m) {
      out.push(m[1]);
      out.push(m[2] ? `${m[2]}=${m[3]}` : m[3]);
    } else {
      out.push(seg);
    }
  }
  return out;
}

async function dispatch(c: Ctx, ver: string): Promise<Response> {
  const url = new URL(c.req.url);
  const segs = splitSegments(url.pathname.slice(ver.length + 2));
  const method = c.req.method;
  for (const rt of routes) {
    if (rt.method !== method || rt.pattern.length !== segs.length) continue;
    const p: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < segs.length; i++) {
      const pat = rt.pattern[i];
      if (pat.startsWith(':')) p[pat.slice(1)] = segs[i];
      else if (pat.toLowerCase() !== segs[i].toLowerCase()) { ok = false; break; }
    }
    if (!ok) continue;
    const gc = await caller(c);
    let cached: any;
    const req: Req = {
      c, p, gc, ver, base: originOf(c), q: c.req.query(),
      body: async () => (cached ??= await readJson(c)),
    };
    return rt.h(req);
  }
  const known = routes.some((rt) => rt.pattern.length === segs.length && rt.pattern.every((pat, i) => pat.startsWith(':') || pat.toLowerCase() === segs[i]?.toLowerCase()));
  if (known) throw new HttpError(405, 'Request_BadRequest', `Specified HTTP method is not allowed for the request target.`);
  throw new HttpError(400, 'BadRequest', `Resource not found for the segment '${segs[segs.length - 1] ?? ''}'.`);
}

export function graphRoutes(app: Hono<AppEnv>): void {
  for (const ver of ['v1.0', 'beta']) {
    app.use(`/${ver}/*`, authenticate('graph'));
    app.post(`/${ver}/$batch`, async (c) => {
      const body = await readJson(c);
      const requests: any[] = body.requests ?? [];
      if (requests.length > 20) throw graphBad('The number of requests in a batch cannot exceed 20.');
      const responses = [];
      const fwd: Record<string, string> = {};
      for (const h of ['authorization', 'cookie', 'x-azzurro-portal', 'x-forwarded-host', 'x-forwarded-proto']) {
        const v = c.req.header(h);
        if (v) fwd[h] = v;
      }
      const origin = new URL(c.req.url).origin;
      for (const rq of requests) {
        const target = `${origin}/${ver}${String(rq.url).startsWith('/') ? '' : '/'}${rq.url}`;
        const res = await app.request(target, {
          method: rq.method ?? 'GET',
          headers: { ...fwd, ...(rq.headers ?? {}), ...(rq.body ? { 'content-type': 'application/json' } : {}) },
          body: rq.body ? JSON.stringify(rq.body) : undefined,
        });
        const text = await res.text();
        let parsed: unknown = undefined;
        try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
        responses.push({ id: rq.id, status: res.status, headers: { 'Content-Type': res.headers.get('content-type') ?? 'application/json' }, ...(parsed !== undefined ? { body: parsed } : {}) });
      }
      return c.json({ responses });
    });
    app.all(`/${ver}/*`, (c) => dispatch(c, ver));
  }
}

