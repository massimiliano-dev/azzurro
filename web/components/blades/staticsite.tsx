'use client';

import { useEffect, useState } from 'react';
import { Eye, EyeOff, Globe, Plus, Save, Trash2 } from 'lucide-react';
import { arm } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { money } from '@/lib/money';
import { useI18n } from '@/i18n';
import { Badge, Button, Card, CopyButton, Empty, ErrorNotice, Field, Input, Notice, Select, Skeleton } from '../ui';
import { Panel, useConfirm, useToast } from '../overlay';
import { loadPricing, type PriceType } from '../pricing';
import { useL } from './common';

export const SWA_API = '2023-12-01';
const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const LIMIT: Record<string, number> = { Free: 2, Standard: 5 };

/** Domini personalizzati: CNAME per i sottodomini, token TXT per il dominio radice. */
export function SwaDomains({ id, site }: { id: string; site: any }) {
  const L = useL();
  const toast = useToast();
  const confirm = useConfirm();
  const list = useAsync(async () => (await arm.get<{ value: any[] }>(`${id}/customDomains`, SWA_API)).value, [id]);
  const [form, setForm] = useState<null | { domain: string; method: 'cname-delegation' | 'dns-txt-token' }>(null);
  const [busy, setBusy] = useState(false);
  const host = site.properties?.defaultHostname ?? '';
  const tier = site.sku?.name ?? 'Free';
  const full = (list.data?.length ?? 0) >= (LIMIT[tier] ?? 5);
  const add = async () => {
    if (!form) return;
    setBusy(true);
    try {
      await arm.put(`${id}/customDomains/${encodeURIComponent(form.domain.toLowerCase())}`, { properties: { validationMethod: form.method } }, SWA_API);
      toast.ok(L('Dominio aggiunto', 'Domain added'), form.domain);
      setForm(null);
      list.reload();
    } catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  const remove = async (d: any) => {
    if (!(await confirm({ title: L(`Rimuovere ${d.name}?`, `Remove ${d.name}?`), text: L('Il dominio smette di servire l\'app; i record DNS restano da togliere.', 'The domain stops serving the app; DNS records still need removing.'), danger: true, confirmLabel: L('Rimuovi', 'Remove') }))) return;
    try { await arm.del(`${id}/customDomains/${encodeURIComponent(d.name)}`, SWA_API); list.reload(); } catch (e) { toast.error(e); }
  };
  const apex = (d: string) => d.split('.').length === 2;
  const records = (d: any) => {
    const p = d.properties ?? {};
    if (p.validationToken) return [['TXT', `_dnsauth.${d.name}`, p.validationToken], ...(apex(d.name) ? [['ALIAS / A', d.name, host]] : [['CNAME', d.name, host]])];
    return [['CNAME', d.name, host]];
  };
  return (
    <Card title={L('Domini personalizzati', 'Custom domains')} actions={<Button size="sm" variant="primary" icon={Plus} disabled={full} title={full ? L(`Il piano ${tier} consente ${LIMIT[tier]} domini`, `The ${tier} plan allows ${LIMIT[tier]} domains`) : undefined} onClick={() => setForm({ domain: '', method: 'cname-delegation' })}>{L('Aggiungi dominio', 'Add domain')}</Button>}>
      <p className="small" style={{ marginTop: 0 }}>{L('Dominio predefinito', 'Default domain')}: <span className="mono">{host}</span> <CopyButton value={host} /></p>
      {list.error ? <ErrorNotice error={list.error} onRetry={list.reload} /> : !list.data ? <Skeleton rows={2} /> : list.data.length === 0 ? (
        <Empty icon={Globe} title={L('Nessun dominio personalizzato', 'No custom domains')} text={L(`Il certificato TLS è gratuito e gestito da Azure. Piano ${tier}: fino a ${LIMIT[tier] ?? 5} domini.`, `The TLS certificate is free and managed by Azure. ${tier} plan: up to ${LIMIT[tier] ?? 5} domains.`)} />
      ) : (
        <div className="stack" style={{ gap: 12 }}>{list.data.map((d) => {
          const st = d.properties?.status ?? 'Ready';
          return (
            <div key={d.id} className="domain-row" style={{ display: 'block' }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span><strong className="mono">{d.name}</strong> <Badge tone={st === 'Ready' ? 'ok' : st === 'Failed' ? 'bad' : 'warn'}>{st}</Badge></span>
                <Button size="sm" variant="ghost" icon={Trash2} aria-label={L('Rimuovi', 'Remove')} onClick={() => void remove(d)} />
              </div>
              {st !== 'Ready' && (
                <div className="table-wrap" style={{ border: 0, boxShadow: 'none', marginTop: 8 }}><table className="table">
                  <thead><tr><th>{L('Tipo', 'Type')}</th><th>{L('Nome', 'Name')}</th><th>{L('Valore', 'Value')}</th></tr></thead>
                  <tbody>{records(d).map(([t, n, v]) => <tr key={t + n}><td>{t}</td><td className="mono small">{n}</td><td className="mono small">{v} <CopyButton value={v} /></td></tr>)}</tbody>
                </table></div>
              )}
              {d.properties?.errorMessage && <Notice tone="bad">{d.properties.errorMessage}</Notice>}
            </div>
          );
        })}</div>
      )}
      <Panel open={!!form} onClose={() => setForm(null)} title={L('Aggiungi dominio', 'Add domain')}
        footer={<><Button onClick={() => setForm(null)}>{L('Annulla', 'Cancel')}</Button><Button variant="primary" loading={busy} disabled={!form || !DOMAIN_RE.test(form.domain)} onClick={() => void add()}>{L('Aggiungi', 'Add')}</Button></>}>
        {form && (
          <div className="stack" style={{ gap: 12 }}>
            <Field label={L('Dominio', 'Domain')} htmlFor="sd-d"><Input id="sd-d" className="mono" placeholder="www.contoso.com" value={form.domain} onChange={(e) => { const v = e.target.value.trim(); setForm({ domain: v, method: apex(v) ? 'dns-txt-token' : form.method }); }} /></Field>
            <Field label={L('Convalida', 'Validation')} htmlFor="sd-m" hint={form.method === 'cname-delegation' ? L(`Crea prima un record CNAME da ${form.domain || 'www.contoso.com'} a ${host}.`, `First create a CNAME record from ${form.domain || 'www.contoso.com'} to ${host}.`) : L('Dopo l\'aggiunta ricevi un token da mettere in un record TXT _dnsauth; per il dominio radice serve anche un record ALIAS o A.', 'After adding it you get a token for a _dnsauth TXT record; the root domain also needs an ALIAS or A record.')}>
              <Select id="sd-m" value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value as 'cname-delegation' | 'dns-txt-token' })}>
                <option value="cname-delegation" disabled={apex(form.domain)}>{L('Record CNAME (sottodomini)', 'CNAME record (subdomains)')}</option>
                <option value="dns-txt-token">{L('Record TXT (anche dominio radice)', 'TXT record (root domain too)')}</option>
              </Select>
            </Field>
          </div>
        )}
      </Panel>
    </Card>
  );
}

/** Impostazioni dell'applicazione (variabili d'ambiente delle API gestite). */
export function SwaSettings({ id }: { id: string }) {
  const L = useL();
  const toast = useToast();
  const cur = useAsync(async () => (await arm.post<{ properties: Record<string, string> }>(`${id}/listAppSettings`, {}, SWA_API)).properties ?? {}, [id]);
  const [rows, setRows] = useState<{ k: string; v: string }[]>([]);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (cur.data) setRows(Object.entries(cur.data).map(([k, v]) => ({ k, v: String(v) }))); }, [cur.data]);
  const asObj = (r: { k: string; v: string }[]) => Object.fromEntries(r.filter((x) => x.k.trim()).map((x) => [x.k.trim(), x.v]));
  const dirty = !!cur.data && JSON.stringify(asObj(rows)) !== JSON.stringify(cur.data);
  const dup = new Set(rows.map((r) => r.k.trim()).filter((k, i, a) => k && a.indexOf(k) !== i));
  const bad = rows.some((r) => r.k.trim() && !/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(r.k.trim()));
  const save = async () => {
    setBusy(true);
    try { await arm.put(`${id}/config/appsettings`, { properties: asObj(rows) }, SWA_API); toast.ok(L('Impostazioni salvate', 'Settings saved')); cur.reload(); }
    catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  return (
    <Card title={L('Impostazioni dell\'applicazione', 'Application settings')} actions={<div className="row">
      <Button size="sm" variant="ghost" icon={show ? EyeOff : Eye} onClick={() => setShow(!show)}>{show ? L('Nascondi valori', 'Hide values') : L('Mostra valori', 'Show values')}</Button>
      <Button variant="primary" icon={Save} loading={busy} disabled={!dirty || dup.size > 0 || bad} onClick={() => void save()}>{L('Salva', 'Save')}</Button>
    </div>}>
      {cur.error ? <ErrorNotice error={cur.error} onRetry={cur.reload} /> : !cur.data ? <Skeleton rows={3} /> : (
        <div className="stack" style={{ gap: 8 }}>
          {rows.length === 0 && <p className="muted small" style={{ margin: 0 }}>{L('Nessuna impostazione: le API gestite le leggono come variabili d\'ambiente (process.env).', 'No settings: managed APIs read them as environment variables (process.env).')}</p>}
          {rows.map((r, i) => (
            <div key={i} className="row" style={{ gap: 8 }}>
              <Input className="mono" aria-label={L('Nome', 'Name')} placeholder="API_URL" value={r.k} invalid={dup.has(r.k.trim())} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))} style={{ maxWidth: 260 }} />
              <Input className="mono" aria-label={L('Valore', 'Value')} type={show ? 'text' : 'password'} autoComplete="off" value={r.v} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} />
              <Button size="sm" variant="ghost" icon={Trash2} aria-label={L('Rimuovi', 'Remove')} onClick={() => setRows(rows.filter((_, j) => j !== i))} />
            </div>
          ))}
          <div><Button size="sm" icon={Plus} onClick={() => setRows([...rows, { k: '', v: '' }])}>{L('Aggiungi', 'Add')}</Button></div>
          {dup.size > 0 && <Notice tone="bad">{L('Nomi duplicati: ', 'Duplicate names: ')}{[...dup].join(', ')}</Notice>}
          {bad && <Notice tone="bad">{L('I nomi possono contenere lettere, numeri, _ . : - e non iniziare con un numero.', 'Names may contain letters, digits, _ . : - and must not start with a digit.')}</Notice>}
          <p className="small muted" style={{ margin: 0 }}>{L('Valgono per le API gestite e le funzioni collegate, non per il codice nel browser.', 'They apply to managed APIs and linked functions, not to browser code.')}</p>
        </div>
      )}
    </Card>
  );
}

/** Piano Free o Standard con il prezzo. */
export function SwaPlan({ id, site, reload }: { id: string; site: any; reload: () => void }) {
  const L = useL();
  const { locale } = useI18n();
  const toast = useToast();
  const pricing = useAsync(() => loadPricing(), []);
  const current = site.sku?.name ?? 'Free';
  const [sel, setSel] = useState(current);
  const [busy, setBusy] = useState(false);
  useEffect(() => setSel(current), [current]);
  const plans = ((pricing.data?.types as PriceType[] | undefined)?.find((x) => x.type === 'Microsoft.Web/staticSites')?.plans ?? []);
  const save = async () => {
    setBusy(true);
    try {
      // il PATCH delle app statiche non porta lo SKU: si rilegge e si riscrive la risorsa
      const cur = await arm.get<any>(id, SWA_API);
      await arm.put(id, { location: cur.location, tags: cur.tags, identity: cur.identity, sku: { name: sel, tier: sel }, properties: cur.properties }, SWA_API);
      toast.ok(L('Piano aggiornato', 'Plan updated'), sel); reload(); }
    catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  return (
    <Card title={L('Piano', 'Hosting plan')} actions={<Button variant="primary" loading={busy} disabled={sel === current} onClick={() => void save()}>{L('Cambia piano', 'Change plan')}</Button>}>
      {pricing.error ? <ErrorNotice error={pricing.error} onRetry={pricing.reload} /> : !pricing.data ? <Skeleton rows={2} /> : (
        <div className="radio-cards">{plans.map((p) => (
          <label className="radio-card" key={p.sku}>
            <input type="radio" name="swa-plan" checked={sel === p.sku} onChange={() => setSel(p.sku)} />
            <span><strong>{p.sku}</strong> {p.sku === current && <Badge tone="info">{L('attuale', 'current')}</Badge>}<br /><span className="small muted">{p.specs[locale]}</span><br /><span className="small">{p.free ? L('Gratuito', 'Free') : p.monthly !== null ? `${money(p.monthly, locale)} ${L('al mese', 'per month')}` : ''}</span></span>
          </label>
        ))}</div>
      )}
      {sel === 'Free' && current !== 'Free' && <Notice tone="warn">{L('Il piano Free ha al massimo 2 domini personalizzati e niente autenticazione personalizzata né API collegate.', 'The Free plan allows at most 2 custom domains and no custom authentication or linked APIs.')}</Notice>}
    </Card>
  );
}
