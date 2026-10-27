import { defaultSiteConfig, syncSiteHostnames } from './webapp.ts';
import * as store from '../db/store.ts';
import { tenant } from '../directory.ts';
import { nowIso, uniqueString, uuid, uuidV5 } from '../ids.ts';
import { createManagedIdentity, deleteServicePrincipal } from '../graph/objects.ts';
import { applyFilter } from '../odata.ts';
import { typeDef, type BuildCtx, type TypeDef } from './catalog.ts';
import {
  accessOf, armError, authorize, checkLocks, logActivity, notifyScope, ok, requireResourceGroup, requireSubscription, systemData,
  type ArmCtx, type ArmResult,
} from './context.ts';
import { normalizeLocation, LOCATIONS } from './locations.ts';
import { buildId, idParts, parseArmPath, rgId } from './path.ts';
import { can } from './rbac.ts';

export interface ResPath {
  scope: string;
  ns: string;
  types: string[];
  names: string[];
}

type ScopeKind = 'tenant' | 'subscription' | 'resourceGroup' | 'resource';

export function scopeKind(scope: string): ScopeKind {
  const segs = scope.split('/').filter(Boolean);
  if (!segs.length) return 'tenant';
  if (segs.length === 2 && segs[0].toLowerCase() === 'subscriptions') return 'subscription';
  if (segs.length === 4 && segs[2].toLowerCase() === 'resourcegroups') return 'resourceGroup';
  return 'resource';
}

export interface ResInfo {
  id: string;
  type: string;
  def?: TypeDef;
  name: string;
  names: string[];
  child: boolean;
  ext: boolean;
  parentId: string | null;
  kind: ScopeKind;
  sub?: string;
  rg?: string;
  parentKey: string;
}

export function resInfo(p: ResPath): ResInfo {
  const id = buildId(p.scope, p.ns, p.types, p.names);
  const rawType = `${p.ns}/${p.types.join('/')}`;
  const def = typeDef(rawType);
  const kind = scopeKind(p.scope);
  const ids = idParts(p.scope);
  const child = p.names.length > 1;
  const parentId = child ? buildId(p.scope, p.ns, p.types.slice(0, -1), p.names.slice(0, -1)) : null;
  return {
    id, type: def?.type ?? rawType, def, name: p.names[p.names.length - 1], names: p.names, child, ext: kind === 'resource', parentId, kind,
    sub: ids.subscriptionId, rg: ids.resourceGroup,
    parentKey: parentId ?? (p.scope || '/'),
  };
}

export function infoFromId(id: string): ResInfo | null {
  try {
    const p = parseArmPath(id);
    if (p.k !== 'res' || p.types.length !== p.names.length || !p.names.length) return null;
    return resInfo(p);
  } catch {
    return null;
  }
}

function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

function deletePath(obj: any, path: string) {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts.slice(0, -1)) {
    if (cur == null || typeof cur !== 'object') return;
    cur = cur[p];
  }
  if (cur && typeof cur === 'object') delete cur[parts[parts.length - 1]];
}

function deepMerge(a: any, b: any): any {
  if (b === undefined) return a;
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = deepMerge(a[k], v);
    return out;
  }
  return b;
}

/** Risorsa (salvata, simulata nel dry-run, o implicita come blobServices/default). */
export async function loadResource(ctx: ArmCtx, id: string): Promise<any | null> {
  const key = id.toLowerCase();
  if (ctx.plan?.has(key)) return ctx.plan.get(key);
  const r = await store.get('resource', id);
  if (r) return r;
  const info = infoFromId(id);
  if (info?.def?.implicit && info.parentId && (await loadResource(ctx, info.parentId))) {
    return { id, name: info.name, type: info.type, properties: {}, _implicit: true, _type: info.type.toLowerCase() };
  }
  return null;
}

function notFound(info: ResInfo): Error {
  const where = info.rg ? ` under resource group '${info.rg}'` : '';
  return armError(404, 'ResourceNotFound', `The Resource '${info.type}/${info.names.join('/')}'${where} was not found. For more details please go to https://aka.ms/ARMResourceNotFoundFix`);
}

export async function viewResource(ctx: ArmCtx, rec: any): Promise<any> {
  const def = typeDef(rec.type);
  const out: any = {};
  for (const [k, v] of Object.entries(rec)) if (!k.startsWith('_')) out[k] = clone(v);
  for (const path of def?.writeOnly ?? []) deletePath(out, path);
  for (const ic of def?.inlineChildren ?? []) {
    const childType = `${rec.type}/${ic.type}`.toLowerCase();
    const kids = await store.list('resource', { parent: rec.id, match: { _type: childType } });
    if (ctx.plan) {
      const prefix = rec.id.toLowerCase() + '/';
      for (const [k, v] of ctx.plan) {
        if (v._type === childType && k.startsWith(prefix) && !k.slice(prefix.length).includes('/', ic.type.length + 1)) {
          const i = kids.findIndex((x) => x.id.toLowerCase() === k);
          if (i >= 0) kids[i] = v;
          else kids.push(v);
        }
      }
    }
    out.properties ??= {};
    out.properties[ic.prop] = await Promise.all(kids.map((k) => viewResource(ctx, k)));
  }
  const expand = (ctx.expand ?? '').toLowerCase();
  if (expand.includes('createdtime')) out.createdTime = rec._created ?? null;
  if (expand.includes('changedtime')) out.changedTime = rec._changed ?? null;
  if (expand.includes('provisioningstate')) out.provisioningState = rec.properties?.provisioningState ?? 'Succeeded';
  if (def?.type === 'Microsoft.Compute/virtualMachines' && expand.includes('instanceview')) out.properties.instanceView = vmInstanceView(rec);
  return out;
}

export function vmInstanceView(rec: any) {
  const power = rec._power ?? 'running';
  const display: Record<string, string> = { running: 'VM running', stopped: 'VM stopped', deallocated: 'VM deallocated', generalized: 'VM generalized' };
  return {
    computerName: rec.properties?.osProfile?.computerName ?? rec.name,
    osName: rec.properties?.storageProfile?.imageReference?.offer ?? 'Linux',
    osVersion: rec.properties?.storageProfile?.imageReference?.sku ?? '',
    vmAgent: { vmAgentVersion: '2.10.0.8', statuses: [{ code: 'ProvisioningState/succeeded', level: 'Info', displayStatus: 'Ready', message: 'Guest Agent is running', time: nowIso() }] },
    disks: [{ name: rec.properties?.storageProfile?.osDisk?.name, statuses: [{ code: 'ProvisioningState/succeeded', level: 'Info', displayStatus: 'Provisioning succeeded', time: rec.properties?.timeCreated }] }],
    hyperVGeneration: 'V2',
    statuses: [
      { code: 'ProvisioningState/succeeded', level: 'Info', displayStatus: 'Provisioning succeeded', time: rec.properties?.timeCreated },
      { code: `PowerState/${power}`, level: 'Info', displayStatus: display[power] ?? power },
    ],
  };
}

const RG_NAME = /^[-\w._()]{1,90}$/;

function validateName(info: ResInfo) {
  const n = info.name;
  const rule = info.def?.nameRule;
  if (rule) {
    if (!rule.pattern.test(n)) throw armError(400, rule.code, `${n} ${rule.message}`.trim());
    return;
  }
  if (!n || n.length > 260 || /[<>%&\\?/]/.test(n) || n.endsWith('.') || n.endsWith(' ')) {
    throw armError(400, 'InvalidResourceName', `The resource name '${n}' for type '${info.type}' is not valid.`);
  }
}

async function ensureScope(ctx: ArmCtx, info: ResInfo, forWrite: boolean): Promise<any | null> {
  if (info.sub) await requireSubscription(info.sub, forWrite);
  if (info.kind === 'resourceGroup') await requireResourceGroup(info.sub!, info.rg!, ctx);
  if (info.kind === 'resource') {
    const scopeId = info.id.slice(0, info.id.toLowerCase().lastIndexOf('/providers/'));
    const parent = await loadResource(ctx, scopeId);
    if (!parent) {
      const pi = infoFromId(scopeId);
      if (pi) throw notFound(pi);
      throw armError(404, 'ResourceNotFound', `The resource '${scopeId}' was not found.`);
    }
  }
  if (info.parentId) {
    const parent = await loadResource(ctx, info.parentId);
    if (!parent) {
      throw armError(404, 'ParentResourceNotFound', `Can not perform requested operation on nested resource. Parent resource '${info.names.slice(0, -1).join('/')}' not found.`);
    }
    return parent;
  }
  return null;
}

async function ensureRegistered(ctx: ArmCtx, info: ResInfo) {
  if (!info.sub) return;
  const ns = info.type.split('/')[0];
  const reg = await store.get('providerReg', `${info.sub}/${ns}`);
  if (reg?.registrationState === 'NotRegistered') {
    throw armError(409, 'MissingSubscriptionRegistration', `The subscription is not registered to use namespace '${ns}'. See https://aka.ms/rps-not-found for how to register subscriptions.`);
  }
}

function buildCtx(info: ResInfo, location: string | undefined, existing: any): BuildCtx {
  return { id: info.id, name: existing?.name ?? info.name, names: info.names, sub: info.sub ?? '', rg: info.rg, location, tenantId: tenant().id, now: nowIso(), existing };
}

const TOP_KEYS = ['location', 'tags', 'sku', 'kind', 'identity', 'plan', 'zones', 'managedBy', 'extendedLocation', 'scale'];

/** Costruisce il documento della risorsa (senza effetti collaterali). */
function buildRecord(ctx: ArmCtx, info: ResInfo, body: any, existing: any, parent: any, apiVersion: string): any {
  const b = clone(body ?? {});
  const def = info.def;
  const tracked = def ? (def.tracked ?? (!info.child && !info.ext && info.kind !== 'tenant')) : b.location !== undefined;
  let location: string | undefined;
  if (def?.global) {
    location = 'global';
  } else if (tracked) {
    const raw = b.location ?? (info.child ? parent?.location : undefined) ?? existing?.location;
    if (raw === undefined || raw === null || raw === '') throw armError(400, 'LocationRequired', 'The location property is required for this definition.');
    const n = normalizeLocation(raw);
    if (!n) {
      throw armError(400, 'LocationNotAvailableForResourceType', `The provided location '${raw}' is not available for resource type '${info.type}'. List of available regions for the resource type is '${LOCATIONS.map((l) => l.name).join(',')}'.`);
    }
    location = n;
  } else if (b.location) {
    location = normalizeLocation(b.location) ?? String(b.location);
  }
  if (existing?.location && location && existing.location !== location && !def?.global) {
    throw armError(400, 'InvalidResourceLocation', `The resource '${info.name}' already exists in location '${existing.location}' in resource group '${info.rg ?? ''}'. A resource with the same name cannot be created in location '${location}'. Please select a new resource name.`);
  }
  b.properties = b.properties && typeof b.properties === 'object' ? b.properties : {};
  if (location) b.location = location;
  const bctx = buildCtx(info, location, existing);
  def?.defaults?.(b, bctx);
  const rec: any = { id: existing?.id ?? info.id, name: existing?.name ?? info.name, type: info.type };
  for (const k of TOP_KEYS) if (b[k] !== undefined) rec[k] = b[k];
  if (tracked && rec.tags === undefined) rec.tags = existing?.tags ?? {};
  for (const [k, v] of Object.entries(b)) {
    if (!['id', 'name', 'type', 'properties', 'apiVersion', 'dependsOn', 'condition', 'copy', 'comments', 'scope', ...TOP_KEYS].includes(k) && !k.startsWith('_')) rec[k] = v;
  }
  rec.properties = { ...b.properties, provisioningState: 'Succeeded' };
  def?.computed?.(rec, bctx);
  rec.systemData = systemData(ctx, existing);
  rec._type = info.type.toLowerCase();
  rec._name = rec.name.toLowerCase();
  rec._sub = info.sub?.toLowerCase() ?? null;
  rec._rg = info.rg?.toLowerCase() ?? null;
  rec._child = info.child;
  rec._ext = info.ext;
  rec._apiVersion = apiVersion;
  rec._created = existing?._created ?? nowIso();
  rec._changed = nowIso();
  rec._secrets = existing?._secrets ?? def?.secrets?.(bctx);
  for (const k of Object.keys(existing ?? {})) if (k.startsWith('_') && rec[k] === undefined) rec[k] = existing[k];
  if (rec._secrets === undefined) delete rec._secrets;
  return rec;
}

async function persist(ctx: ArmCtx, info: ResInfo, rec: any) {
  if (ctx.dryRun) {
    ctx.plan ??= new Map();
    ctx.plan.set(info.id.toLowerCase(), rec);
    return;
  }
  await store.put('resource', rec.id, rec, info.parentKey);
}

// ---------------- hooks ----------------

async function applyIdentity(ctx: ArmCtx, rec: any, existing: any) {
  if (!rec.identity) {
    if (existing?._miSp && !ctx.dryRun) await deleteServicePrincipal(existing._miSp);
    delete rec._miSp;
    return;
  }
  const t = String(rec.identity.type ?? 'None');
  const sys = /systemassigned/i.test(t);
  const user = /userassigned/i.test(t);
  if (sys) {
    let spId = existing?._miSp;
    if (!spId) {
      if (ctx.dryRun) spId = uuidV5(rec.id, '6ba7b811-9dad-11d1-80b4-00c04fd430c8');
      else spId = (await createManagedIdentity(rec.name, rec.id, false)).id;
    }
    rec._miSp = spId;
    rec.identity.principalId = spId;
    rec.identity.tenantId = tenant().id;
  } else {
    if (existing?._miSp && !ctx.dryRun) await deleteServicePrincipal(existing._miSp);
    delete rec._miSp;
    delete rec.identity.principalId;
    delete rec.identity.tenantId;
  }
  if (user) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(rec.identity.userAssignedIdentities ?? {})) {
      const uami = await loadResource(ctx, key);
      if (!uami) throw armError(400, 'InvalidUserAssignedIdentity', `Resource '${key}' was not found.`);
      out[uami.id] = { principalId: uami.properties.principalId, clientId: uami.properties.clientId };
    }
    rec.identity.userAssignedIdentities = out;
  } else {
    delete rec.identity.userAssignedIdentities;
  }
}

/** Dischi dati della VM: nuovi vuoti, collegati da dischi esistenti, scollegati quando spariscono dall'elenco. */
async function syncVmDataDisks(ctx: ArmCtx, info: ResInfo, rec: any, existing: any) {
  const sp = rec.properties.storageProfile ??= {};
  const disks: any[] = sp.dataDisks ?? [];
  const luns = new Set<number>();
  for (const dd of disks) {
    const lun = Number(dd.lun);
    if (!Number.isInteger(lun) || lun < 0 || lun > 63) throw armError(400, 'InvalidParameter', 'The value of parameter dataDisk.lun is invalid: it must be an integer between 0 and 63.');
    if (luns.has(lun)) throw armError(400, 'InvalidParameter', `A disk at LUN ${lun} already exists.`);
    luns.add(lun);
    const opt = String(dd.createOption ?? 'Empty');
    if (opt.toLowerCase() === 'empty' && !dd.managedDisk?.id) {
      const size = Number(dd.diskSizeGB);
      if (!Number.isInteger(size) || size < 1 || size > 32767) throw armError(400, 'InvalidParameter', 'The value of parameter dataDisk.diskSizeGB is invalid.');
      const name = dd.name ?? `${rec.name}_DataDisk_${lun}`;
      const diskId = `${rgId(info.sub!, info.rg!)}/providers/Microsoft.Compute/disks/${name}`;
      if (!ctx.dryRun) await internalPut(ctx, diskId, { location: rec.location, managedBy: rec.id, sku: { name: dd.managedDisk?.storageAccountType ?? 'Premium_LRS' }, properties: { creationData: { createOption: 'Empty' }, diskSizeGB: size } }, '2023-04-02');
      Object.assign(dd, { name, createOption: 'Empty', caching: dd.caching ?? 'None', deleteOption: dd.deleteOption ?? 'Detach', toBeDetached: false, managedDisk: { storageAccountType: dd.managedDisk?.storageAccountType ?? 'Premium_LRS', id: diskId } });
    } else if (opt.toLowerCase() === 'attach') {
      const disk = dd.managedDisk?.id ? await store.get('resource', dd.managedDisk.id) : null;
      if (!disk) throw armError(404, 'NotFound', `Disk '${dd.managedDisk?.id ?? dd.name}' was not found.`);
      if (disk.managedBy && disk.managedBy.toLowerCase() !== rec.id.toLowerCase()) throw armError(409, 'OperationNotAllowed', `Disk '${disk.name}' is already attached to VM '${disk.managedBy}'.`);
      if (!ctx.dryRun && !disk.managedBy) {
        disk.managedBy = rec.id;
        disk.properties.diskState = 'Attached';
        await store.put('resource', disk.id, disk, infoFromId(disk.id)!.parentKey);
      }
      Object.assign(dd, { name: disk.name, createOption: 'Attach', caching: dd.caching ?? 'None', deleteOption: dd.deleteOption ?? 'Detach', toBeDetached: false, diskSizeGB: disk.properties?.diskSizeGB, managedDisk: { storageAccountType: disk.sku?.name, id: disk.id } });
    }
  }
  sp.dataDisks = disks;
  if (ctx.dryRun) return;
  const keep = new Set(disks.map((d) => String(d.managedDisk?.id ?? '').toLowerCase()));
  for (const old of existing?.properties?.storageProfile?.dataDisks ?? []) {
    const id = old.managedDisk?.id;
    if (!id || keep.has(id.toLowerCase())) continue;
    const d = await store.get('resource', id);
    if (!d) continue;
    if (old.deleteOption === 'Delete') await store.removeTree('resource', id);
    else { delete d.managedBy; d.properties.diskState = 'Unattached'; await store.put('resource', d.id, d, infoFromId(d.id)!.parentKey); }
  }
}

/** Pool di nodi AKS: le risorse figlie agentPools e agentPoolProfiles del cluster restano allineate. */
const POOL_KEYS = ['name', 'provisioningState', 'powerState'];
function poolProfile(name: string, props: any, version: string) {
  const p = Object.fromEntries(Object.entries(props ?? {}).filter(([k]) => !POOL_KEYS.includes(k)));
  return { name, ...p, provisioningState: 'Succeeded', powerState: { code: 'Running' }, orchestratorVersion: p.orchestratorVersion ?? version, currentOrchestratorVersion: p.orchestratorVersion ?? version };
}

async function poolScaleSet(ctx: ArmCtx, cluster: any, pool: string, vmSize: string | null, count: number) {
  const sub = idParts(cluster.id).subscriptionId!;
  const nodeRgId = rgId(sub, cluster.properties?.nodeResourceGroup ?? '');
  if (!(await store.get('resourceGroup', nodeRgId))) return;
  const id = `${nodeRgId}/providers/Microsoft.Compute/virtualMachineScaleSets/aks-${pool}-${uniqueString(cluster.id).slice(0, 8)}-vmss`;
  if (vmSize === null) { await store.removeTree('resource', id); return; }
  await internalPut(ctx, id, { location: cluster.location, sku: { name: vmSize, capacity: count, tier: 'Standard' }, properties: { orchestrationMode: 'Uniform' } }, '2023-09-01');
}

async function syncAgentPoolsFromCluster(ctx: ArmCtx, rec: any) {
  const version = rec.properties.kubernetesVersion;
  const names = new Set<string>();
  for (const p of rec.properties.agentPoolProfiles ?? []) {
    names.add(String(p.name).toLowerCase());
    const id = `${rec.id}/agentPools/${p.name}`;
    const cur = await store.get('resource', id);
    const props = Object.fromEntries(Object.entries(poolProfile(p.name, p, version)).filter(([k]) => k !== 'name'));
    if (cur) { cur.properties = { ...cur.properties, ...props }; await store.put('resource', id, cur, rec.id); }
    else await internalPut(ctx, id, { properties: props }, '2024-09-01');
    await poolScaleSet(ctx, rec, p.name, p.vmSize, Number(p.count));
  }
  for (const k of await store.list('resource', { parent: rec.id, match: { _type: 'microsoft.containerservice/managedclusters/agentpools' } })) {
    if (!names.has(k.name.toLowerCase())) { await store.removeTree('resource', k.id); await poolScaleSet(ctx, rec, k.name, null, 0); }
  }
}

async function syncClusterFromPool(ctx: ArmCtx, info: ResInfo, rec: any, remove = false) {
  const cluster = await store.get('resource', info.parentId!);
  if (!cluster) return;
  const same = (p: any) => String(p.name).toLowerCase() === rec.name.toLowerCase();
  const list: any[] = cluster.properties.agentPoolProfiles ?? [];
  const next = poolProfile(rec.name, rec.properties, cluster.properties.kubernetesVersion);
  cluster.properties.agentPoolProfiles = remove ? list.filter((p) => !same(p)) : list.some(same) ? list.map((p) => (same(p) ? next : p)) : [...list, next];
  if (!remove && !rec.properties.currentOrchestratorVersion) {
    Object.assign(rec.properties, { orchestratorVersion: next.orchestratorVersion, currentOrchestratorVersion: next.currentOrchestratorVersion });
    await store.put('resource', rec.id, rec, cluster.id);
  }
  await store.put('resource', cluster.id, cluster, infoFromId(cluster.id)!.parentKey);
  await poolScaleSet(ctx, cluster, rec.name, remove ? null : rec.properties.vmSize, Number(rec.properties.count));
}

/** Revisioni delle app contenitore: una per ogni modello, in modalità Single resta attiva solo l'ultima. */
async function syncRevisions(ctx: ArmCtx, rec: any) {
  const name = rec.properties.latestRevisionName;
  if (!name) return;
  const id = `${rec.id}/revisions/${name}`;
  const single = (rec.properties.configuration?.activeRevisionsMode ?? 'Single') === 'Single';
  const minReplicas = Number(rec.properties.template?.scale?.minReplicas ?? 0);
  if (!(await store.get('resource', id))) {
    await internalPut(ctx, id, { properties: { createdTime: nowIso(), lastActiveTime: nowIso(), fqdn: rec.properties.latestRevisionFqdn ?? '', template: rec.properties.template ?? {}, active: true, replicas: Math.max(minReplicas, 1), trafficWeight: 100, healthState: 'Healthy', provisioningState: 'Provisioned', runningState: 'Running' } }, '2024-03-01');
  }
  if (!single) return;
  for (const k of await store.list('resource', { parent: rec.id, match: { _type: 'microsoft.app/containerapps/revisions' } })) {
    if (k.name === name || !k.properties.active) continue;
    Object.assign(k.properties, { active: false, runningState: 'Stopped', replicas: 0, trafficWeight: 0 });
    await store.put('resource', k.id, k, rec.id);
  }
}

async function internalPut(ctx: ArmCtx, id: string, body: any, apiVersion = '2023-01-01'): Promise<any> {
  const info = infoFromId(id);
  if (!info) throw new Error(`id non valido: ${id}`);
  const res = await putResource({ ...ctx, access: { bypass: true, principalIds: [], grants: [] } }, info, body, apiVersion, { quiet: true });
  return res.body;
}

async function runHooks(ctx: ArmCtx, info: ResInfo, rec: any, existing: any, created: boolean) {
  const hooks = info.def?.hooks ?? [];
  if (hooks.includes('identity')) await applyIdentity(ctx, rec, existing);
  if (hooks.includes('uami')) {
    let spId = existing?._miSp;
    let clientId = existing?.properties?.clientId;
    if (!spId) {
      if (ctx.dryRun) {
        spId = uuidV5(rec.id, '6ba7b811-9dad-11d1-80b4-00c04fd430c8');
        clientId = uuidV5(rec.id + '#c', '6ba7b811-9dad-11d1-80b4-00c04fd430c8');
      } else {
        const sp = await createManagedIdentity(rec.name, rec.id, true);
        spId = sp.id;
        clientId = sp.appId;
      }
    }
    rec._miSp = spId;
    rec.properties = { ...rec.properties, tenantId: tenant().id, principalId: spId, clientId, isolationScope: rec.properties?.isolationScope ?? 'None' };
  }
  if (hooks.includes('kvsecret')) {
    if (rec.properties?.value !== undefined) rec._secrets = { ...(rec._secrets ?? {}), value: String(rec.properties.value) };
    delete rec.properties.value;
  }
  if (hooks.includes('vnetSubnetIp')) {
    for (const ip of rec.properties?.ipConfigurations ?? []) {
      const subnetId = ip.properties?.subnet?.id;
      if (!subnetId || ip.properties.privateIPAllocationMethod === 'Static') continue;
      const subnet = await loadResource(ctx, subnetId);
      const prefix: string | undefined = subnet?.properties?.addressPrefix ?? subnet?.properties?.addressPrefixes?.[0];
      if (!prefix) continue;
      const [base] = prefix.split('/');
      const parts = base.split('.').map(Number);
      const offset = 4 + (parseInt(uniqueString(rec.id + ip.name).slice(0, 4), 36) % 200);
      ip.properties.privateIPAddress = existing?.properties?.ipConfigurations?.find((x: any) => x.name === ip.name)?.properties?.privateIPAddress ?? `${parts[0]}.${parts[1]}.${parts[2]}.${parts[3] + offset}`;
    }
  }
  if (hooks.includes('vm')) {
    // come Azure: con un'immagine e senza osDisk il disco del sistema operativo si crea dall'immagine
    const sp = rec.properties?.storageProfile;
    if (sp?.imageReference && !sp.osDisk && !existing) sp.osDisk = { createOption: 'FromImage' };
    const os = rec.properties?.storageProfile?.osDisk;
    if (os && !os.managedDisk?.id && (os.createOption ?? 'FromImage') === 'FromImage' && info.rg) {
      const diskName = os.name ?? `${rec.name}_OsDisk_1_${uniqueString(rec.id)}${uniqueString(rec.name)}`.slice(0, 80);
      const diskId = `${rgId(info.sub!, info.rg)}/providers/Microsoft.Compute/disks/${diskName}`;
      const isWindows = /windows/i.test(rec.properties?.storageProfile?.imageReference?.offer ?? '') || !!rec.properties?.osProfile?.windowsConfiguration;
      await internalPut(ctx, diskId, {
        location: rec.location,
        managedBy: rec.id,
        sku: { name: os.managedDisk?.storageAccountType ?? 'Premium_LRS' },
        properties: { osType: isWindows ? 'Windows' : 'Linux', creationData: { createOption: 'FromImage', imageReference: { id: `/Subscriptions/${info.sub}/Providers/Microsoft.Compute/Locations/${rec.location}/Publishers/${rec.properties.storageProfile.imageReference?.publisher ?? 'Canonical'}/ArtifactTypes/VMImage/Offers/${rec.properties.storageProfile.imageReference?.offer ?? 'ubuntu'}/Skus/${rec.properties.storageProfile.imageReference?.sku ?? 'server'}/Versions/latest` } }, diskSizeGB: os.diskSizeGB ?? (isWindows ? 127 : 30) },
      }, '2023-04-02');
      rec.properties.storageProfile.osDisk = { osType: isWindows ? 'Windows' : 'Linux', name: diskName, createOption: 'FromImage', caching: 'ReadWrite', deleteOption: os.deleteOption ?? 'Detach', diskSizeGB: os.diskSizeGB ?? (isWindows ? 127 : 30), ...os, managedDisk: { storageAccountType: os.managedDisk?.storageAccountType ?? 'Premium_LRS', id: diskId } };
    }
    for (const nicRef of rec.properties?.networkProfile?.networkInterfaces ?? []) {
      const nic = nicRef.id ? await loadResource(ctx, nicRef.id) : null;
      if (nic && !ctx.dryRun) {
        nic.properties.virtualMachine = { id: rec.id };
        await store.put('resource', nic.id, nic, infoFromId(nic.id)!.parentKey);
      }
    }
    if (info.rg) await syncVmDataDisks(ctx, info, rec, existing);
    if (rec.properties?.osProfile) {
      rec.properties.osProfile.computerName ??= rec.name;
      rec.properties.osProfile.requireGuestProvisionSignal ??= true;
      rec.properties.osProfile.secrets ??= [];
    }
  }
  if (!created || ctx.dryRun) return;
  if (hooks.includes('aks')) {
    const nodeRg = rec.properties.nodeResourceGroup;
    const nodeRgId = rgId(info.sub!, nodeRg);
    if (!(await store.get('resourceGroup', nodeRgId))) {
      await store.put('resourceGroup', nodeRgId, { id: nodeRgId, name: nodeRg, type: 'Microsoft.Resources/resourceGroups', location: rec.location, managedBy: rec.id, tags: {}, properties: { provisioningState: 'Succeeded' }, _created: nowIso() }, `/subscriptions/${info.sub}`);
    }
    const kubelet = await internalPut(ctx, `${nodeRgId}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${rec.name}-agentpool`, { location: rec.location }, '2023-01-31');
    rec.properties.identityProfile = { kubeletidentity: { resourceId: kubelet.id, clientId: kubelet.properties.clientId, objectId: kubelet.properties.principalId } };
    await internalPut(ctx, `${nodeRgId}/providers/Microsoft.Network/virtualNetworks/aks-vnet-${uniqueString(rec.id).slice(0, 8)}`, { location: rec.location, properties: { addressSpace: { addressPrefixes: ['10.224.0.0/12'] }, subnets: [{ name: 'aks-subnet', properties: { addressPrefix: '10.224.0.0/16' } }] } }, '2023-05-01');
    await internalPut(ctx, `${nodeRgId}/providers/Microsoft.Network/loadBalancers/kubernetes`, { location: rec.location, sku: { name: 'Standard' } }, '2023-05-01');
    for (const pool of rec.properties.agentPoolProfiles ?? []) {
      await internalPut(ctx, `${nodeRgId}/providers/Microsoft.Compute/virtualMachineScaleSets/aks-${pool.name}-${uniqueString(rec.id).slice(0, 8)}-vmss`, { location: rec.location, sku: { name: pool.vmSize, capacity: pool.count, tier: 'Standard' }, properties: { orchestrationMode: 'Uniform' } }, '2023-09-01');
    }
  }
}

/** Effetti dopo il salvataggio, quando il record esiste già (configurazione del sito, domini). */
async function runPostHooks(ctx: ArmCtx, info: ResInfo, rec: any, created: boolean) {
  const hooks = info.def?.hooks ?? [];
  // figli creati con la risorsa: dopo il salvataggio, perché il padre deve già esistere
  if (created && (hooks.includes('servicebus') || hooks.includes('eventhub'))) {
    await internalPut(ctx, `${rec.id}/authorizationRules/RootManageSharedAccessKey`, { properties: { rights: ['Listen', 'Manage', 'Send'] } }, '2021-11-01');
  }
  if (created && info.type === 'Microsoft.EventHub/namespaces/eventhubs') {
    await internalPut(ctx, `${rec.id}/consumergroups/$Default`, { properties: {} }, '2021-11-01');
  }
  if (created && hooks.includes('sqlserver')) {
    await internalPut(ctx, `${rec.id}/databases/master`, { location: rec.location, sku: { name: 'System', tier: 'System', capacity: 0 }, properties: { collation: 'SQL_Latin1_General_CP1_CI_AS', maxSizeBytes: 32212254720 } }, '2021-11-01');
  }
  if (hooks.includes('siteconfig') && created) {
    const cfgId = `${rec.id}/config/web`;
    if (!(await store.get('resource', cfgId))) await internalPut(ctx, cfgId, { properties: defaultSiteConfig(rec) }, '2023-12-01');
  }
  if (hooks.includes('hostname')) await syncSiteHostnames(info.parentId!);
  if (hooks.includes('aks')) await syncAgentPoolsFromCluster(ctx, rec);
  if (hooks.includes('akspool')) await syncClusterFromPool(ctx, info, rec);
  if (hooks.includes('carevision')) await syncRevisions(ctx, rec);
  if (hooks.includes('redisdb') && created) {
    const dbId = `${rec.id}/databases/default`;
    if (!(await store.get('resource', dbId))) await internalPut(ctx, dbId, { properties: {} }, '2025-07-01');
  }
}

async function runDeleteHooks(ctx: ArmCtx, rec: any) {
  if (rec._miSp) await deleteServicePrincipal(rec._miSp);
  const def = typeDef(rec.type);
  if (def?.hooks?.includes('aks')) {
    const sub = idParts(rec.id).subscriptionId!;
    const nodeRgId = rgId(sub, rec.properties?.nodeResourceGroup ?? '');
    const nodeRg = await store.get('resourceGroup', nodeRgId);
    if (nodeRg && nodeRg.managedBy?.toLowerCase() === rec.id.toLowerCase()) await deleteResourceGroupTree(ctx, nodeRgId);
  }
  if (def?.hooks?.includes('vm')) {
    const disk = rec.properties?.storageProfile?.osDisk?.managedDisk?.id;
    if (disk) {
      const d = await store.get('resource', disk);
      if (d) {
        if (rec.properties.storageProfile.osDisk.deleteOption === 'Delete') await store.removeTree('resource', disk);
        else {
          delete d.managedBy;
          d.properties.diskState = 'Unattached';
          await store.put('resource', d.id, d, infoFromId(d.id)!.parentKey);
        }
      }
    }
    for (const dd of rec.properties?.storageProfile?.dataDisks ?? []) {
      const d = dd.managedDisk?.id ? await store.get('resource', dd.managedDisk.id) : null;
      if (!d) continue;
      if (dd.deleteOption === 'Delete') await store.removeTree('resource', d.id);
      else { delete d.managedBy; d.properties.diskState = 'Unattached'; await store.put('resource', d.id, d, infoFromId(d.id)!.parentKey); }
    }
    for (const nicRef of rec.properties?.networkProfile?.networkInterfaces ?? []) {
      const nic = await store.get('resource', nicRef.id);
      if (!nic) continue;
      if (nicRef.properties?.deleteOption === 'Delete') await store.removeTree('resource', nic.id);
      else {
        delete nic.properties.virtualMachine;
        await store.put('resource', nic.id, nic, infoFromId(nic.id)!.parentKey);
      }
    }
  }
}

/** Elimina tutto ciò che sta sotto uno scope (risorse, assegnazioni, lock, deployment). */
export async function deleteScopeContents(ctx: ArmCtx, scopeId: string): Promise<void> {
  const prefix = scopeId.toLowerCase();
  const resources = await store.list('resource', { prefix: prefix + '/' });
  const own = await store.get('resource', scopeId);
  for (const r of [...(own ? [own] : []), ...resources]) await runDeleteHooks(ctx, r);
  if (own) await store.remove('resource', scopeId);
  for (const coll of ['resource', 'roleAssignment', 'lock', 'deployment', 'deploymentOperation']) {
    const items = await store.list(coll, { prefix: prefix + '/' });
    for (const it of items) await store.remove(coll, it.id ?? it._key);
  }
}

export async function deleteResourceGroupTree(ctx: ArmCtx, id: string): Promise<void> {
  await deleteScopeContents(ctx, id);
  await store.remove('resourceGroup', id);
  // gruppi gestiti da risorse eliminate (es. node resource group AKS)
  const sub = idParts(id).subscriptionId!;
  for (const rg of await store.list('resourceGroup', { parent: `/subscriptions/${sub}` })) {
    if (rg.managedBy && rg.managedBy.toLowerCase().startsWith(id.toLowerCase() + '/')) await deleteResourceGroupTree(ctx, rg.id);
  }
}

// ---------------- special: Key Vault access policies ----------------

async function putKeyVaultAccessPolicies(ctx: ArmCtx, info: ResInfo, body: any): Promise<ArmResult> {
  const vault = await loadResource(ctx, info.parentId!);
  if (!vault) throw notFound(infoFromId(info.parentId!)!);
  await authorize(ctx, 'Microsoft.KeyVault/vaults/accessPolicies/write', vault.id);
  const op = info.name.toLowerCase();
  if (!['add', 'replace', 'remove'].includes(op)) throw armError(400, 'BadRequest', `Invalid access policy operation '${info.name}'. Allowed values: add, replace, remove.`);
  const incoming: any[] = body?.properties?.accessPolicies ?? [];
  let current: any[] = vault.properties.accessPolicies ?? [];
  if (op === 'replace') current = incoming;
  else if (op === 'add') {
    for (const p of incoming) {
      const ex = current.find((c) => c.objectId === p.objectId && (c.applicationId ?? null) === (p.applicationId ?? null));
      if (!ex) current.push({ tenantId: p.tenantId ?? tenant().id, ...p });
      else for (const k of ['keys', 'secrets', 'certificates', 'storage'] as const) ex.permissions[k] = [...new Set([...(ex.permissions?.[k] ?? []), ...(p.permissions?.[k] ?? [])])];
    }
  } else {
    current = current.filter((c) => !incoming.some((p) => p.objectId === c.objectId));
  }
  vault.properties.accessPolicies = current;
  await persist(ctx, infoFromId(vault.id)!, vault);
  return ok({ id: info.id, name: info.name, type: info.type, properties: { accessPolicies: incoming } });
}

// ---------------- CRUD ----------------

export async function putResource(ctx: ArmCtx, info: ResInfo, body: any, apiVersion: string, opts: { quiet?: boolean } = {}): Promise<ArmResult> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw armError(400, 'InvalidRequestContent', 'The request content was invalid and could not be deserialized.');
  if (info.def?.hooks?.includes('kvaccess')) return putKeyVaultAccessPolicies(ctx, info, body);
  await ensureRegistered(ctx, info);
  const parent = await ensureScope(ctx, info, true);
  validateName(info);
  const existing = await loadResource(ctx, info.id);
  await authorize(ctx, `${info.type}/write`, info.id);
  await checkLocks(ctx, info.id, 'write');
  if (info.def?.globalName && (!existing || existing._implicit)) {
    const clash = await store.list('resource', { match: { _type: info.type.toLowerCase(), _name: info.name.toLowerCase() } });
    if (clash.some((o) => o.id.toLowerCase() !== info.id.toLowerCase())) throw armError(409, info.def.globalName.code, info.def.globalName.message(info.name));
  }
  const created = !existing || !!existing._implicit;
  const rec = buildRecord(ctx, info, body, existing?._implicit ? null : existing, parent, apiVersion);

  // figli inline (subnet, regole NSG, route...)
  const inline: { type: string; items: any[] }[] = [];
  for (const ic of info.def?.inlineChildren ?? []) {
    if (Array.isArray(body.properties?.[ic.prop])) inline.push({ type: ic.type, items: body.properties[ic.prop] });
    delete rec.properties[ic.prop];
  }
  await runHooks(ctx, info, rec, existing, created);
  await persist(ctx, info, rec);
  if (!ctx.dryRun) await runPostHooks(ctx, info, rec, created);
  for (const ic of inline) {
    const keep = new Set<string>();
    for (const item of ic.items) {
      if (!item?.name) throw armError(400, 'InvalidRequestFormat', `Each item in '${ic.type}' must have a name.`);
      const childId = `${rec.id}/${ic.type}/${item.name}`;
      keep.add(childId.toLowerCase());
      const ci = infoFromId(childId)!;
      const childExisting = await loadResource(ctx, childId);
      const crec = buildRecord(ctx, ci, { properties: item.properties ?? {} }, childExisting, rec, apiVersion);
      await persist(ctx, ci, crec);
    }
    if (!ctx.dryRun) {
      for (const old of await store.list('resource', { parent: rec.id, match: { _type: `${info.type}/${ic.type}`.toLowerCase() } })) {
        if (!keep.has(old.id.toLowerCase())) await store.removeTree('resource', old.id);
      }
    }
  }
  if (!ctx.dryRun && created && !info.child && !info.ext && info.rg && !opts.quiet) {
    await notifyScope(ctx, info.id, {
      category: 'resources', key: 'resourceCreated', params: { name: rec.name, rg: info.rg },
      localizedParams: { it: { type: info.def?.label.it ?? info.type }, en: { type: info.def?.label.en ?? info.type } },
      url: `/resource?id=${encodeURIComponent(rec.id)}`,
    });
  }
  return ok(await viewResource(ctx, rec), created ? 201 : 200);
}

export async function getResource(ctx: ArmCtx, info: ResInfo): Promise<ArmResult> {
  if (info.sub) await requireSubscription(info.sub);
  const rec = await loadResource(ctx, info.id);
  if (!rec) {
    if (info.kind === 'resourceGroup' && !(await requireResourceGroup(info.sub!, info.rg!, ctx).catch(() => null))) {
      throw armError(404, 'ResourceGroupNotFound', `Resource group '${info.rg}' could not be found.`);
    }
    throw notFound(info);
  }
  await authorize(ctx, `${info.type}/read`, info.id);
  return ok(await viewResource(ctx, rec));
}

export async function headResource(ctx: ArmCtx, info: ResInfo): Promise<ArmResult> {
  const rec = await loadResource(ctx, info.id);
  if (!rec) return { status: 404 };
  await authorize(ctx, `${info.type}/read`, info.id);
  return { status: 204 };
}

export async function patchResource(ctx: ArmCtx, info: ResInfo, body: any, apiVersion: string): Promise<ArmResult> {
  const existing = await loadResource(ctx, info.id);
  if (!existing || existing._implicit) return putResource(ctx, info, body, apiVersion);
  await requireSubscription(info.sub ?? '', true).catch((e) => { if (info.sub) throw e; });
  await authorize(ctx, `${info.type}/write`, info.id);
  await checkLocks(ctx, info.id, 'write');
  const merged: any = { location: existing.location };
  for (const k of TOP_KEYS) if (existing[k] !== undefined) merged[k] = clone(existing[k]);
  merged.properties = clone(existing.properties ?? {});
  delete merged.properties.provisioningState;
  for (const [k, v] of Object.entries(body ?? {})) {
    if (k === 'tags') merged.tags = v;
    else if (k === 'properties' || k === 'sku' || k === 'identity') merged[k] = deepMerge(merged[k], v);
    else merged[k] = v;
  }
  const rec = buildRecord(ctx, info, merged, existing, info.parentId ? await loadResource(ctx, info.parentId) : null, apiVersion);
  for (const ic of info.def?.inlineChildren ?? []) delete rec.properties[ic.prop];
  await runHooks(ctx, info, rec, existing, false);
  await persist(ctx, info, rec);
  if (!ctx.dryRun) await runPostHooks(ctx, info, rec, false);
  return ok(await viewResource(ctx, rec));
}

export async function deleteResource(ctx: ArmCtx, info: ResInfo): Promise<ArmResult> {
  if (info.sub) await requireSubscription(info.sub, true);
  const existing = await store.get('resource', info.id);
  if (!existing) return { status: 204 };
  await authorize(ctx, `${info.type}/delete`, info.id);
  await checkLocks(ctx, info.id, 'delete');
  if (info.def?.hooks?.includes('akspool')) {
    const cluster = await store.get('resource', info.parentId!);
    const others = (cluster?.properties?.agentPoolProfiles ?? []).filter((p: any) => String(p.name).toLowerCase() !== existing.name.toLowerCase());
    if (existing.properties?.mode === 'System' && !others.some((p: any) => p.mode === 'System')) {
      throw armError(400, 'OperationNotAllowed', 'The cluster must have at least one System agent pool. Add another System pool before deleting this one.');
    }
  }
  await deleteScopeContents(ctx, existing.id);
  if (info.def?.hooks?.includes('akspool')) await syncClusterFromPool(ctx, info, existing, true);
  if (info.def?.hooks?.includes('hostname') && info.parentId) await syncSiteHostnames(info.parentId);
  if (!info.child && !info.ext && info.rg) {
    await notifyScope(ctx, info.id, {
      category: 'resources', key: 'resourceDeleted', params: { name: existing.name, rg: info.rg },
      localizedParams: { it: { type: info.def?.label.it ?? info.type }, en: { type: info.def?.label.en ?? info.type } },
      url: `/resource-groups/${info.sub}/${encodeURIComponent(info.rg)}`,
    });
  }
  return { status: 200 };
}

export async function actionResource(ctx: ArmCtx, info: ResInfo, action: string, body: any): Promise<ArmResult> {
  if (info.sub) await requireSubscription(info.sub);
  const rec = await loadResource(ctx, info.id);
  if (!rec) throw notFound(info);
  await authorize(ctx, `${info.type}/${action}/action`, info.id);
  await checkLocks(ctx, info.id, 'action');
  const actions = info.def?.actions ?? {};
  const key = Object.keys(actions).find((k) => k.toLowerCase() === action.toLowerCase());
  if (!key) {
    if (/^list/i.test(action)) return ok({ value: [] });
    throw armError(400, 'InvalidResourceType', `The resource type '${info.type}' does not support the action '${action}'.`);
  }
  let dirty = false;
  const actx = { ...buildCtx(info, rec.location, rec), body: body ?? {}, save: () => { dirty = true; } };
  let result;
  try {
    result = actions[key](rec, actx);
  } catch (e: any) {
    throw armError(e.status ?? 400, e.code ?? 'BadRequest', e.message);
  }
  if (dirty && !rec._implicit) await persist(ctx, info, rec);
  if (result === null || result === undefined) return { status: 200 };
  return ok(result);
}

export async function listResources(ctx: ArmCtx, opts: { sub?: string; rg?: string; parentId?: string; extScope?: string; type?: string; filter?: string; top?: number; tenantScope?: boolean }): Promise<any[]> {
  let recs: any[];
  if (opts.parentId) {
    recs = await store.list('resource', { parent: opts.parentId });
  } else if (opts.extScope) {
    recs = await store.list('resource', { parent: opts.extScope, match: { _ext: true } });
  } else if (opts.rg && opts.sub) {
    recs = await store.list('resource', { parent: rgId(opts.sub, opts.rg) });
  } else if (opts.sub) {
    recs = await store.list('resource', { prefix: `/subscriptions/${opts.sub}/`, match: { _child: false, _ext: false } });
  } else {
    recs = await store.list('resource', { parent: '/' });
  }
  if (ctx.plan) {
    for (const r of ctx.plan.values()) if (!recs.some((x) => x.id.toLowerCase() === r.id.toLowerCase())) recs.push(r);
  }
  if (opts.type) recs = recs.filter((r) => r._type === opts.type!.toLowerCase());
  const access = await accessOf(ctx);
  recs = recs.filter((r) => can(access, `${r.type}/read`, r.id));
  if (opts.filter) {
    const views = recs.flatMap((r) => {
      const tags = Object.entries(r.tags ?? {});
      const base = { ...r, resourceType: r.type };
      return tags.length ? tags.map(([k, v]) => ({ ...base, tagName: k, tagValue: v, __rec: r })) : [{ ...base, tagName: null, tagValue: null, __rec: r }];
    });
    const matched = new Set(applyFilter(views, opts.filter).map((v: any) => v.__rec));
    recs = recs.filter((r) => matched.has(r));
  }
  if (opts.top) recs = recs.slice(0, opts.top);
  return Promise.all(recs.map((r) => viewResource(ctx, r)));
}

export { RG_NAME, deepMerge, clone, uuid };
