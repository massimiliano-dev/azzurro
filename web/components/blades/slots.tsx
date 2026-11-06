'use client';

import { useState } from 'react';
import { ArrowLeftRight, ExternalLink, Plus, Trash2 } from 'lucide-react';
import { arm } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { powerOf } from '@/lib/power';
import { startOperation } from '@/lib/operations';
import { Badge, Button, Card, Checkbox, ErrorNotice, Field, Input, Notice, Select, Skeleton } from '../ui';
import { Panel, useConfirm, useToast } from '../overlay';
import { PowerBadge } from '../resource';
import { useL, WEB_API } from './common';

/** Slot consentiti dal livello del piano (Free, Shared e Basic: nessuno; Standard 5; Premium e Isolated 20). */
const maxSlots = (tier?: string) => (!tier ? Infinity : /^(free|shared|basic|dynamic)$/i.test(tier) ? 0 : /^standard$/i.test(tier) ? 5 : 20);
const SLOT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,58}$/;
/** Impostazioni generali copiate dalla produzione quando si clona (come az webapp deployment slot create --configuration-source). */
const CLONE_KEYS = ['linuxFxVersion', 'windowsFxVersion', 'netFrameworkVersion', 'phpVersion', 'pythonVersion', 'nodeVersion', 'javaVersion', 'javaContainer', 'javaContainerVersion', 'appCommandLine', 'alwaysOn', 'webSocketsEnabled', 'use32BitWorkerProcess', 'http20Enabled', 'minTlsVersion', 'ftpsState', 'healthCheckPath', 'defaultDocuments'];
const pick = (o: Record<string, any>, keys: string[]) => Object.fromEntries(keys.filter((k) => o[k] !== undefined && o[k] !== null && o[k] !== '').map((k) => [k, o[k]]));
const withoutState = ({ provisioningState: _, ...p }: Record<string, any> = {}) => p;

/** Slot di distribuzione di un'app web: elenco, nuovo slot (anche clonando la produzione), eliminazione e scambio. */
export function WebAppSlots({ id, site }: { id: string; site: any }) {
  const L = useL();
  const toast = useToast();
  const confirm = useConfirm();
  const slots = useAsync(async () => (await arm.get<{ value: any[] }>(`${id}/slots`, WEB_API)).value, [id]);
  const planId: string | undefined = site?.properties?.serverFarmId;
  const plan = useAsync(async () => (planId ? arm.get<any>(planId, WEB_API) : null), [planId]);
  const tier: string | undefined = plan.data?.sku?.tier;
  const max = maxSlots(tier);
  const [create, setCreate] = useState(false);
  const [name, setName] = useState('');
  const [clone, setClone] = useState(true);
  const [busy, setBusy] = useState(false);
  const [swap, setSwap] = useState<{ source: string; target: string } | null>(null);

  const rows = [
    { slot: 'production', host: site?.properties?.defaultHostName as string, state: site?.properties?.state as string, id },
    ...(slots.data ?? []).map((s) => ({ slot: String(s.name).split('/').pop()!, host: s.properties?.defaultHostName as string, state: s.properties?.state as string, id: s.id as string })),
  ];
  const label = (s: string) => (s === 'production' ? L('Produzione', 'Production') : s);

  const add = async () => {
    setBusy(true);
    try {
      const web = withoutState((await arm.get<any>(`${id}/config/web`, WEB_API)).properties);
      const siteConfig = pick(web, clone ? CLONE_KEYS : ['linuxFxVersion', 'windowsFxVersion']);
      await arm.put(`${id}/slots/${name}`, { location: site.location, kind: site.kind, properties: { serverFarmId: planId, siteConfig } }, WEB_API);
      if (clone) {
        const app = withoutState((await arm.post<any>(`${id}/config/appsettings/list`, {}, WEB_API)).properties);
        const cs = withoutState((await arm.post<any>(`${id}/config/connectionstrings/list`, {}, WEB_API)).properties);
        if (Object.keys(app).length) await arm.put(`${id}/slots/${name}/config/appsettings`, { properties: app }, WEB_API);
        if (Object.keys(cs).length) await arm.put(`${id}/slots/${name}/config/connectionstrings`, { properties: cs }, WEB_API);
      }
      toast.ok(L(`Slot ${name} creato`, `Slot ${name} created`));
      setCreate(false);
      setName('');
      await slots.reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (slot: string, slotId: string) => {
    if (!(await confirm({ title: L(`Eliminare lo slot ${slot}?`, `Delete slot ${slot}?`), text: L('Lo slot, il suo contenuto e le sue impostazioni vengono eliminati. La produzione non cambia.', 'The slot, its content and settings are deleted. Production is not affected.'), danger: true, confirmLabel: L('Elimina', 'Delete') }))) return;
    try {
      await arm.del(slotId, WEB_API);
      await slots.reload();
    } catch (e) {
      toast.error(e);
    }
  };

  const doSwap = async () => {
    if (!swap) return;
    setBusy(true);
    try {
      await startOperation({ kind: 'swap', id, source: swap.source, target: swap.target });
      toast.ok(L('Scambio avviato', 'Swap started'), L('Prosegue da solo: lo segui in Operazioni, in alto a destra.', 'It runs on its own: follow it in Operations, top right.'));
      setSwap(null);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const noSlots = max === 0;
  const full = (slots.data?.length ?? 0) >= max;
  return (
    <>
      <Card title={L('Slot di distribuzione', 'Deployment slots')} padded={false}
        actions={<span className="row" style={{ gap: 8 }}>
          <Button icon={ArrowLeftRight} disabled={!slots.data?.length} onClick={() => setSwap({ source: rows[1]?.slot ?? '', target: 'production' })}>{L('Scambia', 'Swap')}</Button>
          <Button variant="primary" icon={Plus} disabled={noSlots || full || !slots.data} onClick={() => setCreate(true)}>{L('Aggiungi slot', 'Add slot')}</Button>
        </span>}>
        {noSlots && <div className="card-body"><Notice tone="warn">{L(`Il piano ${tier} non supporta gli slot di distribuzione: passa a Standard o Premium nella scheda Piano e scalabilità.`, `The ${tier} plan does not support deployment slots: move to Standard or Premium in the Plan and scale tab.`)}</Notice></div>}
        {slots.error ? <div className="card-body"><ErrorNotice error={slots.error} onRetry={slots.reload} /></div> : !slots.data ? <div className="card-body"><Skeleton rows={3} /></div> : (
          <div className="scroll-x">
            <table className="table">
              <thead><tr><th>{L('Slot', 'Slot')}</th><th>{L('Stato', 'Status')}</th><th>{L('Indirizzo', 'URL')}</th><th aria-label={L('Azioni', 'Actions')} /></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.slot}>
                  <td><div className="cell-main"><span>{label(r.slot)}</span>{r.slot === 'production' && <Badge tone="info">{L('principale', 'main')}</Badge>}</div></td>
                  <td><PowerBadge power={powerOf('Microsoft.Web/sites', { properties: { state: r.state } })} /></td>
                  <td>{r.host ? <a className="mono small" href={`https://${r.host}`} target="_blank" rel="noreferrer noopener">{r.host} <ExternalLink size={12} aria-hidden /></a> : '—'}</td>
                  <td className="num">{r.slot !== 'production' && <Button size="sm" variant="ghost" icon={Trash2} aria-label={L(`Elimina ${r.slot}`, `Delete ${r.slot}`)} onClick={() => void remove(r.slot, r.id)} />}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        <p className="small muted card-body" style={{ margin: 0 }}>{L(
          `Gli slot sono app gemelle sullo stesso piano: si pubblica in uno slot, si prova, poi si scambia con la produzione senza tempi morti.${Number.isFinite(max) && max > 0 ? ` Il piano ${tier} ne consente ${max}.` : ''}`,
          `Slots are twin apps on the same plan: deploy to a slot, test it, then swap it with production with no downtime.${Number.isFinite(max) && max > 0 ? ` The ${tier} plan allows ${max}.` : ''}`,
        )}</p>
      </Card>

      <Panel open={create} onClose={() => !busy && setCreate(false)} title={L('Nuovo slot', 'New slot')} subtitle={site?.name}
        footer={<><Button variant="primary" loading={busy} disabled={!SLOT_NAME.test(name) || rows.some((r) => r.slot.toLowerCase() === name.toLowerCase())} onClick={add}>{L('Crea', 'Create')}</Button><Button disabled={busy} onClick={() => setCreate(false)}>{L('Annulla', 'Cancel')}</Button></>}>
        <Field label={L('Nome dello slot', 'Slot name')} htmlFor="sl-n" hint={site?.properties?.defaultHostName && name ? `${String(site.name).toLowerCase()}-${name.toLowerCase()}.azurewebsites.net` : L('Lettere, numeri e trattini, es. staging.', 'Letters, numbers and hyphens, e.g. staging.')}>
          <Input id="sl-n" value={name} placeholder="staging" onChange={(e) => setName(e.target.value.trim())} invalid={!!name && !SLOT_NAME.test(name)} />
        </Field>
        <Checkbox checked={clone} onChange={setClone} label={L('Copia impostazioni generali, impostazioni dell\'app e stringhe di connessione dalla produzione', 'Copy general settings, app settings and connection strings from production')} />
        <Notice>{L('Il contenuto (il codice pubblicato) non viene copiato: lo slot parte vuoto finché non ci pubblichi.', 'Content (the deployed code) is not copied: the slot starts empty until you deploy to it.')}</Notice>
      </Panel>

      <Panel open={!!swap} onClose={() => !busy && setSwap(null)} title={L('Scambia slot', 'Swap slots')} subtitle={site?.name}
        footer={<><Button variant="primary" icon={ArrowLeftRight} loading={busy} disabled={!swap || swap.source === swap.target} onClick={doSwap}>{L('Scambia', 'Swap')}</Button><Button disabled={busy} onClick={() => setSwap(null)}>{L('Annulla', 'Cancel')}</Button></>}>
        {swap && (
          <>
            <Field label={L('Origine', 'Source')} htmlFor="sw-s"><Select id="sw-s" value={swap.source} onChange={(e) => setSwap({ ...swap, source: e.target.value })}>{rows.map((r) => <option key={r.slot} value={r.slot}>{label(r.slot)}</option>)}</Select></Field>
            <Field label={L('Destinazione', 'Target')} htmlFor="sw-t"><Select id="sw-t" value={swap.target} onChange={(e) => setSwap({ ...swap, target: e.target.value })}>{rows.map((r) => <option key={r.slot} value={r.slot}>{label(r.slot)}</option>)}</Select></Field>
            <Notice>{L(
              'Azure riscalda le istanze dell\'origine con le impostazioni della destinazione, poi inverte il traffico: nessun tempo morto. Si scambiano codice, stack, impostazioni dell\'app e stringhe di connessione; restano al loro posto le impostazioni marcate «slot», domini, certificati, scalabilità e rete. Può richiedere alcuni minuti.',
              'Azure warms up the source instances with the target settings, then switches traffic: no downtime. Code, stack, app settings and connection strings are swapped; settings marked "slot", domains, certificates, scale and networking stay. It can take a few minutes.',
            )}</Notice>
          </>
        )}
      </Panel>
    </>
  );
}
