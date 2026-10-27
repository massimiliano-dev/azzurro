/**
 * Emulazione di Microsoft.CostManagement: POST {scope}/providers/Microsoft.CostManagement/query
 * e /forecast, con timeframe, granularità, aggregazioni, raggruppamenti e filtri come Azure.
 */
import { armError, authorize, ok, type ArmCtx, type ArmResult } from '../arm/context.ts';
import { uuid } from '../ids.ts';
import { dayStart, facts, usagesUnder, type Fact } from './engine.ts';

export const CURRENCY = 'EUR';
const EUR_USD = 1.08;
const DAY = 86_400_000;

const DIMENSIONS = ['ResourceId', 'ResourceGroup', 'ResourceGroupName', 'SubscriptionId', 'ResourceType', 'ResourceLocation', 'ServiceName', 'MeterCategory', 'MeterSubCategory', 'Meter', 'ChargeType', 'PublisherType', 'PricingModel', 'ResourceName'];
const DIM_BY_LOWER = new Map(DIMENSIONS.map((d) => [d.toLowerCase(), d]));

/** chiavi case-insensitive (l'API accetta sia `dimensions` sia `Dimensions`) */
function g(o: any, k: string): any {
  if (!o || typeof o !== 'object') return undefined;
  const hit = Object.keys(o).find((x) => x.toLowerCase() === k.toLowerCase());
  return hit === undefined ? undefined : o[hit];
}

function monthStart(t: number) {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}
function nextMonth(t: number) {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

export function period(body: any, now = Date.now(), forecast = false): { from: number; to: number } {
  const tf = String(g(body, 'timeframe') ?? 'MonthToDate').toLowerCase();
  switch (tf) {
    case 'monthtodate':
    case 'billingmonthtodate':
      return { from: monthStart(now), to: forecast ? nextMonth(now) : dayStart(now) + DAY };
    case 'thelastmonth':
    case 'thelastbillingmonth': {
      const to = monthStart(now);
      return { from: monthStart(to - 1), to };
    }
    case 'weektodate': {
      const d = new Date(dayStart(now));
      const back = (d.getUTCDay() + 6) % 7;
      return { from: dayStart(now) - back * DAY, to: dayStart(now) + DAY };
    }
    case 'custom': {
      const tp = g(body, 'timePeriod') ?? {};
      const from = Date.parse(g(tp, 'from'));
      let to = Date.parse(g(tp, 'to'));
      if (!Number.isFinite(from) || !Number.isFinite(to)) throw armError(400, 'BadRequest', "Invalid query definition: 'timePeriod' with 'from' and 'to' is required when timeframe is 'Custom'.");
      if (to % DAY === 0) to += DAY; // data senza ora: giorno incluso
      else to = Math.ceil(to / 1000) * 1000;
      if (to <= from) throw armError(400, 'BadRequest', "Invalid query definition: 'from' must be earlier than 'to'.");
      if (to - from > 366 * DAY) throw armError(400, 'BadRequest', 'Invalid query definition: the time period cannot exceed one year.');
      return { from, to };
    }
    default:
      throw armError(400, 'BadRequest', `Invalid query definition: timeframe '${g(body, 'timeframe')}' is not supported. Supported: MonthToDate, BillingMonthToDate, TheLastMonth, TheLastBillingMonth, WeekToDate, Custom.`);
  }
}

function matches(f: Fact, filter: any): boolean {
  if (!filter) return true;
  const and = g(filter, 'and');
  if (Array.isArray(and)) return and.every((x) => matches(f, x));
  const or = g(filter, 'or');
  if (Array.isArray(or)) return or.some((x) => matches(f, x));
  const not = g(filter, 'not');
  if (not) return !matches(f, not);
  const dim = g(filter, 'dimensions') ?? g(filter, 'dimension');
  const tag = g(filter, 'tags') ?? g(filter, 'tag');
  const cond = dim ?? tag;
  if (!cond) return true;
  const name = String(g(cond, 'name') ?? '');
  const values = (g(cond, 'values') ?? []).map((v: unknown) => String(v).toLowerCase());
  const op = String(g(cond, 'operator') ?? 'In').toLowerCase();
  let actual: string | undefined;
  if (dim) {
    const canon = DIM_BY_LOWER.get(name.toLowerCase());
    if (!canon) throw armError(400, 'BadRequest', `Invalid query definition: dimension '${name}' is not valid. Valid values: ${DIMENSIONS.join(', ')}.`);
    actual = f.dims[canon];
  } else {
    const k = Object.keys(f.tags).find((x) => x.toLowerCase() === name.toLowerCase());
    actual = k === undefined ? undefined : String(f.tags[k]);
  }
  const a = (actual ?? '').toLowerCase();
  if (op === 'in' || op === 'equal') return values.includes(a);
  if (op === 'contains') return values.some((v: string) => a.includes(v));
  if (op === 'notin' || op === 'notequal') return !values.includes(a);
  throw armError(400, 'BadRequest', `Invalid query definition: operator '${g(cond, 'operator')}' is not supported.`);
}

interface Agg { name: string; usd: boolean; quantity: boolean }

function aggregations(body: any, kind: 'query' | 'forecast'): Agg[] {
  const ds = g(body, 'dataset') ?? {};
  const aggs = g(ds, 'aggregation');
  const fallback = String(g(body, 'type') ?? 'ActualCost').toLowerCase() === 'usage' && kind === 'query' ? 'PreTaxCost' : 'Cost';
  if (!aggs || !Object.keys(aggs).length) return [{ name: fallback, usd: false, quantity: false }];
  return Object.values(aggs).map((a: any) => {
    const name = String(g(a, 'name') ?? fallback);
    const fn = String(g(a, 'function') ?? 'Sum');
    if (fn.toLowerCase() !== 'sum') throw armError(400, 'BadRequest', `Invalid query definition: aggregation function '${fn}' is not supported; use 'Sum'.`);
    if (!/^(PreTaxCost|Cost|CostUSD|PreTaxCostUSD|UsageQuantity)$/i.test(name)) throw armError(400, 'BadRequest', `Invalid query definition: aggregation column '${name}' is not valid.`);
    return { name, usd: /usd$/i.test(name), quantity: /^usagequantity$/i.test(name) };
  });
}

function groupings(body: any): { type: 'Dimension' | 'TagKey'; name: string }[] {
  const gs = g(g(body, 'dataset') ?? {}, 'grouping') ?? [];
  if (!Array.isArray(gs)) return [];
  if (gs.length > 2) throw armError(400, 'BadRequest', 'Invalid query definition: a maximum of 2 groupings is supported.');
  return gs.map((x: any) => {
    const type = String(g(x, 'type') ?? 'Dimension').toLowerCase() === 'tagkey' ? 'TagKey' : 'Dimension';
    const raw = String(g(x, 'name') ?? '');
    if (type === 'Dimension') {
      const canon = DIM_BY_LOWER.get(raw.toLowerCase());
      if (!canon) throw armError(400, 'BadRequest', `Invalid dataset grouping: '${raw}'; valid values: ${DIMENSIONS.join(', ')}.`);
      return { type, name: canon };
    }
    return { type, name: raw };
  });
}

function checkScope(scope: string) {
  if (!/^\/subscriptions\/[^/]+(\/resourcegroups\/[^/]+)?$/i.test(scope)) {
    throw armError(400, 'BadRequest', `Scope '${scope}' is not supported. Azzurro supports subscription and resource group scopes.`);
  }
}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const usageDate = (day: string) => Number(day.replaceAll('-', ''));

export async function costManagement(ctx: ArmCtx, method: string, scope: string, op: string, body: any): Promise<ArmResult> {
  const kind = op.toLowerCase();
  if (method !== 'POST' || (kind !== 'query' && kind !== 'forecast')) {
    throw armError(400, 'InvalidResourceType', `The resource type '${op}' could not be found in the namespace 'Microsoft.CostManagement'.`);
  }
  checkScope(scope);
  await authorize(ctx, `Microsoft.CostManagement/${kind}/read`, scope);
  const forecast = kind === 'forecast';
  const { from, to } = period(body, Date.now(), forecast);
  const ds = g(body, 'dataset') ?? {};
  const gran = String(g(ds, 'granularity') ?? 'None').toLowerCase();
  if (!['none', 'daily', 'monthly'].includes(gran)) throw armError(400, 'BadRequest', `Invalid query definition: granularity '${g(ds, 'granularity')}' is not supported.`);
  const aggs = aggregations(body, kind);
  const groups = forecast ? [] : groupings(body);
  const filter = g(ds, 'filter');
  const includeActual = forecast ? g(body, 'includeActualCost') !== false : true;

  const all = facts(await usagesUnder(scope), from, to, Date.now(), forecast).filter((f) => matches(f, filter) && (includeActual || f.forecast));

  const dateCol = gran === 'daily' ? 'UsageDate' : gran === 'monthly' ? 'BillingMonth' : null;
  const buckets = new Map<string, { vals: number[]; date?: string; groups: string[]; status?: string }>();
  for (const f of all) {
    const date = gran === 'daily' ? f.day : gran === 'monthly' ? `${f.day.slice(0, 7)}-01T00:00:00` : undefined;
    const gvals = groups.map((gr) => (gr.type === 'Dimension' ? f.dims[gr.name] ?? '' : (() => { const k = Object.keys(f.tags).find((x) => x.toLowerCase() === gr.name.toLowerCase()); return k === undefined ? '' : String(f.tags[k]); })()));
    const status = forecast ? (f.forecast ? 'Forecast' : 'Actual') : undefined;
    const key = JSON.stringify([date, gvals, status]);
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { vals: aggs.map(() => 0), date, groups: gvals, status }));
    aggs.forEach((a, i) => { b!.vals[i] += a.quantity ? f.hours : a.usd ? f.cost * EUR_USD : f.cost; });
  }

  const columns = [
    ...aggs.map((a) => ({ name: a.name, type: 'Number' })),
    ...(dateCol ? [{ name: dateCol, type: dateCol === 'UsageDate' ? 'Number' : 'Datetime' }] : []),
    ...groups.map((gr) => ({ name: gr.type === 'TagKey' ? gr.name : gr.name, type: 'String' })),
    ...(forecast ? [{ name: 'CostStatus', type: 'String' }] : []),
    { name: 'Currency', type: 'String' },
  ];
  const rows = [...buckets.values()]
    .sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')) || b.vals[0] - a.vals[0])
    .map((b) => [
      ...b.vals.map(r6),
      ...(dateCol ? [dateCol === 'UsageDate' ? usageDate(b.date!) : b.date] : []),
      ...b.groups,
      ...(forecast ? [b.status] : []),
      aggs.some((a) => a.usd) && aggs.every((a) => a.usd || a.quantity) ? 'USD' : CURRENCY,
    ]);
  const id = uuid();
  return ok({
    id: `${scope}/providers/Microsoft.CostManagement/${kind}/${id}`,
    name: id,
    type: `Microsoft.CostManagement/${kind === 'query' ? 'query' : 'forecast'}`,
    location: null,
    sku: null,
    eTag: null,
    properties: { nextLink: null, columns, rows },
  });
}
