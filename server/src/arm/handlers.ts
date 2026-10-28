import * as store from '../db/store.ts';
import { tenant, principalInfo, isGlobalAdmin, expandToUsers } from '../directory.ts';
import { queryEvents } from '../events.ts';
import { isGuid, nowIso, uuid } from '../ids.ts';
import { applyFilter } from '../odata.ts';
import { notifyLater } from '../push.ts';
import { TYPES, namespaces, typeDef } from './catalog.ts';
import {
  accessOf, armError, authorize, canDo, checkLocks, getResourceGroup, notifyScope, ok, requireResourceGroup, requireSubscription,
  type ArmCtx, type ArmResult,
} from './context.ts';
import { deleteResourceGroupTree, infoFromId, listResources, loadResource, RG_NAME, viewResource } from './generic.ts';
import { LOCATIONS, locationDisplay, locationResource, normalizeLocation } from './locations.ts';
import { idParts, isAncestorOrSelf, rgId } from './path.ts';
import {
  allRoleDefinitions, can, getRoleDefinition, hasAnyAccessWithin, permissionsAt, roleDefinitionResource, roleGuidFromId, BUILTIN_ROLES, type RoleDef,
} from './rbac.ts';

// ---------------- tenants & subscriptions ----------------

export function tenantView() {
  const t = tenant();
  return { id: `/tenants/${t.id}`, tenantId: t.id, countryCode: t.countryCode, displayName: t.displayName, domains: t.domains, tenantCategory: 'Home', defaultDomain: t.defaultDomain, tenantType: 'AAD', tenantBrandingLogoUrl: null };
}

function subView(s: any) {
  const { _key, ...rest } = s;
  return rest;
}

export async function listSubscriptions(ctx: ArmCtx): Promise<ArmResult> {
  const access = await accessOf(ctx);
  const subs = (await store.list('subscription')).filter((s) => hasAnyAccessWithin(access, `/subscriptions/${s.subscriptionId}`));
  return ok({ value: subs.map(subView), count: { type: 'Total', value: subs.length } });
}

export async function getSubscriptionView(ctx: ArmCtx, sub: string): Promise<ArmResult> {
  const s = await requireSubscription(sub);
  if (!hasAnyAccessWithin(await accessOf(ctx), `/subscriptions/${s.subscriptionId}`)) {
    throw armError(403, 'AuthorizationFailed', `The client '${ctx.principal.upn ?? ctx.principal.appId}' with object id '${ctx.principal.oid}' does not have authorization to perform action 'Microsoft.Resources/subscriptions/read' over scope '/subscriptions/${sub}' or the scope is invalid.`);
  }
  return ok(subView(s));
}

export async function createSubscription(ctx: ArmCtx, displayName: string, opts: { subscriptionId?: string; workload?: string; tags?: Record<string, string> } = {}): Promise<any> {
  const id = opts.subscriptionId && isGuid(opts.subscriptionId) ? opts.subscriptionId.toLowerCase() : uuid();
  const sub = {
    id: `/subscriptions/${id}`,
    authorizationSource: 'RoleBased',
    managedByTenants: [],
    subscriptionId: id,
    tenantId: tenant().id,
    displayName,
    state: 'Enabled',
    subscriptionPolicies: { locationPlacementId: 'Public_2014-09-01', quotaId: opts.workload === 'DevTest' ? 'MSDN_2014-09-01' : 'PayAsYouGo_2014-09-01', spendingLimit: 'Off' },
    tags: opts.tags ?? {},
  };
  await store.put('subscription', id, sub);
  // il creatore diventa Owner
  const raId = uuid();
  const scope = `/subscriptions/${id}`;
  await store.put('roleAssignment', `${scope}/providers/Microsoft.Authorization/roleAssignments/${raId}`, roleAssignmentRecord(scope, raId, BUILTIN_ROLES[0].name, ctx.principal.oid, ctx.principal.kind === 'user' ? 'User' : 'ServicePrincipal', ctx.principal.upn ?? ctx.principal.appId ?? null, 'Creator of the subscription'), scope);
  return sub;
}

async function canCreateSubscriptions(ctx: ArmCtx): Promise<boolean> {
  if (ctx.principal.via === 'lax') return true;
  if (ctx.principal.kind === 'user' && (await isGlobalAdmin(ctx.principal.oid))) return true;
  return canDo(ctx, 'Microsoft.Subscription/aliases/write', '/');
}

export async function subscriptionAlias(ctx: ArmCtx, method: string, alias: string | undefined, body: any): Promise<ArmResult> {
  const view = (a: any) => ({ id: `/providers/Microsoft.Subscription/aliases/${a.name}`, name: a.name, type: 'Microsoft.Subscription/aliases', properties: { subscriptionId: a.subscriptionId, provisioningState: 'Succeeded', acceptOwnershipState: 'Completed', displayName: a.displayName, workload: a.workload, createdTime: a.createdTime } });
  if (!alias) {
    if (method !== 'GET') throw armError(405, 'MethodNotAllowed', 'The requested method is not allowed.');
    return ok({ value: (await store.list('subscriptionAlias')).map(view) });
  }
  const existing = await store.get('subscriptionAlias', alias);
  if (method === 'GET') {
    if (!existing) throw armError(404, 'NotFound', `The alias '${alias}' was not found.`);
    return ok(view(existing));
  }
  if (method === 'DELETE') {
    await store.remove('subscriptionAlias', alias);
    return { status: 200 };
  }
  if (method !== 'PUT') throw armError(405, 'MethodNotAllowed', 'The requested method is not allowed.');
  if (existing) return ok(view(existing));
  if (!(await canCreateSubscriptions(ctx))) throw armError(403, 'AuthorizationFailed', 'Only Global Administrators can create subscriptions in Azzurro.');
  const p = body?.properties ?? {};
  const displayName = p.displayName ?? alias;
  let subscriptionId = p.subscriptionId;
  if (!subscriptionId || !(await store.get('subscription', subscriptionId))) {
    const sub = await createSubscription(ctx, displayName, { workload: p.workload, tags: p.additionalProperties?.tags });
    subscriptionId = sub.subscriptionId;
  }
  const rec = { name: alias, subscriptionId, displayName, workload: p.workload ?? 'Production', createdTime: nowIso() };
  await store.put('subscriptionAlias', alias, rec);
  return ok(view(rec), 201);
}

export async function subscriptionAction(ctx: ArmCtx, sub: string, action: string, body: any): Promise<ArmResult> {
  const s = await requireSubscription(sub);
  await authorize(ctx, `Microsoft.Subscription/${action}/action`, `/subscriptions/${sub}`);
  switch (action.toLowerCase()) {
    case 'rename':
      if (!body?.subscriptionName) throw armError(400, 'InvalidRequest', "The 'subscriptionName' property is required.");
      s.displayName = body.subscriptionName;
      break;
    case 'cancel':
      s.state = 'Disabled';
      break;
    case 'enable':
      s.state = 'Enabled';
      break;
    default:
      throw armError(400, 'InvalidAction', `Unsupported subscription action '${action}'.`);
  }
  await store.put('subscription', s.subscriptionId, s);
  return ok({ subscriptionId: s.subscriptionId });
}

export async function listLocations(ctx: ArmCtx, sub: string): Promise<ArmResult> {
  await requireSubscription(sub);
  return ok({ value: LOCATIONS.map((l) => locationResource(sub, l)) });
}

// ---------------- resource groups ----------------

function rgView(rg: any, expand?: string) {
  const out: any = { id: rg.id, name: rg.name, type: 'Microsoft.Resources/resourceGroups', location: rg.location };
  if (rg.managedBy) out.managedBy = rg.managedBy;
  out.tags = rg.tags ?? {};
  out.properties = { provisioningState: 'Succeeded' };
  if (expand?.toLowerCase().includes('createdtime')) out.createdTime = rg._created;
  return out;
}

export async function listResourceGroups(ctx: ArmCtx, sub: string, filter?: string, top?: number): Promise<ArmResult> {
  await requireSubscription(sub);
  const access = await accessOf(ctx);
  let rgs = (await store.list('resourceGroup', { parent: `/subscriptions/${sub}` })).filter((r) => can(access, 'Microsoft.Resources/subscriptions/resourceGroups/read', r.id) || hasAnyAccessWithin(access, r.id));
  if (filter) {
    const views = rgs.flatMap((r) => {
      const tags = Object.entries(r.tags ?? {});
      return tags.length ? tags.map(([k, v]) => ({ ...r, tagName: k, tagValue: v, __r: r })) : [{ ...r, tagName: null, tagValue: null, __r: r }];
    });
    const keep = new Set(applyFilter(views, filter).map((v: any) => v.__r));
    rgs = rgs.filter((r) => keep.has(r));
  }
  if (top) rgs = rgs.slice(0, top);
  return ok({ value: rgs.map((r) => rgView(r, ctx.expand)) });
}

export async function resourceGroup(ctx: ArmCtx, method: string, sub: string, rg: string, body: any): Promise<ArmResult> {
  const id = rgId(sub, rg);
  const existing = await getResourceGroup(sub, rg);
  switch (method) {
    case 'HEAD':
      await requireSubscription(sub);
      return { status: existing ? 204 : 404 };
    case 'GET':
      await requireSubscription(sub);
      if (!existing) throw armError(404, 'ResourceGroupNotFound', `Resource group '${rg}' could not be found.`);
      if (!(await canDo(ctx, 'Microsoft.Resources/subscriptions/resourceGroups/read', existing.id)) && !hasAnyAccessWithin(await accessOf(ctx), existing.id)) {
        await authorize(ctx, 'Microsoft.Resources/subscriptions/resourceGroups/read', existing.id);
      }
      return ok(rgView(existing, ctx.expand));
    case 'PUT': {
      await requireSubscription(sub, true);
      if (!RG_NAME.test(rg) || rg.endsWith('.')) throw armError(400, 'InvalidResourceGroup', `The provided resource group name '${rg}' has these invalid characters: '${rg.replace(/[-\w._()]/g, '') || '.'}'. The name can only be a letter, digit, '-', '.', '(', ')' or '_'.`);
      await authorize(ctx, 'Microsoft.Resources/subscriptions/resourceGroups/write', existing?.id ?? id);
      const loc = normalizeLocation(body?.location);
      if (!body?.location) throw armError(400, 'LocationRequired', "The 'location' property is required for this definition.");
      if (!loc || loc === 'global') throw armError(400, 'LocationNotAvailableForResourceGroup', `The provided location '${body.location}' is not available for resource group. List of available regions is '${LOCATIONS.map((l) => l.name).join(',')}'.`);
      if (existing && existing.location !== loc) throw armError(409, 'InvalidResourceGroupLocation', `Invalid resource group location '${loc}'. The Resource group already exists in location '${existing.location}'.`);
      if (existing) await checkLocks(ctx, existing.id, 'write');
      const rec = { id: existing?.id ?? id, name: existing?.name ?? rg, type: 'Microsoft.Resources/resourceGroups', location: loc, managedBy: body.managedBy ?? existing?.managedBy, tags: body.tags ?? existing?.tags ?? {}, properties: { provisioningState: 'Succeeded' }, _created: existing?._created ?? nowIso() };
      if (ctx.dryRun) {
        ctx.plan ??= new Map();
        ctx.plan.set(id.toLowerCase(), rec);
      } else {
        await store.put('resourceGroup', rec.id, rec, `/subscriptions/${sub}`);
      }
      if (!existing && !ctx.dryRun) await notifyScope(ctx, id, { category: 'resources', key: 'rgCreated', params: { name: rg, location: locationDisplay(loc) }, url: `/resource-groups/${sub}/${encodeURIComponent(rg)}` });
      return ok(rgView(rec), existing ? 200 : 201);
    }
    case 'PATCH': {
      if (!existing) throw armError(404, 'ResourceGroupNotFound', `Resource group '${rg}' could not be found.`);
      await authorize(ctx, 'Microsoft.Resources/subscriptions/resourceGroups/write', existing.id);
      await checkLocks(ctx, existing.id, 'write');
      if (body?.tags !== undefined) existing.tags = body.tags;
      if (body?.managedBy !== undefined) existing.managedBy = body.managedBy;
      await store.put('resourceGroup', existing.id, existing, `/subscriptions/${sub}`);
      return ok(rgView(existing));
    }
    case 'DELETE': {
      await requireSubscription(sub, true);
      if (!existing) throw armError(404, 'ResourceGroupNotFound', `Resource group '${rg}' could not be found.`);
      await authorize(ctx, 'Microsoft.Resources/subscriptions/resourceGroups/delete', existing.id);
      await checkLocks(ctx, existing.id, 'delete');
      const watchersScope = existing.id;
      await notifyScope(ctx, watchersScope, { category: 'resources', key: 'rgDeleted', params: { name: existing.name }, url: '/resource-groups' });
      await deleteResourceGroupTree(ctx, existing.id);
      return { status: 200 };
    }
  }
  throw armError(405, 'MethodNotAllowed', 'The requested method is not allowed.');
}

export async function rgAction(ctx: ArmCtx, sub: string, rg: string, action: string, body: any): Promise<ArmResult> {
  const group = await requireResourceGroup(sub, rg);
  switch (action.toLowerCase()) {
    case 'exporttemplate':
      await authorize(ctx, 'Microsoft.Resources/subscriptions/resourceGroups/exportTemplate/action', group.id);
      return ok(await exportTemplate(ctx, group, body?.resources));
    case 'validatemoveresources':
    case 'moveresources': {
      const ids: string[] = body?.resources ?? [];
      const target = String(body?.targetResourceGroup ?? '');
      const tp = idParts(target);
      if (!tp.subscriptionId || !tp.resourceGroup) throw armError(400, 'InvalidTargetResourceGroup', 'The target resource group is invalid.');
      const targetRg = await requireResourceGroup(tp.subscriptionId, tp.resourceGroup);
      if (targetRg.id.toLowerCase() === group.id.toLowerCase()) throw armError(400, 'InvalidTargetResourceGroup', 'The source and target resource groups are the same.');
      const recs = [];
      for (const rid of ids) {
        const r = await store.get('resource', rid);
        if (!r || !rid.toLowerCase().startsWith(group.id.toLowerCase() + '/')) throw armError(400, 'ResourceNotTopLevel', `The resource '${rid}' does not belong to resource group '${rg}' or is not a top-level resource.`);
        if (r._child) throw armError(400, 'ResourceNotTopLevel', `Resource '${rid}' is not a top level resource. Only top level resources can be moved.`);
        // come Azure: i certificati App Service senza Key Vault (gestiti o caricati) non si spostano
        if (r.type.toLowerCase() === 'microsoft.web/certificates' && !r.properties?.keyVaultId) {
          throw armError(400, 'ResourceMovePolicyValidationFailed', `Resource move policy validation failed. Please see details. Diagnostic information: subscription id '${sub}', request correlation id '${uuid()}'.`, [
            { code: 'ResourceMovePolicyValidationFailed', target: r.id, message: JSON.stringify({ error: { code: 'LinkedInvalidPropertyId', message: "Property id '' at path 'properties.keyVaultId' is invalid. Expect fully qualified resource Id that start with '/subscriptions/{subscriptionId}' or '/providers/{resourceProviderNamespace}/'." } }) },
          ]);
        }
        await authorize(ctx, `${r.type}/move/action`, r.id);
        await checkLocks(ctx, r.id, 'delete');
        recs.push(r);
      }
      await authorize(ctx, 'Microsoft.Resources/subscriptions/resourceGroups/write', targetRg.id);
      await checkLocks(ctx, targetRg.id, 'write');
      if (action.toLowerCase() === 'validatemoveresources') return { status: 204 };
      for (const r of recs) {
        const newId = targetRg.id + r.id.slice(group.id.length);
        for (const coll of ['resource', 'roleAssignment', 'lock']) {
          await store.rekeyTree(coll, r.id, newId, (data, nid) => {
            const d = { ...data, id: nid };
            if (coll === 'resource') {
              d._rg = targetRg.name.toLowerCase();
              d._sub = tp.subscriptionId!.toLowerCase();
            } else {
              d._scope = (targetRg.id + (data._scope as string).slice(group.id.length)).toLowerCase();
              if (d.properties?.scope) d.properties.scope = targetRg.id + d.properties.scope.slice(group.id.length);
            }
            return d;
          });
        }
        const moved = await store.get('resource', newId);
        if (moved) await store.put('resource', newId, moved, targetRg.id);
      }
      // come Azure: i riferimenti tra risorse spostate insieme (sito → piano, NIC → subnet…) puntano ai nuovi ID
      const renames = recs.map((r) => [r.id, targetRg.id + r.id.slice(group.id.length)] as const);
      const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      for (const [, newId] of renames) {
        const tree = [await store.get('resource', newId), ...(await store.list('resource', { prefix: newId.toLowerCase() + '/' }))].filter(Boolean);
        for (const rec of tree) {
          let text = JSON.stringify(rec);
          for (const [from, to] of renames) text = text.replace(new RegExp(esc(from) + '(?=["/])', 'gi'), to);
          const next = JSON.parse(text);
          if (text !== JSON.stringify(rec)) await store.replaceData('resource', next.id, next);
        }
      }
      return { status: 204 };
    }
  }
  throw armError(400, 'InvalidAction', `Unsupported resource group action '${action}'.`);
}

async function exportTemplate(ctx: ArmCtx, group: any, only?: string[]) {
  let recs = await store.list('resource', { prefix: group.id.toLowerCase() + '/', match: { _ext: false } });
  if (only?.length && !only.includes('*')) {
    const want = only.map((x) => x.toLowerCase());
    recs = recs.filter((r) => want.some((w) => r.id.toLowerCase() === w || r.id.toLowerCase().startsWith(w + '/')));
  }
  recs.sort((a, b) => a.id.split('/').length - b.id.split('/').length);
  const readOnly = new Set(['provisioningState', 'primaryEndpoints', 'creationTime', 'vaultUri', 'fullyQualifiedDomainName', 'defaultHostName', 'resourceGuid', 'loginServer', 'documentEndpoint', 'hostName', 'endpoint', 'customerId', 'state', 'status']);
  const resources = await Promise.all(recs.map(async (r) => {
    const v = await viewResource(ctx, r);
    const info = infoFromId(r.id)!;
    const props: any = {};
    for (const [k, val] of Object.entries(v.properties ?? {})) if (!readOnly.has(k)) props[k] = val;
    const out: any = { type: r.type, apiVersion: r._apiVersion ?? typeDef(r.type)?.apiVersions[0] ?? '2023-01-01', name: info.names.join('/') };
    for (const k of ['location', 'tags', 'sku', 'kind', 'zones']) if (v[k] !== undefined) out[k] = v[k];
    if (v.identity) out.identity = { type: v.identity.type, ...(v.identity.userAssignedIdentities ? { userAssignedIdentities: Object.fromEntries(Object.keys(v.identity.userAssignedIdentities).map((k) => [k, {}])) } : {}) };
    out.properties = props;
    if (info.child) {
      const parentType = r.type.split('/').slice(0, -1).join('/');
      out.dependsOn = [`[resourceId('${parentType}', ${info.names.slice(0, -1).map((n) => `'${n}'`).join(', ')})]`];
    }
    return out;
  }));
  return {
    template: { $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#', contentVersion: '1.0.0.0', parameters: {}, variables: {}, resources },
  };
}

// ---------------- tags ----------------

export async function tagNames(ctx: ArmCtx, method: string, sub: string, name?: string, value?: string): Promise<ArmResult> {
  await requireSubscription(sub);
  const scope = `/subscriptions/${sub}`;
  if (method === 'GET' && !name) {
    await authorize(ctx, 'Microsoft.Resources/subscriptions/tagNames/read', scope);
    const counts = new Map<string, { name: string; total: number; values: Map<string, number> }>();
    const add = (k: string, v: string) => {
      const e = counts.get(k.toLowerCase()) ?? { name: k, total: 0, values: new Map() };
      e.total++;
      e.values.set(v, (e.values.get(v) ?? 0) + 1);
      counts.set(k.toLowerCase(), e);
    };
    for (const rg of await store.list('resourceGroup', { parent: scope })) for (const [k, v] of Object.entries(rg.tags ?? {})) add(k, String(v));
    for (const r of await store.list('resource', { prefix: scope.toLowerCase() + '/' })) for (const [k, v] of Object.entries(r.tags ?? {})) add(k, String(v));
    for (const t of await store.list('tagName', { parent: scope })) {
      if (!counts.has(t.name.toLowerCase())) counts.set(t.name.toLowerCase(), { name: t.name, total: 0, values: new Map() });
      for (const v of t.values ?? []) if (!counts.get(t.name.toLowerCase())!.values.has(v)) counts.get(t.name.toLowerCase())!.values.set(v, 0);
    }
    return ok({ value: [...counts.values()].map((e) => ({ id: `${scope}/tagNames/${e.name}`, tagName: e.name, count: { type: 'Total', value: e.total }, values: [...e.values.entries()].map(([v, n]) => ({ id: `${scope}/tagNames/${e.name}/tagValues/${v}`, tagValue: v, count: { type: 'Total', value: n } })) })) });
  }
  if (!name) throw armError(405, 'MethodNotAllowed', 'The requested method is not allowed.');
  await authorize(ctx, 'Microsoft.Resources/subscriptions/tagNames/write', scope);
  const key = `${scope}/${name}`;
  const t = (await store.get('tagName', key)) ?? { name, values: [] };
  if (method === 'PUT') {
    if (value !== undefined && !t.values.includes(value)) t.values.push(value);
    await store.put('tagName', key, t, scope);
    return ok(value !== undefined ? { id: `${scope}/tagNames/${name}/tagValues/${value}`, tagValue: value, count: { type: 'Total', value: 0 } } : { id: `${scope}/tagNames/${name}`, tagName: name, count: { type: 'Total', value: 0 }, values: [] }, 201);
  }
  if (method === 'DELETE') {
    if (value !== undefined) {
      t.values = t.values.filter((v: string) => v !== value);
      await store.put('tagName', key, t, scope);
    } else {
      await store.remove('tagName', key);
    }
    return { status: 200 };
  }
  throw armError(405, 'MethodNotAllowed', 'The requested method is not allowed.');
}

/** {scope}/providers/Microsoft.Resources/tags/default */
export async function tagsAtScope(ctx: ArmCtx, method: string, scope: string, body: any): Promise<ArmResult> {
  const parts = idParts(scope);
  const kind = scope.split('/').filter(Boolean).length === 2 ? 'sub' : scope.split('/').filter(Boolean).length === 4 ? 'rg' : 'res';
  let target: any;
  if (kind === 'sub') target = await requireSubscription(parts.subscriptionId!);
  else if (kind === 'rg') target = await requireResourceGroup(parts.subscriptionId!, parts.resourceGroup!);
  else {
    target = await loadResource(ctx, scope);
    if (!target) throw armError(404, 'ResourceNotFound', `The resource '${scope}' was not found.`);
  }
  const view = () => ({ id: `${scope}/providers/Microsoft.Resources/tags/default`, name: 'default', type: 'Microsoft.Resources/tags', properties: { tags: target.tags ?? {} } });
  if (method === 'GET') {
    await authorize(ctx, 'Microsoft.Resources/tags/read', scope);
    return ok(view());
  }
  await authorize(ctx, 'Microsoft.Resources/tags/write', scope);
  await checkLocks(ctx, scope, 'write');
  const incoming: Record<string, string> = body?.properties?.tags ?? {};
  if (Object.keys(incoming).length > 50) throw armError(400, 'InvalidTagNameLength', 'The number of tags on a resource cannot exceed 50.');
  if (method === 'PUT') target.tags = incoming;
  else if (method === 'PATCH') {
    const op = String(body?.operation ?? 'Merge').toLowerCase();
    if (op === 'replace') target.tags = incoming;
    else if (op === 'merge') target.tags = { ...(target.tags ?? {}), ...incoming };
    else if (op === 'delete') {
      target.tags = { ...(target.tags ?? {}) };
      for (const [k, v] of Object.entries(incoming)) if (target.tags[k] === v || v === undefined || v === '') delete target.tags[k];
    } else throw armError(400, 'InvalidOperation', `Invalid tag operation '${body?.operation}'.`);
  } else if (method === 'DELETE') target.tags = {};
  else throw armError(405, 'MethodNotAllowed', 'The requested method is not allowed.');
  if (kind === 'sub') await store.put('subscription', target.subscriptionId, target);
  else if (kind === 'rg') await store.put('resourceGroup', target.id, target, `/subscriptions/${parts.subscriptionId}`);
  else await store.put('resource', target.id, target, infoFromId(target.id)!.parentKey);
  return method === 'DELETE' ? { status: 200 } : ok(view());
}

// ---------------- providers ----------------

const EXTRA_TYPES: Record<string, { resourceType: string; apiVersions: string[]; global?: boolean }[]> = {
  'Microsoft.Resources': [
    { resourceType: 'resourceGroups', apiVersions: ['2024-03-01', '2023-07-01', '2022-09-01', '2021-04-01', '2020-06-01', '2019-10-01'] },
    { resourceType: 'deployments', apiVersions: ['2024-03-01', '2023-07-01', '2022-09-01', '2021-04-01', '2020-10-01', '2019-10-01'], global: true },
    { resourceType: 'deployments/operations', apiVersions: ['2024-03-01', '2022-09-01', '2021-04-01'], global: true },
    { resourceType: 'tags', apiVersions: ['2024-03-01', '2022-09-01', '2021-04-01', '2019-10-01'], global: true },
    { resourceType: 'subscriptions', apiVersions: ['2022-12-01', '2021-01-01', '2020-01-01', '2016-06-01'], global: true },
    { resourceType: 'tenants', apiVersions: ['2022-12-01', '2020-01-01'], global: true },
    { resourceType: 'locations', apiVersions: ['2022-12-01', '2021-01-01'], global: true },
    { resourceType: 'providers', apiVersions: ['2024-03-01', '2021-04-01'], global: true },
  ],
  'Microsoft.Authorization': [
    { resourceType: 'roleAssignments', apiVersions: ['2022-04-01', '2020-10-01-preview', '2020-04-01-preview', '2018-09-01-preview', '2015-07-01'], global: true },
    { resourceType: 'roleDefinitions', apiVersions: ['2022-05-01-preview', '2022-04-01', '2018-01-01-preview', '2015-07-01'], global: true },
    { resourceType: 'locks', apiVersions: ['2020-05-01', '2016-09-01', '2015-01-01'], global: true },
    { resourceType: 'permissions', apiVersions: ['2022-04-01', '2018-07-01', '2015-07-01'], global: true },
    { resourceType: 'elevateAccess', apiVersions: ['2017-05-01', '2015-07-01'], global: true },
  ],
  'Microsoft.Insights': [{ resourceType: 'eventtypes', apiVersions: ['2017-03-01-preview', '2015-04-01'], global: true }],
  'Microsoft.Subscription': [{ resourceType: 'aliases', apiVersions: ['2021-10-01', '2020-09-01'], global: true }],
};

function providerObject(ns: string, sub: string | undefined, state: string) {
  const types = TYPES.filter((t) => t.type.split('/')[0].toLowerCase() === ns.toLowerCase());
  const canonical = types[0]?.type.split('/')[0] ?? Object.keys(EXTRA_TYPES).find((k) => k.toLowerCase() === ns.toLowerCase()) ?? ns;
  const resourceTypes = [
    ...types.map((t) => ({ resourceType: t.type.split('/').slice(1).join('/'), locations: t.global ? ['Global'] : LOCATIONS.map((l) => l.displayName), apiVersions: t.apiVersions, defaultApiVersion: t.apiVersions[0], capabilities: t.global ? 'SupportsTags' : 'SupportsTags, SupportsLocation' })),
    ...(EXTRA_TYPES[canonical] ?? []).map((t) => ({ resourceType: t.resourceType, locations: t.global ? [] : LOCATIONS.map((l) => l.displayName), apiVersions: t.apiVersions, defaultApiVersion: t.apiVersions[0], capabilities: 'None' })),
  ];
  return { id: sub ? `/subscriptions/${sub}/providers/${canonical}` : `/providers/${canonical}`, namespace: canonical, registrationState: state, registrationPolicy: 'RegistrationRequired', resourceTypes };
}

async function regState(sub: string | undefined, ns: string): Promise<string> {
  if (!sub) return 'Registered';
  return (await store.get('providerReg', `${sub}/${ns}`))?.registrationState ?? 'Registered';
}

function knownNamespace(ns: string): string | undefined {
  return namespaces().find((n) => n.toLowerCase() === ns.toLowerCase());
}

export async function providers(ctx: ArmCtx, sub: string | undefined, ns: string | undefined, method: string, action?: string, body?: any): Promise<ArmResult> {
  if (sub) await requireSubscription(sub);
  if (!ns) {
    const list = await Promise.all(namespaces().map(async (n) => providerObject(n, sub, await regState(sub, n))));
    return ok({ value: list });
  }
  const canonical = knownNamespace(ns);
  if (!canonical) throw armError(404, 'InvalidResourceNamespace', `The resource namespace '${ns}' is invalid.`);
  if (!action) return ok(providerObject(canonical, sub, await regState(sub, canonical)));
  const a = action.toLowerCase();
  if (a === 'register' || a === 'unregister') {
    if (!sub) throw armError(400, 'InvalidRequest', 'Provider registration requires a subscription scope.');
    await authorize(ctx, `${canonical}/register/action`, `/subscriptions/${sub}`);
    const state = a === 'register' ? 'Registered' : 'NotRegistered';
    await store.put('providerReg', `${sub}/${canonical}`, { registrationState: state });
    return ok(providerObject(canonical, sub, state));
  }
  if (a === 'checknameavailability') return ok(await checkNameAvailability(canonical, body));
  if (a === 'operations') {
    const types = TYPES.filter((t) => t.type.startsWith(canonical + '/'));
    return ok({ value: types.flatMap((t) => ['read', 'write', 'delete'].map((op) => ({ name: `${t.type}/${op}`, isDataAction: false, display: { provider: canonical, resource: t.label.en, operation: `${op[0].toUpperCase()}${op.slice(1)} ${t.label.en}`, description: `${op} ${t.label.en}` }, origin: 'user,system' }))) });
  }
  throw armError(400, 'InvalidAction', `The provider action '${action}' is not supported.`);
}

export async function checkNameAvailability(ns: string, body: any) {
  const name = String(body?.name ?? '');
  const type = String(body?.type ?? '');
  const candidates = TYPES.filter((t) => t.type.split('/')[0].toLowerCase() === ns.toLowerCase() && t.globalName && !t.type.split('/').slice(2).length);
  const def = candidates.find((t) => t.type.toLowerCase() === type.toLowerCase() || t.type.split('/')[1].toLowerCase() === type.split('/').pop()?.toLowerCase()) ?? candidates[0];
  if (!def) return { nameAvailable: true, available: true };
  if (def.nameRule && !def.nameRule.pattern.test(name)) return { nameAvailable: false, available: false, reason: 'Invalid', message: `${name} ${def.nameRule.message}` };
  const clash = await store.list('resource', { match: { _type: def.type.toLowerCase(), _name: name.toLowerCase() }, limit: 1 });
  if (clash.length) return { nameAvailable: false, available: false, reason: 'AlreadyExists', message: def.globalName!.message(name) };
  return { nameAvailable: true, available: true, reason: null, message: null };
}

// ---------------- locks ----------------

function lockView(l: any) {
  return { id: l.id, type: 'Microsoft.Authorization/locks', name: l.name, properties: l.properties };
}

export async function locks(ctx: ArmCtx, method: string, scope: string, name: string | undefined, body: any, filter?: string): Promise<ArmResult> {
  const scopeKey = (scope || '/').toLowerCase();
  if (!name) {
    if (method !== 'GET') throw armError(405, 'MethodNotAllowed', 'The requested method is not allowed.');
    await authorize(ctx, 'Microsoft.Authorization/locks/read', scope || '/');
    const atScope = /atscope\(\)/i.test(filter ?? '');
    const all = await store.list('lock');
    return ok({ value: all.filter((l) => isAncestorOrSelf(l._scope, scopeKey) || (!atScope && l._scope.startsWith(scopeKey + '/'))).map(lockView) });
  }
  const id = `${scope}/providers/Microsoft.Authorization/locks/${name}`;
  const existing = await store.get('lock', id);
  if (method === 'GET') {
    if (!existing) throw armError(404, 'LockNotFound', `The lock '${name}' could not be found.`);
    await authorize(ctx, 'Microsoft.Authorization/locks/read', scope || '/');
    return ok(lockView(existing));
  }
  if (method === 'DELETE') {
    await authorize(ctx, 'Microsoft.Authorization/locks/delete', scope || '/');
    if (!existing) return { status: 204 };
    await store.remove('lock', id);
    return { status: 200 };
  }
  if (method !== 'PUT') throw armError(405, 'MethodNotAllowed', 'The requested method is not allowed.');
  await authorize(ctx, 'Microsoft.Authorization/locks/write', scope || '/');
  const level = body?.properties?.level;
  if (!['CanNotDelete', 'ReadOnly'].includes(level)) throw armError(400, 'LockLevelInvalid', "The lock level must be 'CanNotDelete' or 'ReadOnly'.");
  await ensureScopeExists(ctx, scope);
  const rec = { id: existing?.id ?? id, name, type: 'Microsoft.Authorization/locks', properties: { level, notes: body.properties.notes ?? null, owners: body.properties.owners ?? [] }, _scope: scopeKey, _scopeOriginal: scope || '/' };
  if (!ctx.dryRun) await store.put('lock', rec.id, rec, scopeKey);
  return ok(lockView(rec), existing ? 200 : 201);
}

async function ensureScopeExists(ctx: ArmCtx, scope: string) {
  const segs = scope.split('/').filter(Boolean);
  if (!segs.length) return;
  const p = idParts(scope);
  if (segs.length === 2) await requireSubscription(p.subscriptionId!);
  else if (segs.length === 4) await requireResourceGroup(p.subscriptionId!, p.resourceGroup!);
  else if (!(await loadResource(ctx, scope))) {
    if (p.subscriptionId && p.resourceGroup) await requireResourceGroup(p.subscriptionId, p.resourceGroup);
    throw armError(404, 'ResourceNotFound', `The Resource '${p.type ?? ''}/${p.name ?? scope}' under resource group '${p.resourceGroup ?? ''}' was not found.`);
  }
}

// ---------------- role assignments & definitions ----------------

export function roleAssignmentRecord(scope: string, name: string, roleGuid: string, principalId: string, principalType: string, by: string | null, description: string | null = null, extra: any = {}) {
  const subPart = idParts(scope).subscriptionId;
  const now = nowIso();
  return {
    id: `${scope === '/' ? '' : scope}/providers/Microsoft.Authorization/roleAssignments/${name}`,
    type: 'Microsoft.Authorization/roleAssignments',
    name,
    properties: {
      roleDefinitionId: `${subPart ? `/subscriptions/${subPart}` : ''}/providers/Microsoft.Authorization/roleDefinitions/${roleGuid}`,
      principalId,
      principalType,
      scope: scope || '/',
      condition: extra.condition ?? null,
      conditionVersion: extra.conditionVersion ?? null,
      createdOn: now,
      updatedOn: now,
      createdBy: by,
      updatedBy: by,
      delegatedManagedIdentityResourceId: extra.delegatedManagedIdentityResourceId ?? null,
      description,
    },
    _scope: (scope || '/').toLowerCase(),
  };
}

function raView(a: any) {
  const { _scope, ...rest } = a;
  return rest;
}

export async function roleAssignments(ctx: ArmCtx, method: string, scope: string, name: string | undefined, body: any, filter?: string): Promise<ArmResult> {
  const scopeKey = (scope || '/').toLowerCase();
  if (!name) {
    if (method !== 'GET') throw armError(405, 'MethodNotAllowed', 'The requested method is not allowed.');
    await authorize(ctx, 'Microsoft.Authorization/roleAssignments/read', scope || '/');
    let all = await store.list('roleAssignment');
    const f = filter ?? '';
    const atScope = /atscope\(\)/i.test(f);
    all = all.filter((a) => isAncestorOrSelf(a._scope, scopeKey) || (!atScope && a._scope.startsWith(scopeKey === '/' ? '/' : scopeKey + '/')));
    const assigned = /assignedTo\('([^']+)'\)/i.exec(f);
    if (assigned) {
      const { groupsOf } = await import('../directory.ts');
      const ids = new Set([assigned[1], ...(await groupsOf(assigned[1]))]);
      all = all.filter((a) => ids.has(a.properties.principalId));
    }
    const pid = /principalId\s+eq\s+'([^']+)'/i.exec(f);
    if (pid) all = all.filter((a) => a.properties.principalId.toLowerCase() === pid[1].toLowerCase());
    const rid = /roleDefinitionId\s+eq\s+'([^']+)'/i.exec(f);
    if (rid) all = all.filter((a) => roleGuidFromId(a.properties.roleDefinitionId) === roleGuidFromId(rid[1]));
    return ok({ value: all.map(raView) });
  }
  const id = `${scope === '/' ? '' : scope}/providers/Microsoft.Authorization/roleAssignments/${name}`;
  const existing = await store.get('roleAssignment', id);
  if (method === 'GET') {
    if (!existing) throw armError(404, 'RoleAssignmentNotFound', `The role assignment '${name}' is not found.`);
    await authorize(ctx, 'Microsoft.Authorization/roleAssignments/read', scope || '/');
    return ok(raView(existing));
  }
  if (method === 'DELETE') {
    if (!existing) return { status: 204 };
    await authorize(ctx, 'Microsoft.Authorization/roleAssignments/delete', scope || '/');
    await checkLocks(ctx, scope || '/', 'delete');
    if (!ctx.dryRun) await store.remove('roleAssignment', id);
    return ok(raView(existing));
  }
  if (method !== 'PUT') throw armError(405, 'MethodNotAllowed', 'The requested method is not allowed.');
  if (!isGuid(name)) throw armError(400, 'InvalidRoleAssignmentId', `The role assignment ID '${name}' is not valid. The role assignment ID must be a GUID.`);
  await authorize(ctx, 'Microsoft.Authorization/roleAssignments/write', scope || '/');
  await checkLocks(ctx, scope || '/', 'write');
  await ensureScopeExists(ctx, scope);
  const p = body?.properties ?? {};
  if (!p.roleDefinitionId || !p.principalId) throw armError(400, 'InvalidRoleAssignmentRequest', "The 'roleDefinitionId' and 'principalId' properties are required.");
  const roleGuid = roleGuidFromId(p.roleDefinitionId);
  const role = await getRoleDefinition(roleGuid);
  if (!role) throw armError(400, 'RoleDefinitionDoesNotExist', `The specified role definition with ID '${roleGuid}' does not exist.`);
  const principal = await principalInfo(p.principalId);
  if (!principal) {
    if (ctx.dryRun) {
      // durante la validazione il principal può essere creato dallo stesso template
    } else {
      throw armError(400, 'PrincipalNotFound', `Principal ${String(p.principalId).replace(/-/g, '')} does not exist in the directory ${tenant().id}. Check that you have the correct principal ID. If you are creating this principal and then immediately assigning a role, this error might be related to a replication delay. In this case, set the role assignment principalType property to a value, such as ServicePrincipal, User, or Group.`);
    }
  }
  const principalType = principal?.type ?? p.principalType ?? 'User';
  if (existing) {
    if (existing.properties.principalId !== p.principalId || roleGuidFromId(existing.properties.roleDefinitionId) !== roleGuid) {
      throw armError(400, 'RoleAssignmentUpdateNotPermitted', 'Tenant ID, application ID, principal ID, and scope are not allowed to be updated.');
    }
    existing.properties.description = p.description ?? existing.properties.description;
    existing.properties.updatedOn = nowIso();
    if (!ctx.dryRun) await store.put('roleAssignment', id, existing, scopeKey);
    return ok(raView(existing));
  }
  const dup = (await store.list('roleAssignment', { parent: scopeKey })).find((a) => a.properties.principalId === p.principalId && roleGuidFromId(a.properties.roleDefinitionId) === roleGuid);
  if (dup) throw armError(409, 'RoleAssignmentExists', 'The role assignment already exists.');
  const rec = roleAssignmentRecord(scope || '/', name, roleGuid, p.principalId, principalType, ctx.principal.oid, p.description ?? null, p);
  if (ctx.dryRun) return ok(raView(rec), 201);
  await store.put('roleAssignment', id, rec, scopeKey);
  const scopeLabel = scope || '/';
  if (principal) {
    const recipients = principal.type === 'ServicePrincipal' ? [] : await expandToUsers([principal.id]);
    notifyLater(recipients, { category: 'access', key: 'roleAssignedToYou', params: { role: role.roleName, scope: scopeLabel }, url: `/iam?scope=${encodeURIComponent(scopeLabel)}` });
    await notifyScope(ctx, scopeLabel, { category: 'access', key: 'roleAssigned', params: { role: role.roleName, principal: principal.displayName, scope: scopeLabel }, url: `/iam?scope=${encodeURIComponent(scopeLabel)}` });
  }
  return ok(raView(rec), 201);
}

export async function roleDefinitions(ctx: ArmCtx, method: string, scope: string, name: string | undefined, body: any, filter?: string): Promise<ArmResult> {
  const scopeKey = (scope || '/').toLowerCase();
  if (!name) {
    if (method !== 'GET') throw armError(405, 'MethodNotAllowed', 'The requested method is not allowed.');
    let defs = (await allRoleDefinitions()).filter((d) => d.type === 'BuiltInRole' || d.assignableScopes.some((s) => isAncestorOrSelf(s, scopeKey) || s.toLowerCase().startsWith(scopeKey + '/')));
    const rn = /roleName\s+eq\s+'([^']+)'/i.exec(filter ?? '');
    if (rn) defs = defs.filter((d) => d.roleName.toLowerCase() === rn[1].toLowerCase());
    const ty = /type\s+eq\s+'([^']+)'/i.exec(filter ?? '');
    if (ty) defs = defs.filter((d) => d.type.toLowerCase() === ty[1].toLowerCase());
    return ok({ value: defs.map((d) => roleDefinitionResource(d, scope || '/')) });
  }
  const existing = await getRoleDefinition(name);
  if (method === 'GET') {
    if (!existing) throw armError(404, 'RoleDefinitionDoesNotExist', `The specified role definition with ID '${name}' does not exist.`);
    return ok(roleDefinitionResource(existing, scope || '/'));
  }
  if (existing?.type === 'BuiltInRole') throw armError(400, 'RoleDefinitionNotUpdatable', 'Built-in role definitions cannot be modified or deleted.');
  if (method === 'DELETE') {
    if (!existing) return { status: 204 };
    await authorize(ctx, 'Microsoft.Authorization/roleDefinitions/delete', scope || '/');
    const used = (await store.list('roleAssignment')).some((a) => roleGuidFromId(a.properties.roleDefinitionId) === name.toLowerCase());
    if (used) throw armError(409, 'RoleDefinitionHasAssignments', 'There are existing role assignments referencing role.');
    await store.remove('roleDefinition', name);
    return ok(roleDefinitionResource(existing, scope || '/'));
  }
  if (method !== 'PUT') throw armError(405, 'MethodNotAllowed', 'The requested method is not allowed.');
  if (!isGuid(name)) throw armError(400, 'InvalidRoleDefinitionId', `The role definition ID '${name}' is not valid. It must be a GUID.`);
  await authorize(ctx, 'Microsoft.Authorization/roleDefinitions/write', scope || '/');
  const p = body?.properties ?? {};
  if (!p.roleName) throw armError(400, 'RoleDefinitionNameNullOrEmpty', 'The role definition name cannot be null or empty.');
  const clash = (await allRoleDefinitions()).find((d) => d.roleName.toLowerCase() === String(p.roleName).toLowerCase() && d.name !== name.toLowerCase());
  if (clash) throw armError(409, 'RoleDefinitionWithSameNameExists', `A custom role with the same name already exists in this directory. Use a different name.`);
  const def: RoleDef = {
    name: name.toLowerCase(),
    roleName: p.roleName,
    description: p.description ?? '',
    type: 'CustomRole',
    permissions: (p.permissions ?? [{}]).map((x: any) => ({ actions: x.actions ?? [], notActions: x.notActions ?? [], dataActions: x.dataActions ?? [], notDataActions: x.notDataActions ?? [] })),
    assignableScopes: p.assignableScopes?.length ? p.assignableScopes : [scope || '/'],
    createdOn: (existing as any)?.createdOn ?? nowIso(),
    updatedOn: nowIso(),
    createdBy: (existing as any)?.createdBy ?? ctx.principal.oid,
    updatedBy: ctx.principal.oid,
  };
  if (!ctx.dryRun) await store.put('roleDefinition', def.name, def);
  return ok(roleDefinitionResource(def, scope || '/'), existing ? 200 : 201);
}

export async function permissions(ctx: ArmCtx, scope: string): Promise<ArmResult> {
  return ok({ value: permissionsAt(await accessOf(ctx), scope || '/') });
}

export async function elevateAccess(ctx: ArmCtx): Promise<ArmResult> {
  if (ctx.principal.kind !== 'user' || !(await isGlobalAdmin(ctx.principal.oid))) throw armError(403, 'AuthorizationFailed', 'Only Global Administrators can elevate access.');
  const uaa = BUILTIN_ROLES.find((r) => r.roleName === 'User Access Administrator')!;
  const existing = (await store.list('roleAssignment', { parent: '/' })).find((a) => a.properties.principalId === ctx.principal.oid && roleGuidFromId(a.properties.roleDefinitionId) === uaa.name);
  if (!existing) {
    const name = uuid();
    const rec = roleAssignmentRecord('/', name, uaa.name, ctx.principal.oid, 'User', ctx.principal.oid, 'Elevated access for Global Administrator');
    await store.put('roleAssignment', rec.id, rec, '/');
  }
  return { status: 200 };
}

// ---------------- activity log ----------------

export async function activityLog(ctx: ArmCtx, sub: string | undefined, filter?: string, select?: string): Promise<ArmResult> {
  if (sub) {
    await requireSubscription(sub);
    await authorize(ctx, 'Microsoft.Insights/eventtypes/values/read', `/subscriptions/${sub}`);
  }
  const events = await queryEvents({ kind: 'activity', subscriptionId: sub, limit: 2000 });
  const access = await accessOf(ctx);
  let items = events.filter((e) => can(access, 'Microsoft.Insights/eventtypes/values/read', e.resourceId) || hasAnyAccessWithin(access, e.resourceId));
  if (filter) {
    const views = items.map((e) => ({
      eventTimestamp: e.eventTimestamp,
      resourceGroupName: e.resourceGroupName,
      resourceUri: e.resourceId,
      resourceId: e.resourceId,
      resourceProvider: e.resourceProviderName?.value,
      status: e.status?.value,
      caller: e.caller,
      correlationId: e.correlationId,
      levels: e.level,
      level: e.level,
      __e: e,
    }));
    const clean = filter.replace(/eventChannels\s+eq\s+'[^']*'/gi, 'true eq true');
    items = applyFilter(views, clean).map((v: any) => v.__e);
  }
  if (select) {
    const fields = select.split(',').map((s) => s.trim());
    items = items.map((e) => Object.fromEntries(fields.map((f) => [f, e[f]])));
  }
  return ok({ value: items });
}

export { listResources };
