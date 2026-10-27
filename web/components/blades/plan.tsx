'use client';

import { useEffect, useState } from 'react';
import { ArrowUpDown, Layers } from 'lucide-react';
import Link from 'next/link';
import { arm } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { money } from '@/lib/money';
import { resourceHref } from '@/lib/arm';
import { useI18n } from '@/i18n';
import { Badge, Button, Card, ErrorNotice, Field, Notice, Select, Skeleton } from '../ui';
import { useToast } from '../overlay';
import { loadPricing, type PriceType } from '../pricing';
import { useL, WEB_API } from './common';

const TIER: Record<string, { tier: string; group: string; max: number }> = {
  F1: { tier: 'Free', group: 'dev', max: 1 }, B1: { tier: 'Basic', group: 'dev', max: 3 }, B2: { tier: 'Basic', group: 'dev', max: 3 }, B3: { tier: 'Basic', group: 'dev', max: 3 },
  S1: { tier: 'Standard', group: 'prod', max: 10 }, S2: { tier: 'Standard', group: 'prod', max: 10 }, S3: { tier: 'Standard', group: 'prod', max: 10 },
  P0v3: { tier: 'PremiumV3', group: 'prod', max: 30 }, P1v3: { tier: 'PremiumV3', group: 'prod', max: 30 }, P2v3: { tier: 'PremiumV3', group: 'prod', max: 30 }, P3v3: { tier: 'PremiumV3', group: 'prod', max: 30 },
  Y1: { tier: 'Dynamic', group: 'fn', max: 1 }, EP1: { tier: 'ElasticPremium', group: 'fn', max: 20 }, EP2: { tier: 'ElasticPremium', group: 'fn', max: 20 }, EP3: { tier: 'ElasticPremium', group: 'fn', max: 20 },
  WS1: { tier: 'WorkflowStandard', group: 'fn', max: 20 },
};

/** Scalabilità verticale (piano) e orizzontale (istanze) di un piano di App Service. */
export function PlanScale({ planId, onChanged }: { planId: string; onChanged?: () => void }) {
  const L = useL();
  const { locale } = useI18n();
  const toast = useToast();
  const plan = useAsync(() => arm.get<any>(planId, WEB_API), [planId]);
  const pricing = useAsync(() => loadPricing(), []);
  const [sku, setSku] = useState('');
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (plan.data) { setSku(plan.data.sku?.name ?? 'B1'); setCount(plan.data.sku?.capacity ?? 1); } }, [plan.data]);
  if (plan.error) return <ErrorNotice error={plan.error} onRetry={plan.reload} />;
  if (!plan.data || !pricing.data) return <Skeleton rows={5} />;
  const p = (pricing.data.types as PriceType[]).find((x) => x.type === 'Microsoft.Web/serverfarms');
  const plans = (p?.plans ?? []).filter((x) => TIER[x.sku]);
  const current = plan.data.sku?.name;
  const isFn = TIER[current]?.group === 'fn';
  const groups: [string, string][] = isFn ? [['fn', L('Functions', 'Functions')]] : [['dev', L('Sviluppo e test', 'Dev and test')], ['prod', L('Produzione', 'Production')]];
  const max = TIER[sku]?.max ?? 1;
  const monthly = (s: string) => plans.find((x) => x.sku === s)?.monthly ?? null;
  const est = monthly(sku);
  const changed = sku !== current || count !== (plan.data.sku?.capacity ?? 1);
  const apply = async () => {
    setBusy(true);
    try {
      await arm.patch(planId, { sku: { name: sku, tier: TIER[sku]?.tier, capacity: Math.min(count, max) } }, WEB_API);
      toast.ok(L('Piano aggiornato', 'Plan updated'), `${sku} × ${Math.min(count, max)}`);
      plan.reload(); onChanged?.();
    } catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card title={L('Scala verticalmente: scegli il piano', 'Scale up: choose the plan')}>
        {groups.map(([g, label]) => (
          <div key={g} className="mb-16">
            <h3 className="small muted" style={{ textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>{label}</h3>
            <div className="radio-cards">{plans.filter((x) => TIER[x.sku].group === g).map((x) => (
              <label className="radio-card" key={x.sku}>
                <input type="radio" name="plan-sku" checked={sku === x.sku} onChange={() => { setSku(x.sku); setCount((c) => Math.min(c, TIER[x.sku].max)); }} />
                <span>
                  <strong className="mono">{x.sku}</strong> {x.sku === current && <Badge tone="info">{L('attuale', 'current')}</Badge>}<br />
                  <span className="small muted">{x.specs[locale]}</span><br />
                  <span className="small">{x.free ? L('Gratis', 'Free') : x.monthly !== null ? `${money(x.monthly, locale)} ${L('al mese per istanza', 'per month per instance')}` : L('a consumo', 'usage-based')}</span>
                </span>
              </label>
            ))}</div>
          </div>
        ))}
      </Card>
      <Card title={L('Scala orizzontalmente: istanze', 'Scale out: instances')}>
        {max <= 1 ? <p className="muted">{L('Questo piano ha una sola istanza.', 'This plan has a single instance.')}</p> : (
          <Field label={L(`Istanze (fino a ${max} con ${sku})`, `Instances (up to ${max} with ${sku})`)} htmlFor="cnt">
            <div className="row"><input id="cnt" type="range" min={1} max={max} value={Math.min(count, max)} onChange={(e) => setCount(Number(e.target.value))} style={{ flex: 1, accentColor: 'var(--azzurro)' }} /><strong className="num" style={{ minWidth: 40, textAlign: 'right' }}>{Math.min(count, max)}</strong></div>
          </Field>
        )}
      </Card>
      <div className="row wrap">
        {est !== null && <span className="small">{L('Stima', 'Estimate')}: <strong>{money(est * Math.min(count, max), locale)}</strong> {L('al mese', 'per month')}</span>}
        <span style={{ flex: 1 }} />
        <Button variant="primary" icon={ArrowUpDown} loading={busy} disabled={!changed} onClick={() => void apply()}>{L('Applica', 'Apply')}</Button>
      </div>
      {TIER[sku]?.group !== TIER[current]?.group && changed && <Notice tone="warn">{L('Passare tra Functions a consumo e piani dedicati può non essere consentito per le app esistenti.', 'Moving between consumption Functions and dedicated plans may not be allowed for existing apps.')}</Notice>}
    </div>
  );
}

/** Piano di un'app web: cambio piano e scalabilità del piano attuale. */
export function WebAppPlan({ id, site, reload }: { id: string; site: any; reload: () => void }) {
  const L = useL();
  const toast = useToast();
  const rg = id.split('/providers/')[0];
  const planId: string | undefined = site.properties?.serverFarmId;
  const plans = useAsync(async () => (await arm.get<{ value: any[] }>(`${rg}/providers/Microsoft.Web/serverfarms`, WEB_API)).value.filter((p) => !site.location || String(p.location).replace(/\s/g, '').toLowerCase() === String(site.location).replace(/\s/g, '').toLowerCase()), [rg]);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const move = async () => {
    setBusy(true);
    try { await arm.patch(id, { properties: { serverFarmId: target } }, WEB_API); toast.ok(L('App spostata nel nuovo piano', 'App moved to the new plan')); setTarget(''); reload(); }
    catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card title={L('Piano di App Service', 'App Service plan')}>
        {planId ? <p><Layers size={15} aria-hidden /> <Link href={resourceHref(planId)}>{planId.split('/').pop()}</Link></p> : <Notice tone="warn">{L('L\'app non è associata a un piano.', 'The app is not linked to a plan.')}</Notice>}
        {plans.data && plans.data.length > 1 && (
          <div className="row wrap mt-16" style={{ alignItems: 'flex-end' }}>
            <Field label={L('Sposta in un altro piano (stessa area e gruppo)', 'Move to another plan (same region and group)')} htmlFor="mv">
              <Select id="mv" value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">—</option>
                {plans.data.filter((p) => p.id.toLowerCase() !== planId?.toLowerCase()).map((p) => <option key={p.id} value={p.id}>{p.name} · {p.sku?.name}</option>)}
              </Select>
            </Field>
            <Button loading={busy} disabled={!target} onClick={() => void move()} style={{ marginBottom: 16 }}>{L('Cambia piano', 'Change plan')}</Button>
          </div>
        )}
      </Card>
      {planId && <PlanScale planId={planId} onChanged={reload} />}
    </div>
  );
}
