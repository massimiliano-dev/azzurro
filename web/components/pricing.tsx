'use client';

import Link from 'next/link';
import { arm, portal } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { ErrorNotice, Notice, Skeleton } from './ui';
import { money, monthRange, unitPrice } from '@/lib/money';
import { useI18n, type MessageKey } from '@/i18n';
import { ResourceIcon } from './resource';

type Lbl = { it: string; en: string };

export interface PriceType {
  type: string; label: Lbl; category: string; hidden: boolean; service: string;
  model: 'plan' | 'consumption' | 'mixed' | 'free' | 'included';
  unitLabel?: Lbl; billedWith?: Lbl; notes?: Lbl;
  plans: { sku: string; specs: Lbl; free: boolean; hourly: number | null; monthly: number | null; meterPrices: Record<string, number> | null; meterIncluded: Record<string, number> | null }[];
  meters: { key: string; label: Lbl; unit: Lbl; price: number; per: number; included: number; sample: number }[];
}

let pricingPromise: Promise<any> | null = null;
export function loadPricing() {
  pricingPromise ??= portal.get('/pricing').catch((e) => { pricingPromise = null; throw e; });
  return pricingPromise;
}

export function PriceCard({ p, current, wide }: { p: PriceType; current?: string; wide?: boolean }) {
  const { t, locale } = useI18n();
  const modelLabel: Record<PriceType['model'], MessageKey> = { plan: 'pricing.model.plan', consumption: 'pricing.model.consumption', mixed: 'pricing.model.mixed', free: 'pricing.model.free', included: 'pricing.model.included' };
  return (
    <section className={`board-cell ${wide ? 'span-12' : 'span-6'} price-card`} id={p.type.replace(/[^\w]/g, '-')}>
      <div className="card-head">
        <div className="cell-main"><ResourceIcon type={p.type} /><div><h2>{p.label[locale]}</h2><div className="mono small muted">{p.type}</div></div></div>
        <span className="stamp">{t(modelLabel[p.model])}</span>
      </div>
      <div className="card-body">
        {p.plans.length > 0 && (
          <div className="scroll-x"><table className="table compact">
            <thead><tr><th>{t('pricing.plan')}</th><th>{t('pricing.specs')}</th><th className="num">{t('pricing.perHour')}</th><th className="num">{t('pricing.perMonth')}</th></tr></thead>
            <tbody>{p.plans.map((pl) => (
              <tr key={pl.sku} className={current && current.toLowerCase() === pl.sku.toLowerCase() ? 'current' : ''}>
                <td className="mono small">{pl.sku}{current && current.toLowerCase() === pl.sku.toLowerCase() ? <span className="stamp sm">{t('pricing.current')}</span> : null}</td>
                <td className="small">{pl.specs[locale]}</td>
                <td className="num small">{pl.free ? t('pricing.free') : pl.hourly !== null ? unitPrice(pl.hourly, locale) : '—'}</td>
                <td className="num">{pl.free ? money(0, locale) : pl.monthly !== null ? money(pl.monthly, locale) : (() => {
                  const k = Object.keys(pl.meterPrices ?? {})[0];
                  const m = k ? p.meters.find((x) => x.key === k) : undefined;
                  return m && pl.meterPrices![k] ? <span className="small">{unitPrice(pl.meterPrices![k], locale)} <span className="muted">/ {m.per > 1 ? `${new Intl.NumberFormat(locale).format(m.per)} ` : ''}{m.unit[locale]}</span></span> : <span className="small muted">{t('pricing.usageOnly')}</span>;
                })()}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        {p.meters.length > 0 && (
          <div className="scroll-x"><table className="table compact meters">
            <thead><tr><th>{t('pricing.meter')}</th><th className="num">{t('pricing.price')}</th><th>{t('pricing.unit')}</th><th className="num">{t('pricing.included')}</th></tr></thead>
            <tbody>{p.meters.map((m) => (
              <tr key={m.key}>
                <td className="small">{m.label[locale]}</td>
                <td className="num small">{m.price ? unitPrice(m.price, locale) : <span className="muted">{t('pricing.byPlan')}</span>}</td>
                <td className="small muted">{m.unit[locale]}</td>
                <td className="num small">{m.included ? new Intl.NumberFormat(locale).format(m.included) : '—'}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        {p.unitLabel && p.plans.some((x) => !x.free) && <p className="small muted note">{t('pricing.perUnit', { unit: p.unitLabel[locale] })}</p>}
        {p.notes && <p className="small muted note">{p.notes[locale]}</p>}
      </div>
    </section>
  );
}

/** Scheda «Costi e piano» di una risorsa. */
export function ResourceCosts({ id, type, apiVersion }: { id: string; type?: string; apiVersion?: string }) {
  const { t, locale } = useI18n();
  const est = useAsync(async () => {
    const e = await portal.get<any>(`/pricing/estimate?id=${encodeURIComponent(id)}${apiVersion ? `&api-version=${apiVersion}` : ''}`);
    if (!e.real) return e;
    // Azure reale: spesa e previsione vere da Cost Management, filtrate sulla risorsa
    const sub = /\/subscriptions\/([^/]+)/i.exec(id)?.[1];
    const filter = { dimensions: { name: 'ResourceId', operator: 'In', values: [id.toLowerCase()] } };
    const agg = { totalCost: { name: 'Cost', function: 'Sum' } };
    const sum = (r: any) => (r?.properties?.rows ?? []).reduce((s: number, row: any[]) => s + Number(row[0] ?? 0), 0);
    const [q, f] = await Promise.all([
      arm.post(`/subscriptions/${sub}/providers/Microsoft.CostManagement/query`, { type: 'ActualCost', timeframe: 'MonthToDate', dataset: { granularity: 'None', aggregation: agg, filter } }, '2023-03-01').catch(() => null),
      arm.post(`/subscriptions/${sub}/providers/Microsoft.CostManagement/forecast`, { type: 'ActualCost', timeframe: 'Custom', timePeriod: monthRange(0), includeActualCost: true, dataset: { granularity: 'Daily', aggregation: agg, filter } }, '2023-03-01').catch(() => null),
    ]);
    return { ...e, monthToDate: q ? sum(q) : null, forecast: f ? sum(f) : null };
  }, [id, apiVersion]);
  const pricing = useAsync(() => loadPricing(), []);
  const p: PriceType | undefined = pricing.data?.types.find((x: PriceType) => x.type.toLowerCase() === (type ?? '').toLowerCase());
  if (est.error) return <ErrorNotice error={est.error} onRetry={est.reload} />;
  if (!est.data || !pricing.data) return <Skeleton rows={6} />;
  const e = est.data.estimate;
  if (e.model === 'free' || e.model === 'included' || e.model === 'unknown') {
    return (
      <div className="stack" style={{ gap: 16 }}>
        <Notice tone="ok" title={e.model === 'included' ? t('pricing.includedTitle') : t('pricing.freeResource')}>
          {e.model === 'included' ? t('pricing.includedIn', { what: e.billedWith?.[locale] ?? '' }) : e.notes?.[locale] ?? t('pricing.freeText')}
        </Notice>
      </div>
    );
  }
  return (
    <div className="board">
      <section className="ledger four" aria-label={t('pricing.summary')}>
        <div className="cell"><span className="label">{t('pricing.currentPlan')}</span><span className="value plan">{e.sku ?? t('pricing.usageOnly')}</span></div>
        <div className={`cell ${e.idle ? 'zero' : ''}`}><span className="label">{t('pricing.monthly')}</span><span className="value money">{money(e.monthly, locale)}</span></div>
        <div className="cell"><span className="label">{t('costs.mtd')}</span><span className="value money">{money(est.data.monthToDate, locale)}</span></div>
        <div className="cell"><span className="label">{t('costs.forecast')}</span><span className="value money">{money(est.data.forecast, locale)}</span></div>
      </section>
      <section className="board-cell span-12">
        <div className="card-head"><h2>{t('pricing.breakdown')}</h2><span className="small muted">{t('costs.estimateStamp')}</span></div>
        {e.idle && <div className="card-body"><Notice tone="info">{t('pricing.idle')}</Notice></div>}
        <div className="scroll-x"><table className="table">
          <thead><tr><th>{t('pricing.line')}</th><th className="num">{t('pricing.quantity')}</th><th className="num">{t('pricing.price')}</th><th className="num">{t('pricing.included')}</th><th className="num">{t('pricing.perMonth')}</th></tr></thead>
          <tbody>
            {e.lines.map((l: any) => (
              <tr key={l.key}>
                <td>{l.label[locale]} {l.simulated && <span className="stamp sm" title={t('pricing.simulatedHint')}>{t('pricing.simulated')}</span>}</td>
                <td className="num small">{new Intl.NumberFormat(locale).format(l.quantity)} <span className="muted">{l.kind === 'plan' ? (e.unitLabel?.[locale] ?? '') : ''}</span></td>
                <td className="num small">{unitPrice(l.unitPrice, locale)} <span className="muted">/ {l.per > 1 ? `${new Intl.NumberFormat(locale).format(l.per)} ` : ''}{l.kind === 'plan' ? t('pricing.perMonthShort') : l.unit[locale]}</span></td>
                <td className="num small">{l.included ? new Intl.NumberFormat(locale).format(l.included) : '—'}</td>
                <td className="num">{money(l.monthly, locale)}</td>
              </tr>
            ))}
            <tr className="total"><td colSpan={4}>{t('pricing.total')}</td><td className="num">{money(e.monthly, locale)}</td></tr>
          </tbody>
        </table></div>
        {e.notes && <div className="card-body small muted">{e.notes[locale]}</div>}
      </section>
      {p && p.plans.length > 1 && <PriceCard p={{ ...p, notes: undefined }} current={e.sku} wide />}
    </div>
  );
}

/** Stima compatta per il modulo di creazione. */
export function DraftEstimate({ type, resource }: { type: string; resource: any }) {
  const { t, locale } = useI18n();
  const key = JSON.stringify(resource);
  const est = useAsync(() => portal.post<any>('/pricing/estimate', { type, resource: JSON.parse(key) }), [type, key]);
  const e = est.data?.estimate;
  if (!e || e.model === 'unknown') return null;
  return (
    <div className="draft-estimate">
      <span className="label">{t('pricing.draft')}</span>
      <span className="value">{e.model === 'free' ? t('pricing.free') : e.model === 'included' ? t('pricing.includedShort') : `${money(e.monthly, locale)} ${t('pricing.perMonthShort')}`}</span>
      {e.lines?.some((l: any) => l.simulated) && <span className="small muted">{t('pricing.draftHint')}</span>}
      <Link href={`/pricing#${type.replace(/[^\w]/g, '-')}`} className="small">{t('nav.pricing')}</Link>
    </div>
  );
}
