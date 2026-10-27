import type { Context } from 'hono';
import { HttpError } from '../errors.ts';
import { directoryRolesOf, groupsOf } from '../directory.ts';
import {
  APP_ADMIN, CLOUD_APP_ADMIN, GLOBAL_ADMIN, GLOBAL_READER, GROUPS_ADMIN, HELPDESK_ADMIN,
  PRIV_ROLE_ADMIN, REPORTS_READER, USER_ADMIN, DIRECTORY_ROLES,
} from '../firstParty.ts';
import type { AppEnv, Principal } from '../types.ts';

export type Kind = 'application' | 'servicePrincipal' | 'user' | 'group' | 'groupMembers' | 'roles' | 'grants' | 'audit' | 'organization';

export interface Caller {
  p: Principal;
  roles: Set<string>;
  groups: string[];
  isGlobalAdmin: boolean;
}

const cache = new WeakMap<object, Caller>();

export async function caller(c: Context<AppEnv>): Promise<Caller> {
  const hit = cache.get(c);
  if (hit) return hit;
  const p = c.get('principal');
  const groups = await groupsOf(p.oid);
  const roles = new Set(await directoryRolesOf(p.oid, groups));
  if (p.via === 'lax') roles.add(GLOBAL_ADMIN);
  const gc: Caller = { p, roles, groups, isGlobalAdmin: roles.has(GLOBAL_ADMIN) };
  cache.set(c, gc);
  return gc;
}

export const denied = () => new HttpError(403, 'Authorization_RequestDenied', 'Insufficient privileges to complete the operation.');

const DIR_READ = ['Directory.Read.All', 'Directory.ReadWrite.All'];
const DIR_WRITE = ['Directory.ReadWrite.All'];

const APP_READ_ROLES: Record<Kind, string[]> = {
  application: ['Application.Read.All', 'Application.ReadWrite.All', 'Application.ReadWrite.OwnedBy', ...DIR_READ],
  servicePrincipal: ['Application.Read.All', 'Application.ReadWrite.All', 'Application.ReadWrite.OwnedBy', ...DIR_READ],
  user: ['User.Read.All', 'User.ReadWrite.All', ...DIR_READ],
  group: ['Group.Read.All', 'Group.ReadWrite.All', 'GroupMember.Read.All', 'GroupMember.ReadWrite.All', ...DIR_READ],
  groupMembers: ['Group.Read.All', 'Group.ReadWrite.All', 'GroupMember.Read.All', 'GroupMember.ReadWrite.All', ...DIR_READ],
  roles: ['RoleManagement.Read.Directory', 'RoleManagement.ReadWrite.Directory', ...DIR_READ],
  grants: ['Application.Read.All', 'Application.ReadWrite.All', 'AppRoleAssignment.ReadWrite.All', ...DIR_READ],
  audit: ['AuditLog.Read.All'],
  organization: [...DIR_READ, 'User.Read.All', 'Application.Read.All'],
};

const APP_WRITE_ROLES: Record<Kind, string[]> = {
  application: ['Application.ReadWrite.All', ...DIR_WRITE],
  servicePrincipal: ['Application.ReadWrite.All', ...DIR_WRITE],
  user: ['User.ReadWrite.All', ...DIR_WRITE],
  group: ['Group.ReadWrite.All', ...DIR_WRITE],
  groupMembers: ['Group.ReadWrite.All', 'GroupMember.ReadWrite.All', ...DIR_WRITE],
  roles: ['RoleManagement.ReadWrite.Directory'],
  grants: ['AppRoleAssignment.ReadWrite.All', 'Application.ReadWrite.All', ...DIR_WRITE],
  audit: [],
  organization: [...DIR_WRITE],
};

const USER_WRITE_ROLES: Record<Kind, string[]> = {
  application: [APP_ADMIN, CLOUD_APP_ADMIN],
  servicePrincipal: [APP_ADMIN, CLOUD_APP_ADMIN],
  user: [USER_ADMIN],
  group: [GROUPS_ADMIN, USER_ADMIN],
  groupMembers: [GROUPS_ADMIN, USER_ADMIN],
  roles: [PRIV_ROLE_ADMIN],
  grants: [APP_ADMIN, CLOUD_APP_ADMIN, PRIV_ROLE_ADMIN],
  audit: [],
  organization: [],
};

export function canRead(gc: Caller, kind: Kind): boolean {
  if (gc.p.via === 'lax') return true;
  if (gc.p.kind === 'app') return gc.p.roles.some((r) => APP_READ_ROLES[kind].includes(r));
  if (kind === 'audit') return [GLOBAL_ADMIN, GLOBAL_READER, REPORTS_READER, DIRECTORY_ROLES.find((r) => r.displayName === 'Security Administrator')!.id, USER_ADMIN, APP_ADMIN, CLOUD_APP_ADMIN].some((r) => gc.roles.has(r));
  return true;
}

export function assertRead(gc: Caller, kind: Kind): void {
  if (!canRead(gc, kind)) throw denied();
}

/** Può creare oggetti di questo tipo? (gli utenti membri possono creare app e gruppi di sicurezza) */
export function assertCreate(gc: Caller, kind: Kind): void {
  if (gc.isGlobalAdmin) return;
  if (gc.p.kind === 'app') {
    if (gc.p.roles.some((r) => APP_WRITE_ROLES[kind].includes(r))) return;
    if ((kind === 'application' || kind === 'servicePrincipal') && gc.p.roles.includes('Application.ReadWrite.OwnedBy')) return;
    throw denied();
  }
  if (kind === 'application' || kind === 'servicePrincipal' || kind === 'group') return;
  if (USER_WRITE_ROLES[kind].some((r) => gc.roles.has(r))) return;
  throw denied();
}

export function isOwner(gc: Caller, obj: any): boolean {
  return (obj?._owners ?? []).includes(gc.p.oid);
}

export function canWrite(gc: Caller, kind: Kind, obj?: any): boolean {
  if (gc.isGlobalAdmin) return true;
  if (gc.p.kind === 'app') {
    if (gc.p.roles.some((r) => APP_WRITE_ROLES[kind].includes(r))) return true;
    return (kind === 'application' || kind === 'servicePrincipal') && gc.p.roles.includes('Application.ReadWrite.OwnedBy') && isOwner(gc, obj);
  }
  if (USER_WRITE_ROLES[kind].some((r) => gc.roles.has(r))) return true;
  if (kind === 'user' && gc.roles.has(HELPDESK_ADMIN)) return true;
  return obj ? isOwner(gc, obj) : false;
}

export function assertWrite(gc: Caller, kind: Kind, obj?: any): void {
  if (!canWrite(gc, kind, obj)) throw denied();
}
