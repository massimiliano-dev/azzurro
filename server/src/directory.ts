import * as store from './db/store.ts';
import { DIRECTORY_ROLES, GLOBAL_ADMIN } from './firstParty.ts';

export interface Tenant {
  id: string;
  displayName: string;
  defaultDomain: string;
  domains: string[];
  countryCode: string;
  createdDateTime: string;
}

let current: Tenant | undefined;

export function setTenant(t: Tenant): void {
  current = t;
}

export function tenant(): Tenant {
  if (!current) throw new Error('Tenant non inizializzato');
  return current;
}

export const tid = (): string => tenant().id;

/** Normalizza l'identificativo di tenant nell'URL (guid, dominio, common, organizations). */
export function resolveTenantSegment(seg: string): string | null {
  const t = tenant();
  const s = seg.toLowerCase();
  if (s === t.id || s === 'common' || s === 'organizations' || s === 'consumers' || t.domains.includes(s)) return t.id;
  return null;
}

export type DirType = 'user' | 'group' | 'servicePrincipal' | 'application';

export const ODATA_TYPE: Record<DirType, string> = {
  user: '#microsoft.graph.user',
  group: '#microsoft.graph.group',
  servicePrincipal: '#microsoft.graph.servicePrincipal',
  application: '#microsoft.graph.application',
};

export async function userByUpn(upn: string): Promise<any | null> {
  const rows = await store.list('user', { match: { _upn: upn.toLowerCase() }, limit: 1 });
  return rows[0] ?? null;
}

export async function spByAppId(appId: string): Promise<any | null> {
  const rows = await store.list('servicePrincipal', { match: { appId }, limit: 1 });
  return rows[0] ?? null;
}

export async function appByAppId(appId: string): Promise<any | null> {
  const rows = await store.list('application', { match: { appId }, limit: 1 });
  return rows[0] ?? null;
}

/** Trova il service principal di una risorsa (appId, servicePrincipalName o identifierUri). */
export async function spByResource(resource: string): Promise<any | null> {
  const variants = new Set([resource, resource.replace(/\/+$/, ''), resource.replace(/\/+$/, '') + '/']);
  for (const v of variants) {
    const rows = await store.list('servicePrincipal', { match: { servicePrincipalNames: [v] }, limit: 1 });
    if (rows[0]) return rows[0];
  }
  const lower = resource.toLowerCase().replace(/\/+$/, '');
  const all = await store.list('servicePrincipal');
  return all.find((sp) => sp.appId?.toLowerCase() === lower || (sp.servicePrincipalNames ?? []).some((n: string) => n.toLowerCase().replace(/\/+$/, '') === lower)) ?? null;
}

export async function getDirectoryObject(id: string): Promise<{ type: DirType; obj: any } | null> {
  for (const type of ['user', 'group', 'servicePrincipal', 'application'] as DirType[]) {
    const obj = await store.get(type, id);
    if (obj) return { type, obj };
  }
  return null;
}

export interface PrincipalInfo {
  id: string;
  type: 'User' | 'Group' | 'ServicePrincipal';
  displayName: string;
  userPrincipalName?: string;
  appId?: string;
  servicePrincipalType?: string;
}

export async function principalInfo(id: string): Promise<PrincipalInfo | null> {
  const o = await getDirectoryObject(id);
  if (!o || o.type === 'application') return null;
  const t = o.type === 'user' ? 'User' : o.type === 'group' ? 'Group' : 'ServicePrincipal';
  return { id: o.obj.id, type: t, displayName: o.obj.displayName, userPrincipalName: o.obj.userPrincipalName, appId: o.obj.appId, servicePrincipalType: o.obj.servicePrincipalType };
}

/** Gruppi di cui l'oggetto è membro (transitivamente). */
export async function groupsOf(id: string): Promise<string[]> {
  const seen = new Set<string>();
  let frontier = [id];
  while (frontier.length) {
    const next: string[] = [];
    for (const m of frontier) {
      const groups = await store.list('group', { match: { _members: [m] } });
      for (const g of groups) {
        if (!seen.has(g.id)) {
          seen.add(g.id);
          next.push(g.id);
        }
      }
    }
    frontier = next;
  }
  return [...seen];
}

/** Espande una lista di principal (utenti/gruppi/SP) nei soli utenti. */
export async function expandToUsers(ids: string[]): Promise<string[]> {
  const users = new Set<string>();
  const seen = new Set<string>();
  const queue = [...ids];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const g = await store.get('group', id);
    if (g) {
      queue.push(...(g._members ?? []));
      continue;
    }
    if (await store.get('user', id)) users.add(id);
  }
  return [...users];
}

/** roleTemplateId dei ruoli di directory assegnati al principal (direttamente o tramite gruppi). */
export async function directoryRolesOf(oid: string, groups?: string[]): Promise<string[]> {
  const ids = new Set([oid, ...(groups ?? (await groupsOf(oid)))]);
  const all = await store.list('dirRoleAssignment');
  return [...new Set(all.filter((a) => ids.has(a.principalId)).map((a) => a.roleDefinitionId))];
}

export async function isGlobalAdmin(oid: string): Promise<boolean> {
  return (await directoryRolesOf(oid)).includes(GLOBAL_ADMIN);
}

export function roleTemplate(id: string) {
  return DIRECTORY_ROLES.find((r) => r.id === id);
}
