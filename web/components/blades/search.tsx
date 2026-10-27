'use client';

import { useEffect, useState } from 'react';
import { Eye, EyeOff, KeyRound, Plus, Trash2 } from 'lucide-react';
import { arm } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { money } from '@/lib/money';
import { useI18n } from '@/i18n';
import { Badge, Button, Card, CopyButton, Empty, ErrorNotice, Field, Input, Notice, Select, Skeleton } from '../ui';
import { Panel, useConfirm, useToast } from '../overlay';
import { loadPricing, type PriceType } from '../pricing';
import { KeysCard } from './keys';
import { useL } from './common';

export const SEARCH_API = '2023-11-01';
export const SIGNALR_API = '2024-03-01';
const monthlyOf = (p?: PriceType['plans'][number]) => (p ? p.monthly ?? (p.hourly !== null ? p.hourly * 730 : null) : null);

/** Repliche e partizioni di Azure AI Search, con il costo delle unità di ricerca. */
export function SearchScale({ id, svc, reload }: { id: string; svc: any; reload: () => void }) {
  const L = useL();
  const { locale } = useI18n();
  const toast = useToast();
  const pricing = useAsync(() => loadPricing(), []);
  const sku = String(svc.sku?.name ?? 'basic').toLowerCase();
  const curR = Number(svc.properties?.replicaCount ?? 1);
  const curP = Number(svc.properties?.partitionCount ?? 1);
  const [rep, setRep] = useState(curR);
  const [part, setPart] = useState(curP);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setRep(curR); setPart(curP); }, [curR, curP]);
  const free = sku === 'free';
  const basic = sku === 'basic';
  const reps = Array.from({ length: basic ? 3 : 12 }, (_, i) => i + 1);
  const parts = basic ? [1, 2, 3] : [1, 2, 3, 4, 6, 12];
  const plan = ((pricing.data?.types as PriceType[] | undefined)?.find((x) => x.type === 'Microsoft.Search/searchServices')?.plans ?? []).find((p) => p.sku === sku);
  const unit = monthlyOf(plan);
  const su = rep * part;
  const save = async () => {
    setBusy(true);
    try { await arm.patch(id, { properties: { replicaCount: rep, partitionCount: part } }, SEARCH_API); toast.ok(L('Scala aggiornata', 'Scale updated')); reload(); }
    catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  return (
    <Card title={L('Scala', 'Scale')} actions={<Button variant="primary" loading={busy} disabled={free || (rep === curR && part === curP) || su > 36} onClick={() => void save()}>{L('Salva', 'Save')}</Button>}>
      {free ? <Notice>{L('Il piano gratuito non si scala: crea un servizio Basic o Standard (il piano non si cambia dopo la creazione).', 'The free tier cannot scale: create a Basic or Standard service (the tier cannot change after creation).')}</Notice> : (
        <div className="stack" style={{ gap: 12 }}>
          <p className="small muted" style={{ margin: 0 }}>{L('Piano', 'Tier')}: <strong>{sku}</strong> · {plan?.specs[locale]}</p>
          <div className="grid cols-2" style={{ gap: 12 }}>
            <Field label={L('Repliche', 'Replicas')} htmlFor="ss-r" hint={L('Più repliche = più query al secondo e disponibilità: 2 per lo SLA in lettura, 3 anche in scrittura.', 'More replicas = more queries per second and availability: 2 for the read SLA, 3 for read-write.')}>
              <Select id="ss-r" value={rep} onChange={(e) => setRep(Number(e.target.value))}>{reps.map((n) => <option key={n} value={n}>{n}</option>)}</Select>
            </Field>
            <Field label={L('Partizioni', 'Partitions')} htmlFor="ss-p" hint={L('Più partizioni = più spazio per gli indici e indicizzazione più veloce.', 'More partitions = more index storage and faster indexing.')}>
              <Select id="ss-p" value={part} onChange={(e) => setPart(Number(e.target.value))}>{parts.map((n) => <option key={n} value={n}>{n}</option>)}</Select>
            </Field>
          </div>
          <p style={{ margin: 0 }}>
            <strong>{su}</strong> {L('unità di ricerca', 'search units')}
            {unit !== null && <> · <strong>{money(unit * su, locale)}</strong> {L('al mese', 'per month')} <span className="small muted">({money(unit, locale)} × {su})</span></>}
          </p>
          {su > 36 && <Notice tone="bad">{L('Massimo 36 unità di ricerca (repliche × partizioni).', 'At most 36 search units (replicas × partitions).')}</Notice>}
          {rep === 1 && <Notice>{L('Con una sola replica non c\'è SLA: durante gli aggiornamenti le query possono fallire.', 'With a single replica there is no SLA: queries may fail during updates.')}</Notice>}
        </div>
      )}
    </Card>
  );
}

/** Chiavi amministrative (con rigenerazione) e chiavi di query (crea ed elimina). */
export function SearchKeys({ id, svc }: { id: string; svc: any }) {
  const L = useL();
  const toast = useToast();
  const confirm = useConfirm();
  const [queryKeys, setQueryKeys] = useState<{ name: string | null; key: string }[] | null>(null);
  const [show, setShow] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const localAuth = !svc.properties?.disableLocalAuth;
  const endpoint = `https://${svc.name}.search.windows.net`;
  const loadAdmin = async () => {
    const k = await arm.post<{ primaryKey: string; secondaryKey: string }>(`${id}/listAdminKeys`, {}, SEARCH_API);
    return [
      { key: 'p', label: L('Primaria', 'Primary'), value: k.primaryKey, regen: () => arm.post(`${id}/regenerateAdminKey/primary`, {}, SEARCH_API) },
      { key: 's', label: L('Secondaria', 'Secondary'), value: k.secondaryKey, regen: () => arm.post(`${id}/regenerateAdminKey/secondary`, {}, SEARCH_API) },
    ];
  };
  const loadQuery = async () => {
    try { setQueryKeys((await arm.post<{ value: any[] }>(`${id}/listQueryKeys`, {}, SEARCH_API)).value); }
    catch (e) { toast.error(e); }
  };
  const create = async () => {
    if (name === null) return;
    setBusy(true);
    try { await arm.post(`${id}/createQueryKey/${encodeURIComponent(name)}`, {}, SEARCH_API); toast.ok(L('Chiave di query creata', 'Query key created')); setName(null); await loadQuery(); setShow(true); }
    catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  const remove = async (k: { name: string | null; key: string }) => {
    if (!(await confirm({ title: L(`Eliminare la chiave ${k.name ?? ''}?`, `Delete key ${k.name ?? ''}?`), text: L('Le app che la usano per cercare ricevono 403.', 'Apps using it to search get 403.'), danger: true, confirmLabel: L('Elimina', 'Delete') }))) return;
    try { await arm.del(`${id}/deleteQueryKey/${encodeURIComponent(k.key)}`, SEARCH_API); await loadQuery(); } catch (e) { toast.error(e); }
  };
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card title="Endpoint"><p style={{ margin: 0 }}><span className="mono">{endpoint}</span> <CopyButton value={endpoint} /></p></Card>
      <KeysCard title={L('Chiavi amministrative', 'Admin keys')} load={loadAdmin}
        disabled={localAuth ? undefined : L('L\'autenticazione con chiave è disattivata: si usano i ruoli Search Index Data Reader / Contributor.', 'Key authentication is disabled: use the Search Index Data Reader / Contributor roles.')}
        note={L('Danno pieno controllo su indici, indicizzatori e dati: tienile sul server.', 'They grant full control over indexes, indexers and data: keep them server-side.')} />
      {localAuth && (
        <Card title={L('Chiavi di query', 'Query keys')} actions={<div className="row">
          {queryKeys && <Button size="sm" variant="ghost" icon={show ? EyeOff : Eye} onClick={() => setShow(!show)}>{show ? L('Nascondi', 'Hide') : L('Mostra', 'Show')}</Button>}
          <Button size="sm" variant="primary" icon={Plus} onClick={() => setName('')}>{L('Nuova chiave', 'New key')}</Button>
        </div>}>
          {!queryKeys ? <Button icon={KeyRound} onClick={() => void loadQuery()}>{L('Mostra le chiavi di query', 'Show query keys')}</Button>
            : queryKeys.length === 0 ? <Empty icon={KeyRound} title={L('Nessuna chiave di query', 'No query keys')} text={L('Le chiavi di query permettono solo di cercare: si possono usare in un\'app client.', 'Query keys only allow searching: they can be used in a client app.')} /> : (
              <div className="stack" style={{ gap: 10 }}>{queryKeys.map((k) => (
                <div className="kv-edit" key={k.key}>
                  <span>{k.name ?? <span className="muted">{L('(senza nome)', '(unnamed)')}</span>}</span>
                  <span className="secret"><span>{show ? k.key : '•'.repeat(24)}</span><CopyButton value={k.key} /></span>
                  <Button size="sm" variant="ghost" icon={Trash2} aria-label={L('Elimina', 'Delete')} onClick={() => void remove(k)} />
                </div>
              ))}</div>
            )}
        </Card>
      )}
      <Panel open={name !== null} onClose={() => setName(null)} title={L('Nuova chiave di query', 'New query key')}
        footer={<><Button onClick={() => setName(null)}>{L('Annulla', 'Cancel')}</Button><Button variant="primary" loading={busy} disabled={!name?.trim() || (name?.length ?? 0) > 100} onClick={() => void create()}>{L('Crea', 'Create')}</Button></>}>
        <Field label={L('Nome', 'Name')} htmlFor="qk-n" hint={L('Per riconoscerla: per esempio sito-web o app-mobile.', 'To recognise it: e.g. website or mobile-app.')}><Input id="qk-n" value={name ?? ''} onChange={(e) => setName(e.target.value)} /></Field>
      </Panel>
    </div>
  );
}

const SIGNALR_UNITS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

/** SignalR / Web PubSub: piano e unità. */
export function SignalRScale({ id, r, reload }: { id: string; r: any; reload: () => void }) {
  const L = useL();
  const { locale } = useI18n();
  const toast = useToast();
  const pricing = useAsync(() => loadPricing(), []);
  const type = String(r.type ?? '').toLowerCase().endsWith('webpubsub') ? 'Microsoft.SignalRService/webPubSub' : 'Microsoft.SignalRService/signalR';
  const curSku = r.sku?.name ?? 'Free_F1';
  const curCap = Number(r.sku?.capacity ?? 1);
  const [sku, setSku] = useState(curSku);
  const [cap, setCap] = useState(curCap);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setSku(curSku); setCap(curCap); }, [curSku, curCap]);
  const plans = ((pricing.data?.types as PriceType[] | undefined)?.find((x) => x.type === type)?.plans ?? []).filter((p) => p.sku !== 'Premium_P2');
  const units = sku.startsWith('Free') ? [1] : SIGNALR_UNITS;
  const price = monthlyOf(plans.find((p) => p.sku === sku));
  const save = async () => {
    setBusy(true);
    try {
      const tier = sku.startsWith('Free') ? 'Free' : sku.startsWith('Premium') ? 'Premium' : 'Standard';
      await arm.patch(id, { sku: { name: sku, tier, capacity: cap } }, SIGNALR_API);
      toast.ok(L('Scala aggiornata', 'Scale updated'));
      reload();
    } catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  return (
    <Card title={L('Piano e unità', 'Tier and units')} actions={<Button variant="primary" loading={busy} disabled={sku === curSku && cap === curCap} onClick={() => void save()}>{L('Salva', 'Save')}</Button>}>
      {pricing.error ? <ErrorNotice error={pricing.error} onRetry={pricing.reload} /> : !pricing.data ? <Skeleton rows={2} /> : (
        <div className="stack" style={{ gap: 12 }}>
          <div className="radio-cards">{plans.map((p) => (
            <label className="radio-card" key={p.sku}>
              <input type="radio" name="sr-sku" checked={sku === p.sku} onChange={() => { setSku(p.sku); if (p.sku.startsWith('Free')) setCap(1); }} />
              <span><strong className="mono">{p.sku}</strong> {p.sku === curSku && <Badge tone="info">{L('attuale', 'current')}</Badge>}<br /><span className="small muted">{p.specs[locale]}</span><br /><span className="small">{p.free ? L('Gratuito', 'Free') : monthlyOf(p) !== null ? `${money(monthlyOf(p)!, locale)} ${L('per unità al mese', 'per unit per month')}` : ''}</span></span>
            </label>
          ))}</div>
          <Field label={L('Unità', 'Units')} htmlFor="sr-u" hint={L('Ogni unità regge circa 1000 connessioni contemporanee.', 'Each unit handles about 1,000 concurrent connections.')}>
            <Select id="sr-u" value={cap} disabled={units.length === 1} onChange={(e) => setCap(Number(e.target.value))}>{units.map((n) => <option key={n} value={n}>{n}</option>)}</Select>
          </Field>
          {price !== null && !sku.startsWith('Free') && <p style={{ margin: 0 }}><strong>{money(price * cap, locale)}</strong> {L('al mese, più i messaggi oltre la quota giornaliera', 'per month, plus messages above the daily quota')}</p>}
          {curSku.startsWith('Free') === false && sku.startsWith('Free') && <Notice tone="warn">{L('Tornando al piano gratuito si scende a 20 connessioni contemporanee.', 'Going back to the free tier drops to 20 concurrent connections.')}</Notice>}
        </div>
      )}
    </Card>
  );
}

/** SignalR / Web PubSub: chiavi e stringhe di connessione con rigenerazione. */
export function SignalRKeys({ id, r }: { id: string; r: any }) {
  const L = useL();
  const load = async () => {
    const k = await arm.post<any>(`${id}/listKeys`, {}, SIGNALR_API);
    return [
      { key: 'p', label: L('Stringa di connessione primaria', 'Primary connection string'), value: k.primaryConnectionString, regen: () => arm.post(`${id}/regenerateKey`, { keyType: 'Primary' }, SIGNALR_API) },
      { key: 's', label: L('Stringa di connessione secondaria', 'Secondary connection string'), value: k.secondaryConnectionString, regen: () => arm.post(`${id}/regenerateKey`, { keyType: 'Secondary' }, SIGNALR_API) },
    ];
  };
  const host = r.properties?.hostName ?? '';
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card title="Endpoint"><p style={{ margin: 0 }}><span className="mono">https://{host}</span> <CopyButton value={`https://${host}`} /></p></Card>
      <KeysCard title={L('Chiavi di accesso', 'Access keys')} load={load}
        disabled={r.properties?.disableLocalAuth ? L('L\'autenticazione con chiave è disattivata: il server usa un\'identità gestita.', 'Key authentication is disabled: the server uses a managed identity.') : undefined}
        note={L('La stringa di connessione va nell\'app server (Azure__SignalR__ConnectionString); i client ricevono solo token temporanei.', 'The connection string goes in the server app (Azure__SignalR__ConnectionString); clients only receive short-lived tokens.')} />
    </div>
  );
}
