/** Endpoint del portale per listino ed estimazioni (non sono API di Azure). */
import type { Hono } from 'hono';
import * as store from '../db/store.ts';
import { readJson } from '../http.ts';
import { HttpError } from '../errors.ts';
import { loadAccess, can } from '../arm/rbac.ts';
import { typeDef } from '../arm/catalog.ts';
import { HOURS_PER_MONTH, PRICES, VM_SIZES } from './prices.ts';
import { estimate } from './engine.ts';
import { CLAUDE_PRICES, MODEL_REGIONS, modelPrices } from './models.ts';
import { facts, usagesUnder } from './engine.ts';
import { period, CURRENCY } from './query.ts';
import type { AppEnv } from '../types.ts';

const SAMPLE = { id: '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/sample/providers/x/y/sample', properties: {}, sku: {} };

export function pricingRoutes(app: Hono<AppEnv>): void {
  /** Modelli AI di Foundry / Azure OpenAI per regione (Azure Retail Prices, EUR) e Claude (Marketplace, USD). */
  app.get('/_portal/pricing/models', async (c) => {
    const list = await modelPrices(c.req.query('region') ?? 'swedencentral');
    return c.json({ ...list, regions: MODEL_REGIONS, claude: CLAUDE_PRICES });
  });
  app.get('/_portal/pricing', (c) => c.json({
    currency: CURRENCY,
    region: 'westeurope',
    hoursPerMonth: HOURS_PER_MONTH,
    disclaimer: {
      it: 'Prezzi indicativi in EUR per West Europe, a consumo, Linux, IVA esclusa. Servono a confrontare piani e stimare costi: non sono il listino ufficiale Azure.',
      en: 'Indicative prices in EUR for West Europe, pay-as-you-go, Linux, excluding VAT. They are for comparing plans and estimating costs: not the official Azure price list.',
    },
    types: PRICES.map((p) => ({
      type: p.type,
      label: typeDef(p.type)?.label ?? { it: p.type, en: p.type },
      category: typeDef(p.type)?.category ?? 'management',
      hidden: !!typeDef(p.type)?.ui?.hidden,
      service: p.service,
      model: p.model,
      unitLabel: p.unitLabel,
      billedWith: p.billedWith,
      notes: p.notes,
      plans: (p.plans ?? []).map((pl) => ({
        sku: pl.sku, specs: pl.specs, free: !!pl.free,
        hourly: pl.hourly ?? null,
        monthly: pl.free ? 0 : pl.hourly !== undefined || pl.monthly !== undefined ? Math.round(((pl.hourly ?? 0) * HOURS_PER_MONTH + (pl.monthly ?? 0)) * 100) / 100 : null,
        meterPrices: pl.meterPrices ?? null, meterIncluded: pl.meterIncluded ?? null,
      })),
      meters: (p.meters ?? []).map((m) => ({ key: m.key, label: m.label, unit: m.unit, price: m.price, per: m.per ?? 1, included: m.included ?? 0, sample: m.sim(SAMPLE) })),
    })),
    vmSizes: Object.entries(VM_SIZES).map(([sku, [cpu, gb, h, extra]]) => ({ sku, vcpu: cpu, memoryGiB: gb, hourly: h, monthly: Math.round(h * HOURS_PER_MONTH * 100) / 100, extra: extra ?? null })),
  }));

  /** Stima per una risorsa esistente (?id=) o per una bozza ({ type, resource }) dal modulo di creazione. */
  app.get('/_portal/pricing/estimate', async (c) => {
    const id = String(c.req.query('id') ?? '');
    const rec = id ? await store.get('resource', id) : null;
    if (!rec) throw new HttpError(404, 'ResourceNotFound', `The resource '${id}' was not found.`);
    const access = await loadAccess(c.get('principal'));
    if (!can(access, `${rec.type}/read`, rec.id)) throw new HttpError(403, 'AuthorizationFailed', 'You do not have access to this resource.');
    const est = estimate(rec);
    const { from, to } = period({ timeframe: 'MonthToDate' }, Date.now(), true);
    const f = facts(await usagesUnder(rec.id), from, to, Date.now(), true).filter((x) => x.dims.ResourceId === rec.id.toLowerCase());
    const mtd = f.filter((x) => !x.forecast).reduce((s, x) => s + x.cost, 0);
    const fc = mtd + f.filter((x) => x.forecast).reduce((s, x) => s + x.cost, 0);
    return c.json({ currency: CURRENCY, estimate: est, monthToDate: Math.round(mtd * 100) / 100, forecast: Math.round(fc * 100) / 100, createdAt: rec._created ?? null, power: rec._power ?? null });
  });

  app.post('/_portal/pricing/estimate', async (c) => {
    const body = await readJson(c);
    const type = String(body.type ?? '');
    const draft = { ...(body.resource ?? {}), type, id: `${SAMPLE.id}-${type}` };
    return c.json({ currency: CURRENCY, estimate: estimate(draft) });
  });
}
