'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Globe2, Link2, Pencil, Plus, Trash2 } from 'lucide-react';
import { arm } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { resourceHref } from '@/lib/arm';
import { Badge, Button, Card, CopyButton, Empty, ErrorNotice, Field, Input, Notice, Select, Skeleton, Switch } from '../ui';
import { Panel, useConfirm, useToast } from '../overlay';
import { useL } from './common';

export const DNS_API = '2018-05-01';
export const PDNS_API = '2020-06-01';
const nameOf = (id?: string) => id?.split('/').pop() ?? '';

type Col = { key: string; it: string; en: string; num?: boolean; placeholder?: string };
interface Spec { type: string; pub: string; priv: string; single?: boolean; cols: Col[]; it: string; en: string }
/** Tipi di record: nomi delle proprietà nell'API pubblica (2018-05-01) e privata (2020-06-01). */
const SPECS: Spec[] = [
  { type: 'A', pub: 'ARecords', priv: 'aRecords', cols: [{ key: 'ipv4Address', it: 'Indirizzo IPv4', en: 'IPv4 address', placeholder: '20.50.1.10' }], it: 'Indirizzo IPv4', en: 'IPv4 address' },
  { type: 'AAAA', pub: 'AAAARecords', priv: 'aaaaRecords', cols: [{ key: 'ipv6Address', it: 'Indirizzo IPv6', en: 'IPv6 address', placeholder: '2001:db8::1' }], it: 'Indirizzo IPv6', en: 'IPv6 address' },
  { type: 'CNAME', pub: 'CNAMERecord', priv: 'cnameRecord', single: true, cols: [{ key: 'cname', it: 'Alias di', en: 'Alias of', placeholder: 'myapp.azurewebsites.net' }], it: 'Alias verso un altro nome', en: 'Alias to another name' },
  { type: 'MX', pub: 'MXRecords', priv: 'mxRecords', cols: [{ key: 'preference', it: 'Preferenza', en: 'Preference', num: true, placeholder: '10' }, { key: 'exchange', it: 'Server di posta', en: 'Mail exchange', placeholder: 'contoso-com.mail.protection.outlook.com' }], it: 'Server di posta', en: 'Mail server' },
  { type: 'TXT', pub: 'TXTRecords', priv: 'txtRecords', cols: [{ key: 'value', it: 'Testo', en: 'Text', placeholder: 'v=spf1 include:spf.protection.outlook.com -all' }], it: 'Testo (SPF, verifiche di dominio)', en: 'Text (SPF, domain verification)' },
  { type: 'SRV', pub: 'SRVRecords', priv: 'srvRecords', cols: [{ key: 'priority', it: 'Priorità', en: 'Priority', num: true, placeholder: '10' }, { key: 'weight', it: 'Peso', en: 'Weight', num: true, placeholder: '5' }, { key: 'port', it: 'Porta', en: 'Port', num: true, placeholder: '5060' }, { key: 'target', it: 'Destinazione', en: 'Target', placeholder: 'sip.contoso.com' }], it: 'Servizio', en: 'Service' },
  { type: 'CAA', pub: 'CAARecords', priv: 'caaRecords', cols: [{ key: 'flags', it: 'Flag', en: 'Flags', num: true, placeholder: '0' }, { key: 'tag', it: 'Tag', en: 'Tag', placeholder: 'issue' }, { key: 'value', it: 'Valore', en: 'Value', placeholder: 'digicert.com' }], it: 'Autorità di certificazione', en: 'Certificate authority' },
  { type: 'NS', pub: 'NSRecords', priv: 'nsRecords', cols: [{ key: 'nsdname', it: 'Server dei nomi', en: 'Name server', placeholder: 'ns1.contoso.com' }], it: 'Delega di un sottodominio', en: 'Subdomain delegation' },
  { type: 'PTR', pub: 'PTRRecords', priv: 'ptrRecords', cols: [{ key: 'ptrdname', it: 'Nome', en: 'Name', placeholder: 'host.contoso.com' }], it: 'Ricerca inversa', en: 'Reverse lookup' },
];
const PRIVATE_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'PTR', 'SRV', 'TXT'];
const TTLS: [number, string, string][] = [[60, '1 minuto', '1 minute'], [300, '5 minuti', '5 minutes'], [3600, '1 ora', '1 hour'], [86400, '1 giorno', '1 day']];
const isIp4 = (s: string) => /^(\d{1,3}\.){3}\d{1,3}$/.test(s) && s.split('.').every((x) => Number(x) <= 255);

const typeOf = (r: any) => String(r.type ?? '').split('/').pop()!.toUpperCase();
const ttlOf = (r: any) => r.properties?.TTL ?? r.properties?.ttl;
function rowsOf(r: any, spec: Spec): Record<string, string>[] {
  const v = r.properties?.[spec.pub] ?? r.properties?.[spec.priv];
  const list = spec.single ? (v ? [v] : []) : v ?? [];
  return list.map((x: any) => Object.fromEntries(spec.cols.map((c) => [c.key, spec.type === 'TXT' ? (x.value ?? []).join('') : String(x[c.key] ?? '')])));
}
function summary(r: any): string {
  const t = typeOf(r);
  if (t === 'SOA') { const s = r.properties?.SOARecord ?? r.properties?.soaRecord; return s ? `${s.host} · ${s.email}` : ''; }
  const spec = SPECS.find((s) => s.type === t);
  if (!spec) return '';
  return rowsOf(r, spec).map((row) => spec.cols.map((c) => row[c.key]).join(' ')).join(', ');
}

/** Record set della zona (pubblica o privata) e, per le pubbliche, i server dei nomi da configurare presso il registrar. */
export function DnsRecordSets({ zoneId, zone, isPrivate }: { zoneId: string; zone: any; isPrivate: boolean }) {
  const L = useL();
  const toast = useToast();
  const confirm = useConfirm();
  const api = isPrivate ? PDNS_API : DNS_API;
  const sets = useAsync(async () => (await arm.get<{ value: any[] }>(`${zoneId}/${isPrivate ? 'ALL' : 'recordsets'}`, api)).value, [zoneId]);
  const [editing, setEditing] = useState<any | null | undefined>(undefined);
  const [form, setForm] = useState({ name: '@', type: 'A', ttl: 3600, rows: [{}] as Record<string, string>[] });
  const [busy, setBusy] = useState(false);
  const types = SPECS.filter((s) => !isPrivate || PRIVATE_TYPES.includes(s.type));
  const spec = SPECS.find((s) => s.type === form.type)!;
  const zoneName = zone.name;
  const fqdn = form.name === '@' || !form.name ? zoneName : `${form.name}.${zoneName}`;
  const open = (r: any | null) => {
    setEditing(r);
    if (r) {
      const t = typeOf(r);
      const sp = SPECS.find((s) => s.type === t)!;
      const rows = rowsOf(r, sp);
      setForm({ name: r.name, type: t, ttl: Number(ttlOf(r) ?? 3600), rows: rows.length ? rows : [{}] });
    } else setForm({ name: '', type: 'A', ttl: 3600, rows: [{}] });
  };
  const existing = (sets.data ?? []).filter((r) => r.name.toLowerCase() === (form.name || '@').toLowerCase() && (!editing || r.id !== editing.id));
  const nameErr = !form.name ? undefined
    : form.name !== '@' && !/^(\*\.)?[a-zA-Z0-9_]([a-zA-Z0-9_-]{0,61}[a-zA-Z0-9_])?(\.[a-zA-Z0-9_]([a-zA-Z0-9_-]{0,61}[a-zA-Z0-9_])?)*$/.test(form.name) ? L('Etichette di lettere, numeri, trattini e trattini bassi separate da punti; @ per l\'apice', 'Labels of letters, digits, hyphens and underscores separated by dots; @ for the apex')
    : form.type === 'CNAME' && form.name === '@' ? L('Un CNAME non può stare all\'apice della zona', 'A CNAME cannot sit at the zone apex')
    : !editing && existing.some((r) => typeOf(r) === form.type) ? L(`Esiste già un record ${form.type} con questo nome: modificalo`, `A ${form.type} record with this name already exists: edit it`)
    : form.type === 'CNAME' && existing.length ? L('Un CNAME non può convivere con altri record con lo stesso nome', 'A CNAME cannot coexist with other records of the same name')
    : form.type !== 'CNAME' && existing.some((r) => typeOf(r) === 'CNAME') ? L('Esiste già un CNAME con questo nome', 'A CNAME with this name already exists') : undefined;
  const rowErr = (row: Record<string, string>) => {
    for (const c of spec.cols) {
      const v = (row[c.key] ?? '').trim();
      if (!v) return L(`${c.it} obbligatorio`, `${c.en} is required`);
      if (c.num && !/^\d+$/.test(v)) return L(`${c.it}: numero intero`, `${c.en}: whole number`);
    }
    if (spec.type === 'A' && !isIp4(row.ipv4Address.trim())) return L('Indirizzo IPv4 non valido', 'Invalid IPv4 address');
    if (spec.type === 'AAAA' && !/^[0-9a-fA-F:]+$/.test(row.ipv6Address.trim())) return L('Indirizzo IPv6 non valido', 'Invalid IPv6 address');
    if (spec.type === 'CAA' && !['issue', 'issuewild', 'iodef'].includes(row.tag.trim())) return L('Tag: issue, issuewild o iodef', 'Tag: issue, issuewild or iodef');
    return undefined;
  };
  const rowErrors = form.rows.map(rowErr);
  const save = async () => {
    setBusy(true);
    const items = form.rows.map((row) => {
      if (spec.type === 'TXT') { const t = row.value; const chunks: string[] = []; for (let i = 0; i < t.length; i += 255) chunks.push(t.slice(i, i + 255)); return { value: chunks.length ? chunks : [''] }; }
      return Object.fromEntries(spec.cols.map((c) => [c.key, c.num ? Number(row[c.key]) : row[c.key].trim()]));
    });
    const name = form.name || '@';
    try {
      await arm.put(`${zoneId}/${form.type}/${name}`, { properties: { [isPrivate ? 'ttl' : 'TTL']: form.ttl, [isPrivate ? spec.priv : spec.pub]: spec.single ? items[0] : items } }, api);
      toast.ok(editing ? L('Record aggiornato', 'Record updated') : L('Record aggiunto', 'Record added'), `${form.type} ${fqdn}`);
      setEditing(undefined);
      sets.reload();
    } catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  const remove = async (r: any) => {
    if (!(await confirm({ title: L(`Eliminare ${typeOf(r)} ${r.name}?`, `Delete ${typeOf(r)} ${r.name}?`), text: L('Chi interroga questo nome smetterà di ottenere risposta dopo la scadenza del TTL.', 'Clients querying this name stop getting an answer once the TTL expires.'), danger: true, confirmLabel: L('Elimina', 'Delete') }))) return;
    try { await arm.del(`${zoneId}/${typeOf(r)}/${r.name}`, api); sets.reload(); } catch (e) { toast.error(e); }
  };
  const ns: string[] = zone.properties?.nameServers ?? [];
  const locked = (r: any) => typeOf(r) === 'SOA' || (!isPrivate && typeOf(r) === 'NS' && r.name === '@');
  const sorted = [...(sets.data ?? [])].sort((a, b) => (a.name === '@' ? -1 : b.name === '@' ? 1 : a.name.localeCompare(b.name)) || typeOf(a).localeCompare(typeOf(b)));
  return (
    <div className="stack" style={{ gap: 16 }}>
      {!isPrivate && ns.length > 0 && (
        <Card title={L('Server dei nomi', 'Name servers')}>
          <p className="muted" style={{ marginTop: 0 }}>{L(`Perché la zona risponda su Internet, imposta questi server dei nomi presso il registrar di ${zoneName}.`, `For the zone to answer on the Internet, set these name servers at the registrar of ${zoneName}.`)}</p>
          <div className="stack" style={{ gap: 4 }}>{ns.map((n) => <div className="row" key={n}><span className="mono">{n}</span><CopyButton value={n} /></div>)}</div>
        </Card>
      )}
      <Card title={L('Record set', 'Record sets')} actions={<Button size="sm" icon={Plus} onClick={() => open(null)}>{L('Record', 'Record')}</Button>}>
        {sets.error ? <ErrorNotice error={sets.error} onRetry={sets.reload} /> : !sets.data ? <Skeleton rows={4} /> : sorted.length === 0 ? <Empty icon={Globe2} title={L('Nessun record', 'No records')} /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>{L('Nome', 'Name')}</th><th>{L('Tipo', 'Type')}</th><th>TTL</th><th>{L('Valore', 'Value')}</th><th /></tr></thead>
            <tbody>{sorted.map((r) => (
              <tr key={r.id}>
                <td className="mono">{r.name}</td>
                <td><Badge>{typeOf(r)}</Badge></td>
                <td className="mono">{ttlOf(r) ?? '—'}</td>
                <td className="mono small" style={{ maxWidth: 420, overflowWrap: 'anywhere' }}>{summary(r) || '—'}</td>
                <td>{!locked(r) && <div className="row" style={{ gap: 2, justifyContent: 'flex-end' }}>
                  <Button size="sm" variant="ghost" icon={Pencil} aria-label={L('Modifica', 'Edit')} onClick={() => open(r)} />
                  <Button size="sm" variant="ghost" icon={Trash2} aria-label={L('Elimina', 'Delete')} onClick={() => void remove(r)} />
                </div>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      <Panel open={editing !== undefined} onClose={() => setEditing(undefined)} wide title={editing ? `${form.type} ${fqdn}` : L('Nuovo record', 'New record')}
        footer={<><Button onClick={() => setEditing(undefined)}>{L('Annulla', 'Cancel')}</Button><Button variant="primary" loading={busy} disabled={!form.name || !!nameErr || rowErrors.some(Boolean) || form.ttl < 1} onClick={() => void save()}>{editing ? L('Salva', 'Save') : L('Aggiungi', 'Add')}</Button></>}>
        <div className="grid cols-2" style={{ gap: '0 16px', alignItems: 'start' }}>
          <Field label={L('Nome', 'Name')} htmlFor="dr-n" error={nameErr} hint={form.name ? fqdn : L('@ per il dominio stesso, www per www.', '@ for the domain itself, www for www.') + zoneName}>
            <Input id="dr-n" className="mono" disabled={!!editing} placeholder="www" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value.toLowerCase() })} />
          </Field>
          <Field label={L('Tipo', 'Type')} htmlFor="dr-t">
            <Select id="dr-t" value={form.type} disabled={!!editing} onChange={(e) => setForm({ ...form, type: e.target.value, rows: [{}] })}>{types.map((s) => <option key={s.type} value={s.type}>{s.type} · {L(s.it, s.en)}</option>)}</Select>
          </Field>
          <Field label="TTL" htmlFor="dr-ttl" hint={L('Per quanto i resolver tengono in cache la risposta (secondi).', 'How long resolvers cache the answer (seconds).')}>
            <Input id="dr-ttl" type="number" min={1} list="dr-ttls" value={form.ttl} onChange={(e) => setForm({ ...form, ttl: Number(e.target.value) })} />
            <datalist id="dr-ttls">{TTLS.map(([v, it, en]) => <option key={v} value={v}>{L(it, en)}</option>)}</datalist>
          </Field>
        </div>
        <div className="stack" style={{ gap: 8 }}>
          {form.rows.map((row, i) => (
            <div key={i} className="row wrap" style={{ alignItems: 'flex-end' }}>
              {spec.cols.map((c) => (
                <Field key={c.key} label={i === 0 ? L(c.it, c.en) : undefined} htmlFor={`dr-${i}-${c.key}`}>
                  <Input id={`dr-${i}-${c.key}`} aria-label={L(c.it, c.en)} className="mono" style={c.num ? { width: 96 } : { minWidth: 240 }} placeholder={c.placeholder} value={row[c.key] ?? ''} invalid={!!row[c.key] && !!rowErrors[i]}
                    onChange={(e) => setForm({ ...form, rows: form.rows.map((x, j) => (j === i ? { ...x, [c.key]: e.target.value } : x)) })} />
                </Field>
              ))}
              {!spec.single && form.rows.length > 1 && <Button size="sm" variant="ghost" icon={Trash2} aria-label={L('Rimuovi', 'Remove')} onClick={() => setForm({ ...form, rows: form.rows.filter((_, j) => j !== i) })} />}
            </div>
          ))}
          {!spec.single && <div><Button size="sm" icon={Plus} onClick={() => setForm({ ...form, rows: [...form.rows, {}] })}>{L('Altro valore', 'Another value')}</Button></div>}
          {form.rows.some((r, i) => Object.values(r).some(Boolean) && rowErrors[i]) && <Notice tone="warn">{rowErrors.find(Boolean)}</Notice>}
          {form.type === 'TXT' && <p className="small muted" style={{ margin: 0 }}>{L('I testi più lunghi di 255 caratteri vengono divisi in più stringhe, come richiede il DNS.', 'Texts longer than 255 characters are split into several strings, as DNS requires.')}</p>}
        </div>
      </Panel>
    </div>
  );
}

/** Collegamenti della zona privata alle reti virtuali, con registrazione automatica delle VM. */
export function PrivateDnsLinks({ zoneId }: { zoneId: string }) {
  const L = useL();
  const toast = useToast();
  const confirm = useConfirm();
  const links = useAsync(async () => (await arm.get<{ value: any[] }>(`${zoneId}/virtualNetworkLinks`, PDNS_API)).value, [zoneId]);
  const [open, setOpen] = useState(false);
  const vnets = useAsync(async () => {
    if (!open) return [];
    const subs = (await arm.get<{ value: any[] }>('/subscriptions', '2022-12-01')).value;
    return (await Promise.all(subs.map((s) => arm.get<{ value: any[] }>(`/subscriptions/${s.subscriptionId}/providers/Microsoft.Network/virtualNetworks`, '2024-01-01').then((r) => r.value).catch(() => [])))).flat();
  }, [open]);
  const [form, setForm] = useState({ name: '', vnet: '', registration: false });
  const [busy, setBusy] = useState(false);
  const linked = new Set((links.data ?? []).map((l) => String(l.properties?.virtualNetwork?.id ?? '').toLowerCase()));
  const create = async () => {
    setBusy(true);
    try {
      await arm.put(`${zoneId}/virtualNetworkLinks/${form.name}`, { location: 'global', properties: { virtualNetwork: { id: form.vnet }, registrationEnabled: form.registration } }, PDNS_API);
      toast.ok(L('Rete collegata', 'Network linked'), nameOf(form.vnet));
      setOpen(false);
      links.reload();
    } catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  const toggle = async (l: any, on: boolean) => {
    try { await arm.put(l.id, { location: 'global', tags: l.tags, properties: { virtualNetwork: l.properties.virtualNetwork, registrationEnabled: on } }, PDNS_API); links.reload(); }
    catch (e) { toast.error(e); }
  };
  const remove = async (l: any) => {
    if (!(await confirm({ title: L(`Scollegare ${nameOf(l.properties?.virtualNetwork?.id)}?`, `Unlink ${nameOf(l.properties?.virtualNetwork?.id)}?`), text: L('Le risorse di quella rete smettono di risolvere i nomi di questa zona.', 'Resources in that network stop resolving names in this zone.'), danger: true, confirmLabel: L('Scollega', 'Unlink') }))) return;
    try { await arm.del(l.id, PDNS_API); links.reload(); } catch (e) { toast.error(e); }
  };
  return (
    <Card title={L('Collegamenti alle reti virtuali', 'Virtual network links')} actions={<Button size="sm" icon={Link2} onClick={() => { setForm({ name: '', vnet: '', registration: false }); setOpen(true); }}>{L('Collega rete', 'Link network')}</Button>}>
      {links.error ? <ErrorNotice error={links.error} onRetry={links.reload} /> : !links.data ? <Skeleton rows={2} /> : links.data.length === 0 ? <Empty icon={Link2} title={L('Nessuna rete collegata', 'No linked networks')} text={L('Una zona privata risponde solo alle reti virtuali collegate.', 'A private zone answers only linked virtual networks.')} /> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>{L('Collegamento', 'Link')}</th><th>{L('Rete virtuale', 'Virtual network')}</th><th>{L('Registrazione automatica', 'Auto-registration')}</th><th>{L('Stato', 'State')}</th><th /></tr></thead>
          <tbody>{links.data.map((l) => (
            <tr key={l.id}>
              <td className="mono">{l.name}</td>
              <td><Link className="mono" href={resourceHref(l.properties?.virtualNetwork?.id ?? '')}>{nameOf(l.properties?.virtualNetwork?.id)}</Link></td>
              <td><Switch checked={!!l.properties?.registrationEnabled} onChange={(v) => void toggle(l, v)} label={l.properties?.registrationEnabled ? L('Attiva', 'On') : L('Spenta', 'Off')} /></td>
              <td><Badge tone={l.properties?.virtualNetworkLinkState === 'Completed' ? 'ok' : 'warn'}>{l.properties?.virtualNetworkLinkState ?? '—'}</Badge></td>
              <td><Button size="sm" variant="ghost" icon={Trash2} aria-label={L('Scollega', 'Unlink')} onClick={() => void remove(l)} /></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      <Panel open={open} onClose={() => setOpen(false)} title={L('Collega una rete virtuale', 'Link a virtual network')}
        footer={<><Button onClick={() => setOpen(false)}>{L('Annulla', 'Cancel')}</Button><Button variant="primary" loading={busy} disabled={!/^[a-zA-Z0-9][\w.-]{0,79}$/.test(form.name) || !form.vnet} onClick={() => void create()}>{L('Collega', 'Link')}</Button></>}>
        <Field label={L('Rete virtuale', 'Virtual network')} htmlFor="dl-v">
          {vnets.error ? <ErrorNotice error={vnets.error} onRetry={vnets.reload} /> : !vnets.data ? <Skeleton rows={1} /> : (
            <Select id="dl-v" value={form.vnet} onChange={(e) => { const v = vnets.data!.find((x) => x.id === e.target.value); setForm({ ...form, vnet: e.target.value, name: form.name || (v ? `${v.name}-link` : '') }); }}>
              <option value="">—</option>
              {vnets.data.map((v) => <option key={v.id} value={v.id} disabled={linked.has(v.id.toLowerCase())}>{v.name} · {v.id.split('/')[4]}{linked.has(v.id.toLowerCase()) ? ` — ${L('già collegata', 'already linked')}` : ''}</option>)}
            </Select>
          )}
        </Field>
        <Field label={L('Nome del collegamento', 'Link name')} htmlFor="dl-n"><Input id="dl-n" className="mono" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Switch checked={form.registration} onChange={(v) => setForm({ ...form, registration: v })} label={L('Registra automaticamente le VM della rete in questa zona', 'Auto-register the network\'s VMs in this zone')} />
        {form.registration && <p className="small muted">{L('Una rete può registrarsi automaticamente in una sola zona privata.', 'A network can auto-register in one private zone only.')}</p>}
      </Panel>
    </Card>
  );
}
