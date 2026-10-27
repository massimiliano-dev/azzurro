'use client';

import { useEffect, useState } from 'react';
import { KeyRound, Plus, Save, Trash2, Workflow } from 'lucide-react';
import { arm } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { Badge, Button, Card, Checkbox, CopyButton, Empty, ErrorNotice, Field, Input, Notice, SecretValue, Select, Skeleton, Switch } from '../ui';
import { Panel, useConfirm, useToast } from '../overlay';
import { useL } from './common';

export const STORAGE_API = '2023-05-01';
const NET_API = '2024-01-01';
const IP_RE = /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/;

export interface NetworkState { mode: 'all' | 'selected' | 'disabled'; ipRules: string[]; subnets: string[]; bypass: boolean }

/** Stato della rete nel formato comune di Storage, Key Vault e AI Services. */
export function readNetwork(p: any): NetworkState {
  const acls = p?.networkAcls ?? {};
  const disabled = String(p?.publicNetworkAccess ?? 'Enabled').toLowerCase() === 'disabled';
  return {
    mode: disabled ? 'disabled' : acls.defaultAction === 'Deny' ? 'selected' : 'all',
    ipRules: (acls.ipRules ?? []).map((r: any) => String(r.value ?? r.ipAddressOrRange ?? '')),
    subnets: (acls.virtualNetworkRules ?? []).map((r: any) => String(r.id ?? r.virtualNetworkResourceId ?? '')),
    bypass: String(acls.bypass ?? 'AzureServices').includes('AzureServices'),
  };
}

/** Accesso dalla rete pubblica: tutte le reti, reti selezionate (IP e subnet) o disattivato. */
export function NetworkAccessCard({ id, state, bypass, endpoint, onSave }: { id: string; state: NetworkState; bypass?: string; endpoint?: string; onSave: (s: NetworkState) => Promise<unknown> }) {
  const L = useL();
  const toast = useToast();
  const sub = id.split('/')[2];
  const vnets = useAsync(async () => (await arm.get<{ value: any[] }>(`/subscriptions/${sub}/providers/Microsoft.Network/virtualNetworks`, NET_API)).value, [sub]);
  const [s, setS] = useState(state);
  const [ip, setIp] = useState('');
  const [subnet, setSubnet] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setS(state), [JSON.stringify(state)]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(s) !== JSON.stringify(state);
  const subnets = (vnets.data ?? []).flatMap((v) => (v.properties?.subnets ?? []).map((sn: any) => ({ id: sn.id as string, label: `${v.name} / ${sn.name}`, endpoints: (sn.properties?.serviceEndpoints ?? []).map((e: any) => e.service as string) })));
  const save = async () => {
    setBusy(true);
    try { await onSave(s); toast.ok(L('Rete aggiornata', 'Networking updated')); }
    catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  const addIp = () => { const v = ip.trim(); if (IP_RE.test(v) && !s.ipRules.includes(v)) setS({ ...s, ipRules: [...s.ipRules, v] }); setIp(''); };
  return (
    <Card title={L('Accesso dalla rete pubblica', 'Public network access')} actions={<Button variant="primary" icon={Save} loading={busy} disabled={!dirty} onClick={() => void save()}>{L('Salva', 'Save')}</Button>}>
      <div className="stack" style={{ gap: 14 }}>
        <div className="radio-cards">
          {([
            ['all', L('Tutte le reti', 'All networks'), L('Raggiungibile da internet con le credenziali giuste.', 'Reachable from the internet with valid credentials.')],
            ['selected', L('Reti e IP selezionati', 'Selected networks and IPs'), L('Solo dagli indirizzi IP e dalle subnet elencati.', 'Only from the listed IP addresses and subnets.')],
            ['disabled', L('Disattivato', 'Disabled'), L('Solo tramite endpoint privati.', 'Only through private endpoints.')],
          ] as const).map(([k, title, text]) => (
            <label className="radio-card" key={k}>
              <input type="radio" name={`net-${id}`} checked={s.mode === k} onChange={() => setS({ ...s, mode: k })} />
              <span><strong>{title}</strong><br /><span className="small muted">{text}</span></span>
            </label>
          ))}
        </div>
        {s.mode === 'selected' && (
          <>
            <Field label={L('Indirizzi IP o intervalli CIDR', 'IP addresses or CIDR ranges')} htmlFor="net-ip" hint={L('IPv4 pubblici, per esempio 203.0.113.10 o 203.0.113.0/24.', 'Public IPv4, e.g. 203.0.113.10 or 203.0.113.0/24.')}>
              <div className="row">
                <Input id="net-ip" className="mono" value={ip} invalid={!!ip && !IP_RE.test(ip.trim())} placeholder="203.0.113.0/24" onChange={(e) => setIp(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addIp(); } }} />
                <Button icon={Plus} disabled={!IP_RE.test(ip.trim())} onClick={addIp}>{L('Aggiungi', 'Add')}</Button>
              </div>
            </Field>
            {s.ipRules.length > 0 && <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>{s.ipRules.map((r) => (
              <span key={r} className="chip mono">{r} <button type="button" className="link-btn" aria-label={L(`Rimuovi ${r}`, `Remove ${r}`)} onClick={() => setS({ ...s, ipRules: s.ipRules.filter((x) => x !== r) })}>×</button></span>
            ))}</div>}
            <Field label={L('Subnet di reti virtuali', 'Virtual network subnets')} htmlFor="net-sn" hint={endpoint ? L(`La subnet deve avere l'endpoint di servizio ${endpoint}.`, `The subnet needs the ${endpoint} service endpoint.`) : undefined}>
              <div className="row">
                <Select id="net-sn" value={subnet} onChange={(e) => setSubnet(e.target.value)}>
                  <option value="">{vnets.data ? (subnets.length ? L('Scegli una subnet…', 'Choose a subnet…') : L('Nessuna rete virtuale nella sottoscrizione', 'No virtual network in the subscription')) : L('Caricamento…', 'Loading…')}</option>
                  {subnets.filter((x) => !s.subnets.some((y) => y.toLowerCase() === x.id.toLowerCase())).map((x) => <option key={x.id} value={x.id}>{x.label}{endpoint && !x.endpoints.includes(endpoint) ? L(' (senza endpoint di servizio)', ' (no service endpoint)') : ''}</option>)}
                </Select>
                <Button icon={Plus} disabled={!subnet} onClick={() => { setS({ ...s, subnets: [...s.subnets, subnet] }); setSubnet(''); }}>{L('Aggiungi', 'Add')}</Button>
              </div>
            </Field>
            {s.subnets.length > 0 && <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>{s.subnets.map((r) => (
              <span key={r} className="chip mono">{r.split('/virtualNetworks/')[1]?.replace('/subnets/', ' / ') ?? r} <button type="button" className="link-btn" aria-label={L('Rimuovi', 'Remove')} onClick={() => setS({ ...s, subnets: s.subnets.filter((x) => x !== r) })}>×</button></span>
            ))}</div>}
            {bypass && <Switch checked={s.bypass} onChange={(v) => setS({ ...s, bypass: v })} label={bypass} />}
            {s.ipRules.length === 0 && s.subnets.length === 0 && <Notice tone="warn">{L('Senza IP né subnet, nessuno raggiunge la risorsa dalla rete pubblica.', 'With no IPs or subnets, nobody reaches the resource from the public network.')}</Notice>}
          </>
        )}
        {s.mode === 'disabled' && <Notice tone="warn">{L('Le app devono passare da un endpoint privato nella loro rete virtuale; anche il portale non vede più i dati.', 'Apps must go through a private endpoint in their virtual network; the portal can no longer see the data either.')}</Notice>}
      </div>
    </Card>
  );
}

/** Configurazione dell'account: ridondanza, livello di accesso, TLS, accesso con chiave e pubblico. */
export function StorageConfig({ id, acc, reload }: { id: string; acc: any; reload: () => void }) {
  const L = useL();
  const toast = useToast();
  const p = acc.properties ?? {};
  const premium = String(acc.sku?.name).startsWith('Premium');
  const tiered = !premium && ['StorageV2', 'BlobStorage'].includes(acc.kind);
  const zoneFamily = /ZRS/.test(acc.sku?.name ?? '');
  const redundancies = premium ? [acc.sku.name] : zoneFamily ? ['Standard_ZRS', 'Standard_GZRS', 'Standard_RAGZRS'] : ['Standard_LRS', 'Standard_GRS', 'Standard_RAGRS'];
  const initial = () => ({
    sku: acc.sku?.name ?? 'Standard_LRS', accessTier: p.accessTier ?? 'Hot', minimumTlsVersion: p.minimumTlsVersion ?? 'TLS1_2',
    supportsHttpsTrafficOnly: p.supportsHttpsTrafficOnly !== false, allowBlobPublicAccess: !!p.allowBlobPublicAccess,
    allowSharedKeyAccess: p.allowSharedKeyAccess !== false, defaultToOAuthAuthentication: !!p.defaultToOAuthAuthentication,
  });
  const [f, setF] = useState(initial);
  const [busy, setBusy] = useState(false);
  useEffect(() => setF(initial()), [acc]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(f) !== JSON.stringify(initial());
  const save = async () => {
    setBusy(true);
    try {
      const { sku, ...props } = f;
      if (!tiered) delete (props as any).accessTier;
      await arm.patch(id, { ...(sku !== acc.sku?.name ? { sku: { name: sku } } : {}), properties: props }, STORAGE_API);
      toast.ok(L('Configurazione salvata', 'Configuration saved'));
      reload();
    } catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  const label: Record<string, string> = { Standard_LRS: L('LRS · locale (3 copie in un datacenter)', 'LRS · local (3 copies in one datacenter)'), Standard_GRS: L('GRS · geo-ridondante', 'GRS · geo-redundant'), Standard_RAGRS: L('RA-GRS · geo-ridondante con lettura', 'RA-GRS · read-access geo-redundant'), Standard_ZRS: L('ZRS · tra zone', 'ZRS · zone-redundant'), Standard_GZRS: L('GZRS · zone + geo', 'GZRS · zone + geo'), Standard_RAGZRS: L('RA-GZRS · zone + geo con lettura', 'RA-GZRS · zone + geo with read access') };
  return (
    <Card title={L('Configurazione', 'Configuration')} actions={<Button variant="primary" icon={Save} loading={busy} disabled={!dirty} onClick={() => void save()}>{L('Salva', 'Save')}</Button>}>
      <div className="stack" style={{ gap: 12 }}>
        <Field label={L('Ridondanza', 'Redundancy')} htmlFor="sc-sku" hint={premium ? L('Gli account Premium non cambiano ridondanza.', 'Premium accounts cannot change redundancy.') : zoneFamily ? undefined : L('Per passare a ZRS serve una migrazione dell\'account.', 'Moving to ZRS requires an account migration.')}>
          <Select id="sc-sku" value={f.sku} disabled={premium} onChange={(e) => setF({ ...f, sku: e.target.value })}>{redundancies.map((r) => <option key={r} value={r}>{label[r] ?? r}</option>)}</Select>
        </Field>
        {tiered && (
          <Field label={L('Livello di accesso predefinito', 'Default access tier')} htmlFor="sc-tier" hint={L('Hot per dati usati spesso; Cool e Cold costano meno da tenere ma di più da leggere.', 'Hot for frequently used data; Cool and Cold cost less to store but more to read.')}>
            <Select id="sc-tier" value={f.accessTier} onChange={(e) => setF({ ...f, accessTier: e.target.value })}>{['Hot', 'Cool', 'Cold'].map((x) => <option key={x}>{x}</option>)}</Select>
          </Field>
        )}
        <Field label={L('Versione TLS minima', 'Minimum TLS version')} htmlFor="sc-tls">
          <Select id="sc-tls" value={f.minimumTlsVersion} onChange={(e) => setF({ ...f, minimumTlsVersion: e.target.value })}>{['TLS1_0', 'TLS1_1', 'TLS1_2'].map((x) => <option key={x} value={x}>{x.replace('_', '.')}</option>)}</Select>
        </Field>
        {f.minimumTlsVersion !== 'TLS1_2' && <Notice tone="warn">{L('Azure ritira TLS 1.0 e 1.1: usa 1.2.', 'Azure is retiring TLS 1.0 and 1.1: use 1.2.')}</Notice>}
        <Switch checked={f.supportsHttpsTrafficOnly} onChange={(v) => setF({ ...f, supportsHttpsTrafficOnly: v })} label={L('Solo trasferimenti sicuri (HTTPS)', 'Secure transfer required (HTTPS only)')} />
        <Switch checked={f.allowSharedKeyAccess} onChange={(v) => setF({ ...f, allowSharedKeyAccess: v })} label={L('Accesso con chiave dell\'account (e SAS firmate con chiave)', 'Storage account key access (and key-signed SAS)')} />
        {!f.allowSharedKeyAccess && <Notice>{L('Le app dovranno usare Microsoft Entra ID (ruoli Storage Blob Data …) o SAS di delega utente.', 'Apps will need Microsoft Entra ID (Storage Blob Data … roles) or user delegation SAS.')}</Notice>}
        <Switch checked={f.defaultToOAuthAuthentication} onChange={(v) => setF({ ...f, defaultToOAuthAuthentication: v })} label={L('Nel portale usa Microsoft Entra ID come autorizzazione predefinita', 'Default to Microsoft Entra authorization in the portal')} />
        <Switch checked={f.allowBlobPublicAccess} onChange={(v) => setF({ ...f, allowBlobPublicAccess: v })} label={L('Consenti l\'accesso anonimo ai BLOB', 'Allow anonymous blob access')} />
        {f.allowBlobPublicAccess && <Notice tone="warn">{L('Con l\'accesso anonimo un contenitore impostato come pubblico è leggibile da chiunque.', 'With anonymous access, a container set to public is readable by anyone.')}</Notice>}
      </div>
    </Card>
  );
}

/** Rete dell'account di archiviazione. */
export function StorageNetworking({ id, acc, reload }: { id: string; acc: any; reload: () => void }) {
  const L = useL();
  const save = async (s: NetworkState) => {
    await arm.patch(id, {
      properties: {
        publicNetworkAccess: s.mode === 'disabled' ? 'Disabled' : 'Enabled',
        networkAcls: {
          defaultAction: s.mode === 'selected' ? 'Deny' : 'Allow', bypass: s.bypass ? 'AzureServices' : 'None',
          ipRules: s.mode === 'selected' ? s.ipRules.map((value) => ({ value, action: 'Allow' })) : [],
          virtualNetworkRules: s.mode === 'selected' ? s.subnets.map((sid) => ({ id: sid, action: 'Allow' })) : [],
        },
      },
    }, STORAGE_API);
    reload();
  };
  return <NetworkAccessCard id={id} state={readNetwork(acc.properties)} endpoint="Microsoft.Storage" bypass={L('Consenti ai servizi Azure attendibili (Backup, Monitor, Event Grid…)', 'Allow trusted Azure services (Backup, Monitor, Event Grid…)')} onSave={save} />;
}

interface Rule { name: string; enabled: boolean; blobTypes: string[]; prefixes: string; cool: string; cold: string; archive: string; del: string; snapDel: string }
const toNum = (v: string) => (v.trim() === '' ? undefined : Number(v));
const ruleFrom = (r: any): Rule => {
  const b = r.definition?.actions?.baseBlob ?? {};
  const d = (x: any) => String(x?.daysAfterModificationGreaterThan ?? x?.daysAfterLastAccessTimeGreaterThan ?? x?.daysAfterCreationGreaterThan ?? '');
  return { name: r.name, enabled: r.enabled !== false, blobTypes: r.definition?.filters?.blobTypes ?? ['blockBlob'], prefixes: (r.definition?.filters?.prefixMatch ?? []).join(', '), cool: d(b.tierToCool), cold: d(b.tierToCold), archive: d(b.tierToArchive), del: d(b.delete), snapDel: String(r.definition?.actions?.snapshot?.delete?.daysAfterCreationGreaterThan ?? '') };
};
const ruleTo = (r: Rule) => {
  const days = (v: string) => (toNum(v) === undefined ? undefined : { daysAfterModificationGreaterThan: toNum(v) });
  const baseBlob = Object.fromEntries(Object.entries({ tierToCool: days(r.cool), tierToCold: days(r.cold), tierToArchive: days(r.archive), delete: days(r.del) }).filter(([, v]) => v));
  const prefixMatch = r.prefixes.split(',').map((x) => x.trim()).filter(Boolean);
  return {
    name: r.name, enabled: r.enabled, type: 'Lifecycle',
    definition: {
      filters: { blobTypes: r.blobTypes, ...(prefixMatch.length ? { prefixMatch } : {}) },
      actions: { ...(Object.keys(baseBlob).length ? { baseBlob } : {}), ...(toNum(r.snapDel) !== undefined ? { snapshot: { delete: { daysAfterCreationGreaterThan: toNum(r.snapDel) } } } : {}) },
    },
  };
};

/** Gestione del ciclo di vita: regole che spostano o eliminano i BLOB in base all'età. */
export function StorageLifecycle({ id }: { id: string }) {
  const L = useL();
  const toast = useToast();
  const confirm = useConfirm();
  const pol = useAsync(async () => {
    try { return ((await arm.get<any>(`${id}/managementPolicies/default`, STORAGE_API)).properties?.policy?.rules ?? []).map(ruleFrom) as Rule[]; }
    catch (e: any) { if (e?.status === 404) return [] as Rule[]; throw e; }
  }, [id]);
  const [edit, setEdit] = useState<(Rule & { isNew: boolean }) | null>(null);
  const [busy, setBusy] = useState(false);
  const persist = async (rules: Rule[]) => {
    if (rules.length === 0) await arm.del(`${id}/managementPolicies/default`, STORAGE_API);
    else await arm.put(`${id}/managementPolicies/default`, { properties: { policy: { rules: rules.map(ruleTo) } } }, STORAGE_API);
    pol.reload();
  };
  const save = async () => {
    if (!edit) return;
    setBusy(true);
    try {
      const { isNew, ...rule } = edit;
      const rules = isNew ? [...(pol.data ?? []), rule] : (pol.data ?? []).map((r) => (r.name === rule.name ? rule : r));
      await persist(rules);
      toast.ok(L('Regola salvata', 'Rule saved'), rule.name);
      setEdit(null);
    } catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  const nums = edit ? [edit.cool, edit.cold, edit.archive, edit.del, edit.snapDel].map(toNum) : [];
  const valid = !!edit && /^[a-zA-Z0-9]{1,256}$/.test(edit.name) && edit.blobTypes.length > 0
    && nums.every((n) => n === undefined || (Number.isInteger(n) && n >= 0 && n <= 99999)) && nums.some((n) => n !== undefined)
    && (!edit.isNew || !(pol.data ?? []).some((r) => r.name.toLowerCase() === edit.name.toLowerCase()));
  const steps = (r: Rule) => [
    r.cool && L(`Cool dopo ${r.cool} g`, `Cool after ${r.cool} d`), r.cold && L(`Cold dopo ${r.cold} g`, `Cold after ${r.cold} d`),
    r.archive && L(`Archive dopo ${r.archive} g`, `Archive after ${r.archive} d`), r.del && L(`elimina dopo ${r.del} g`, `delete after ${r.del} d`),
    r.snapDel && L(`snapshot eliminati dopo ${r.snapDel} g`, `snapshots deleted after ${r.snapDel} d`),
  ].filter(Boolean).join(' → ');
  return (
    <Card title={L('Gestione del ciclo di vita', 'Lifecycle management')} actions={<Button size="sm" variant="primary" icon={Plus} onClick={() => setEdit({ name: `rule${(pol.data?.length ?? 0) + 1}`, enabled: true, blobTypes: ['blockBlob'], prefixes: '', cool: '30', cold: '', archive: '', del: '', snapDel: '', isNew: true })}>{L('Nuova regola', 'New rule')}</Button>}>
      {pol.error ? <ErrorNotice error={pol.error} onRetry={pol.reload} /> : !pol.data ? <Skeleton rows={3} /> : pol.data.length === 0 ? (
        <Empty icon={Workflow} title={L('Nessuna regola', 'No rules')} text={L('Sposta i BLOB su livelli più economici o eliminali quando invecchiano: una volta al giorno Azure applica le regole.', 'Move blobs to cheaper tiers or delete them as they age: Azure applies the rules once a day.')} />
      ) : (
        <div className="table-wrap" style={{ border: 0, boxShadow: 'none' }}><table className="table">
          <thead><tr><th>{L('Regola', 'Rule')}</th><th>{L('Stato', 'State')}</th><th>{L('Filtro', 'Filter')}</th><th>{L('Azioni', 'Actions')}</th><th /></tr></thead>
          <tbody>{pol.data.map((r) => (
            <tr key={r.name}>
              <td className="mono">{r.name}</td>
              <td><Badge tone={r.enabled ? 'ok' : undefined}>{r.enabled ? L('attiva', 'enabled') : L('disattivata', 'disabled')}</Badge></td>
              <td className="small">{r.blobTypes.join(', ')}{r.prefixes && <><br /><span className="mono muted">{r.prefixes}</span></>}</td>
              <td className="small">{steps(r)}</td>
              <td><div className="row">
                <Button size="sm" variant="ghost" onClick={() => setEdit({ ...r, isNew: false })}>{L('Modifica', 'Edit')}</Button>
                <Button size="sm" variant="ghost" icon={Trash2} aria-label={L('Elimina', 'Delete')} onClick={async () => { if (!(await confirm({ title: L(`Eliminare la regola ${r.name}?`, `Delete rule ${r.name}?`), danger: true, confirmLabel: L('Elimina', 'Delete') }))) return; try { await persist((pol.data ?? []).filter((x) => x.name !== r.name)); } catch (e) { toast.error(e); } }} />
              </div></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      <Panel open={!!edit} onClose={() => setEdit(null)} title={edit?.isNew ? L('Nuova regola', 'New rule') : L(`Regola ${edit?.name}`, `Rule ${edit?.name}`)}
        footer={<><Button onClick={() => setEdit(null)}>{L('Annulla', 'Cancel')}</Button><Button variant="primary" loading={busy} disabled={!valid} onClick={() => void save()}>{L('Salva', 'Save')}</Button></>}>
        {edit && (
          <div className="stack" style={{ gap: 12 }}>
            <Field label={L('Nome', 'Name')} htmlFor="lr-n" hint={L('Solo lettere e numeri.', 'Letters and digits only.')}><Input id="lr-n" className="mono" disabled={!edit.isNew} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Switch checked={edit.enabled} onChange={(v) => setEdit({ ...edit, enabled: v })} label={L('Regola attiva', 'Rule enabled')} />
            <Field label={L('Tipi di BLOB', 'Blob types')}>
              <div className="row">{[['blockBlob', 'Block'], ['appendBlob', 'Append']].map(([k, lab]) => <Checkbox key={k} checked={edit.blobTypes.includes(k)} onChange={(v) => setEdit({ ...edit, blobTypes: v ? [...edit.blobTypes, k] : edit.blobTypes.filter((x) => x !== k) })} label={lab} />)}</div>
            </Field>
            <Field label={L('Prefissi (facoltativi)', 'Prefixes (optional)')} htmlFor="lr-p" hint={L('contenitore/percorso, separati da virgola: per esempio logs/, backup/2025', 'container/path, comma separated: e.g. logs/, backup/2025')}><Input id="lr-p" className="mono" value={edit.prefixes} onChange={(e) => setEdit({ ...edit, prefixes: e.target.value })} /></Field>
            <p className="small muted" style={{ margin: 0 }}>{L('Giorni dall\'ultima modifica del BLOB (lascia vuoto per saltare il passaggio):', 'Days since the blob was last modified (leave blank to skip a step):')}</p>
            <div className="grid cols-2" style={{ gap: 10 }}>
              <Field label={L('Sposta in Cool', 'Move to Cool')} htmlFor="lr-c"><Input id="lr-c" type="number" min={0} value={edit.cool} onChange={(e) => setEdit({ ...edit, cool: e.target.value })} /></Field>
              <Field label={L('Sposta in Cold', 'Move to Cold')} htmlFor="lr-o"><Input id="lr-o" type="number" min={0} value={edit.cold} onChange={(e) => setEdit({ ...edit, cold: e.target.value })} /></Field>
              <Field label={L('Sposta in Archive', 'Move to Archive')} htmlFor="lr-a"><Input id="lr-a" type="number" min={0} value={edit.archive} disabled={edit.blobTypes.includes('appendBlob')} onChange={(e) => setEdit({ ...edit, archive: e.target.value })} /></Field>
              <Field label={L('Elimina', 'Delete')} htmlFor="lr-d"><Input id="lr-d" type="number" min={0} value={edit.del} onChange={(e) => setEdit({ ...edit, del: e.target.value })} /></Field>
              <Field label={L('Elimina gli snapshot (giorni dalla creazione)', 'Delete snapshots (days since creation)')} htmlFor="lr-s"><Input id="lr-s" type="number" min={0} value={edit.snapDel} onChange={(e) => setEdit({ ...edit, snapDel: e.target.value })} /></Field>
            </div>
            {nums.every((n) => n === undefined) && <Notice>{L('Imposta almeno un\'azione.', 'Set at least one action.')}</Notice>}
          </div>
        )}
      </Panel>
    </Card>
  );
}

/** Firma di accesso condiviso (SAS) dell'account, firmata con una delle due chiavi. */
export function StorageSas({ id, acc }: { id: string; acc: any }) {
  const L = useL();
  const toast = useToast();
  const plusDays = (d: number) => new Date(Date.now() + d * 86400_000).toISOString().slice(0, 16);
  const [svc, setSvc] = useState(['b']);
  const [types, setTypes] = useState(['c', 'o']);
  const [perms, setPerms] = useState(['r', 'l']);
  const [start, setStart] = useState('');
  const [expiry, setExpiry] = useState(plusDays(7));
  const [ip, setIp] = useState('');
  const [httpsOnly, setHttpsOnly] = useState(true);
  const [key, setKey] = useState('key1');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const keyless = acc.properties?.allowSharedKeyAccess === false;
  const toggle = (list: string[], set: (v: string[]) => void, k: string) => (v: boolean) => set(v ? [...list, k] : list.filter((x) => x !== k));
  const ipOk = !ip || /^\d{1,3}(\.\d{1,3}){3}(-\d{1,3}(\.\d{1,3}){3})?$/.test(ip);
  const valid = svc.length > 0 && types.length > 0 && perms.length > 0 && !!expiry && (!start || start < expiry) && ipOk;
  const generate = async () => {
    setBusy(true);
    try {
      const order = (all: string, sel: string[]) => all.split('').filter((c) => sel.includes(c)).join('');
      const r = await arm.post<{ accountSasToken: string }>(`${id}/listAccountSas`, {
        signedServices: order('bfqt', svc), signedResourceTypes: order('sco', types), signedPermission: order('rwdlacup', perms),
        signedProtocol: httpsOnly ? 'https' : 'https,http', signedExpiry: new Date(expiry).toISOString(),
        ...(start ? { signedStart: new Date(start).toISOString() } : {}), ...(ip ? { signedIp: ip } : {}), keyToSign: key,
      }, STORAGE_API);
      setToken(r.accountSasToken);
    } catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  const ep = acc.properties?.primaryEndpoints ?? {};
  const urls: [string, string | undefined][] = [['Blob', ep.blob], ['File', ep.file], ['Queue', ep.queue], ['Table', ep.table]];
  const svcKeys: Record<string, string> = { Blob: 'b', File: 'f', Queue: 'q', Table: 't' };
  return (
    <Card title={L('Firma di accesso condiviso (SAS)', 'Shared access signature (SAS)')}>
      {keyless ? <Notice>{L('L\'accesso con chiave è disattivato: usa una SAS di delega utente firmata con Microsoft Entra ID (az storage container generate-sas --as-user --auth-mode login).', 'Key access is disabled: use a user delegation SAS signed with Microsoft Entra ID (az storage container generate-sas --as-user --auth-mode login).')}</Notice> : (
        <div className="stack" style={{ gap: 12 }}>
          <Field label={L('Servizi', 'Services')}><div className="row">{[['b', 'Blob'], ['f', 'File'], ['q', 'Queue'], ['t', 'Table']].map(([k, l]) => <Checkbox key={k} checked={svc.includes(k)} onChange={toggle(svc, setSvc, k)} label={l} />)}</div></Field>
          <Field label={L('Tipi di risorsa', 'Resource types')}><div className="row">{[['s', L('Servizio', 'Service')], ['c', L('Contenitore', 'Container')], ['o', L('Oggetto', 'Object')]].map(([k, l]) => <Checkbox key={k} checked={types.includes(k)} onChange={toggle(types, setTypes, k)} label={l} />)}</div></Field>
          <Field label={L('Autorizzazioni', 'Permissions')}><div className="row" style={{ flexWrap: 'wrap' }}>{[['r', L('Lettura', 'Read')], ['w', L('Scrittura', 'Write')], ['d', L('Eliminazione', 'Delete')], ['l', L('Elenco', 'List')], ['a', L('Aggiunta', 'Add')], ['c', L('Creazione', 'Create')], ['u', L('Aggiornamento', 'Update')], ['p', L('Elaborazione', 'Process')]].map(([k, l]) => <Checkbox key={k} checked={perms.includes(k)} onChange={toggle(perms, setPerms, k)} label={l} />)}</div></Field>
          <div className="grid cols-2" style={{ gap: 10 }}>
            <Field label={L('Inizio (facoltativo)', 'Start (optional)')} htmlFor="sas-s"><Input id="sas-s" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
            <Field label={L('Scadenza', 'Expiry')} htmlFor="sas-e"><Input id="sas-e" type="datetime-local" value={expiry} onChange={(e) => setExpiry(e.target.value)} /></Field>
            <Field label={L('IP consentiti (facoltativo)', 'Allowed IPs (optional)')} htmlFor="sas-ip" hint="203.0.113.5 · 203.0.113.0-203.0.113.255"><Input id="sas-ip" className="mono" value={ip} invalid={!ipOk} onChange={(e) => setIp(e.target.value)} /></Field>
            <Field label={L('Chiave di firma', 'Signing key')} htmlFor="sas-k"><Select id="sas-k" value={key} onChange={(e) => setKey(e.target.value)}><option value="key1">key1</option><option value="key2">key2</option></Select></Field>
          </div>
          <Switch checked={httpsOnly} onChange={setHttpsOnly} label={L('Solo HTTPS', 'HTTPS only')} />
          <div className="row" style={{ justifyContent: 'flex-end' }}><Button variant="primary" icon={KeyRound} loading={busy} disabled={!valid} onClick={() => void generate()}>{L('Genera SAS', 'Generate SAS')}</Button></div>
          {token && (
            <div className="stack" style={{ gap: 8 }}>
              <Field label={L('Token SAS', 'SAS token')}><SecretValue value={`?${token}`} /></Field>
              {urls.filter(([k, u]) => u && svc.includes(svcKeys[k])).map(([k, u]) => (
                <p key={k} className="small" style={{ margin: 0 }}>{k}: <span className="mono">{u}?…</span> <CopyButton value={`${u}?${token}`} label={L('Copia URL', 'Copy URL')} /></p>
              ))}
              <Notice tone="warn">{L('Chi ha questa SAS ha i permessi scelti fino alla scadenza. Per revocarla devi rigenerare la chiave che l\'ha firmata.', 'Anyone with this SAS has the chosen permissions until it expires. To revoke it you must regenerate the key that signed it.')}</Notice>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
