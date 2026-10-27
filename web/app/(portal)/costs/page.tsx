'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Coins, Plus, Tags, Trash2 } from 'lucide-react';
import { arm } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { loadCatalog, parseId, resourceHref, typeLabel } from '@/lib/arm';
import { money, monthRange, rowsOf, type CostTable } from '@/lib/money';
import { useI18n } from '@/i18n';
import { PageHeader } from '@/components/page';
import { SubscriptionSelect, ResourceGroupSelect, useSubscriptions } from '@/components/pickers';
import { Button, Empty, ErrorNotice, Field, Input, Notice, Skeleton } from '@/components/ui';
import { ResourceIcon } from '@/components/resource';
import { CostBars, CostChart, type DayPoint } from '@/components/costchart';
import { useConfirm, useToast } from '@/components/overlay';

const CM = '2023-03-01';
const BUDGET_API = '2023-05-01';
type Period = 'current' | 'last';

const ymd = (n: number) => `${String(n).slice(0, 4)}-${String(n).slice(4, 6)}-${String(n).slice(6, 8)}`;

export default function CostsPage() {
  const { t, locale } = useI18n();
  const subs = useSubscriptions();
  const sp = useSearchParams();
  const [sub, setSub] = useState(sp.get('sub') ?? '');
  const [rg, setRg] = useState('');
  const [periodSel, setPeriod] = useState<Period>('current');
  useEffect(() => {
    if (!sub && subs.data?.length) setSub(subs.data[0].subscriptionId);
  }, [subs.data, sub]);
  const scope = sub ? `/subscriptions/${sub}${rg ? `/resourceGroups/${rg}` : ''}` : '';
  const timeframe = periodSel === 'current' ? 'MonthToDate' : 'LastMonth';
  const cat = useAsync(() => loadCatalog(), []);

  const data = useAsync(async () => {
    if (!scope) return null;
    // Azure reale limita molto Cost Management: ogni chiamata può fallire da sola senza azzerare la pagina
    let failed = 0;
    const soft = <T,>(p: Promise<T>) => p.catch(() => { failed++; return undefined; });
    const period = periodSel === 'current' ? { timeframe: 'MonthToDate' } : { timeframe: 'Custom', timePeriod: monthRange(-1) };
    const q = (body: any) => soft(arm.post<CostTable>(`${scope}/providers/Microsoft.CostManagement/query`, { type: 'ActualCost', ...period, ...body }, CM));
    const sum = { totalCost: { name: 'Cost', function: 'Sum' } };
    const [fc, byService, byRg, byResource, last] = await Promise.all([
      periodSel === 'current'
        ? soft(arm.post<CostTable>(`${scope}/providers/Microsoft.CostManagement/forecast`, { type: 'ActualCost', timeframe: 'Custom', timePeriod: monthRange(0), includeActualCost: true, includeFreshPartialCost: false, dataset: { granularity: 'Daily', aggregation: sum } }, CM))
        : Promise.resolve(undefined),
      q({ dataset: { granularity: 'None', aggregation: sum, grouping: [{ type: 'Dimension', name: 'ServiceName' }] } }),
      rg ? Promise.resolve(undefined) : q({ dataset: { granularity: 'None', aggregation: sum, grouping: [{ type: 'Dimension', name: 'ResourceGroupName' }] } }),
      q({ dataset: { granularity: 'None', aggregation: sum, grouping: [{ type: 'Dimension', name: 'ResourceId' }, { type: 'Dimension', name: 'MeterSubCategory' }] } }),
      periodSel === 'current' ? soft(arm.post<CostTable>(`${scope}/providers/Microsoft.CostManagement/query`, { type: 'ActualCost', timeframe: 'Custom', timePeriod: monthRange(-1), dataset: { granularity: 'None', aggregation: sum } }, CM)) : Promise.resolve(undefined),
    ]);
    // senza previsione (o per il mese scorso) il grafico usa la spesa giornaliera effettiva
    const daily = fc ?? await q({ dataset: { granularity: 'Daily', aggregation: sum } });
    if (!daily && !byService && !byResource) throw new Error(failed ? 'COST_UNAVAILABLE' : 'COST_EMPTY');
    return { daily, byService, byRg, byResource, last, partial: failed > 0 };
  }, [scope, timeframe]);

  const budgets = useAsync(async () => (scope ? (await arm.get<{ value: any[] }>(`${scope}/providers/Microsoft.Consumption/budgets`, BUDGET_API)).value : []), [scope]);

  const view = useMemo(() => {
    const d = data.data;
    if (!d) return null;
    const now = new Date();
    const y = now.getUTCFullYear(), m = now.getUTCMonth();
    const ref = periodSel === 'current' ? new Date(Date.UTC(y, m, 1)) : new Date(Date.UTC(y, m - 1, 1));
    const days = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + 1, 0)).getUTCDate();
    const map = new Map<string, DayPoint>();
    for (let i = 1; i <= days; i++) {
      const day = `${ref.getUTCFullYear()}-${String(ref.getUTCMonth() + 1).padStart(2, '0')}-${String(i).padStart(2, '0')}`;
      map.set(day, { day, actual: 0, forecast: 0 });
    }
    for (const r of rowsOf(d.daily)) {
      const p = map.get(ymd(r.UsageDate));
      if (!p) continue;
      if (r.CostStatus === 'Forecast') p.forecast += r.Cost;
      else p.actual += r.Cost;
    }
    const points = [...map.values()];
    const actual = points.reduce((s, p) => s + p.actual, 0);
    const forecast = actual + points.reduce((s, p) => s + p.forecast, 0);
    const elapsed = periodSel === 'current' ? Math.max(1, now.getUTCDate()) : days;
    const resources = rowsOf(d.byResource);
    return {
      points, actual, forecast, perDay: actual / elapsed,
      last: d.last ? rowsOf(d.last).reduce((s, r) => s + r.Cost, 0) : null,
      services: rowsOf(d.byService).map((r) => ({ key: r.ServiceName, label: r.ServiceName, value: r.Cost })),
      groups: rowsOf(d.byRg).map((r) => ({ key: r.ResourceGroupName, label: <Link href={`/resource-groups/${sub}/${encodeURIComponent(r.ResourceGroupName)}`} className="mono">{r.ResourceGroupName}</Link>, value: r.Cost })),
      resources: resources.slice(0, 25),
      billable: new Set(resources.map((r) => r.ResourceId)).size,
      today: periodSel === 'current' ? now.toISOString().slice(0, 10) : undefined,
    };
  }, [data.data, periodSel, sub]);

  const mainBudget = budgets.data?.[0];
  const budgetPct = mainBudget && mainBudget.properties.amount > 0 && view ? (view.actual / mainBudget.properties.amount) * 100 : null;

  return (
    <>
      <PageHeader
        title={t('costs.title')}
        subtitle={t('costs.subtitle')}
        icon={Coins}
        actions={<Link className="btn" href="/pricing"><Tags size={16} />{t('costs.priceList')}</Link>}
      />
      <div className="toolbar costs-scope" role="toolbar">
        <Field label={t('common.subscription')} htmlFor="cs"><SubscriptionSelect id="cs" value={sub} onChange={(v) => { setSub(v); setRg(''); }} /></Field>
        <Field label={t('common.resourceGroup')} htmlFor="cr"><ResourceGroupSelect id="cr" sub={sub} value={rg} onChange={(v) => setRg(v)} allowEmpty /></Field>
        <div className="seg" role="group" aria-label={t('costs.period')}>
          <button type="button" className={periodSel === 'current' ? 'on' : ''} onClick={() => setPeriod('current')}>{t('costs.thisMonth')}</button>
          <button type="button" className={periodSel === 'last' ? 'on' : ''} onClick={() => setPeriod('last')}>{t('costs.lastMonth')}</button>
        </div>
      </div>

      {data.error ? ((data.error as Error).message === 'COST_UNAVAILABLE' ? <Notice tone="warn" title={t('costs.throttledTitle')}>{t('costs.throttled')}</Notice> : <ErrorNotice error={data.error} onRetry={data.reload} />) : null}
      {data.data?.partial && <Notice tone="warn">{t('costs.partial')}</Notice>}
      <div className="board">
        <section aria-label={t('costs.summary')} className="ledger six">
          {([
            [periodSel === 'current' ? t('costs.mtd') : t('costs.periodTotal'), view?.actual],
            [t('costs.forecast'), periodSel === 'current' ? view?.forecast : undefined],
            [t('costs.lastMonthTotal'), view?.last ?? undefined],
            [t('costs.perDay'), view?.perDay],
          ] as [string, number | undefined][]).map(([label, v]) => (
            <div className={`cell ${v === 0 ? 'zero' : ''}`} key={label}>
              <span className="label">{label}</span>
              <span className="value money">{v === undefined ? '–' : money(v, locale)}</span>
            </div>
          ))}
          <div className={`cell ${budgetPct !== null && budgetPct >= 100 ? 'alert' : budgetPct !== null && budgetPct >= 80 ? 'running' : ''}`}>
            <span className="label">{mainBudget ? t('costs.budgetUsed', { name: mainBudget.name }) : t('costs.noBudget')}</span>
            <span className="value money">{budgetPct === null ? '–' : `${Math.round(budgetPct)}%`}</span>
          </div>
          <div className="cell">
            <span className="label">{t('costs.billable')}</span>
            <span className="value">{view ? view.billable : '–'}</span>
          </div>
        </section>

        <section className="board-cell span-12">
          <div className="card-head"><h2>{t('costs.daily')}</h2><span className="small muted">{t('costs.estimateStamp')}</span></div>
          <div className="card-body">{!view ? <Skeleton rows={6} /> : <CostChart points={view.points} today={view.today} />}
            {view && (
              <details className="table-view">
                <summary>{t('costs.asTable')}</summary>
                <div className="scroll-x"><table className="table">
                  <thead><tr><th>{t('costs.day')}</th><th className="num">{t('costs.actual')}</th><th className="num">{t('costs.forecastLegend')}</th></tr></thead>
                  <tbody>{view.points.map((p) => <tr key={p.day}><td className="mono">{p.day}</td><td className="num">{money(p.actual, locale, { precise: true })}</td><td className="num">{p.forecast ? money(p.forecast, locale, { precise: true }) : '—'}</td></tr>)}</tbody>
                </table></div>
              </details>
            )}
          </div>
        </section>

        <section className={`board-cell ${rg ? 'span-12' : 'span-6'}`}>
          <div className="card-head"><h2>{t('costs.byService')}</h2></div>
          <div className="card-body">{!view ? <Skeleton /> : view.services.length ? <CostBars items={view.services} total={view.actual} /> : <p className="muted">{t('costs.none')}</p>}</div>
        </section>
        {!rg && (
          <section className="board-cell span-6">
            <div className="card-head"><h2>{t('costs.byGroup')}</h2></div>
            <div className="card-body">{!view ? <Skeleton /> : view.groups.length ? <CostBars items={view.groups} total={view.actual} /> : <p className="muted">{t('costs.none')}</p>}</div>
          </section>
        )}

        <section className="board-cell span-8">
          <div className="card-head"><h2>{t('costs.topResources')}</h2></div>
          {!view ? <div className="card-body"><Skeleton /></div> : view.resources.length ? (
            <div className="scroll-x"><table className="table">
              <thead><tr><th>{t('common.name')}</th><th>{t('common.type')}</th><th>{t('costs.plan')}</th><th>{t('common.resourceGroup')}</th><th className="num">{t('costs.cost')}</th></tr></thead>
              <tbody>
                {view.resources.map((r) => {
                  const info = parseId(r.ResourceId);
                  return (
                    <tr key={r.ResourceId + r.MeterSubCategory}>
                      <td><div className="cell-main"><ResourceIcon type={info.type ?? ''} size="sm" /><Link href={resourceHref(r.ResourceId, 'costs')}>{info.name}</Link></div></td>
                      <td className="small muted">{typeLabel(cat.data?.all, info.type ?? '', locale)}</td>
                      <td className="mono small">{r.MeterSubCategory || '—'}</td>
                      <td className="mono small">{info.resourceGroup ?? '—'}</td>
                      <td className="num">{money(r.Cost, locale)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
          ) : <Empty icon={Coins} title={t('costs.none')} text={t('costs.noneText')} />}
        </section>

        <section className="board-cell span-4">
          <div className="card-head"><h2>{t('costs.budgets')}</h2></div>
          <div className="card-body">
            <Budgets scope={scope} list={budgets.data} reload={budgets.reload} />
          </div>
          <div className="cell-sub card-body small muted method">
            <strong>{t('costs.howTitle')}</strong>
            <p>{t('costs.how')}</p>
            <Link href="/pricing">{t('costs.priceList')}</Link>
          </div>
        </section>
      </div>
    </>
  );
}

function Budgets({ scope, list, reload }: { scope: string; list?: any[]; reload: () => void }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('mensile');
  const [amount, setAmount] = useState('100');
  const [busy, setBusy] = useState(false);
  if (!list) return <Skeleton rows={2} />;
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const start = new Date();
      await arm.put(`${scope}/providers/Microsoft.Consumption/budgets/${encodeURIComponent(name)}`, {
        properties: {
          category: 'Cost', amount: Number(amount), timeGrain: 'Monthly',
          timePeriod: { startDate: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1)).toISOString().replace('.000Z', 'Z') },
          notifications: {
            forecast80: { enabled: true, operator: 'GreaterThan', threshold: 80, thresholdType: 'Forecasted', contactEmails: [] },
            actual100: { enabled: true, operator: 'GreaterThanOrEqualTo', threshold: 100, thresholdType: 'Actual', contactEmails: [] },
          },
        },
      }, BUDGET_API);
      toast.ok(t('costs.budgetCreated'));
      setAdding(false);
      reload();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="budgets">
      {list.length === 0 && !adding && <p className="muted" style={{ marginTop: 0 }}>{t('costs.budgetEmpty')}</p>}
      {list.map((b) => {
        const amt = Number(b.properties.amount) || 0;
        const cur = b.properties.currentSpend?.amount ?? 0;
        const fc = b.properties.forecastSpend?.amount ?? cur;
        const pc = amt ? Math.min(100, (cur / amt) * 100) : 0;
        const pf = amt ? Math.min(100, (fc / amt) * 100) : 0;
        return (
          <div className="budget" key={b.id}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <strong className="mono">{b.name}</strong>
              <button type="button" className="btn ghost sm icon" aria-label={t('common.delete')} onClick={async () => {
                if (!(await confirm({ title: t('costs.budgetDelete', { name: b.name }), danger: true }))) return;
                try { await arm.del(b.id, BUDGET_API); reload(); } catch (err) { toast.error(err); }
              }}><Trash2 size={14} /></button>
            </div>
            <div className={`meter ${fc > amt ? 'over' : ''}`} role="img" aria-label={t('costs.budgetAria', { spent: money(cur, locale), amount: money(amt, locale) })}>
              <span className="f" style={{ width: `${pf}%` }} />
              <span className="a" style={{ width: `${pc}%` }} />
            </div>
            <div className="small row" style={{ justifyContent: 'space-between' }}>
              <span>{money(cur, locale)} <span className="muted">/ {money(amt, locale)}</span></span>
              <span className={fc > amt ? 'bad-text' : 'muted'}>{t('costs.forecastShort')} {money(fc, locale)}</span>
            </div>
          </div>
        );
      })}
      {adding ? (
        <form onSubmit={create} className="stack" style={{ gap: 10 }}>
          <Field label={t('common.name')} htmlFor="bn"><Input id="bn" value={name} onChange={(e) => setName(e.target.value.replace(/[^\w-]/g, ''))} /></Field>
          <Field label={t('costs.budgetAmount')} htmlFor="ba" hint={t('costs.budgetHint')}><Input id="ba" type="number" min="1" step="1" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <div className="row"><Button type="submit" variant="primary" loading={busy} disabled={!name || !(Number(amount) > 0)}>{t('common.create')}</Button><Button type="button" onClick={() => setAdding(false)}>{t('common.cancel')}</Button></div>
        </form>
      ) : (
        <Button icon={Plus} onClick={() => setAdding(true)} disabled={!scope}>{t('costs.budgetNew')}</Button>
      )}
      {list.length > 0 && <Notice>{t('costs.budgetPush')}</Notice>}
    </div>
  );
}
