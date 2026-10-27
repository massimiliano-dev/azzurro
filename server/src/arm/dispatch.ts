import * as store from '../db/store.ts';
import { costManagement } from '../costs/query.ts';
import { analyzeCustomHostname } from './webapp.ts';
import { paramsFor, paramView, validateParam } from './serverParams.ts';
import { enrichBudget } from '../costs/budgets.ts';
import { HttpError } from '../errors.ts';
import {
  activityLog, elevateAccess, getSubscriptionView, listLocations, listResourceGroups, listSubscriptions, locks, permissions, providers,
  resourceGroup, rgAction, roleAssignments, roleDefinitions, subscriptionAction, subscriptionAlias, tagNames, tagsAtScope, tenantView,
} from './handlers.ts';
import { armError, logActivity, ok, requireResourceGroup, requireSubscription, type ArmCtx, type ArmResult } from './context.ts';
import { actionResource, deleteResource, getResource, headResource, listResources, loadResource, patchResource, putResource, resInfo, scopeKind, vmInstanceView, viewResource } from './generic.ts';
import { bindArmRequest, deleteDeployment, deploymentAction, getDeployment, listDeployments, listOperations, operationStatus, putDeployment } from './deployments.ts';
import { buildId, parseArmPath, type ArmPath } from './path.ts';
import { typeDef } from './catalog.ts';
import { accountModels } from './aimodels.ts';
import { authorize } from './context.ts';
import { diagnosticCategories, metricDefinitions } from './monitoring.ts';
import { listRecordSets } from './network.ts';

const API_VERSION = /^\d{4}-\d{2}-\d{2}(-[a-z]+)?$/i;
const WRITE = new Set(['PUT', 'PATCH', 'DELETE', 'POST']);

type Res = Extract<ArmPath, { k: 'res' }>;

function describe(p: ArmPath, method: string): { operation: string; resourceId: string } | null {
  const verb = method === 'DELETE' ? 'delete' : 'write';
  switch (p.k) {
    case 'resourceGroup':
      return { operation: `Microsoft.Resources/subscriptions/resourceGroups/${verb}`, resourceId: `/subscriptions/${p.sub}/resourceGroups/${p.rg}` };
    case 'rgAction':
      return { operation: `Microsoft.Resources/subscriptions/resourceGroups/${p.action}/action`, resourceId: `/subscriptions/${p.sub}/resourceGroups/${p.rg}` };
    case 'tagNames':
      return { operation: `Microsoft.Resources/subscriptions/tagNames/${verb}`, resourceId: `/subscriptions/${p.sub}` };
    case 'res': {
      if (p.types.length === p.names.length) {
        if (!p.names.length) return null;
        const type = `${typeDef(`${p.ns}/${p.types.join('/')}`)?.type ?? `${p.ns}/${p.types.join('/')}`}`;
        if (type.toLowerCase() === 'microsoft.resources/deployments' && method === 'PUT') return null;
        return { operation: method === 'POST' ? `${type}/action` : `${type}/${verb}`, resourceId: buildId(p.scope, p.ns, p.types, p.names) };
      }
      const action = p.types[p.types.length - 1];
      if (/^(validate|whatif|operations|operationstatuses)$/i.test(action)) return null;
      if (p.ns.toLowerCase() === 'microsoft.costmanagement') return null;
      const parentTypes = p.types.slice(0, -1);
      const type = parentTypes.length ? `${p.ns}/${parentTypes.join('/')}` : p.ns;
      const resourceId = p.names.length ? buildId(p.scope, p.ns, parentTypes, p.names) : `${p.scope}/providers/${p.ns}`;
      return { operation: `${type}/${action}/action`, resourceId };
    }
  }
  return null;
}

export async function armRequest(ctx: ArmCtx, method: string, path: string, query: Record<string, string> | URLSearchParams, body?: any): Promise<ArmResult> {
  const q = query instanceof URLSearchParams ? query : new URLSearchParams(query);
  const apiVersion = q.get('api-version');
  if (!apiVersion) throw armError(400, 'MissingApiVersionParameter', 'The api-version query parameter (?api-version=) is required for all requests.');
  if (!API_VERSION.test(apiVersion)) throw armError(400, 'InvalidApiVersionParameter', `The api-version '${apiVersion}' is invalid. The supported versions are '2024-03-01,2023-07-01,2022-09-01,2021-04-01,2020-06-01'.`);
  const c: ArmCtx = { ...ctx, expand: q.get('$expand') ?? undefined };
  const p = parseArmPath(path.split('?')[0]);
  const desc = WRITE.has(method) && !ctx.dryRun ? describe(p, method) : null;
  try {
    const res = await route(c, method, p, q, body, apiVersion);
    ctx.access ??= c.access;
    if (desc) {
      await logActivity(c, { ...desc, status: res.status >= 400 ? 'Failed' : res.status === 202 ? 'Accepted' : 'Succeeded', httpStatus: res.status });
    }
    return res;
  } catch (e) {
    if (desc && e instanceof HttpError) {
      await logActivity(c, { ...desc, status: 'Failed', httpStatus: e.status, error: { code: e.code, message: e.message } }).catch(() => undefined);
    }
    throw e;
  }
}

bindArmRequest(armRequest);

async function route(ctx: ArmCtx, method: string, p: ArmPath, q: URLSearchParams, body: any, apiVersion: string): Promise<ArmResult> {
  const filter = q.get('$filter') ?? undefined;
  const top = q.get('$top') ? Number(q.get('$top')) : undefined;
  const only = (...m: string[]) => {
    if (!m.includes(method)) throw armError(405, 'MethodNotAllowed', `The requested method '${method}' is not allowed for this resource.`);
  };
  switch (p.k) {
    case 'tenants':
      only('GET');
      return ok({ value: [tenantView()] });
    case 'subscriptions':
      only('GET');
      return listSubscriptions(ctx);
    case 'subscription':
      only('GET');
      return getSubscriptionView(ctx, p.sub);
    case 'locations':
      only('GET');
      return listLocations(ctx, p.sub);
    case 'resources':
      only('GET');
      await requireSubscription(p.sub);
      if (p.rg) await requireResourceGroup(p.sub, p.rg, ctx);
      return ok({ value: await listResources(ctx, { sub: p.sub, rg: p.rg, filter, top }) });
    case 'resourceGroups':
      only('GET');
      return listResourceGroups(ctx, p.sub, filter, top);
    case 'resourceGroup':
      return resourceGroup(ctx, method, p.sub, p.rg, body);
    case 'rgAction':
      only('POST');
      return rgAction(ctx, p.sub, p.rg, p.action, body);
    case 'tagNames':
      return tagNames(ctx, method, p.sub, p.name, p.value);
    case 'providers':
      only('GET');
      return providers(ctx, p.sub, undefined, method);
    case 'res':
      return routeRes(ctx, method, p, q, body, apiVersion, filter, top);
  }
}

async function routeRes(ctx: ArmCtx, method: string, p: Res, q: URLSearchParams, body: any, apiVersion: string, filter?: string, top?: number): Promise<ArmResult> {
  const ns = p.ns.toLowerCase();
  const t0 = p.types[0]?.toLowerCase();
  const tl = p.types.length;
  const n = p.names.length;
  const scope = p.scope;

  if (tl === 0) {
    if (method !== 'GET') throw armError(405, 'MethodNotAllowed', 'The requested method is not allowed.');
    return providers(ctx, p.sub, p.ns, method);
  }

  // ---- Microsoft.Subscription ----
  if (ns === 'microsoft.subscription') {
    if (t0 === 'aliases' && tl === 1 && scope === '') return subscriptionAlias(ctx, method, p.names[0], body);
    if (tl === 1 && n === 0 && p.sub && method === 'POST' && ['rename', 'cancel', 'enable'].includes(t0)) return subscriptionAction(ctx, p.sub, t0, body);
  }

  // ---- Microsoft.Resources ----
  if (ns === 'microsoft.resources') {
    if (t0 === 'deployments') {
      const name = p.names[0];
      if (tl === 1 && n === 0) {
        if (method !== 'GET') throw armError(405, 'MethodNotAllowed', 'The requested method is not allowed.');
        return listDeployments(ctx, scope, filter, top);
      }
      if (tl === 1 && n === 1) {
        if (method === 'PUT') return putDeployment(ctx, scope, name, body, apiVersion);
        if (method === 'GET' || method === 'HEAD') return getDeployment(ctx, scope, name, method);
        if (method === 'DELETE') return deleteDeployment(ctx, scope, name);
        throw armError(405, 'MethodNotAllowed', 'The requested method is not allowed.');
      }
      const sub = p.types[1].toLowerCase();
      if (tl === 2 && n === 1) {
        if (sub === 'operations' && method === 'GET') return listOperations(ctx, scope, name);
        if (method === 'POST') return deploymentAction(ctx, scope, name, p.types[1], body);
      }
      if (tl === 2 && n === 2) {
        if (sub === 'operations') return listOperations(ctx, scope, name, p.names[1]);
        if (sub === 'operationstatuses') return operationStatus(ctx, p.names[1]);
      }
    }
    if (t0 === 'tags' && tl === 1 && n === 1) return tagsAtScope(ctx, method, scope, body);
    if ((t0 === 'operationstatuses' || t0 === 'operationresults') && n === 1) return operationStatus(ctx, p.names[0]);
    if (t0 === 'checkresourcename' && method === 'POST') {
      return ok({ name: body?.name, type: body?.type, status: /^(login|microsoft|windows|azure|xbox|office)/i.test(String(body?.name ?? '')) ? 'Reserved' : 'Allowed' });
    }
  }

  // ---- Microsoft.Authorization ----
  if (ns === 'microsoft.authorization' && tl === 1) {
    if (t0 === 'roleassignments') return roleAssignments(ctx, method, scope, p.names[0], body, filter);
    if (t0 === 'roledefinitions') return roleDefinitions(ctx, method, scope, p.names[0], body, filter);
    if (t0 === 'locks') return locks(ctx, method, scope, p.names[0], body, filter);
    if (t0 === 'permissions' && n === 0) return permissions(ctx, scope);
    if (t0 === 'elevateaccess' && method === 'POST') return elevateAccess(ctx);
    if ((t0 === 'classicadministrators' || t0 === 'denyassignments' || t0 === 'roleeligibilityscheduleinstances' || t0 === 'roleassignmentscheduleinstances') && n === 0) return ok({ value: [] });
  }

  // ---- Activity log ----
  if (ns === 'microsoft.insights' && t0 === 'eventtypes') {
    if (method !== 'GET') throw armError(405, 'MethodNotAllowed', 'The requested method is not allowed.');
    return activityLog(ctx, p.sub, filter, q.get('$select') ?? undefined);
  }

  // ---- Cost Management ----
  if (ns === 'microsoft.costmanagement' && tl === 1 && n === 0) return costManagement(ctx, method, scope, p.types[0], body);

  // ---- budget: spesa attuale e prevista calcolate alla lettura ----
  if (ns === 'microsoft.consumption' && t0 === 'budgets' && method === 'GET') {
    const res = tl === n ? await getResource(ctx, resInfo(p)) : null;
    if (res) return { ...res, body: await enrichBudget(res.body) };
    if (n === 0) {
      if (scopeKind(scope) === 'resourceGroup') await requireResourceGroup(p.sub!, p.rg!, ctx);
      await authorize(ctx, 'Microsoft.Consumption/budgets/read', scope);
      const recs = await store.list('resource', { prefix: `${scope.toLowerCase()}/providers/microsoft.consumption/budgets/` });
      const value = await Promise.all(recs.filter((r: any) => !r.name.includes('/')).map(async (r: any) => enrichBudget(await viewResource(ctx, r))));
      return ok({ value });
    }
  }

  // ---- Azure Monitor sulla risorsa: categorie di diagnostica e definizioni delle metriche ----
  if (ns === 'microsoft.insights' && tl === 1 && (t0 === 'diagnosticsettingscategories' || t0 === 'metricdefinitions') && scopeKind(scope) === 'resource') {
    if (method !== 'GET') throw armError(405, 'MethodNotAllowed', 'The requested method is not allowed.');
    const res = await loadResource(ctx, scope);
    if (!res) throw armError(404, 'ResourceNotFound', `The Resource '${scope}' was not found.`);
    await authorize(ctx, `${res.type}/read`, res.id);
    return ok(t0 === 'metricdefinitions' ? metricDefinitions(res) : diagnosticCategories(res, p.names[0]));
  }

  // ---- azioni a livello di provider ----
  if (tl === 1 && n === 0) {
    if (method === 'POST') return providers(ctx, p.sub, p.ns, method, p.types[0], body);
    if (t0 === 'operations') return providers(ctx, p.sub, p.ns, method, 'operations');
    if (method === 'GET') {
      const type = `${typeDef(`${p.ns}/${p.types[0]}`)?.type ?? `${p.ns}/${p.types[0]}`}`;
      const kind = scopeKind(scope);
      if (kind === 'resourceGroup') await requireResourceGroup(p.sub!, p.rg!, ctx);
      const value = kind === 'resource'
        ? await listResources(ctx, { extScope: scope, type })
        : kind === 'tenant' ? await listResources(ctx, { type, tenantScope: true }) : await listResources(ctx, { sub: p.sub, rg: p.rg, type, filter, top });
      return ok({ value });
    }
  }

  // ---- parametri server di PostgreSQL / MySQL flessibili: valori predefiniti + modifiche ----
  if (/^microsoft\.dbfor(postgresql|mysql)$/.test(ns) && p.types[0]?.toLowerCase() === 'flexibleservers' && p.types[1]?.toLowerCase() === 'configurations' && n >= 1) {
    const serverId = buildId(scope, p.ns, ['flexibleServers'], [p.names[0]]);
    const server = await loadResource(ctx, serverId);
    if (!server) return getResource(ctx, resInfo({ scope, ns: p.ns, types: ['flexibleServers'], names: [p.names[0]] }));
    const type = `${p.ns}/flexibleServers`;
    const params = paramsFor(type);
    if (n === 1 && method === 'GET') {
      await authorize(ctx, `${type}/configurations/read`, serverId);
      const stored = await store.list('resource', { parent: serverId.toLowerCase(), match: { _type: `${type}/configurations`.toLowerCase() } });
      return ok({ value: params.map((pp) => paramView(serverId, type, pp, stored.find((x: any) => x.name.toLowerCase() === pp.name.toLowerCase()))) });
    }
    if (n === 2) {
      const pp = params.find((x) => x.name.toLowerCase() === p.names[1].toLowerCase());
      if (!pp) throw armError(404, 'ConfigurationNotExists', `The configuration '${p.names[1]}' does not exist for server '${p.names[0]}'.`);
      const cfgId = `${serverId}/configurations/${pp.name}`;
      if (method === 'GET') {
        await authorize(ctx, `${type}/configurations/read`, serverId);
        return ok(paramView(serverId, type, pp, await store.get('resource', cfgId)));
      }
      if (method === 'PUT' || method === 'PATCH') {
        const value = String(body?.properties?.value ?? pp.value);
        const err = validateParam(pp, value);
        if (err) throw armError(400, 'InvalidParameterValue', err);
        await putResource(ctx, resInfo(p), { properties: { value, source: 'user-override' } }, apiVersion);
        return ok(paramView(serverId, type, pp, await store.get('resource', cfgId)));
      }
    }
  }

  // ---- azioni con nome nel percorso: chiavi di Azure AI Search ----
  if (ns === 'microsoft.search' && p.types[0]?.toLowerCase() === 'searchservices' && tl === 2 && n === 2) {
    const op = p.types[1].toLowerCase();
    const parent = resInfo({ scope, ns: p.ns, types: ['searchServices'], names: [p.names[0]] });
    if (op === 'createquerykey' && method === 'POST') return actionResource(ctx, parent, 'createQueryKey', { _name: p.names[1] });
    if (op === 'deletequerykey' && method === 'DELETE') return actionResource(ctx, parent, 'deleteQueryKey', { _name: p.names[1] });
    if (op === 'regenerateadminkey' && method === 'POST') return actionResource(ctx, parent, 'regenerateAdminKey', { _name: p.names[1] });
  }

  // ---- impostazioni delle app Web statiche: lettura con listAppSettings / listFunctionAppSettings ----
  if (ns === 'microsoft.web' && p.types[0]?.toLowerCase() === 'staticsites' && tl === 2 && n === 1 && method === 'POST' && /^list(function)?appsettings$/i.test(p.types[1])) {
    const siteId = buildId(scope, p.ns, ['staticSites'], [p.names[0]]);
    const site = await loadResource(ctx, siteId);
    if (!site) return getResource(ctx, resInfo({ scope, ns: p.ns, types: ['staticSites'], names: [p.names[0]] }));
    await authorize(ctx, `Microsoft.Web/staticSites/${p.types[1]}/action`, siteId);
    const which = /function/i.test(p.types[1]) ? 'functionappsettings' : 'appsettings';
    const cfg = await loadResource(ctx, `${siteId}/config/${which}`);
    const { provisioningState: _ps, ...settings } = cfg?.properties ?? {};
    return ok({ id: `${siteId}/config/${which}`, name: which, type: 'Microsoft.Web/staticSites/config', location: site.location, properties: settings });
  }

  // ---- risorse generiche ----
  if (tl === n) {
    const info = resInfo(p);
    switch (method) {
      case 'PUT': return putResource(ctx, info, body, apiVersion);
      case 'GET': return getResource(ctx, info);
      case 'HEAD': return headResource(ctx, info);
      case 'PATCH': return patchResource(ctx, info, body, apiVersion);
      case 'DELETE': return deleteResource(ctx, info);
    }
    throw armError(405, 'MethodNotAllowed', 'The requested method is not allowed.');
  }
  if (tl === n + 1) {
    const parent = resInfo({ scope, ns: p.ns, types: p.types.slice(0, -1), names: p.names });
    const last = p.types[p.types.length - 1];
    if (method === 'POST') return actionResource(ctx, parent, last, body);
    if (method === 'GET') {
      const rec = await loadResource(ctx, parent.id);
      if (!rec) return getResource(ctx, parent);
      await authorize(ctx, `${parent.type}/read`, parent.id);
      if (last.toLowerCase() === 'instanceview' && parent.type === 'Microsoft.Compute/virtualMachines') return ok(vmInstanceView(rec));
      if (/^(recordsets|all)$/i.test(last) && /^Microsoft\.Network\/(privateDnsZones|dnsZones)$/i.test(parent.type)) {
        return ok({ value: await Promise.all((await listRecordSets(parent.id)).map((r) => viewResource(ctx, r))) });
      }
      if (last.toLowerCase() === 'models' && parent.type === 'Microsoft.CognitiveServices/accounts') return ok({ value: accountModels(rec.kind) });
      if (last.toLowerCase() === 'analyzecustomhostname' && parent.type === 'Microsoft.Web/sites') {
        const hostName = q.get('hostName') ?? '';
        if (!hostName) throw armError(400, 'BadRequest', "The parameter 'hostName' is required.");
        return ok(await analyzeCustomHostname(rec, hostName, rec.properties.inboundIpAddress ?? ''));
      }
      const childType = `${parent.type}/${last}`;
      const canonical = typeDef(childType)?.type ?? childType;
      const value = await listResources(ctx, { parentId: parent.id, type: canonical, filter, top });
      // figli impliciti (es. blobServices/default, sites/config/web)
      const def = typeDef(canonical);
      if (def?.implicit && !value.length) {
        const implicitName = canonical.endsWith('/config') ? 'web' : 'default';
        const virt = await loadResource(ctx, `${parent.id}/${last}/${implicitName}`);
        if (virt) value.push(await viewResource(ctx, virt));
      }
      return ok({ value });
    }
  }
  throw armError(400, 'InvalidResourceType', `The resource type '${p.types.join('/')}' could not be found in the namespace '${p.ns}' for api version '${apiVersion}'.`);
}
