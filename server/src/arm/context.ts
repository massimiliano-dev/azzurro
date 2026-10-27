import * as store from '../db/store.ts';
import { HttpError } from '../errors.ts';
import { recordEvent } from '../events.ts';
import { tenant } from '../directory.ts';
import { nowIso, uuid } from '../ids.ts';
import { notifyLater, type Notice } from '../push.ts';
import type { Principal } from '../types.ts';
import { authorizationFailed, can, loadAccess, scopeWatchers, type Access } from './rbac.ts';
import { idParts, isAncestorOrSelf } from './path.ts';

export interface ArmCtx {
  principal: Principal;
  origin: string;
  correlationId: string;
  access?: Access;
  /** validazione/what-if: nessuna scrittura */
  dryRun?: boolean;
  /** risorse simulate durante un dry-run (id minuscolo → risorsa) */
  plan?: Map<string, any>;
  /** valori di $expand */
  expand?: string;
  /** chiamata interna (motore di template): niente activity log duplicato per le letture */
  internal?: boolean;
}

export interface ArmResult {
  status: number;
  body?: any;
  headers?: Record<string, string>;
}

export async function accessOf(ctx: ArmCtx): Promise<Access> {
  ctx.access ??= await loadAccess(ctx.principal);
  return ctx.access;
}

export async function authorize(ctx: ArmCtx, action: string, scope: string): Promise<void> {
  if (!can(await accessOf(ctx), action, scope)) throw authorizationFailed(ctx.principal, action, scope);
}

export async function canDo(ctx: ArmCtx, action: string, scope: string): Promise<boolean> {
  return can(await accessOf(ctx), action, scope);
}

export const ok = (body?: any, status = 200, headers?: Record<string, string>): ArmResult => ({ status, body, headers });

export function armError(status: number, code: string, message: string, details?: unknown[]): HttpError {
  return new HttpError(status, code, message, details ? { details } : {});
}

// ---------------- subscriptions ----------------

export async function getSubscription(sub: string): Promise<any | null> {
  return store.get('subscription', sub);
}

export async function requireSubscription(sub: string, forWrite = false): Promise<any> {
  const s = await getSubscription(sub);
  if (!s) throw armError(404, 'SubscriptionNotFound', `The subscription '${sub}' could not be found.`);
  if (forWrite && s.state !== 'Enabled') {
    throw armError(409, 'ReadOnlyDisabledSubscription', `The subscription '${sub}' is disabled and therefore marked as read only. You cannot perform any write actions on this subscription until it is re-enabled.`);
  }
  return s;
}

export async function getResourceGroup(sub: string, rg: string, ctx?: ArmCtx): Promise<any | null> {
  const id = `/subscriptions/${sub}/resourceGroups/${rg}`;
  return ctx?.plan?.get(id.toLowerCase()) ?? (await store.get('resourceGroup', id));
}

export async function requireResourceGroup(sub: string, rg: string, ctx?: ArmCtx): Promise<any> {
  const r = await getResourceGroup(sub, rg, ctx);
  if (!r) throw armError(404, 'ResourceGroupNotFound', `Resource group '${rg}' could not be found.`);
  return r;
}

// ---------------- locks ----------------

export async function checkLocks(ctx: ArmCtx, target: string, op: 'write' | 'delete' | 'action'): Promise<void> {
  if (ctx.dryRun) return;
  const t = target.toLowerCase();
  const locks = await store.list('lock');
  const hits = locks.filter((l) => {
    const ancestor = isAncestorOrSelf(l._scope, t);
    if (op === 'delete') return ancestor || l._scope.startsWith(t + '/');
    return ancestor && l.properties.level === 'ReadOnly';
  });
  if (hits.length) {
    const scopes = [...new Set(hits.map((h) => h._scopeOriginal ?? h._scope))].map((s) => `'${s}'`).join(', ');
    throw armError(409, 'ScopeLocked', `The scope '${target}' cannot perform ${op === 'delete' ? 'delete' : 'write'} operation because following scope(s) are locked: ${scopes}. Please remove the lock and try again.`);
  }
}

// ---------------- activity log ----------------

export interface ActivityInput {
  operation: string;
  resourceId: string;
  status: 'Succeeded' | 'Failed' | 'Started' | 'Accepted';
  httpStatus?: number;
  error?: { code: string; message: string };
  description?: string;
}

const STATUS_TEXT: Record<number, string> = { 200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'NoContent', 400: 'BadRequest', 403: 'Forbidden', 404: 'NotFound', 409: 'Conflict', 500: 'InternalServerError' };

export async function logActivity(ctx: ArmCtx, a: ActivityInput): Promise<void> {
  if (ctx.dryRun) return;
  const p = idParts(a.resourceId);
  const eventDataId = uuid();
  const ts = nowIso();
  const level = a.status === 'Failed' ? 'Error' : 'Informational';
  const provider = a.operation.split('/')[0];
  const data = {
    authorization: { action: a.operation, scope: a.resourceId },
    caller: ctx.principal.kind === 'user' ? ctx.principal.upn : ctx.principal.appId,
    channels: 'Operation',
    claims: { oid: ctx.principal.oid, name: ctx.principal.name, appid: ctx.principal.appId ?? null, 'http://schemas.microsoft.com/identity/claims/objectidentifier': ctx.principal.oid },
    correlationId: ctx.correlationId,
    description: a.description ?? '',
    eventDataId,
    eventName: { value: 'EndRequest', localizedValue: 'End request' },
    category: { value: 'Administrative', localizedValue: 'Administrative' },
    eventTimestamp: ts,
    id: `${a.resourceId}/events/${eventDataId}/ticks/${Date.now() * 10000 + 621355968000000000}`,
    level,
    operationId: uuid(),
    operationName: { value: a.operation, localizedValue: a.operation },
    resourceGroupName: p.resourceGroup ?? null,
    resourceProviderName: { value: provider, localizedValue: provider },
    resourceType: { value: p.type ?? provider, localizedValue: p.type ?? provider },
    resourceId: a.resourceId,
    status: { value: a.status, localizedValue: a.status },
    subStatus: a.httpStatus ? { value: STATUS_TEXT[a.httpStatus] ?? String(a.httpStatus), localizedValue: `${STATUS_TEXT[a.httpStatus] ?? ''} (HTTP Status Code: ${a.httpStatus})` } : { value: '', localizedValue: '' },
    submissionTimestamp: ts,
    subscriptionId: p.subscriptionId ?? null,
    tenantId: tenant().id,
    properties: {
      statusCode: a.httpStatus ? STATUS_TEXT[a.httpStatus] ?? String(a.httpStatus) : null,
      serviceRequestId: null,
      eventCategory: 'Administrative',
      entity: a.resourceId,
      message: a.operation,
      hierarchy: `${tenant().id}/${p.subscriptionId ?? ''}`,
      ...(a.error ? { statusMessage: JSON.stringify({ error: a.error }) } : {}),
    },
    relatedEvents: [],
  };
  await recordEvent('activity', data, { subscriptionId: p.subscriptionId, resourceId: a.resourceId, actorId: ctx.principal.oid });
}

/** Notifica gli utenti con permessi di scrittura sullo scope (e l'autore se utente). */
export async function notifyScope(ctx: ArmCtx, scope: string, notice: Omit<Notice, 'actorId'>): Promise<void> {
  if (ctx.dryRun) return;
  const users = await scopeWatchers(scope);
  if (ctx.principal.kind === 'user') users.push(ctx.principal.oid);
  notifyLater(users, { ...notice, actorId: ctx.principal.kind === 'user' ? ctx.principal.oid : undefined, params: { actor: ctx.principal.name, ...(notice.params ?? {}) } });
}

export function systemData(ctx: ArmCtx, existing?: any) {
  const by = ctx.principal.kind === 'user' ? ctx.principal.upn : ctx.principal.appId;
  const byType = ctx.principal.kind === 'user' ? 'User' : 'Application';
  const now = nowIso();
  return {
    createdBy: existing?.systemData?.createdBy ?? by,
    createdByType: existing?.systemData?.createdByType ?? byType,
    createdAt: existing?.systemData?.createdAt ?? now,
    lastModifiedBy: by,
    lastModifiedByType: byType,
    lastModifiedAt: now,
  };
}
