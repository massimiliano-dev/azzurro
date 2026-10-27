/**
 * Motore dei costi stimati: tariffa del piano attuale × ore di vita della risorsa,
 * più consumi simulati (l'emulatore non ha un data plane). Le risorse eliminate
 * restano nello storico (`retiredResource`) per i costi del periodo.
 */
import * as store from '../db/store.ts';
import { diskTier, HOURS_PER_MONTH, openAiTokenPrices, priceDef, type Lbl, type Plan, type PriceDef } from './prices.ts';

export interface Line {
  kind: 'plan' | 'meter';
  key: string;
  label: Lbl;
  quantity: number;
  unit: Lbl;
  unitPrice: number;
  per: number;
  included: number;
  monthly: number;
  simulated: boolean;
}

export interface Estimate {
  type: string;
  service: string;
  model: PriceDef['model'] | 'unknown';
  sku?: string;
  plan?: Plan;
  units: number;
  unitLabel?: Lbl;
  idle: boolean;
  monthly: number;
  hourly: number;
  lines: Line[];
  billedWith?: Lbl;
  notes?: Lbl;
}

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
const l = (it: string, en: string = it): Lbl => ({ it, en });

export function estimate(rec: any): Estimate {
  const def = priceDef(rec?.type ?? '');
  if (!def) return { type: rec?.type, service: 'Other', model: 'unknown', units: 1, idle: false, monthly: 0, hourly: 0, lines: [] };
  const base: Estimate = { type: def.type, service: def.service, model: def.model, units: 1, unitLabel: def.unitLabel, idle: false, monthly: 0, hourly: 0, lines: [], billedWith: def.billedWith, notes: def.notes };
  if (def.model === 'free' || def.model === 'included') return base;

  const sku = def.plan?.(rec);
  const plan = sku ? def.plans?.find((p) => p.sku.toLowerCase() === sku.toLowerCase()) : undefined;
  const units = def.units ? def.units(rec) : 1;
  const idle = !!def.idle?.(rec);
  const lines: Line[] = [];

  if (def.type === 'Microsoft.Compute/disks') {
    const size = Number(rec?.properties?.diskSizeGB ?? 32);
    const t = diskTier(sku ?? 'Premium_LRS', size);
    lines.push({ kind: 'plan', key: 'plan', label: l(`Disco ${t.tier} (${size} GiB)`, `${t.tier} disk (${size} GiB)`), quantity: 1, unit: l('disco/mese', 'disk/month'), unitPrice: round(t.monthly), per: 1, included: 0, monthly: round(t.monthly), simulated: false });
  } else if (sku) {
    const perUnitMonthly = plan ? (plan.free ? 0 : (plan.hourly ?? 0) * HOURS_PER_MONTH + (plan.monthly ?? 0)) : fallbackMonthly(def, sku);
    if (perUnitMonthly > 0 || plan?.free || !plan) {
      const monthly = idle ? 0 : perUnitMonthly * units;
      lines.push({
        kind: 'plan', key: 'plan', label: l(`Piano ${sku}`, `${sku} plan`), quantity: units, unit: def.unitLabel ?? l('unità', 'unit'),
        unitPrice: round(perUnitMonthly), per: 1, included: 0, monthly: round(monthly), simulated: false,
      });
    }
  }

  const tokenPrices = def.type === 'Microsoft.CognitiveServices/accounts/deployments' ? openAiTokenPrices(rec?.properties?.model?.name) : undefined;
  for (const m of def.meters ?? []) {
    let price = plan?.meterPrices?.[m.key] ?? m.price;
    if (tokenPrices && (m.key === 'input' || m.key === 'output') && plan?.meterPrices?.[m.key] === undefined) price = m.key === 'input' ? tokenPrices[0] : tokenPrices[1];
    const included = plan?.meterIncluded?.[m.key] ?? m.included ?? 0;
    const qty = Math.max(0, m.sim(rec));
    if (!qty && !price) continue;
    if (!qty) continue;
    const per = m.per ?? 1;
    const billable = Math.max(0, qty - included);
    const zero = idle && def.model === 'consumption';
    const monthly = zero ? 0 : (billable / per) * price;
    lines.push({ kind: 'meter', key: m.key, label: m.label, quantity: qty, unit: m.unit, unitPrice: price, per, included, monthly: round(monthly), simulated: true });
  }

  const monthly = round(lines.reduce((s, x) => s + x.monthly, 0), 2);
  return { ...base, sku, plan, units, idle, monthly, hourly: monthly / HOURS_PER_MONTH, lines };
}

function fallbackMonthly(def: PriceDef, _sku: string): number {
  // dimensione VM o SKU non a listino: una stima prudente invece di zero
  if (/virtualMachines|virtualMachineScaleSets/.test(def.type)) return 0.1 * HOURS_PER_MONTH;
  return 0;
}

// ------------------------------------------------------------------ storico

/** Conserva le risorse eliminate per poterne contare i costi nel periodo. */
export function installRetirement(): void {
  store.onRemove('resource', async (rows) => {
    const at = new Date().toISOString();
    for (const r of rows) {
      if (!r?.id || r._ext) continue;
      const def = priceDef(r.type);
      if (!def || def.model === 'free' || def.model === 'included') continue;
      const { _secrets, ...rest } = r;
      void _secrets;
      await store.put('retiredResource', `${r.id}|${at}`, { ...rest, _deleted: at });
    }
  });
}

// ------------------------------------------------------------------ fatti di costo

export interface Usage {
  rec: any;
  est: Estimate;
  start: number;
  end: number | null;
}

export async function usagesUnder(prefix: string): Promise<Usage[]> {
  const p = prefix.toLowerCase().replace(/\/+$/, '');
  const live = await store.list('resource', { prefix: p + '/' });
  const own = await store.get('resource', p);
  const retired = await store.list('retiredResource', { prefix: p + '/' });
  const out: Usage[] = [];
  for (const r of [...(own ? [own] : []), ...live]) {
    if (r._ext) continue;
    const est = estimate(r);
    if (est.monthly > 0) out.push({ rec: r, est, start: Date.parse(r._created ?? r.systemData?.createdAt ?? new Date().toISOString()), end: null });
  }
  for (const r of retired) {
    const est = estimate(r);
    if (est.monthly > 0) out.push({ rec: r, est, start: Date.parse(r._created ?? r.systemData?.createdAt), end: Date.parse(r._deleted) });
  }
  return out;
}

export interface Fact {
  day: string; // YYYY-MM-DD
  cost: number;
  hours: number;
  forecast: boolean;
  dims: Record<string, string>;
  tags: Record<string, string>;
}

const DAY = 86_400_000;
export const dayStart = (t: number) => Math.floor(t / DAY) * DAY;
export const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

function dimsOf(u: Usage, line: Line): Record<string, string> {
  const id = String(u.rec.id).toLowerCase();
  const m = /^\/subscriptions\/([^/]+)(?:\/resourcegroups\/([^/]+))?/.exec(id);
  const type = String(u.rec.type).toLowerCase();
  return {
    ResourceId: id,
    ResourceGroup: m?.[2] ?? '',
    ResourceGroupName: m?.[2] ?? '',
    SubscriptionId: m?.[1] ?? '',
    ResourceType: type,
    ResourceLocation: String(u.rec.location ?? 'global').toLowerCase(),
    ServiceName: u.est.service,
    MeterCategory: u.est.service,
    MeterSubCategory: u.est.sku ?? '',
    Meter: line.label.en,
    ChargeType: 'Usage',
    PublisherType: 'Azure',
    PricingModel: 'OnDemand',
    ResourceName: String(u.rec.name ?? ''),
  };
}

/**
 * Fatti giornalieri nel periodo [from, to). I giorni (o le ore) dopo `now`
 * sono previsioni: solo per le risorse ancora esistenti, alla tariffa attuale.
 */
export function facts(usages: Usage[], from: number, to: number, now = Date.now(), withForecast = false): Fact[] {
  const out: Fact[] = [];
  for (const u of usages) {
    const s = Math.max(from, u.start);
    const eActual = Math.min(to, u.end ?? now, now);
    const eForecast = u.end === null ? to : Math.min(to, u.end);
    for (let d = dayStart(s); d < (withForecast ? eForecast : eActual); d += DAY) {
      const segs: [number, number, boolean][] = [];
      const a0 = Math.max(d, s), a1 = Math.min(d + DAY, eActual);
      if (a1 > a0) segs.push([a0, a1, false]);
      if (withForecast) {
        const f0 = Math.max(d, s, now), f1 = Math.min(d + DAY, eForecast);
        if (f1 > f0) segs.push([f0, f1, true]);
      }
      for (const [x0, x1, fc] of segs) {
        const hours = (x1 - x0) / 3_600_000;
        for (const line of u.est.lines) {
          if (!line.monthly) continue;
          out.push({ day: isoDay(d), cost: (line.monthly / HOURS_PER_MONTH) * hours, hours, forecast: fc, dims: dimsOf(u, line), tags: u.rec.tags ?? {} });
        }
      }
    }
  }
  return out;
}
