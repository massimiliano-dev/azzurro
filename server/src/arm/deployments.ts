import * as store from '../db/store.ts';
import { tenant } from '../directory.ts';
import { HttpError } from '../errors.ts';
import { nowIso, uuid } from '../ids.ts';
import { notifyLater } from '../push.ts';
import {
  armError, authorize, logActivity, ok, requireResourceGroup, requireSubscription, type ArmCtx, type ArmResult,
} from './context.ts';
import { infoFromId, loadResource, viewResource } from './generic.ts';
import { idParts } from './path.ts';
import { scopeWatchers } from './rbac.ts';
import { runTemplate, templateScopeLevel, TemplateError, type DeployScope, type EngineHost, type NestedInput, type OperationRecord } from './templates.ts';

type ArmRequestFn = (ctx: ArmCtx, method: string, path: string, query: Record<string, string>, body?: any) => Promise<ArmResult>;
let armRequest: ArmRequestFn;
export function bindArmRequest(fn: ArmRequestFn) {
  armRequest = fn;
}

const cancelFlags = new Set<string>();
const DEPLOY_NAME = /^[-\w._()]{1,64}$/;

export function scopeFromString(scope: string): DeployScope {
  const segs = scope.split('/').filter(Boolean);
  if (!segs.length) return { level: 'tenant' };
  if (segs[0].toLowerCase() === 'subscriptions' && segs.length === 2) return { level: 'subscription', subscriptionId: segs[1] };
  if (segs[0].toLowerCase() === 'subscriptions' && segs.length === 4 && segs[2].toLowerCase() === 'resourcegroups') return { level: 'resourceGroup', subscriptionId: segs[1], resourceGroup: segs[3] };
  if (/^providers\/microsoft\.management\/managementgroups/i.test(segs.join('/'))) throw armError(400, 'UnsupportedScope', 'Management group deployments are not supported by Azzurro.');
  throw armError(400, 'InvalidDeploymentScope', `The deployment scope '${scope}' is not valid.`);
}

function scopeString(s: DeployScope): string {
  if (s.level === 'resourceGroup') return `/subscriptions/${s.subscriptionId}/resourceGroups/${s.resourceGroup}`;
  if (s.level === 'subscription') return `/subscriptions/${s.subscriptionId}`;
  return '';
}

function deploymentId(scope: string, name: string) {
  return `${scope}/providers/Microsoft.Resources/deployments/${name}`;
}

function view(d: any) {
  const out: any = {};
  for (const [k, v] of Object.entries(d)) if (!k.startsWith('_')) out[k] = v;
  return out;
}

function sanitizeParameters(params: any, template: any) {
  const out: any = {};
  for (const [k, v] of Object.entries<any>(params ?? {})) {
    const def = Object.entries<any>(template?.parameters ?? {}).find(([n]) => n.toLowerCase() === k.toLowerCase())?.[1];
    const type = String(def?.type ?? '').toLowerCase();
    if (type === 'securestring' || type === 'secureobject') out[k] = { type: type === 'securestring' ? 'SecureString' : 'SecureObject' };
    else out[k] = v;
  }
  return out;
}

async function ensureDeployScope(scope: DeployScope, forWrite: boolean, ctx?: ArmCtx) {
  if (scope.subscriptionId) await requireSubscription(scope.subscriptionId, forWrite);
  if (scope.level === 'resourceGroup') await requireResourceGroup(scope.subscriptionId!, scope.resourceGroup!, ctx);
}

async function resolveContent(ctx: ArmCtx, props: any, parentLink?: string): Promise<{ template: any; parameters: any; templateLink?: any }> {
  let template = props.template;
  let templateLink = props.templateLink;
  if (!template && templateLink) {
    if (templateLink.id) {
      const spec = await store.get('resource', templateLink.id);
      if (!spec?.properties?.mainTemplate) throw armError(400, 'TemplateSpecNotFound', `The template spec version '${templateLink.id}' was not found.`);
      template = spec.properties.mainTemplate;
    } else {
      let uri = templateLink.uri;
      if (!uri && templateLink.relativePath && parentLink) uri = new URL(templateLink.relativePath, parentLink).toString();
      if (!uri) throw armError(400, 'InvalidContentLink', "The 'templateLink' must contain 'uri', 'id' or 'relativePath'.");
      template = await fetchJson(uri);
      templateLink = { ...templateLink, uri, contentVersion: template.contentVersion };
    }
  }
  if (!template) throw armError(400, 'InvalidRequestContent', "The request content was invalid and could not be deserialized: 'Either 'template' or 'templateLink' must be specified.'.");
  let parameters = props.parameters;
  if (!parameters && props.parametersLink?.uri) parameters = await fetchJson(props.parametersLink.uri);
  if (typeof template === 'string') template = JSON.parse(template);
  return { template, parameters: parameters ?? {}, templateLink };
}

async function fetchJson(uri: string): Promise<any> {
  try {
    const r = await fetch(uri);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = (await r.text()).replace(/^﻿/, '');
    return JSON.parse(text);
  } catch (e) {
    throw new TemplateError('InvalidContentLink', `Unable to download deployment content from '${uri}'. The tracking Id is '${uuid()}'. Please see https://aka.ms/arm-deploy-resources for usage details. ${(e as Error).message}`);
  }
}

function toArmError(e: any): { code: string; message: string; details?: any[] } {
  if (e instanceof TemplateError) return { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) };
  if (e instanceof HttpError) return { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) };
  return { code: e?.code ?? 'InternalServerError', message: e?.message ?? String(e) };
}

// ---------------- engine host ----------------

function makeHost(ctx: ArmCtx, deployId: string, dryRun: boolean): EngineHost {
  const q = (apiVersion?: string) => ({ 'api-version': apiVersion || '2021-04-01' });
  return {
    dryRun,
    origin: ctx.origin,
    tenantId: tenant().id,
    async getResourceGroup(sub, rg) {
      const id = `/subscriptions/${sub}/resourceGroups/${rg}`;
      return ctx.plan?.get(id.toLowerCase()) ?? (await store.get('resourceGroup', id));
    },
    async getSubscription(sub) {
      return store.get('subscription', sub);
    },
    async get(id, apiVersion) {
      try {
        const r = await armRequest(ctx, 'GET', id, q(apiVersion));
        return r.body ?? null;
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) return null;
        throw e;
      }
    },
    async put(id, apiVersion, body) {
      const r = await armRequest(ctx, 'PUT', id, q(apiVersion), body);
      return { status: r.status, body: r.body };
    },
    async action(id, action, apiVersion, body) {
      const r = await armRequest(ctx, 'POST', `${id}/${action}`, q(apiVersion), body ?? {});
      return r.body ?? null;
    },
    async remove(id, apiVersion) {
      await armRequest(ctx, 'DELETE', id, q(apiVersion));
    },
    async listGroupResources(sub, rg) {
      const all = await store.list('resource', { parent: `/subscriptions/${sub}/resourceGroups/${rg}` });
      return all.map((r) => ({ id: r.id, type: r.type }));
    },
    async nested(input) {
      return runNested(ctx, input, dryRun);
    },
    async keyVaultSecret(vaultId, name) {
      const vault = await loadResource(ctx, vaultId);
      if (!vault) throw new TemplateError('KeyVaultParameterReferenceNotFound', `The specified KeyVault '${vaultId}' could not be found.`);
      if (vault.properties?.enabledForTemplateDeployment !== true) {
        throw new TemplateError('KeyVaultParameterReferenceSecretRetrieveFailed', `The key vault '${vault.name}' is not enabled for template deployment. Set 'enabledForTemplateDeployment' to true.`);
      }
      const secret = await store.get('resource', `${vault.id}/secrets/${name}`);
      if (secret?._secrets?.value === undefined) throw new TemplateError('KeyVaultParameterReferenceSecretRetrieveFailed', `The secret '${name}' was not found in key vault '${vault.name}'.`);
      return secret._secrets.value;
    },
    fetchJson,
    async templateSpec(id) {
      const spec = await store.get('resource', id);
      return spec?.properties?.mainTemplate ?? null;
    },
    async operation(op: OperationRecord) {
      if (dryRun) return;
      const id = `${deployId}/operations/${op.operationId}`;
      await store.put('deploymentOperation', id, {
        id,
        operationId: op.operationId,
        properties: { provisioningOperation: op.provisioningOperation, provisioningState: op.provisioningState, timestamp: op.timestamp, duration: op.duration, trackingId: uuid(), serviceRequestId: uuid(), statusCode: op.statusCode, ...(op.statusMessage ? { statusMessage: op.statusMessage } : {}), targetResource: op.targetResource },
      }, deployId);
    },
    canceled() {
      return cancelFlags.has(deployId.toLowerCase());
    },
  };
}

async function runNested(ctx: ArmCtx, input: NestedInput, dryRun: boolean): Promise<any> {
  const scopeStr = scopeString(input.scope);
  const id = deploymentId(scopeStr, input.name);
  await ensureDeployScope(input.scope, true, ctx);
  const { template, parameters, templateLink } = await resolveContent(ctx, input.properties, input.parentTemplateLink);
  const started = Date.now();
  const rec: any = {
    id, name: input.name, type: 'Microsoft.Resources/deployments',
    ...(input.scope.level !== 'resourceGroup' && input.location ? { location: input.location } : {}),
    properties: {
      templateHash: '', parameters: sanitizeParameters(parameters, template), mode: input.properties.mode ?? 'Incremental', provisioningState: 'Running',
      timestamp: nowIso(), duration: 'PT0S', correlationId: ctx.correlationId, providers: [], dependencies: [], ...(templateLink ? { templateLink } : {}),
    },
    _template: template,
  };
  if (!dryRun) await store.put('deployment', id, rec, (scopeStr || '/').toLowerCase());
  try {
    const result = await runTemplate({
      template, parameters, scope: input.scope, deploymentName: input.name, deploymentLocation: input.location,
      mode: input.properties.mode, host: makeHost(ctx, id, dryRun), templateLink, outer: input.outer,
    });
    Object.assign(rec.properties, {
      templateHash: result.templateHash, provisioningState: 'Succeeded', outputs: result.outputs, outputResources: result.outputResources,
      providers: result.providers, duration: `PT${((Date.now() - started) / 1000).toFixed(7)}S`, timestamp: nowIso(),
      ...(input.outer ? {} : { parameters: { ...sanitizeParameters(parameters, template) } }),
    });
    if (dryRun) rec.properties.validatedResources = result.validatedResources.map((r) => ({ id: r.id }));
    if (!dryRun) await store.put('deployment', id, rec, (scopeStr || '/').toLowerCase());
    return view(rec);
  } catch (e) {
    const err = toArmError(e);
    Object.assign(rec.properties, { provisioningState: 'Failed', error: err, duration: `PT${((Date.now() - started) / 1000).toFixed(7)}S`, timestamp: nowIso() });
    if (!dryRun) await store.put('deployment', id, rec, (scopeStr || '/').toLowerCase());
    throw new TemplateError(err.code, err.message, err.details);
  }
}

// ---------------- API ----------------

export async function putDeployment(ctx: ArmCtx, scopeStr: string, name: string, body: any, apiVersion: string): Promise<ArmResult> {
  const scope = scopeFromString(scopeStr);
  await ensureDeployScope(scope, true);
  if (!DEPLOY_NAME.test(name)) throw armError(400, 'InvalidDeploymentName', `The deployment name '${name}' is not valid. It must be 1-64 characters and contain only letters, digits, '-', '.', '_', '(' and ')'.`);
  await authorize(ctx, 'Microsoft.Resources/deployments/write', scopeStr || '/');
  const props = body?.properties;
  if (!props) throw armError(400, 'InvalidRequestContent', "The request content was invalid and could not be deserialized: 'Required property 'properties' not found in JSON.'.");
  if (scope.level !== 'resourceGroup' && !body.location) {
    throw armError(400, 'LocationRequired', "The location property is required for this definition. The 'location' property must be specified for the template deployment at subscription or tenant scope.");
  }
  const id = deploymentId(scopeStr, name);
  const existing = await store.get('deployment', id);
  if (existing && ['Accepted', 'Running'].includes(existing.properties.provisioningState)) {
    throw armError(409, 'DeploymentActive', `Unable to edit or replace deployment '${name}': previous deployment from '${existing.properties.timestamp}' is still active (expiration time is '${new Date(Date.now() + 7 * 86400_000).toISOString()}'). Please see https://aka.ms/arm-deploy-resources for usage details.`);
  }
  const { template, parameters, templateLink } = await resolveContent(ctx, props);
  const level = templateScopeLevel(template);
  if (level !== scope.level) {
    throw armError(400, 'InvalidTemplate', `Deployment template validation failed: 'The template schema '${template.$schema}' is not supported for ${scope.level} level deployments. Please see https://aka.ms/arm-template for usage details.'.`);
  }
  // preflight: validazione completa in dry-run
  const pre = await validateInternal(ctx, scope, name, body.location, { ...props, template, parameters, templateLink });
  if (pre.error) {
    const inner = pre.error;
    if (inner.code === 'InvalidTemplate') throw armError(400, 'InvalidTemplate', inner.message, inner.details);
    throw armError(400, 'InvalidTemplateDeployment', `The template deployment '${name}' is not valid according to the validation procedure. The tracking id is '${uuid()}'. See inner errors for details.`, [inner, ...(inner.details ?? [])]);
  }
  const opId = uuid();
  const rec: any = {
    id, name, type: 'Microsoft.Resources/deployments',
    ...(body.location ? { location: String(body.location).toLowerCase().replace(/\s/g, '') } : {}),
    ...(body.tags ? { tags: body.tags } : {}),
    properties: {
      templateHash: pre.templateHash, parameters: sanitizeParameters(parameters, template), mode: props.mode ?? 'Incremental', provisioningState: 'Accepted',
      timestamp: nowIso(), duration: 'PT0S', correlationId: ctx.correlationId, providers: pre.providers ?? [], dependencies: [],
      ...(templateLink ? { templateLink } : {}), ...(props.parametersLink ? { parametersLink: props.parametersLink } : {}), ...(props.debugSetting ? { debugSetting: props.debugSetting } : {}),
    },
    _template: template,
    _opId: opId,
  };
  const scopeKey = (scopeStr || '/').toLowerCase();
  await store.put('deployment', id, rec, scopeKey);
  for (const old of await store.list('deploymentOperation', { parent: id })) await store.remove('deploymentOperation', old.id);
  await store.put('operationStatus', opId, { id: opId, name: opId, status: 'Running', startTime: nowIso(), deploymentId: id });
  const runCtx: ArmCtx = { principal: ctx.principal, origin: ctx.origin, correlationId: ctx.correlationId, access: ctx.access, internal: true };
  setImmediate(() => {
    executeDeployment(runCtx, scope, rec, { template, parameters, templateLink, mode: props.mode }).catch((e) => console.error('[deployment] errore inatteso:', e));
  });
  const statusPath = `${scopeStr}/providers/Microsoft.Resources/deployments/${name}/operationStatuses/${opId}?api-version=${apiVersion}`;
  return ok(view(rec), existing ? 200 : 201, { 'Azure-AsyncOperation': `${ctx.origin}${statusPath}`, 'Retry-After': '2' });
}

async function executeDeployment(ctx: ArmCtx, scope: DeployScope, rec: any, input: { template: any; parameters: any; templateLink?: any; mode?: string }) {
  const started = Date.now();
  const scopeStr = scopeString(scope);
  const scopeKey = (scopeStr || '/').toLowerCase();
  rec.properties.provisioningState = 'Running';
  await store.put('deployment', rec.id, rec, scopeKey);
  let status: 'Succeeded' | 'Failed' | 'Canceled' = 'Succeeded';
  let error: any;
  try {
    const result = await runTemplate({
      template: input.template, parameters: input.parameters, scope, deploymentName: rec.name, deploymentLocation: rec.location,
      mode: (input.mode as any) ?? 'Incremental', host: makeHost(ctx, rec.id, false), templateLink: input.templateLink,
    });
    Object.assign(rec.properties, { outputs: result.outputs, outputResources: result.outputResources, providers: result.providers, templateHash: result.templateHash });
  } catch (e: any) {
    error = toArmError(e);
    status = e?.code === 'DeploymentCanceled' ? 'Canceled' : 'Failed';
  }
  cancelFlags.delete(rec.id.toLowerCase());
  Object.assign(rec.properties, { provisioningState: status, duration: `PT${((Date.now() - started) / 1000).toFixed(7)}S`, timestamp: nowIso(), ...(error ? { error } : {}) });
  await store.put('deployment', rec.id, rec, scopeKey);
  await store.put('operationStatus', rec._opId, { id: rec._opId, name: rec._opId, status, startTime: new Date(started).toISOString(), endTime: nowIso(), deploymentId: rec.id, ...(error ? { error } : {}) });
  await logActivity(ctx, { operation: 'Microsoft.Resources/deployments/write', resourceId: rec.id, status: status === 'Succeeded' ? 'Succeeded' : 'Failed', httpStatus: status === 'Succeeded' ? 200 : 400, ...(error ? { error: { code: error.code, message: error.message } } : {}) });
  const parts = idParts(rec.id);
  const scopeLabel = parts.resourceGroup ? parts.resourceGroup : parts.subscriptionId ?? 'tenant';
  const users = scopeStr ? await scopeWatchers(scopeStr) : [];
  if (ctx.principal.kind === 'user') users.push(ctx.principal.oid);
  const detail = error ? (error.details?.[0]?.message ?? error.message) : '';
  notifyLater(users, {
    category: 'deployments',
    key: status === 'Succeeded' ? 'deploymentSucceeded' : 'deploymentFailed',
    params: { name: rec.name, scope: scopeLabel, error: String(detail).slice(0, 160), actor: ctx.principal.name },
    url: `/deployment?id=${encodeURIComponent(rec.id)}`,
    actorId: ctx.principal.kind === 'user' ? ctx.principal.oid : undefined,
  });
}

interface ValidateResult {
  error?: { code: string; message: string; details?: any[] };
  templateHash?: string;
  providers?: any[];
  validated?: { id: string; type: string; apiVersion: string; name: string; body: any }[];
  plan?: Map<string, any>;
  parameters?: any;
}

async function validateInternal(ctx: ArmCtx, scope: DeployScope, name: string, location: string | undefined, props: any): Promise<ValidateResult> {
  const dry: ArmCtx = { principal: ctx.principal, origin: ctx.origin, correlationId: ctx.correlationId, access: ctx.access, dryRun: true, plan: new Map(), internal: true };
  try {
    const { template, parameters, templateLink } = props.template ? props : await resolveContent(ctx, props);
    const result = await runTemplate({ template, parameters, scope, deploymentName: name, deploymentLocation: location, mode: props.mode, host: makeHost(dry, deploymentId(scopeString(scope), name), true), templateLink });
    return { templateHash: result.templateHash, providers: result.providers, validated: result.validatedResources, plan: dry.plan, parameters: result.parameters };
  } catch (e) {
    return { error: toArmError(e) };
  }
}

export async function getDeployment(ctx: ArmCtx, scopeStr: string, name: string, method: string): Promise<ArmResult> {
  const id = deploymentId(scopeStr, name);
  const d = await store.get('deployment', id);
  if (method === 'HEAD') return { status: d ? 204 : 404 };
  if (!d) throw armError(404, 'DeploymentNotFound', `Deployment '${name}' could not be found.`);
  await authorize(ctx, 'Microsoft.Resources/deployments/read', scopeStr || '/');
  return ok(view(d));
}

export async function deleteDeployment(ctx: ArmCtx, scopeStr: string, name: string): Promise<ArmResult> {
  const id = deploymentId(scopeStr, name);
  const d = await store.get('deployment', id);
  if (!d) return { status: 204 };
  await authorize(ctx, 'Microsoft.Resources/deployments/delete', scopeStr || '/');
  if (['Accepted', 'Running'].includes(d.properties.provisioningState)) throw armError(409, 'DeploymentActive', `The deployment '${name}' is still active and cannot be deleted. Cancel it first.`);
  await store.remove('deployment', id);
  for (const op of await store.list('deploymentOperation', { parent: id })) await store.remove('deploymentOperation', op.id);
  return { status: 204 };
}

export async function listDeployments(ctx: ArmCtx, scopeStr: string, filter?: string, top?: number): Promise<ArmResult> {
  const scope = scopeFromString(scopeStr);
  await ensureDeployScope(scope, false);
  await authorize(ctx, 'Microsoft.Resources/deployments/read', scopeStr || '/');
  let all = await store.list('deployment', { parent: (scopeStr || '/').toLowerCase() });
  const m = /provisioningState\s+eq\s+'([^']+)'/i.exec(filter ?? '');
  if (m) all = all.filter((d) => d.properties.provisioningState.toLowerCase() === m[1].toLowerCase());
  all.sort((a, b) => String(b.properties.timestamp).localeCompare(String(a.properties.timestamp)));
  if (top) all = all.slice(0, top);
  return ok({ value: all.map(view) });
}

export async function deploymentAction(ctx: ArmCtx, scopeStr: string, name: string, action: string, body: any): Promise<ArmResult> {
  const id = deploymentId(scopeStr, name);
  const scope = scopeFromString(scopeStr);
  switch (action.toLowerCase()) {
    case 'validate': {
      await ensureDeployScope(scope, false);
      await authorize(ctx, 'Microsoft.Resources/deployments/validate/action', scopeStr || '/');
      const props = body?.properties ?? {};
      const r = await validateInternal(ctx, scope, name, body?.location, props);
      if (r.error) {
        const e = r.error;
        throw armError(400, e.code === 'InvalidTemplate' ? 'InvalidTemplate' : 'InvalidTemplateDeployment', e.code === 'InvalidTemplate' ? e.message : `The template deployment '${name}' is not valid according to the validation procedure. The tracking id is '${uuid()}'. See inner errors for details.`, e.code === 'InvalidTemplate' ? e.details : [e, ...(e.details ?? [])]);
      }
      return ok({ id, name, type: 'Microsoft.Resources/deployments', ...(body?.location ? { location: body.location } : {}), properties: { templateHash: r.templateHash, parameters: r.parameters, mode: props.mode ?? 'Incremental', provisioningState: 'Succeeded', timestamp: nowIso(), duration: 'PT0S', correlationId: ctx.correlationId, providers: r.providers, dependencies: [], validatedResources: (r.validated ?? []).map((v) => ({ id: v.id })) } });
    }
    case 'whatif': {
      await ensureDeployScope(scope, false);
      await authorize(ctx, 'Microsoft.Resources/deployments/whatIf/action', scopeStr || '/');
      const props = body?.properties ?? {};
      const r = await validateInternal(ctx, scope, name, body?.location, props);
      if (r.error) return ok({ status: 'Failed', error: r.error });
      return ok({ status: 'Succeeded', properties: { changes: await whatIfChanges(ctx, scope, r, props.mode ?? 'Incremental') } });
    }
    case 'cancel': {
      const d = await store.get('deployment', id);
      if (!d) throw armError(404, 'DeploymentNotFound', `Deployment '${name}' could not be found.`);
      await authorize(ctx, 'Microsoft.Resources/deployments/cancel/action', scopeStr || '/');
      if (!['Accepted', 'Running'].includes(d.properties.provisioningState)) throw armError(409, 'DeploymentCannotBeCancelled', `The deployment '${name}' cannot be cancelled because its provisioning state is '${d.properties.provisioningState}'.`);
      cancelFlags.add(id.toLowerCase());
      return { status: 204 };
    }
    case 'exporttemplate': {
      const d = await store.get('deployment', id);
      if (!d) throw armError(404, 'DeploymentNotFound', `Deployment '${name}' could not be found.`);
      await authorize(ctx, 'Microsoft.Resources/deployments/exportTemplate/action', scopeStr || '/');
      return ok({ template: d._template ?? {} });
    }
  }
  throw armError(400, 'InvalidAction', `Unsupported deployment action '${action}'.`);
}

const VOLATILE = new Set(['provisioningState', 'systemData', 'etag', 'creationTime', 'createdTime', 'changedTime', 'timeCreated', 'lastModifiedTime', 'keyCreationTime', 'resourceGuid', 'createdAt', 'updatedAt', 'secretUriWithVersion', 'keyUriWithVersion', 'latestRevisionName', 'latestReadyRevisionName', 'latestRevisionFqdn', 'uniqueId', 'vmId', 'lastModifiedTimeUtc', 'modifiedDate', 'createdDate', 'version', 'macAddress']);

function delta(before: any, after: any, path = ''): any[] {
  const out: any[] = [];
  if (after && typeof after === 'object' && !Array.isArray(after) && before && typeof before === 'object' && !Array.isArray(before)) {
    for (const k of Object.keys(after)) {
      if (VOLATILE.has(k)) continue;
      const p = path ? `${path}.${k}` : k;
      if (!(k in before)) out.push({ path: p, propertyChangeType: 'Create', after: after[k] });
      else out.push(...delta(before[k], after[k], p));
    }
    return out;
  }
  if (JSON.stringify(stripVolatile(before)) !== JSON.stringify(stripVolatile(after))) out.push({ path, propertyChangeType: Array.isArray(after) ? 'Array' : 'Modify', before, after });
  return out;
}

function stripVolatile(v: any): any {
  if (Array.isArray(v)) return v.map(stripVolatile);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).filter((k) => !VOLATILE.has(k)).sort().map((k) => [k, stripVolatile(v[k])]));
  return v;
}

async function whatIfChanges(ctx: ArmCtx, scope: DeployScope, r: ValidateResult, mode: string) {
  const changes: any[] = [];
  const planned = new Set<string>();
  const live: ArmCtx = { ...ctx, dryRun: false, plan: undefined };
  const sim: ArmCtx = { ...ctx, dryRun: true, plan: r.plan };
  for (const [key, rec] of r.plan ?? new Map()) {
    const isRg = rec.type === 'Microsoft.Resources/resourceGroups';
    if (!isRg && (rec._child || rec._implicit)) continue;
    planned.add(key);
    const real = isRg ? await store.get('resourceGroup', rec.id) : await store.get('resource', rec.id);
    const after = isRg ? { id: rec.id, name: rec.name, type: rec.type, location: rec.location, tags: rec.tags } : await viewResource(sim, rec);
    if (!real) {
      changes.push({ resourceId: rec.id, changeType: 'Create', after });
      continue;
    }
    const before = isRg ? { id: real.id, name: real.name, type: real.type, location: real.location, tags: real.tags } : await viewResource(live, real);
    const d = delta(before, after);
    changes.push({ resourceId: rec.id, changeType: d.length ? 'Modify' : 'NoChange', before, after, ...(d.length ? { delta: d } : {}) });
  }
  if (scope.level === 'resourceGroup') {
    for (const res of await store.list('resource', { parent: `/subscriptions/${scope.subscriptionId}/resourceGroups/${scope.resourceGroup}` })) {
      if (planned.has(res.id.toLowerCase())) continue;
      changes.push({ resourceId: res.id, changeType: mode === 'Complete' ? 'Delete' : 'Ignore', before: await viewResource(live, res) });
    }
  }
  return changes.sort((a, b) => a.resourceId.localeCompare(b.resourceId));
}

export async function listOperations(ctx: ArmCtx, scopeStr: string, name: string, opId?: string): Promise<ArmResult> {
  const id = deploymentId(scopeStr, name);
  const d = await store.get('deployment', id);
  if (!d) throw armError(404, 'DeploymentNotFound', `Deployment '${name}' could not be found.`);
  await authorize(ctx, 'Microsoft.Resources/deployments/operations/read', scopeStr || '/');
  if (opId) {
    const op = await store.get('deploymentOperation', `${id}/operations/${opId}`);
    if (!op) throw armError(404, 'DeploymentOperationNotFound', `Deployment operation '${opId}' could not be found.`);
    return ok(op);
  }
  return ok({ value: await store.list('deploymentOperation', { parent: id }) });
}

export async function operationStatus(_ctx: ArmCtx, opId: string): Promise<ArmResult> {
  const s = await store.get('operationStatus', opId);
  if (!s) throw armError(404, 'OperationNotFound', `The operation '${opId}' could not be found.`);
  const { deploymentId: _d, ...rest } = s;
  return ok(rest);
}
