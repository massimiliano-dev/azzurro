/**
 * Strumenti dell'assistente. Ogni chiamata passa dalle stesse API del portale
 * (ARM e Graph) con la sessione dell'utente: RBAC e autorizzazioni restano le sue.
 */
import { z } from 'zod';
import type { Hono } from 'hono';
import { typeDef, TYPES } from '../arm/catalog.ts';
import { priceDef } from '../costs/prices.ts';
import { estimate } from '../costs/engine.ts';
import * as store from '../db/store.ts';
import type { AppEnv } from '../types.ts';

export interface ToolSpec {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

const DIMENSIONS = ['ResourceGroupName', 'ResourceId', 'ResourceType', 'ServiceName', 'ResourceLocation', 'Meter', 'MeterSubCategory'];

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'arm_request',
    description: 'Call Azure Resource Manager on Azzurro as the signed-in user; their Azure RBAC applies. Use GET to read, PUT to create or replace, PATCH to update, POST for actions (for example .../start, .../listKeys) and DELETE to delete. The path starts with /subscriptions/ or /providers/ and has no query string. Omit api_version to use the right default for the resource type. Creations, updates and actions may wait for the user\'s approval; deletions always do. Secret values in responses are hidden.',
    schema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'PUT', 'PATCH', 'POST', 'DELETE'] },
        path: { type: 'string', description: 'ARM path, e.g. /subscriptions/{id}/resourceGroups/demo-rg/providers/Microsoft.Storage/storageAccounts/stdemo01' },
        api_version: { type: 'string', description: 'Optional api-version, e.g. 2023-05-01' },
        query: { type: 'object', description: 'Optional extra query parameters such as $filter or $top', additionalProperties: { type: 'string' } },
        body: { type: 'object', description: 'JSON body for PUT, PATCH and POST' },
      },
      required: ['method', 'path'],
      additionalProperties: false,
    },
  },
  {
    name: 'graph_request',
    description: 'Call Microsoft Graph v1.0 on Azzurro\'s emulated Entra ID directory as the signed-in user: users, groups, applications (app registrations), service principals, directory roles, sign-in and audit logs. The path is relative to /v1.0 and may include OData options such as $filter, $select and $top. Writes may wait for approval; deletions always do. Client secrets in responses are hidden.',
    schema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PATCH', 'DELETE'] },
        path: { type: 'string', description: 'e.g. /applications?$select=displayName,appId or /users' },
        body: { type: 'object' },
      },
      required: ['method', 'path'],
      additionalProperties: false,
    },
  },
  {
    name: 'query_costs',
    description: 'Estimated costs from the Cost Management API for a subscription or resource group: totals, daily series, forecast to month end, and breakdowns. Costs are estimates in EUR (indicative plan rate × hours the resource existed, plus simulated usage).',
    schema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: '/subscriptions/{id} or /subscriptions/{id}/resourceGroups/{name}' },
        timeframe: { type: 'string', enum: ['MonthToDate', 'TheLastMonth', 'WeekToDate', 'Custom'] },
        from: { type: 'string', description: 'ISO date, only for Custom' },
        to: { type: 'string', description: 'ISO date, only for Custom' },
        granularity: { type: 'string', enum: ['None', 'Daily', 'Monthly'] },
        group_by: { type: 'array', items: { type: 'string', enum: DIMENSIONS }, maxItems: 2 },
        forecast: { type: 'boolean', description: 'Return actual plus forecast to the end of the current month (daily rows with CostStatus)' },
      },
      required: ['scope'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_pricing',
    description: 'Indicative price list (EUR, West Europe, pay-as-you-go). With resource_type: its plans/SKUs with specs and €/hour, €/month, plus usage meters. Without it: every paid type with its cheapest and most expensive plan. Use it to suggest a plan and to state the monthly cost before creating something.',
    schema: {
      type: 'object',
      properties: { resource_type: { type: 'string', description: 'e.g. Microsoft.Web/serverfarms' } },
      additionalProperties: false,
    },
  },
  {
    name: 'estimate_resource',
    description: 'Monthly cost estimate of an existing resource: current plan, cost lines, whether usage is simulated, and whether it is idle (for example a deallocated VM).',
    schema: {
      type: 'object',
      properties: { resource_id: { type: 'string' } },
      required: ['resource_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_resource_type',
    description: 'What Azzurro knows about a resource type: supported api-versions, the main creation fields with defaults and allowed values, POST actions, and child types. Without resource_type it lists all supported types.',
    schema: {
      type: 'object',
      properties: { resource_type: { type: 'string' } },
      additionalProperties: false,
    },
  },
];

const Inputs = {
  arm_request: z.object({ method: z.enum(['GET', 'PUT', 'PATCH', 'POST', 'DELETE']), path: z.string().startsWith('/'), api_version: z.string().optional(), query: z.record(z.string(), z.string()).optional(), body: z.record(z.string(), z.unknown()).optional() }),
  graph_request: z.object({ method: z.enum(['GET', 'POST', 'PATCH', 'DELETE']), path: z.string().min(1), body: z.record(z.string(), z.unknown()).optional() }),
  query_costs: z.object({ scope: z.string().startsWith('/subscriptions/'), timeframe: z.enum(['MonthToDate', 'TheLastMonth', 'WeekToDate', 'Custom']).optional(), from: z.string().optional(), to: z.string().optional(), granularity: z.enum(['None', 'Daily', 'Monthly']).optional(), group_by: z.array(z.string()).max(2).optional(), forecast: z.boolean().optional() }),
  get_pricing: z.object({ resource_type: z.string().optional() }),
  estimate_resource: z.object({ resource_id: z.string().startsWith('/') }),
  get_resource_type: z.object({ resource_type: z.string().optional() }),
} as const;
export type ToolName = keyof typeof Inputs;

export function validate(name: string, input: unknown): { ok: true; value: any } | { ok: false; error: string } {
  const schema = (Inputs as Record<string, z.ZodTypeAny>)[name];
  if (!schema) return { ok: false, error: `Unknown tool '${name}'.` };
  const r = schema.safeParse(input);
  return r.success ? { ok: true, value: r.data } : { ok: false, error: r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ') };
}

export type Kind = 'read' | 'write' | 'delete';

/** Le letture vanno da sole; le scritture chiedono conferma salvo esecuzione automatica; le eliminazioni sempre. */
export function classify(name: string, input: any): Kind {
  if (name === 'arm_request' || name === 'graph_request') {
    const m = String(input?.method ?? 'GET').toUpperCase();
    if (m === 'GET') return 'read';
    if (m === 'DELETE') return 'delete';
    if (name === 'arm_request' && m === 'POST') {
      const last = String(input.path ?? '').split('/').filter(Boolean).pop() ?? '';
      if (/^(list\w*|check\w*|validate\w*|whatIf|query|forecast)$/i.test(last) || /microsoft\.costmanagement\//i.test(input.path)) return 'read';
    }
    return 'write';
  }
  return 'read';
}

// ------------------------------------------------------------------ esecuzione

const SECRET_KEYS = /^(primaryKey|secondaryKey|primaryMasterKey|secondaryMasterKey|primaryReadonlyMasterKey|secondaryReadonlyMasterKey|primaryConnectionString|secondaryConnectionString|connectionString|secretText|password|adminPassword|key1|key2|accessKey|sharedAccessKey|token|access_token|refresh_token|id_token|clientSecret|value)$/i;

export function redact(v: unknown, key = ''): unknown {
  if (typeof v === 'string') return SECRET_KEYS.test(key) && v.length >= 8 && !/^(true|false)$/i.test(v) && !(key.toLowerCase() === 'value' && v.length < 24) ? '[hidden: visible only in the portal]' : v;
  if (Array.isArray(v)) return v.map((x) => redact(x, key));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith('_')).map(([k, x]) => [k, redact(x, k)]));
  return v;
}

const MAX = 14_000;
function clip(s: string): string {
  return s.length > MAX ? `${s.slice(0, MAX)}\n…[truncated ${s.length - MAX} characters; narrow the request with $filter, $select or $top]` : s;
}

/** versioni del catalogo per il tipo del percorso, se noto */
function knownApiVersions(path: string): string[] | null {
  const at = path.toLowerCase().lastIndexOf('/providers/');
  if (at < 0) return null;
  const segs = path.slice(at + 11).split('/').filter(Boolean);
  const types = [segs[0], ...segs.slice(1).filter((_, i) => i % 2 === 0)];
  for (let n = types.length; n >= 2; n--) {
    const def = typeDef(types.slice(0, n).join('/'));
    if (def) return def.apiVersions;
  }
  return null;
}

/** Azure indica le versioni supportate nell'errore: la più recente stabile */
function retryVersion(r: { status: number; json: unknown }): string | null {
  if (r.status !== 400) return null;
  const msg = String((r.json as any)?.error?.message ?? '');
  const m = /supported api-versions are '([^']+)'/i.exec(msg);
  if (!m) return null;
  const v = m[1].split(',').map((x) => x.trim()).filter(Boolean).sort().reverse();
  return v.find((x) => !/preview/i.test(x)) ?? v[0] ?? null;
}

export function defaultApiVersion(path: string): string {
  const p = path.toLowerCase();
  if (/microsoft\.costmanagement\//.test(p)) return '2023-03-01';
  if (/microsoft\.consumption\//.test(p)) return '2023-05-01';
  if (/microsoft\.authorization\//.test(p)) return '2022-04-01';
  if (/microsoft\.resources\/deployments/.test(p)) return '2024-03-01';
  if (/microsoft\.insights\/eventtypes/.test(p)) return '2015-04-01';
  const at = path.toLowerCase().lastIndexOf('/providers/');
  if (at >= 0) {
    const segs = path.slice(at + 11).split('/').filter(Boolean);
    const types = [segs[0], ...segs.slice(1).filter((_, i) => i % 2 === 0)];
    for (let n = types.length; n >= 2; n--) {
      const def = typeDef(types.slice(0, n).join('/'));
      if (def) return def.apiVersions[0];
    }
    return '2023-01-01';
  }
  if (/^\/subscriptions\/[^/]+\/resourcegroups/.test(p)) return '2021-04-01';
  return '2022-12-01';
}

export interface ExecResult {
  content: string;
  isError: boolean;
  request?: { method: string; path: string; status: number; ms: number };
}

export interface ExecCtx {
  app: Hono<AppEnv>;
  cookie: string;
  userId: string;
  /** directory Azure reale attiva: ogni scrittura chiede conferma, i costi sono quelli veri */
  real?: { tenantId: string; name: string } | null;
}

async function call(ctx: ExecCtx, method: string, url: string, body?: unknown): Promise<{ status: number; json: unknown; ms: number }> {
  const t0 = Date.now();
  const res = await ctx.app.request(url, {
    method,
    headers: { cookie: ctx.cookie, 'X-Azzurro-Portal': '1', 'Content-Type': 'application/json', 'User-Agent': 'Azzurro-Assistant' },
    body: body === undefined || method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = text;
  try { json = text ? JSON.parse(text) : null; } catch { /* testo */ }
  return { status: res.status, json, ms: Date.now() - t0 };
}

export async function execute(ctx: ExecCtx, name: string, input: any): Promise<ExecResult> {
  switch (name) {
    case 'arm_request': {
      const path = input.path.split('?')[0];
      // il modello a volte inventa la versione: se il catalogo conosce il tipo, vale la sua
      const known = knownApiVersions(path);
      const version = input.api_version && (!known || known.includes(input.api_version)) ? input.api_version : defaultApiVersion(path);
      const qs = new URLSearchParams({ ...(input.query ?? {}), 'api-version': version });
      let r = await call(ctx, input.method, `${path}?${qs}`, input.body ?? (input.method === 'POST' ? {} : undefined));
      const retry = retryVersion(r);
      if (retry && retry !== version) {
        qs.set('api-version', retry);
        r = await call(ctx, input.method, `${path}?${qs}`, input.body ?? (input.method === 'POST' ? {} : undefined));
      }
      return { content: clip(JSON.stringify({ status: r.status, body: redact(r.json) })), isError: r.status >= 400, request: { method: input.method, path: `${path}?api-version=${qs.get('api-version')}`, status: r.status, ms: r.ms } };
    }
    case 'graph_request': {
      const path = String(input.path).replace(/^\/?(v1\.0|beta)\//, '/').replace(/^(?!\/)/, '/');
      const r = await call(ctx, input.method, `/v1.0${path}`, input.body);
      return { content: clip(JSON.stringify({ status: r.status, body: redact(r.json) })), isError: r.status >= 400, request: { method: input.method, path: `/v1.0${path}`, status: r.status, ms: r.ms } };
    }
    case 'query_costs': {
      const forecast = !!input.forecast;
      // Azure reale non accetta TheLastMonth e vuole un intervallo esplicito per la previsione
      const n = new Date();
      const month = (o: number) => ({ from: new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + o, 1)).toISOString(), to: new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + o + 1, 0, 23, 59, 59)).toISOString() });
      const tf = forecast ? 'Custom' : input.timeframe === 'TheLastMonth' ? 'Custom' : input.timeframe ?? 'MonthToDate';
      const tp = forecast ? month(0) : input.timeframe === 'TheLastMonth' ? month(-1) : input.timeframe === 'Custom' ? { from: input.from, to: input.to } : undefined;
      const body: any = {
        type: 'ActualCost',
        timeframe: tf,
        ...(tp ? { timePeriod: tp } : {}),
        dataset: {
          granularity: forecast ? 'Daily' : input.granularity ?? 'None',
          aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
          ...(input.group_by?.length && !forecast ? { grouping: input.group_by.map((n: string) => ({ type: 'Dimension', name: n })) } : {}),
        },
        ...(forecast ? { includeActualCost: true } : {}),
      };
      const path = `${input.scope.replace(/\/+$/, '')}/providers/Microsoft.CostManagement/${forecast ? 'forecast' : 'query'}`;
      const r = await call(ctx, 'POST', `${path}?api-version=2023-03-01`, body);
      return { content: clip(JSON.stringify({ status: r.status, note: ctx.real ? 'Real Azure Cost Management data for this directory.' : 'Estimated costs in EUR from the emulator, not an Azure invoice.', body: r.json })), isError: r.status >= 400, request: { method: 'POST', path: `${path}?api-version=2023-03-01`, status: r.status, ms: r.ms } };
    }
    case 'get_pricing': {
      if (input.resource_type) {
        const p = priceDef(input.resource_type);
        if (!p) return { content: JSON.stringify({ error: `No pricing for '${input.resource_type}'. Use get_resource_type without arguments to list types.` }), isError: true };
        return { content: clip(JSON.stringify({
          type: p.type, service: p.service, model: p.model, billedWith: p.billedWith?.en, notes: p.notes?.en, unit: p.unitLabel?.en, currency: 'EUR',
          plans: (p.plans ?? []).map((x) => ({ sku: x.sku, specs: x.specs.en, free: !!x.free, eurPerHour: x.hourly ?? null, eurPerMonth: x.free ? 0 : x.hourly !== undefined || x.monthly !== undefined ? +(((x.hourly ?? 0) * 730) + (x.monthly ?? 0)).toFixed(2) : null, meterPrices: x.meterPrices, meterIncluded: x.meterIncluded })),
          meters: (p.meters ?? []).map((m) => ({ key: m.key, label: m.label.en, unit: m.unit.en, eurPrice: m.price, per: m.per ?? 1, included: m.included ?? 0 })),
        })), isError: false };
      }
      const { PRICES } = await import('../costs/prices.ts');
      const rows = PRICES.filter((p) => p.model !== 'free' && p.model !== 'included').map((p) => {
        const monthly = (p.plans ?? []).filter((x) => !x.free && (x.hourly !== undefined || x.monthly !== undefined)).map((x) => +(((x.hourly ?? 0) * 730) + (x.monthly ?? 0)).toFixed(2));
        return { type: p.type, service: p.service, model: p.model, plans: (p.plans ?? []).length, minEurPerMonth: monthly.length ? Math.min(...monthly) : null, maxEurPerMonth: monthly.length ? Math.max(...monthly) : null };
      });
      return { content: clip(JSON.stringify({ currency: 'EUR', types: rows })), isError: false };
    }
    case 'estimate_resource': {
      if (ctx.real) {
        const g = await call(ctx, 'GET', `${input.resource_id}?api-version=${defaultApiVersion(input.resource_id)}`);
        if (g.status >= 400) return { content: JSON.stringify({ status: g.status, body: g.json }), isError: true };
        const e = estimate(g.json);
        return { content: clip(JSON.stringify({ currency: 'EUR', note: 'Indicative list-price estimate; use query_costs for the real billed cost.', type: e.type, plan: e.sku ?? null, units: e.units, eurPerMonth: e.monthly, lines: e.lines.map((l) => ({ line: l.label.en, quantity: l.quantity, unitPrice: l.unitPrice, eurPerMonth: l.monthly, simulatedUsage: l.simulated })) })), isError: false };
      }
      const rec = await store.get('resource', input.resource_id);
      if (!rec) return { content: JSON.stringify({ error: 'Resource not found.' }), isError: true };
      const check = await call(ctx, 'GET', `${input.resource_id}?api-version=${defaultApiVersion(input.resource_id)}`);
      if (check.status >= 400) return { content: JSON.stringify({ status: check.status, body: check.json }), isError: true };
      const e = estimate(rec);
      return { content: clip(JSON.stringify({ currency: 'EUR', type: e.type, service: e.service, model: e.model, plan: e.sku ?? null, units: e.units, idle: e.idle, eurPerMonth: e.monthly, lines: e.lines.map((l) => ({ line: l.label.en, quantity: l.quantity, unit: l.unit.en, unitPrice: l.unitPrice, per: l.per, included: l.included, eurPerMonth: l.monthly, simulatedUsage: l.simulated })), billedWith: e.billedWith?.en, notes: e.notes?.en })), isError: false };
    }
    case 'get_resource_type': {
      if (!input.resource_type) {
        return { content: clip(JSON.stringify(TYPES.filter((t) => !t.ui?.hidden).map((t) => ({ type: t.type, name: t.label.en, category: t.category })))), isError: false };
      }
      const t = typeDef(input.resource_type);
      if (!t) return { content: JSON.stringify({ error: `Type '${input.resource_type}' is not in the catalog; Azzurro still stores it as a generic resource.` }), isError: true };
      const children = TYPES.filter((x) => x.type.toLowerCase().startsWith(t.type.toLowerCase() + '/') && x.type.split('/').length === t.type.split('/').length + 1).map((x) => x.type);
      return { content: clip(JSON.stringify({
        type: t.type, name: t.label.en, category: t.category, apiVersions: t.apiVersions, global: !!t.global,
        fields: (t.ui?.fields ?? []).map((f) => ({ path: f.key, label: f.label.en, kind: f.kind, options: f.options, default: f.default, required: !!f.required })),
        actions: Object.keys(t.actions ?? {}), children,
        nameRule: t.nameRule ? { pattern: String(t.nameRule.pattern), message: t.nameRule.message } : null,
      })), isError: false };
    }
  }
  return { content: JSON.stringify({ error: `Unknown tool '${name}'.` }), isError: true };
}

/** Riga leggibile per la richiesta di conferma. */
export function describeCall(name: string, input: any): string {
  if (name === 'arm_request' || name === 'graph_request') return `${input.method} ${name === 'graph_request' ? '/v1.0' : ''}${input.path}`;
  return name;
}
