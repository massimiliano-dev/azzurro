'use client';

import Link from 'next/link';
import { arm } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { money, monthRange, rowsOf, type CostTable } from '@/lib/money';
import { useI18n } from '@/i18n';
import { Notice, Skeleton } from './ui';

const CM = '2023-03-01';
const agg = { totalCost: { name: 'Cost', function: 'Sum' } };

/** Riepilogo dei costi del mese in home: spesa, previsione, media e servizi più costosi. */
export function HomeCosts({ subscriptions }: { subscriptions: { id: string; name: string }[] }) {
  const { t, locale } = useI18n();
  const key = subscriptions.slice(0, 8).map((x) => x.id).join(',');
  const data = useAsync(async () => {
    const subs = key ? key.split(',') : [];
    const per = await Promise.all(subs.map(async (sub) => {
      const scope = `/subscriptions/${sub}`;
      const [fc, svc] = await Promise.all([
        arm.post<CostTable>(`${scope}/providers/Microsoft.CostManagement/forecast`, { type: 'ActualCost', timeframe: 'Custom', timePeriod: monthRange(0), includeActualCost: true, includeFreshPartialCost: false, dataset: { granularity: 'Daily', aggregation: agg } }, CM).catch(() => null),
        arm.post<CostTable>(`${scope}/providers/Microsoft.CostManagement/query`, { type: 'ActualCost', timeframe: 'MonthToDate', dataset: { granularity: 'None', aggregation: agg, grouping: [{ type: 'Dimension', name: 'ServiceName' }] } }, CM).catch(() => null),
      ]);
      return { sub, fc, svc };
    }));
    let actual = 0, forecast = 0, ok = false, fcOk = false;
    const bySub: { id: string; actual: number; forecast: number | null; top: string | null; ok: boolean }[] = [];
    for (const p of per) {
      // la spesa del mese viene dalla query per servizio; la previsione solo se l'API la restituisce
      const svc = p.svc ? rowsOf(p.svc).sort((x, y) => y.Cost - x.Cost) : [];
      const a = svc.reduce((n, r) => n + r.Cost, 0);
      let f: number | null = null;
      if (p.fc) { fcOk = true; f = rowsOf(p.fc).reduce((n, r) => n + r.Cost, 0); }
      if (p.svc) ok = true;
      actual += a; forecast += f ?? a;
      bySub.push({ id: p.sub, actual: a, forecast: f, top: svc.find((r) => r.Cost > 0)?.ServiceName ?? null, ok: !!p.svc });
    }
    const day = Math.max(1, new Date().getUTCDate());
    return { ok, fcOk, actual, forecast: fcOk ? forecast : null, perDay: actual / day, bySub: bySub.sort((x, y) => y.actual - x.actual) };
  }, [key], { enabled: !!key, interval: 10 * 60_000 });

  return (
    <section className="board-cell span-12">
      <div className="card-head"><h2>{t('home.costs')}</h2><span className="small muted">{t('costs.estimateStamp')}</span><Link href="/costs" className="small">{t('nav.costs')}</Link></div>
      {!data.data ? <div className="card-body"><Skeleton rows={3} /></div> : !data.data.ok ? <div className="card-body"><Notice tone="warn" title={t('costs.throttledTitle')}>{t('costs.throttled')}</Notice></div> : (
        <div className="home-costs">
          <div className="figures">
            {([[t('costs.mtd'), data.data.actual, '#2f5bff'], [t('costs.forecast'), data.data.forecast, '#f6c344'], [t('costs.perDay'), data.data.perDay, '#19b36b']] as [string, number | null, string][]).map(([label, v, team], i) => (
              <div className="fig" key={label} style={{ ['--team' as string]: team, animationDelay: `${i * 0.06}s` }}>
                <span className="label">{label}</span>
                <span className="value">{v === null ? '—' : money(v, locale)}</span>
              </div>
            ))}
          </div>
          <div className="subs">
            <div className="subs-head"><span>{t('common.subscription')}</span><span>{t('costs.mtd')}</span><span>{t('costs.forecast')}</span></div>
            {data.data.bySub.map((x) => {
              const name = subscriptions.find((y) => y.id === x.id)?.name ?? x.id;
              const max = Math.max(0.0001, ...data.data!.bySub.map((y) => Math.max(y.actual, y.forecast ?? 0)));
              return (
                <Link key={x.id} href={`/costs?sub=${x.id}`} className="sub-row">
                  <span className="n"><strong>{name}</strong><span className="small muted">{x.ok ? (x.top ?? t('costs.none')) : t('costs.throttledShort')}</span></span>
                  <span className="bar" aria-hidden><span className="f" style={{ width: `${((x.forecast ?? x.actual) / max) * 100}%` }} /><span className="a" style={{ width: `${(x.actual / max) * 100}%` }} /></span>
                  <span className="v">{x.ok ? money(x.actual, locale) : '—'}</span>
                  <span className="v muted">{x.forecast !== null ? money(x.forecast, locale) : '—'}</span>
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
