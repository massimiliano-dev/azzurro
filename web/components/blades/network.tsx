'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeftRight, Link2, Network, Pencil, Plus, Route, Shield, Trash2, Unlink } from 'lucide-react';
import { arm } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { resourceHref } from '@/lib/arm';
import { Badge, Button, Card, Checkbox, Empty, ErrorNotice, Field, Input, Notice, Select, Skeleton, Switch } from '../ui';
import { Panel, useConfirm, useToast } from '../overlay';
import { useL } from './common';

export const NET_API = '2024-01-01';
const SUBS_API = '2022-12-01';
const nameOf = (id?: string) => id?.split('/').pop() ?? '';
const subOf = (id: string) => id.split('/')[2];
const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

// ---------------- indirizzi IPv4 ----------------

export interface Cidr { lo: number; hi: number; len: number; text: string }
/** CIDR IPv4 valido con i bit host a zero; null altrimenti. */
export function parseCidr(text: string): Cidr | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(text.trim());
  if (!m) return null;
  const o = m.slice(1, 5).map(Number);
  const len = Number(m[5]);
  if (o.some((x) => x > 255) || len > 32) return null;
  const ip = ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
  const size = 2 ** (32 - len);
  if (ip % size !== 0) return null;
  return { lo: ip, hi: ip + size - 1, len, text: text.trim() };
}
const ipText = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
const overlaps = (a: Cidr, b: Cidr) => a.lo <= b.hi && b.lo <= a.hi;
const within = (a: Cidr, b: Cidr) => a.lo >= b.lo && a.hi <= b.hi;
const isIp = (s: string) => /^(\d{1,3}\.){3}\d{1,3}$/.test(s) && s.split('.').every((x) => Number(x) <= 255);
const prefixesOf = (p: any): string[] => (p?.addressPrefixes?.length ? p.addressPrefixes : p?.addressPrefix ? [p.addressPrefix] : []);

/** Primo blocco libero della lunghezza data dentro lo spazio di indirizzi. */
function nextFree(space: string[], used: string[], len: number): string {
  const taken = used.map(parseCidr).filter(Boolean) as Cidr[];
  for (const s of space.map(parseCidr).filter(Boolean) as Cidr[]) {
    if (len < s.len) continue;
    const size = 2 ** (32 - len);
    for (let lo = s.lo; lo + size - 1 <= s.hi; lo += size) {
      const c: Cidr = { lo, hi: lo + size - 1, len, text: `${ipText(lo)}/${len}` };
      if (!taken.some((t) => overlaps(t, c))) return c.text;
    }
  }
  return '';
}

/** Risorse di un tipo in tutte le sottoscrizioni leggibili (per peering, link DNS, associazioni). */
async function listEverywhere(type: string, apiVersion: string): Promise<any[]> {
  const subs = (await arm.get<{ value: any[] }>('/subscriptions', SUBS_API)).value;
  const all = await Promise.all(subs.map((s) => arm.get<{ value: any[] }>(`/subscriptions/${s.subscriptionId}/providers/${type}`, apiVersion).then((r) => r.value).catch(() => [])));
  return all.flat();
}
const listInSub = async (sub: string, type: string, apiVersion = NET_API) => (await arm.get<{ value: any[] }>(`/subscriptions/${sub}/providers/${type}`, apiVersion)).value;

/** Corpo per un PUT completo a partire dal GET (Azure accetta solo i tag in PATCH sulle risorse di rete). */
function putBody(r: any, properties: any) {
  return { location: r.location, tags: r.tags, ...(r.sku ? { sku: r.sku } : {}), ...(r.zones ? { zones: r.zones } : {}), properties };
}

// ---------------- rete virtuale ----------------

/** Spazio di indirizzi e server DNS della rete virtuale. */
export function VnetAddressSpace({ id, vnet, reload }: { id: string; vnet: any; reload: () => void }) {
  const L = useL();
  const toast = useToast();
  const [space, setSpace] = useState<string[]>([]);
  const [dnsMode, setDnsMode] = useState<'azure' | 'custom'>('azure');
  const [dns, setDns] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const reset = () => {
    setSpace([...(vnet.properties?.addressSpace?.addressPrefixes ?? [])]);
    const servers: string[] = vnet.properties?.dhcpOptions?.dnsServers ?? [];
    setDnsMode(servers.length ? 'custom' : 'azure');
    setDns(servers.length ? [...servers] : ['']);
  };
  useEffect(reset, [vnet]); // eslint-disable-line react-hooks/exhaustive-deps
  const subnets: any[] = vnet.properties?.subnets ?? [];
  const parsed = space.map((s) => parseCidr(s));
  const errors = space.map((s, i) => {
    if (!parsed[i]) return L('CIDR non valido: usa l\'indirizzo di rete, es. 10.1.0.0/16', 'Invalid CIDR: use the network address, e.g. 10.1.0.0/16');
    const clash = parsed.findIndex((p, j) => j !== i && p && overlaps(p, parsed[i]!));
    return clash >= 0 ? L(`Si sovrappone a ${space[clash]}`, `Overlaps ${space[clash]}`) : undefined;
  });
  const orphans = subnets.filter((s) => prefixesOf(s.properties).some((p) => { const c = parseCidr(p); return c && !parsed.some((x) => x && within(c, x)); }));
  const dnsBad = dnsMode === 'custom' && (dns.filter(Boolean).length === 0 || dns.some((d) => d && !isIp(d)));
  const dirty = JSON.stringify(space) !== JSON.stringify(vnet.properties?.addressSpace?.addressPrefixes ?? []) || JSON.stringify(dnsMode === 'custom' ? dns.filter(Boolean) : []) !== JSON.stringify(vnet.properties?.dhcpOptions?.dnsServers ?? []);
  const save = async () => {
    setBusy(true);
    try {
      const fresh = await arm.get<any>(id, NET_API);
      await arm.put(id, putBody(fresh, { ...fresh.properties, addressSpace: { addressPrefixes: space }, dhcpOptions: { dnsServers: dnsMode === 'custom' ? dns.filter(Boolean) : [] } }), NET_API);
      toast.ok(L('Rete virtuale aggiornata', 'Virtual network updated'));
      reload();
    } catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card title={L('Spazio di indirizzi', 'Address space')}>
        <div className="stack" style={{ gap: 8 }}>
          {space.map((s, i) => {
            const inside = subnets.filter((sn) => prefixesOf(sn.properties).some((p) => { const c = parseCidr(p); return c && parsed[i] && within(c, parsed[i]!); }));
            return (
              <div className="kv-edit three" key={i}>
                <Input className="mono" aria-label={L('Prefisso', 'Prefix')} value={s} invalid={!!errors[i]} onChange={(e) => setSpace(space.map((x, j) => (j === i ? e.target.value : x)))} />
                <span className="small muted">{errors[i] ?? (parsed[i] ? `${ipText(parsed[i]!.lo)} – ${ipText(parsed[i]!.hi)} · ${(parsed[i]!.hi - parsed[i]!.lo + 1).toLocaleString()} ${L('indirizzi', 'addresses')}${inside.length ? ` · ${inside.length} subnet` : ''}` : '')}</span>
                <span />
                <Button size="sm" variant="ghost" icon={Trash2} aria-label={L('Rimuovi', 'Remove')} disabled={space.length === 1 || inside.length > 0} title={inside.length ? L('Contiene subnet', 'Contains subnets') : undefined} onClick={() => setSpace(space.filter((_, j) => j !== i))} />
              </div>
            );
          })}
          <div><Button size="sm" icon={Plus} onClick={() => setSpace([...space, ''])}>{L('Aggiungi spazio di indirizzi', 'Add address space')}</Button></div>
          {orphans.length > 0 && <Notice tone="bad">{L(`Le subnet ${orphans.map((o) => o.name).join(', ')} resterebbero fuori dallo spazio di indirizzi.`, `Subnets ${orphans.map((o) => o.name).join(', ')} would fall outside the address space.`)}</Notice>}
        </div>
      </Card>
      <Card title={L('Server DNS', 'DNS servers')}>
        <div className="seg mb-16">
          <button type="button" className={dnsMode === 'azure' ? 'on' : ''} onClick={() => setDnsMode('azure')}>{L('Predefinito (fornito da Azure)', 'Default (Azure-provided)')}</button>
          <button type="button" className={dnsMode === 'custom' ? 'on' : ''} onClick={() => setDnsMode('custom')}>{L('Personalizzato', 'Custom')}</button>
        </div>
        {dnsMode === 'custom' ? (
          <div className="stack" style={{ gap: 8 }}>
            {dns.map((d, i) => (
              <div className="row" key={i}>
                <Input className="mono" aria-label={L('Indirizzo IP del server DNS', 'DNS server IP address')} placeholder="10.0.0.4" value={d} invalid={!!d && !isIp(d)} onChange={(e) => setDns(dns.map((x, j) => (j === i ? e.target.value : x)))} />
                <Button size="sm" variant="ghost" icon={Trash2} aria-label={L('Rimuovi', 'Remove')} disabled={dns.length === 1} onClick={() => setDns(dns.filter((_, j) => j !== i))} />
              </div>
            ))}
            <div><Button size="sm" icon={Plus} onClick={() => setDns([...dns, ''])}>{L('Aggiungi server', 'Add server')}</Button></div>
            <p className="small muted" style={{ margin: 0 }}>{L('Le VM prendono i nuovi server al rinnovo del lease DHCP o al riavvio.', 'VMs pick up new servers when they renew their DHCP lease or restart.')}</p>
          </div>
        ) : <p className="muted" style={{ margin: 0 }}>{L('Le risorse usano il DNS di Azure (168.63.129.16), che risolve anche le zone DNS private collegate.', 'Resources use Azure DNS (168.63.129.16), which also resolves linked private DNS zones.')}</p>}
      </Card>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button disabled={!dirty || busy} onClick={reset}>{L('Annulla', 'Cancel')}</Button>
        <Button variant="primary" loading={busy} disabled={!dirty || errors.some(Boolean) || orphans.length > 0 || dnsBad} onClick={() => void save()}>{L('Salva', 'Save')}</Button>
      </div>
    </div>
  );
}

const SERVICE_ENDPOINTS = ['Microsoft.Storage', 'Microsoft.Sql', 'Microsoft.KeyVault', 'Microsoft.AzureCosmosDB', 'Microsoft.ServiceBus', 'Microsoft.EventHub', 'Microsoft.Web', 'Microsoft.ContainerRegistry', 'Microsoft.CognitiveServices'];
const DELEGATIONS: [string, string, string][] = [
  ['Microsoft.Web/serverFarms', 'App Service (integrazione VNet)', 'App Service (VNet integration)'],
  ['Microsoft.App/environments', 'Ambiente Container Apps', 'Container Apps environment'],
  ['Microsoft.DBforPostgreSQL/flexibleServers', 'PostgreSQL server flessibile', 'PostgreSQL flexible server'],
  ['Microsoft.DBforMySQL/flexibleServers', 'MySQL server flessibile', 'MySQL flexible server'],
  ['Microsoft.ContainerInstance/containerGroups', 'Istanze di contenitore', 'Container instances'],
  ['Microsoft.Sql/managedInstances', 'Istanza gestita SQL', 'SQL managed instance'],
  ['Microsoft.Network/dnsResolvers', 'Resolver DNS privato', 'Private DNS resolver'],
];

/** Subnet: prefisso, associazioni (NSG, tabella di route, gateway NAT), endpoint di servizio e delega. */
export function VnetSubnets({ id, vnet, reload }: { id: string; vnet: any; reload: () => void }) {
  const L = useL();
  const toast = useToast();
  const confirm = useConfirm();
  const subnets: any[] = vnet.properties?.subnets ?? [];
  const space: string[] = vnet.properties?.addressSpace?.addressPrefixes ?? [];
  const sub = subOf(id);
  const opts = useAsync(async () => {
    const [nsgs, rts, nats] = await Promise.all([listInSub(sub, 'Microsoft.Network/networkSecurityGroups'), listInSub(sub, 'Microsoft.Network/routeTables'), listInSub(sub, 'Microsoft.Network/natGateways')]);
    const here = (x: any) => x.location === vnet.location;
    return { nsgs: nsgs.filter(here), rts: rts.filter(here), nats: nats.filter(here) };
  }, [sub, vnet.location]);
  const blank = { name: '', prefix: '', nsg: '', rt: '', nat: '', endpoints: [] as string[], delegation: '' };
  const [form, setForm] = useState(blank);
  const [editing, setEditing] = useState<any | null | undefined>(undefined); // undefined = chiuso, null = nuova
  const [busy, setBusy] = useState(false);
  const open = (s: any | null) => {
    setEditing(s);
    setForm(s ? {
      name: s.name, prefix: prefixesOf(s.properties)[0] ?? '', nsg: s.properties?.networkSecurityGroup?.id ?? '', rt: s.properties?.routeTable?.id ?? '', nat: s.properties?.natGateway?.id ?? '',
      endpoints: (s.properties?.serviceEndpoints ?? []).map((e: any) => e.service), delegation: s.properties?.delegations?.[0]?.properties?.serviceName ?? '',
    } : { ...blank, prefix: nextFree(space, subnets.flatMap((x) => prefixesOf(x.properties)), 24) || nextFree(space, subnets.flatMap((x) => prefixesOf(x.properties)), 27) });
  };
  const c = parseCidr(form.prefix);
  const others = subnets.filter((s) => !editing || s.name !== editing.name);
  const clash = c && others.find((s) => prefixesOf(s.properties).some((p) => { const o = parseCidr(p); return o && overlaps(o, c); }));
  const prefixErr = !form.prefix ? undefined
    : !c ? L('CIDR non valido: usa l\'indirizzo di rete, es. 10.0.1.0/24', 'Invalid CIDR: use the network address, e.g. 10.0.1.0/24')
    : c.len > 29 ? L('La subnet più piccola è /29', 'The smallest subnet is /29')
    : !space.some((s) => { const p = parseCidr(s); return p && within(c, p); }) ? L('Fuori dallo spazio di indirizzi della rete', 'Outside the network address space')
    : clash ? L(`Si sovrappone alla subnet ${clash.name}`, `Overlaps subnet ${clash.name}`) : undefined;
  const nameErr = !form.name ? undefined : !/^[a-zA-Z0-9][\w.-]{0,78}[\w]$|^[a-zA-Z0-9]$/.test(form.name) ? L('Lettere, numeri, punti, trattini e trattini bassi', 'Letters, digits, dots, hyphens and underscores') : !editing && subnets.some((s) => s.name.toLowerCase() === form.name.toLowerCase()) ? L('Esiste già una subnet con questo nome', 'A subnet with this name already exists') : undefined;
  const save = async () => {
    setBusy(true);
    try {
      const props: any = { ...(editing?.properties ?? {}) };
      for (const k of ['provisioningState', 'ipConfigurations', 'purpose']) delete props[k];
      delete props.addressPrefixes;
      props.addressPrefix = form.prefix;
      const ref = (v: string) => (v ? { id: v } : undefined);
      props.networkSecurityGroup = ref(form.nsg);
      props.routeTable = ref(form.rt);
      props.natGateway = ref(form.nat);
      props.serviceEndpoints = form.endpoints.map((service) => ({ service, locations: ['*'] }));
      props.delegations = form.delegation ? [{ name: form.delegation.split('/').pop()!.toLowerCase(), properties: { serviceName: form.delegation } }] : [];
      for (const k of ['networkSecurityGroup', 'routeTable', 'natGateway']) if (!props[k]) delete props[k];
      await arm.put(`${id}/subnets/${form.name}`, { properties: props }, NET_API);
      toast.ok(editing ? L('Subnet aggiornata', 'Subnet updated') : L('Subnet creata', 'Subnet created'), form.name);
      setEditing(undefined);
      reload();
    } catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  const remove = async (s: any) => {
    if (!(await confirm({ title: L(`Eliminare la subnet ${s.name}?`, `Delete subnet ${s.name}?`), text: L('Azure la elimina solo se non contiene risorse.', 'Azure deletes it only if it contains no resources.'), danger: true, confirmLabel: L('Elimina', 'Delete') }))) return;
    try { await arm.del(`${id}/subnets/${s.name}`, NET_API); toast.ok(L('Subnet eliminata', 'Subnet deleted'), s.name); reload(); } catch (e) { toast.error(e); }
  };
  const free = (s: any) => {
    const p = parseCidr(prefixesOf(s.properties)[0] ?? '');
    return p ? p.hi - p.lo + 1 - 5 - (s.properties?.ipConfigurations?.length ?? 0) : null;
  };
  return (
    <Card title={L('Subnet', 'Subnets')} actions={<Button size="sm" icon={Plus} onClick={() => open(null)}>{L('Subnet', 'Subnet')}</Button>}>
      {subnets.length === 0 ? <Empty icon={Network} title={L('Nessuna subnet', 'No subnets')} text={L('Le risorse si collegano a una subnet: creane almeno una.', 'Resources connect to a subnet: create at least one.')} /> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>{L('Nome', 'Name')}</th><th>{L('Prefisso', 'Prefix')}</th><th>{L('IP liberi', 'Free IPs')}</th><th>NSG</th><th>{L('Tabella di route', 'Route table')}</th><th>{L('Delega', 'Delegation')}</th><th>{L('Endpoint di servizio', 'Service endpoints')}</th><th /></tr></thead>
          <tbody>{subnets.map((s) => (
            <tr key={s.id ?? s.name}>
              <td className="mono">{s.name}</td>
              <td className="mono">{prefixesOf(s.properties).join(', ')}</td>
              <td className="mono">{free(s) ?? '—'}{s.properties?.ipConfigurations?.length ? <div className="small muted">{s.properties.ipConfigurations.length} {L('in uso', 'in use')}</div> : null}</td>
              <td>{s.properties?.networkSecurityGroup?.id ? <Link className="mono" href={resourceHref(s.properties.networkSecurityGroup.id)}>{nameOf(s.properties.networkSecurityGroup.id)}</Link> : <span className="muted">—</span>}</td>
              <td>{s.properties?.routeTable?.id ? <Link className="mono" href={resourceHref(s.properties.routeTable.id)}>{nameOf(s.properties.routeTable.id)}</Link> : <span className="muted">—</span>}</td>
              <td className="small">{s.properties?.delegations?.[0]?.properties?.serviceName ?? <span className="muted">—</span>}</td>
              <td className="small">{(s.properties?.serviceEndpoints ?? []).map((e: any) => e.service.replace('Microsoft.', '')).join(', ') || <span className="muted">—</span>}</td>
              <td><div className="row" style={{ gap: 2, justifyContent: 'flex-end' }}>
                <Button size="sm" variant="ghost" icon={Pencil} aria-label={L('Modifica', 'Edit')} onClick={() => open(s)} />
                <Button size="sm" variant="ghost" icon={Trash2} aria-label={L('Elimina', 'Delete')} onClick={() => void remove(s)} />
              </div></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      <Panel open={editing !== undefined} onClose={() => setEditing(undefined)} title={editing ? L(`Subnet ${editing.name}`, `Subnet ${editing.name}`) : L('Nuova subnet', 'New subnet')}
        footer={<><Button onClick={() => setEditing(undefined)}>{L('Annulla', 'Cancel')}</Button><Button variant="primary" loading={busy} disabled={!form.name || !!nameErr || !c || !!prefixErr} onClick={() => void save()}>{editing ? L('Salva', 'Save') : L('Crea', 'Create')}</Button></>}>
        <Field label={L('Nome', 'Name')} htmlFor="sn-n" error={nameErr} hint={L('Nomi riservati: GatewaySubnet, AzureBastionSubnet, AzureFirewallSubnet.', 'Reserved names: GatewaySubnet, AzureBastionSubnet, AzureFirewallSubnet.')}>
          <Input id="sn-n" className="mono" list="sn-special" disabled={!!editing} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <datalist id="sn-special">{['default', 'GatewaySubnet', 'AzureBastionSubnet', 'AzureFirewallSubnet'].map((n) => <option key={n} value={n} />)}</datalist>
        </Field>
        <Field label={L('Intervallo di indirizzi', 'Address range')} htmlFor="sn-p" error={prefixErr} hint={c && !prefixErr ? `${ipText(c.lo)} – ${ipText(c.hi)} · ${c.hi - c.lo + 1 - 5} ${L('indirizzi utilizzabili (Azure ne riserva 5)', 'usable addresses (Azure reserves 5)')}` : `${L('Spazio della rete', 'Network space')}: ${space.join(', ')}`}>
          <Input id="sn-p" className="mono" value={form.prefix} onChange={(e) => setForm({ ...form, prefix: e.target.value })} invalid={!!prefixErr} />
        </Field>
        {opts.error ? <ErrorNotice error={opts.error} onRetry={opts.reload} /> : (
          <>
            <Field label={L('Gruppo di sicurezza di rete', 'Network security group')} htmlFor="sn-nsg"><Select id="sn-nsg" value={form.nsg} onChange={(e) => setForm({ ...form, nsg: e.target.value })}><option value="">{L('Nessuno', 'None')}</option>{opts.data?.nsgs.map((x) => <option key={x.id} value={x.id}>{x.name} · {x.id.split('/')[4]}</option>)}</Select></Field>
            <Field label={L('Tabella di route', 'Route table')} htmlFor="sn-rt"><Select id="sn-rt" value={form.rt} onChange={(e) => setForm({ ...form, rt: e.target.value })}><option value="">{L('Nessuna', 'None')}</option>{opts.data?.rts.map((x) => <option key={x.id} value={x.id}>{x.name} · {x.id.split('/')[4]}</option>)}</Select></Field>
            <Field label={L('Gateway NAT', 'NAT gateway')} htmlFor="sn-nat" hint={L('Tutto il traffico in uscita verso Internet usa gli IP pubblici del gateway.', 'All outbound Internet traffic uses the gateway\'s public IPs.')}><Select id="sn-nat" value={form.nat} onChange={(e) => setForm({ ...form, nat: e.target.value })}><option value="">{L('Nessuno', 'None')}</option>{opts.data?.nats.map((x) => <option key={x.id} value={x.id}>{x.name} · {x.id.split('/')[4]}</option>)}</Select></Field>
          </>
        )}
        <Field label={L('Delega a un servizio', 'Delegate to a service')} htmlFor="sn-del" hint={L('Una subnet delegata può ospitare solo quel servizio.', 'A delegated subnet can host only that service.')}>
          <Select id="sn-del" value={form.delegation} onChange={(e) => setForm({ ...form, delegation: e.target.value })}><option value="">{L('Nessuna', 'None')}</option>{DELEGATIONS.map(([v, it, en]) => <option key={v} value={v}>{L(it, en)}</option>)}</Select>
        </Field>
        <Field label={L('Endpoint di servizio', 'Service endpoints')}>
          <div className="grid cols-2" style={{ gap: 4 }}>{SERVICE_ENDPOINTS.map((se) => (
            <Checkbox key={se} label={<span className="mono small">{se}</span>} checked={form.endpoints.includes(se)} onChange={(on) => setForm({ ...form, endpoints: on ? [...form.endpoints, se] : form.endpoints.filter((x) => x !== se) })} />
          ))}</div>
        </Field>
      </Panel>
    </Card>
  );
}

const peerTone = (s?: string) => (s === 'Connected' ? 'ok' : s === 'Initiated' ? 'warn' : 'bad');

/** Peering verso altre reti virtuali, anche in altre sottoscrizioni, in una o in entrambe le direzioni. */
export function VnetPeerings({ id, vnet, reload }: { id: string; vnet: any; reload: () => void }) {
  const L = useL();
  const toast = useToast();
  const confirm = useConfirm();
  const peerings: any[] = vnet.properties?.virtualNetworkPeerings ?? [];
  const [open, setOpen] = useState(false);
  const remotes = useAsync(async () => (open ? (await listEverywhere('Microsoft.Network/virtualNetworks', NET_API)).filter((v) => !same(v.id, id)) : []), [open, id]);
  const [form, setForm] = useState({ name: '', remote: '', reverse: true, reverseName: '', access: true, forwarded: false, transit: false, remoteGw: false });
  const [busy, setBusy] = useState(false);
  const mine = (vnet.properties?.addressSpace?.addressPrefixes ?? []).map(parseCidr).filter(Boolean) as Cidr[];
  const conflict = (v: any) => {
    const theirs = (v.properties?.addressSpace?.addressPrefixes ?? []).map(parseCidr).filter(Boolean) as Cidr[];
    const hit = mine.flatMap((a) => theirs.filter((b) => overlaps(a, b)).map((b) => `${a.text} ↔ ${b.text}`));
    return hit.length ? hit.join(', ') : peerings.some((p) => same(p.properties?.remoteVirtualNetwork?.id, v.id)) ? L('già collegata', 'already peered') : '';
  };
  const remote = remotes.data?.find((v) => v.id === form.remote);
  const create = async () => {
    setBusy(true);
    try {
      await arm.put(`${id}/virtualNetworkPeerings/${form.name}`, { properties: { remoteVirtualNetwork: { id: form.remote }, allowVirtualNetworkAccess: form.access, allowForwardedTraffic: form.forwarded, allowGatewayTransit: form.transit, useRemoteGateways: form.remoteGw } }, NET_API);
      if (form.reverse) {
        await arm.put(`${form.remote}/virtualNetworkPeerings/${form.reverseName}`, { properties: { remoteVirtualNetwork: { id }, allowVirtualNetworkAccess: form.access, allowForwardedTraffic: form.forwarded, allowGatewayTransit: false, useRemoteGateways: false } }, NET_API);
      }
      toast.ok(L('Peering creato', 'Peering created'), form.reverse ? L('in entrambe le direzioni', 'in both directions') : form.name);
      setOpen(false);
      reload();
    } catch (e) { toast.error(e); reload(); }
    finally { setBusy(false); }
  };
  const remove = async (p: any) => {
    if (!(await confirm({ title: L(`Eliminare il peering ${p.name}?`, `Delete peering ${p.name}?`), text: L('Il traffico tra le due reti si interrompe subito. Il peering nella direzione opposta resta, in stato Disconnesso.', 'Traffic between the two networks stops at once. The peering in the opposite direction stays, as Disconnected.'), danger: true, confirmLabel: L('Elimina', 'Delete') }))) return;
    try { await arm.del(`${id}/virtualNetworkPeerings/${p.name}`, NET_API); reload(); } catch (e) { toast.error(e); }
  };
  const nameOk = (n: string) => /^[a-zA-Z0-9][\w.-]{0,78}$/.test(n);
  return (
    <Card title={L('Peering', 'Peerings')} actions={<Button size="sm" icon={Plus} onClick={() => { setForm({ name: `${vnet.name}-to-`, remote: '', reverse: true, reverseName: '', access: true, forwarded: false, transit: false, remoteGw: false }); setOpen(true); }}>{L('Peering', 'Peering')}</Button>}>
      {peerings.length === 0 ? <Empty icon={ArrowLeftRight} title={L('Nessun peering', 'No peerings')} text={L('Collega questa rete ad altre reti virtuali: il traffico resta sulla rete Microsoft.', 'Connect this network to other virtual networks: traffic stays on the Microsoft network.')} /> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>{L('Nome', 'Name')}</th><th>{L('Rete remota', 'Remote network')}</th><th>{L('Stato', 'State')}</th><th>{L('Spazio remoto', 'Remote space')}</th><th>{L('Traffico inoltrato', 'Forwarded traffic')}</th><th /></tr></thead>
          <tbody>{peerings.map((p) => (
            <tr key={p.id ?? p.name}>
              <td className="mono">{p.name}</td>
              <td><Link className="mono" href={resourceHref(p.properties?.remoteVirtualNetwork?.id ?? '')}>{nameOf(p.properties?.remoteVirtualNetwork?.id)}</Link>{subOf(p.properties?.remoteVirtualNetwork?.id ?? '') !== subOf(id) && <span className="small muted"> · {L('altra sottoscrizione', 'other subscription')}</span>}</td>
              <td><Badge tone={peerTone(p.properties?.peeringState)}>{p.properties?.peeringState ?? '—'}</Badge>{p.properties?.peeringState === 'Initiated' && <div className="small muted">{L('Manca il peering inverso', 'Reverse peering missing')}</div>}</td>
              <td className="mono small">{(p.properties?.remoteAddressSpace?.addressPrefixes ?? []).join(', ')}</td>
              <td>{p.properties?.allowForwardedTraffic ? L('Consentito', 'Allowed') : L('Bloccato', 'Blocked')}</td>
              <td><Button size="sm" variant="ghost" icon={Trash2} aria-label={L('Elimina', 'Delete')} onClick={() => void remove(p)} /></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      <Panel open={open} onClose={() => setOpen(false)} title={L('Nuovo peering', 'New peering')} wide
        footer={<><Button onClick={() => setOpen(false)}>{L('Annulla', 'Cancel')}</Button><Button variant="primary" loading={busy} disabled={!nameOk(form.name) || !form.remote || !!(remote && conflict(remote)) || (form.reverse && !nameOk(form.reverseName))} onClick={() => void create()}>{L('Crea', 'Create')}</Button></>}>
        <Field label={L('Rete virtuale remota', 'Remote virtual network')} htmlFor="pr-r" hint={L('Gli spazi di indirizzi delle due reti non devono sovrapporsi.', 'The two networks\' address spaces must not overlap.')}>
          {remotes.error ? <ErrorNotice error={remotes.error} onRetry={remotes.reload} /> : !remotes.data ? <Skeleton rows={1} /> : (
            <Select id="pr-r" value={form.remote} onChange={(e) => { const v = remotes.data!.find((x) => x.id === e.target.value); setForm({ ...form, remote: e.target.value, name: v ? `${vnet.name}-to-${v.name}` : form.name, reverseName: v ? `${v.name}-to-${vnet.name}` : '' }); }}>
              <option value="">—</option>
              {remotes.data.map((v) => { const why = conflict(v); return <option key={v.id} value={v.id} disabled={!!why}>{v.name} · {v.id.split('/')[4]} · {(v.properties?.addressSpace?.addressPrefixes ?? []).join(', ')}{why ? ` — ${why}` : ''}</option>; })}
            </Select>
          )}
        </Field>
        <Field label={L('Nome del peering', 'Peering name')} htmlFor="pr-n"><Input id="pr-n" className="mono" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} invalid={!!form.name && !nameOk(form.name)} /></Field>
        <Checkbox checked={form.reverse} onChange={(v) => setForm({ ...form, reverse: v })} label={L('Crea anche il peering dalla rete remota (serve per far passare il traffico)', 'Also create the peering from the remote network (traffic needs both)')} />
        {form.reverse && <Field label={L('Nome del peering inverso', 'Reverse peering name')} htmlFor="pr-rn"><Input id="pr-rn" className="mono" value={form.reverseName} onChange={(e) => setForm({ ...form, reverseName: e.target.value })} invalid={!!form.reverseName && !nameOk(form.reverseName)} /></Field>}
        <div className="stack mt-16" style={{ gap: 8 }}>
          <Switch checked={form.access} onChange={(v) => setForm({ ...form, access: v })} label={L('Consenti l\'accesso tra le reti', 'Allow access between the networks')} />
          <Switch checked={form.forwarded} onChange={(v) => setForm({ ...form, forwarded: v })} label={L('Consenti il traffico inoltrato (da NVA o hub)', 'Allow forwarded traffic (from an NVA or hub)')} />
          <Switch checked={form.transit} onChange={(v) => { setForm({ ...form, transit: v, remoteGw: v ? false : form.remoteGw }); }} label={L('Permetti alla rete remota di usare il gateway di questa rete', 'Let the remote network use this network\'s gateway')} />
          <Switch checked={form.remoteGw} onChange={(v) => setForm({ ...form, remoteGw: v, transit: v ? false : form.transit })} label={L('Usa il gateway della rete remota', 'Use the remote network\'s gateway')} />
        </div>
      </Panel>
    </Card>
  );
}

// ---------------- associazioni alle subnet (NSG, tabella di route, gateway NAT) ----------------

type AssocKey = 'networkSecurityGroup' | 'routeTable' | 'natGateway';

/** Subnet associate alla risorsa, con associazione e dissociazione. */
export function SubnetAssociations({ id, r, kind, reload }: { id: string; r: any; kind: AssocKey; reload: () => void }) {
  const L = useL();
  const toast = useToast();
  const confirm = useConfirm();
  const linked: string[] = (r.properties?.subnets ?? []).map((s: any) => s.id);
  const nics: string[] = kind === 'networkSecurityGroup' ? (r.properties?.networkInterfaces ?? []).map((n: any) => n.id) : [];
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const candidates = useAsync(async () => {
    if (!open) return [];
    const vnets = (await listInSub(subOf(id), 'Microsoft.Network/virtualNetworks')).filter((v) => v.location === r.location);
    return vnets.flatMap((v) => (v.properties?.subnets ?? []).filter((s: any) => !same(s.properties?.[kind]?.id, id) && !['GatewaySubnet', 'AzureFirewallSubnet'].includes(s.name)).map((s: any) => ({ ...s, vnet: v.name, current: s.properties?.[kind]?.id as string | undefined })));
  }, [open, id, r.location]);
  const setOn = async (subnetId: string, value: string | null) => {
    const s = await arm.get<any>(subnetId, NET_API);
    const props = { ...s.properties };
    for (const k of ['provisioningState', 'ipConfigurations', 'purpose']) delete props[k];
    if (value) props[kind] = { id: value }; else delete props[kind];
    await arm.put(subnetId, { properties: props }, NET_API);
  };
  const associate = async () => {
    setBusy(true);
    try { await setOn(target, id); toast.ok(L('Subnet associata', 'Subnet associated'), nameOf(target)); setOpen(false); reload(); }
    catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  const dissociate = async (subnetId: string) => {
    if (!(await confirm({ title: L(`Dissociare ${nameOf(subnetId)}?`, `Dissociate ${nameOf(subnetId)}?`), confirmLabel: L('Dissocia', 'Dissociate'), danger: kind === 'networkSecurityGroup', text: kind === 'networkSecurityGroup' ? L('Senza NSG, la subnet lascia passare tutto il traffico consentito dalle altre regole.', 'Without an NSG the subnet lets through all traffic the other rules allow.') : undefined }))) return;
    try { await setOn(subnetId, null); reload(); } catch (e) { toast.error(e); }
  };
  const chosen = candidates.data?.find((c) => c.id === target);
  return (
    <Card title={L('Associazioni', 'Associations')} actions={<Button size="sm" icon={Link2} onClick={() => { setTarget(''); setOpen(true); }}>{L('Associa subnet', 'Associate subnet')}</Button>}>
      {linked.length === 0 && nics.length === 0 ? <p className="muted" style={{ margin: 0 }}>{L('Non è associata a nessuna subnet: per ora non ha effetto.', 'Not associated with any subnet: it has no effect yet.')}</p> : (
        <div className="stack" style={{ gap: 6 }}>
          {linked.map((s) => (
            <div className="row" key={s}><Badge>subnet</Badge><Link className="mono" href={resourceHref(s.split('/subnets/')[0])}>{nameOf(s.split('/subnets/')[0])} / {nameOf(s)}</Link><span className="spacer" /><Button size="sm" variant="ghost" icon={Unlink} onClick={() => void dissociate(s)}>{L('Dissocia', 'Dissociate')}</Button></div>
          ))}
          {nics.map((n) => <div className="row" key={n}><Badge tone="info">NIC</Badge><Link className="mono" href={resourceHref(n)}>{nameOf(n)}</Link></div>)}
        </div>
      )}
      <Panel open={open} onClose={() => setOpen(false)} title={L('Associa una subnet', 'Associate a subnet')}
        footer={<><Button onClick={() => setOpen(false)}>{L('Annulla', 'Cancel')}</Button><Button variant="primary" loading={busy} disabled={!target} onClick={() => void associate()}>{L('Associa', 'Associate')}</Button></>}>
        {candidates.error ? <ErrorNotice error={candidates.error} onRetry={candidates.reload} /> : !candidates.data ? <Skeleton rows={2} /> : candidates.data.length === 0 ? <Notice>{L(`Nessuna subnet disponibile nelle reti di ${r.location}.`, `No subnets available in networks in ${r.location}.`)}</Notice> : (
          <Field label={L('Subnet (stessa area geografica)', 'Subnet (same region)')} htmlFor="as-s">
            <Select id="as-s" value={target} onChange={(e) => setTarget(e.target.value)}><option value="">—</option>{candidates.data.map((c) => <option key={c.id} value={c.id}>{c.vnet} / {c.name} · {prefixesOf(c.properties).join(', ')}</option>)}</Select>
          </Field>
        )}
        {chosen?.current && <Notice tone="warn">{L(`La subnet usa già ${nameOf(chosen.current)}: verrà sostituito.`, `The subnet already uses ${nameOf(chosen.current)}: it will be replaced.`)}</Notice>}
      </Panel>
    </Card>
  );
}

// ---------------- gruppo di sicurezza di rete ----------------

const SERVICE_TAGS = ['Internet', 'VirtualNetwork', 'AzureLoadBalancer', 'AzureCloud', 'Storage', 'Sql', 'AzureKeyVault', 'AzureMonitor', 'AppService', 'AzureFrontDoor.Backend', 'GatewayManager', 'AzureActiveDirectory', 'EventHub', 'ServiceBus', 'AzureContainerRegistry', 'AzureCosmosDB', 'AzureBastion'];
const PORT_PRESETS: [string, string][] = [['22', 'SSH'], ['3389', 'RDP'], ['80', 'HTTP'], ['443', 'HTTPS'], ['80,443', 'HTTP + HTTPS'], ['1433', 'SQL Server'], ['5432', 'PostgreSQL'], ['3306', 'MySQL'], ['6379-6380', 'Redis'], ['*', '*']];
const portOk = (v: string) => v === '*' || v.split(',').every((p) => /^\d{1,5}(-\d{1,5})?$/.test(p.trim()) && p.trim().split('-').every((n) => Number(n) <= 65535));
const addrOk = (v: string) => v === '*' || v.split(',').every((a) => { const x = a.trim(); return isIp(x) || !!parseCidr(x) || SERVICE_TAGS.includes(x) || /^[A-Za-z]+\.[A-Za-z0-9]+$/.test(x); });
const many = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);
const showList = (one?: string, list?: string[]) => one ?? (list ?? []).join(', ');

/** Regole in ingresso e in uscita: editor completo, regole predefinite in sola lettura. */
export function NsgRulesEditor({ id, nsg, reload }: { id: string; nsg: any; reload: () => void }) {
  const L = useL();
  const toast = useToast();
  const confirm = useConfirm();
  const rules: any[] = nsg.properties?.securityRules ?? [];
  const defaults: any[] = nsg.properties?.defaultSecurityRules ?? [];
  const blank = { name: '', direction: 'Inbound', priority: 300, access: 'Allow', protocol: 'Tcp', source: '*', sourcePorts: '*', dest: '*', destPorts: '443', description: '' };
  const [form, setForm] = useState(blank);
  const [editing, setEditing] = useState<any | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const used = (dir: string, except?: string) => new Set(rules.filter((r) => r.properties?.direction === dir && r.name !== except).map((r) => Number(r.properties.priority)));
  const freePrio = (dir: string) => { const u = used(dir); let p = 100; for (const r of rules) if (r.properties?.direction === dir) p = Math.max(p, Number(r.properties.priority) + 10); while (u.has(p)) p += 10; return Math.min(p, 4096); };
  const open = (r: any | null, direction = 'Inbound') => {
    setEditing(r);
    const p = r?.properties;
    setForm(r ? {
      name: r.name, direction: p.direction, priority: Number(p.priority), access: p.access, protocol: p.protocol,
      source: showList(p.sourceAddressPrefix, p.sourceAddressPrefixes), sourcePorts: showList(p.sourcePortRange, p.sourcePortRanges),
      dest: showList(p.destinationAddressPrefix, p.destinationAddressPrefixes), destPorts: showList(p.destinationPortRange, p.destinationPortRanges), description: p.description ?? '',
    } : { ...blank, direction, priority: freePrio(direction), destPorts: direction === 'Inbound' ? '443' : '*' });
  };
  const prioTaken = used(form.direction, editing?.name).has(form.priority);
  const errs = {
    name: form.name && !/^[a-zA-Z0-9][\w.-]{0,78}$/.test(form.name) ? L('Lettere, numeri, punti e trattini', 'Letters, digits, dots and hyphens') : !editing && rules.some((r) => r.name.toLowerCase() === form.name.toLowerCase()) ? L('Nome già usato', 'Name already used') : undefined,
    priority: form.priority < 100 || form.priority > 4096 ? L('Tra 100 e 4096', 'Between 100 and 4096') : prioTaken ? L('Priorità già usata in questa direzione', 'Priority already used in this direction') : undefined,
    source: addrOk(form.source) ? undefined : L('IP, CIDR o tag di servizio, separati da virgole', 'IPs, CIDRs or service tags, comma-separated'),
    dest: addrOk(form.dest) ? undefined : L('IP, CIDR o tag di servizio, separati da virgole', 'IPs, CIDRs or service tags, comma-separated'),
    sourcePorts: portOk(form.sourcePorts) ? undefined : L('Porte o intervalli 0-65535, separati da virgole', 'Ports or ranges 0-65535, comma-separated'),
    destPorts: portOk(form.destPorts) ? undefined : L('Porte o intervalli 0-65535, separati da virgole', 'Ports or ranges 0-65535, comma-separated'),
  };
  const risky = form.direction === 'Inbound' && form.access === 'Allow' && ['*', 'Internet', '0.0.0.0/0'].includes(form.source.trim()) && many(form.destPorts).some((p) => ['22', '3389', '*'].includes(p) || (p.includes('-') && Number(p.split('-')[0]) <= 3389 && Number(p.split('-')[1]) >= 22));
  const save = async () => {
    setBusy(true);
    const pair = (v: string, one: string, list: string) => (many(v).length > 1 ? { [list]: many(v), [one]: undefined } : { [one]: many(v)[0] ?? '*', [list]: [] });
    try {
      await arm.put(`${id}/securityRules/${form.name}`, {
        properties: {
          priority: form.priority, direction: form.direction, access: form.access, protocol: form.protocol, description: form.description || undefined,
          ...pair(form.source, 'sourceAddressPrefix', 'sourceAddressPrefixes'), ...pair(form.dest, 'destinationAddressPrefix', 'destinationAddressPrefixes'),
          ...pair(form.sourcePorts, 'sourcePortRange', 'sourcePortRanges'), ...pair(form.destPorts, 'destinationPortRange', 'destinationPortRanges'),
        },
      }, NET_API);
      toast.ok(editing ? L('Regola aggiornata', 'Rule updated') : L('Regola aggiunta', 'Rule added'), form.name);
      setEditing(undefined);
      reload();
    } catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  const remove = async (r: any) => {
    if (!(await confirm({ title: L(`Eliminare la regola ${r.name}?`, `Delete rule ${r.name}?`), danger: true, confirmLabel: L('Elimina', 'Delete') }))) return;
    try { await arm.del(`${id}/securityRules/${r.name}`, NET_API); reload(); } catch (e) { toast.error(e); }
  };
  const table = (dir: 'Inbound' | 'Outbound') => {
    const list = [...rules, ...defaults].filter((r) => r.properties?.direction === dir).sort((a, b) => a.properties.priority - b.properties.priority);
    return (
      <Card key={dir} title={dir === 'Inbound' ? L('Regole in ingresso', 'Inbound rules') : L('Regole in uscita', 'Outbound rules')} actions={<Button size="sm" icon={Plus} onClick={() => open(null, dir)}>{L('Regola', 'Rule')}</Button>}>
        <div className="table-wrap"><table className="table">
          <thead><tr><th>{L('Priorità', 'Priority')}</th><th>{L('Nome', 'Name')}</th><th>{L('Porta', 'Port')}</th><th>{L('Protocollo', 'Protocol')}</th><th>{L('Origine', 'Source')}</th><th>{L('Destinazione', 'Destination')}</th><th>{L('Azione', 'Action')}</th><th /></tr></thead>
          <tbody>{list.map((r) => {
            const custom = !String(r.type ?? '').toLowerCase().endsWith('/defaultsecurityrules') && !String(r.id ?? '').toLowerCase().includes('/defaultsecurityrules/');
            const p = r.properties;
            return (
              <tr key={r.id ?? r.name} className={custom ? undefined : 'muted'}>
                <td className="mono">{p.priority}</td>
                <td className="mono">{r.name}{!custom && <div className="small">{L('predefinita', 'default')}</div>}</td>
                <td className="mono">{showList(p.destinationPortRange, p.destinationPortRanges)}</td>
                <td>{p.protocol === '*' ? L('Qualsiasi', 'Any') : p.protocol}</td>
                <td className="mono small">{showList(p.sourceAddressPrefix, p.sourceAddressPrefixes)}</td>
                <td className="mono small">{showList(p.destinationAddressPrefix, p.destinationAddressPrefixes)}</td>
                <td><Badge tone={p.access === 'Allow' ? 'ok' : 'bad'}>{p.access === 'Allow' ? L('Consenti', 'Allow') : L('Nega', 'Deny')}</Badge></td>
                <td>{custom && <div className="row" style={{ gap: 2, justifyContent: 'flex-end' }}>
                  <Button size="sm" variant="ghost" icon={Pencil} aria-label={L('Modifica', 'Edit')} onClick={() => open(r)} />
                  <Button size="sm" variant="ghost" icon={Trash2} aria-label={L('Elimina', 'Delete')} onClick={() => void remove(r)} />
                </div>}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      </Card>
    );
  };
  return (
    <div className="stack" style={{ gap: 16 }}>
      <p className="muted" style={{ margin: 0 }}>{L('Le regole si valutano per priorità, dal numero più basso: la prima che corrisponde decide. Le regole predefinite (65000+) non si possono modificare ma si possono scavalcare.', 'Rules are evaluated by priority, lowest number first: the first match decides. Default rules (65000+) cannot be changed but can be overridden.')}</p>
      {table('Inbound')}
      {table('Outbound')}
      <Panel open={editing !== undefined} onClose={() => setEditing(undefined)} wide title={editing ? L(`Regola ${editing.name}`, `Rule ${editing.name}`) : form.direction === 'Inbound' ? L('Nuova regola in ingresso', 'New inbound rule') : L('Nuova regola in uscita', 'New outbound rule')}
        footer={<><Button onClick={() => setEditing(undefined)}>{L('Annulla', 'Cancel')}</Button><Button variant="primary" loading={busy} disabled={!form.name || Object.values(errs).some(Boolean)} onClick={() => void save()}>{editing ? L('Salva', 'Save') : L('Aggiungi', 'Add')}</Button></>}>
        <div className="grid cols-2" style={{ gap: '0 16px', alignItems: 'start' }}>
          <Field label={L('Nome', 'Name')} htmlFor="ns-n" error={errs.name}><Input id="ns-n" className="mono" disabled={!!editing} placeholder="allow-https" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label={L('Priorità (100-4096, più bassa vince)', 'Priority (100-4096, lower wins)')} htmlFor="ns-p" error={errs.priority}><Input id="ns-p" type="number" min={100} max={4096} value={form.priority} onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })} /></Field>
          <Field label={L('Direzione', 'Direction')} htmlFor="ns-d"><Select id="ns-d" value={form.direction} disabled={!!editing} onChange={(e) => setForm({ ...form, direction: e.target.value })}><option value="Inbound">{L('In ingresso', 'Inbound')}</option><option value="Outbound">{L('In uscita', 'Outbound')}</option></Select></Field>
          <Field label={L('Azione', 'Action')} htmlFor="ns-a"><Select id="ns-a" value={form.access} onChange={(e) => setForm({ ...form, access: e.target.value })}><option value="Allow">{L('Consenti', 'Allow')}</option><option value="Deny">{L('Nega', 'Deny')}</option></Select></Field>
          <Field label={L('Origine', 'Source')} htmlFor="ns-s" error={errs.source} hint={L('*, IP, CIDR o tag di servizio; più valori separati da virgole', '*, IP, CIDR or service tag; several values comma-separated')}>
            <Input id="ns-s" className="mono" list="ns-tags" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} />
          </Field>
          <Field label={L('Porte di origine', 'Source ports')} htmlFor="ns-sp" error={errs.sourcePorts}><Input id="ns-sp" className="mono" value={form.sourcePorts} onChange={(e) => setForm({ ...form, sourcePorts: e.target.value })} /></Field>
          <Field label={L('Destinazione', 'Destination')} htmlFor="ns-de" error={errs.dest}><Input id="ns-de" className="mono" list="ns-tags" value={form.dest} onChange={(e) => setForm({ ...form, dest: e.target.value })} /></Field>
          <Field label={L('Porte di destinazione', 'Destination ports')} htmlFor="ns-dp" error={errs.destPorts}>
            <Input id="ns-dp" className="mono" list="ns-ports" value={form.destPorts} onChange={(e) => setForm({ ...form, destPorts: e.target.value })} />
          </Field>
          <Field label={L('Protocollo', 'Protocol')} htmlFor="ns-pr"><Select id="ns-pr" value={form.protocol} onChange={(e) => setForm({ ...form, protocol: e.target.value })}>{['Tcp', 'Udp', 'Icmp', '*'].map((p) => <option key={p} value={p}>{p === '*' ? L('Qualsiasi', 'Any') : p.toUpperCase()}</option>)}</Select></Field>
          <Field label={L('Descrizione', 'Description')} htmlFor="ns-ds"><Input id="ns-ds" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
        </div>
        <datalist id="ns-tags">{['*', ...SERVICE_TAGS].map((t) => <option key={t} value={t} />)}</datalist>
        <datalist id="ns-ports">{PORT_PRESETS.map(([p, n]) => <option key={p} value={p}>{n}</option>)}</datalist>
        {risky && <Notice tone="warn">{L('Stai aprendo una porta di amministrazione a tutta Internet: limita l\'origine al tuo IP o usa Azure Bastion.', 'You are opening an admin port to the whole Internet: restrict the source to your IP or use Azure Bastion.')}</Notice>}
      </Panel>
    </div>
  );
}

// ---------------- IP pubblico ----------------

/** IP pubblico: risorsa associata, etichetta DNS, timeout di inattività. */
export function PublicIpSettings({ id, pip, reload }: { id: string; pip: any; reload: () => void }) {
  const L = useL();
  const toast = useToast();
  const P = pip.properties ?? {};
  const [label, setLabel] = useState('');
  const [idle, setIdle] = useState(4);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setLabel(P.dnsSettings?.domainNameLabel ?? ''); setIdle(Number(P.idleTimeoutInMinutes ?? 4)); }, [pip]); // eslint-disable-line react-hooks/exhaustive-deps
  const owner: string | undefined = P.ipConfiguration?.id?.split(/\/(ipConfigurations|frontendIPConfigurations)\//i)[0];
  const labelErr = label && !/^[a-z][a-z0-9-]{1,61}[a-z0-9]$/.test(label) ? L('3-63 caratteri: minuscole, numeri e trattini, inizia con una lettera', '3-63 characters: lowercase letters, digits and hyphens, starting with a letter') : undefined;
  const dirty = label !== (P.dnsSettings?.domainNameLabel ?? '') || idle !== Number(P.idleTimeoutInMinutes ?? 4);
  const save = async () => {
    setBusy(true);
    try {
      const fresh = await arm.get<any>(id, NET_API);
      const props = { ...fresh.properties };
      delete props.ipConfiguration;
      props.idleTimeoutInMinutes = idle;
      if (label) props.dnsSettings = { ...(props.dnsSettings ?? {}), domainNameLabel: label }; else delete props.dnsSettings;
      await arm.put(id, putBody(fresh, props), NET_API);
      toast.ok(L('IP pubblico aggiornato', 'Public IP updated'));
      reload();
    } catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card title={L('Indirizzo', 'Address')}>
        <div className="row wrap">
          <span className="mono" style={{ fontSize: 22, fontWeight: 700 }}>{P.ipAddress ?? L('non assegnato', 'not assigned')}</span>
          <Badge>{pip.sku?.name ?? 'Standard'}{pip.sku?.tier ? ` · ${pip.sku.tier}` : ''}</Badge>
          <Badge>{P.publicIPAllocationMethod === 'Static' ? L('Statico', 'Static') : L('Dinamico', 'Dynamic')}</Badge>
          <Badge>{P.publicIPAddressVersion ?? 'IPv4'}</Badge>
          {(pip.zones ?? []).length > 0 && <Badge tone="info">{L('Zone', 'Zones')} {pip.zones.join(', ')}</Badge>}
        </div>
        <p className="mt-16" style={{ marginBottom: 0 }}>{owner
          ? <>{L('Associato a', 'Associated with')} <Link className="mono" href={resourceHref(owner)}>{nameOf(owner)}</Link> <span className="small muted">({/loadBalancers/i.test(owner) ? L('bilanciamento del carico', 'load balancer') : L('interfaccia di rete', 'network interface')})</span></>
          : <span className="muted">{L('Non associato: un IP statico Standard si paga anche quando non è in uso.', 'Not associated: a Standard static IP is billed even when unused.')}</span>}</p>
      </Card>
      <Card title={L('Configurazione', 'Configuration')}>
        <Field label={L('Etichetta del nome DNS', 'DNS name label')} htmlFor="pip-l" error={labelErr} hint={label && !labelErr ? `${label}.${pip.location}.cloudapp.azure.com` : L('Facoltativa: crea un nome DNS che punta a questo IP.', 'Optional: creates a DNS name that points to this IP.')}>
          <Input id="pip-l" className="mono" value={label} onChange={(e) => setLabel(e.target.value.toLowerCase())} />
        </Field>
        {P.dnsSettings?.fqdn && <p className="small" style={{ marginTop: 0 }}>{L('Nome attuale', 'Current name')}: <span className="mono">{P.dnsSettings.fqdn}</span></p>}
        <Field label={L(`Timeout di inattività: ${idle} minuti`, `Idle timeout: ${idle} minutes`)} htmlFor="pip-i" hint={L('Dopo quanto tempo una connessione TCP inattiva viene chiusa (4-30).', 'How long an idle TCP connection stays open (4-30).')}>
          <input id="pip-i" type="range" min={4} max={30} value={idle} onChange={(e) => setIdle(Number(e.target.value))} style={{ width: '100%' }} />
        </Field>
        <div className="row" style={{ justifyContent: 'flex-end' }}><Button variant="primary" loading={busy} disabled={!dirty || !!labelErr} onClick={() => void save()}>{L('Salva', 'Save')}</Button></div>
      </Card>
    </div>
  );
}

// ---------------- tabella di route ----------------

const HOPS: [string, string, string][] = [['VirtualAppliance', 'Appliance virtuale (firewall, NVA)', 'Virtual appliance (firewall, NVA)'], ['Internet', 'Internet', 'Internet'], ['VnetLocal', 'Rete virtuale', 'Virtual network'], ['VirtualNetworkGateway', 'Gateway di rete virtuale', 'Virtual network gateway'], ['None', 'Nessuno (scarta il traffico)', 'None (drop traffic)']];

/** Route personalizzate e propagazione BGP. */
export function RouteTableRoutes({ id, rt, reload }: { id: string; rt: any; reload: () => void }) {
  const L = useL();
  const toast = useToast();
  const confirm = useConfirm();
  const routes: any[] = rt.properties?.routes ?? [];
  const [form, setForm] = useState({ name: '', prefix: '', hop: 'VirtualAppliance', ip: '' });
  const [editing, setEditing] = useState<any | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const open = (r: any | null) => { setEditing(r); setForm(r ? { name: r.name, prefix: r.properties.addressPrefix, hop: r.properties.nextHopType, ip: r.properties.nextHopIpAddress ?? '' } : { name: '', prefix: '0.0.0.0/0', hop: 'VirtualAppliance', ip: '' }); };
  const prefixErr = !form.prefix ? undefined : form.prefix.includes('/') ? (parseCidr(form.prefix) ? undefined : L('CIDR non valido', 'Invalid CIDR')) : /^[A-Za-z][A-Za-z0-9.]*$/.test(form.prefix) ? undefined : L('CIDR o tag di servizio', 'CIDR or service tag');
  const dup = routes.find((r) => r.name !== editing?.name && r.properties.addressPrefix === form.prefix);
  const ipErr = form.hop === 'VirtualAppliance' && !isIp(form.ip) ? L('Indirizzo IP privato dell\'appliance', 'Private IP address of the appliance') : undefined;
  const save = async () => {
    setBusy(true);
    try {
      await arm.put(`${id}/routes/${form.name}`, { properties: { addressPrefix: form.prefix, nextHopType: form.hop, ...(form.hop === 'VirtualAppliance' ? { nextHopIpAddress: form.ip } : {}) } }, NET_API);
      toast.ok(editing ? L('Route aggiornata', 'Route updated') : L('Route aggiunta', 'Route added'), form.name);
      setEditing(undefined);
      reload();
    } catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  const remove = async (r: any) => {
    if (!(await confirm({ title: L(`Eliminare la route ${r.name}?`, `Delete route ${r.name}?`), danger: true, confirmLabel: L('Elimina', 'Delete') }))) return;
    try { await arm.del(`${id}/routes/${r.name}`, NET_API); reload(); } catch (e) { toast.error(e); }
  };
  const toggleBgp = async (propagate: boolean) => {
    try {
      const fresh = await arm.get<any>(id, NET_API);
      await arm.put(id, putBody(fresh, { ...fresh.properties, disableBgpRoutePropagation: !propagate }), NET_API);
      reload();
    } catch (e) { toast.error(e); }
  };
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card title={L('Route', 'Routes')} actions={<Button size="sm" icon={Plus} onClick={() => open(null)}>{L('Route', 'Route')}</Button>}>
        {routes.length === 0 ? <Empty icon={Route} title={L('Nessuna route', 'No routes')} text={L('Senza route personalizzate valgono quelle di sistema di Azure.', 'Without custom routes, Azure system routes apply.')} /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>{L('Nome', 'Name')}</th><th>{L('Prefisso di destinazione', 'Destination prefix')}</th><th>{L('Hop successivo', 'Next hop')}</th><th>{L('Indirizzo hop', 'Hop address')}</th><th /></tr></thead>
            <tbody>{routes.map((r) => (
              <tr key={r.id ?? r.name}>
                <td className="mono">{r.name}</td>
                <td className="mono">{r.properties.addressPrefix}</td>
                <td>{L(...(HOPS.find((h) => h[0] === r.properties.nextHopType)?.slice(1) as [string, string] ?? [r.properties.nextHopType, r.properties.nextHopType]))}</td>
                <td className="mono">{r.properties.nextHopIpAddress ?? '—'}</td>
                <td><div className="row" style={{ gap: 2, justifyContent: 'flex-end' }}>
                  <Button size="sm" variant="ghost" icon={Pencil} aria-label={L('Modifica', 'Edit')} onClick={() => open(r)} />
                  <Button size="sm" variant="ghost" icon={Trash2} aria-label={L('Elimina', 'Delete')} onClick={() => void remove(r)} />
                </div></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        <div className="mt-16"><Switch checked={!rt.properties?.disableBgpRoutePropagation} onChange={(v) => void toggleBgp(v)} label={L('Propaga le route del gateway (BGP)', 'Propagate gateway routes (BGP)')} /></div>
      </Card>
      <Panel open={editing !== undefined} onClose={() => setEditing(undefined)} title={editing ? L(`Route ${editing.name}`, `Route ${editing.name}`) : L('Nuova route', 'New route')}
        footer={<><Button onClick={() => setEditing(undefined)}>{L('Annulla', 'Cancel')}</Button><Button variant="primary" loading={busy} disabled={!/^[a-zA-Z0-9][\w.-]{0,78}$/.test(form.name) || !form.prefix || !!prefixErr || !!ipErr || !!dup} onClick={() => void save()}>{editing ? L('Salva', 'Save') : L('Aggiungi', 'Add')}</Button></>}>
        <Field label={L('Nome', 'Name')} htmlFor="rt-n"><Input id="rt-n" className="mono" disabled={!!editing} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label={L('Destinazione (CIDR o tag di servizio)', 'Destination (CIDR or service tag)')} htmlFor="rt-p" error={prefixErr ?? (dup ? L(`Stesso prefisso della route ${dup.name}`, `Same prefix as route ${dup.name}`) : undefined)}><Input id="rt-p" className="mono" list="rt-tags" value={form.prefix} onChange={(e) => setForm({ ...form, prefix: e.target.value })} /></Field>
        <datalist id="rt-tags">{['0.0.0.0/0', 'Internet', 'AzureCloud', 'Storage', 'Sql', 'AzureMonitor'].map((t) => <option key={t} value={t} />)}</datalist>
        <Field label={L('Tipo di hop successivo', 'Next hop type')} htmlFor="rt-h"><Select id="rt-h" value={form.hop} onChange={(e) => setForm({ ...form, hop: e.target.value })}>{HOPS.map(([v, it, en]) => <option key={v} value={v}>{L(it, en)}</option>)}</Select></Field>
        {form.hop === 'VirtualAppliance' && <Field label={L('Indirizzo dell\'hop successivo', 'Next hop address')} htmlFor="rt-i" error={form.ip ? ipErr : undefined}><Input id="rt-i" className="mono" placeholder="10.0.0.4" value={form.ip} onChange={(e) => setForm({ ...form, ip: e.target.value })} /></Field>}
      </Panel>
    </div>
  );
}

// ---------------- bilanciamento del carico ----------------

/** Frontend, pool back-end, probe di integrità e regole: lettura completa, aggiunta ed eliminazione. */
export function LoadBalancerConfig({ id, lb, reload }: { id: string; lb: any; reload: () => void }) {
  const L = useL();
  const toast = useToast();
  const confirm = useConfirm();
  const P = lb.properties ?? {};
  const fes: any[] = P.frontendIPConfigurations ?? [];
  const pools: any[] = P.backendAddressPools ?? [];
  const probes: any[] = P.probes ?? [];
  const rules: any[] = P.loadBalancingRules ?? [];
  const [open, setOpen] = useState<'rule' | 'probe' | 'pool' | null>(null);
  const [rule, setRule] = useState({ name: '', fe: '', pool: '', probe: '', protocol: 'Tcp', fport: 80, bport: 80, idle: 4, floating: false, persistence: 'Default' });
  const [probe, setProbe] = useState({ name: '', protocol: 'Http', port: 80, path: '/', interval: 5 });
  const [pool, setPool] = useState('');
  const [busy, setBusy] = useState(false);
  const write = async (mutate: (p: any) => void, msg: string) => {
    setBusy(true);
    try {
      const fresh = await arm.get<any>(id, NET_API);
      const props = JSON.parse(JSON.stringify(fresh.properties));
      mutate(props);
      await arm.put(id, putBody(fresh, props), NET_API);
      toast.ok(msg);
      setOpen(null);
      reload();
    } catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  const nameOk = (n: string, list: any[]) => /^[a-zA-Z0-9][\w.-]{0,78}$/.test(n) && !list.some((x) => x.name.toLowerCase() === n.toLowerCase());
  const usedBy = (part: string, x: any) => rules.filter((r) => same(r.properties?.[part]?.id, x.id)).map((r) => r.name);
  const del = async (part: string, x: any, label: string) => {
    if (!(await confirm({ title: L(`Eliminare ${label} ${x.name}?`, `Delete ${label} ${x.name}?`), danger: true, confirmLabel: L('Elimina', 'Delete') }))) return;
    await write((p) => { p[part] = (p[part] ?? []).filter((y: any) => y.name !== x.name); }, L('Eliminato', 'Deleted'));
  };
  const portConflict = rules.find((r) => same(r.properties?.frontendIPConfiguration?.id, rule.fe) && r.properties.protocol === rule.protocol && Number(r.properties.frontendPort) === rule.fport);
  const feLabel = (fe: any) => fe.properties?.publicIPAddress?.id ? `${fe.name} · ${nameOf(fe.properties.publicIPAddress.id)}` : `${fe.name} · ${fe.properties?.privateIPAddress ?? nameOf(fe.properties?.subnet?.id)}`;
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card title={L('Configurazioni IP front-end', 'Frontend IP configurations')}>
        {fes.length === 0 ? <p className="muted" style={{ margin: 0 }}>—</p> : (
          <div className="stack" style={{ gap: 6 }}>{fes.map((fe) => (
            <div className="row wrap" key={fe.name}><span className="mono">{fe.name}</span>
              {fe.properties?.publicIPAddress?.id ? <><Badge tone="info">{L('Pubblico', 'Public')}</Badge><Link className="mono" href={resourceHref(fe.properties.publicIPAddress.id)}>{nameOf(fe.properties.publicIPAddress.id)}</Link></> : <><Badge>{L('Privato', 'Private')}</Badge><span className="mono">{fe.properties?.privateIPAddress ?? ''} {nameOf(fe.properties?.subnet?.id)}</span></>}
              <span className="small muted">{(fe.properties?.loadBalancingRules ?? []).length === 1 ? L('1 regola', '1 rule') : L(`${(fe.properties?.loadBalancingRules ?? []).length} regole`, `${(fe.properties?.loadBalancingRules ?? []).length} rules`)}</span>
            </div>
          ))}</div>
        )}
      </Card>
      <Card title={L('Pool back-end', 'Backend pools')} actions={<Button size="sm" icon={Plus} onClick={() => { setPool('backend'); setOpen('pool'); }}>{L('Pool', 'Pool')}</Button>}>
        {pools.length === 0 ? <p className="muted" style={{ margin: 0 }}>{L('Nessun pool: aggiungine uno e collega le interfaccia di rete delle VM.', 'No pools: add one and attach VM network interfaces.')}</p> : (
          <div className="stack" style={{ gap: 8 }}>{pools.map((bp) => {
            const members: string[] = (bp.properties?.backendIPConfigurations ?? []).map((x: any) => x.id);
            return (
              <div key={bp.name} className="row wrap"><span className="mono">{bp.name}</span><Badge>{members.length === 1 ? L('1 membro', '1 member') : L(`${members.length} membri`, `${members.length} members`)}</Badge>
                {members.map((m) => <Link key={m} className="mono small" href={resourceHref(m.split('/ipConfigurations/')[0])}>{nameOf(m.split('/ipConfigurations/')[0])}</Link>)}
                <span className="spacer" />
                <Button size="sm" variant="ghost" icon={Trash2} aria-label={L('Elimina', 'Delete')} disabled={usedBy('backendAddressPool', bp).length > 0 || members.length > 0} title={usedBy('backendAddressPool', bp).length ? L(`Usato da ${usedBy('backendAddressPool', bp).join(', ')}`, `Used by ${usedBy('backendAddressPool', bp).join(', ')}`) : members.length ? L('Ha membri', 'Has members') : undefined} onClick={() => void del('backendAddressPools', bp, L('il pool', 'pool'))} />
              </div>
            );
          })}</div>
        )}
      </Card>
      <Card title={L('Probe di integrità', 'Health probes')} actions={<Button size="sm" icon={Plus} onClick={() => { setProbe({ name: 'http-probe', protocol: 'Http', port: 80, path: '/', interval: 5 }); setOpen('probe'); }}>{L('Probe', 'Probe')}</Button>}>
        {probes.length === 0 ? <p className="muted" style={{ margin: 0 }}>{L('Nessun probe: senza probe il bilanciamento non sa quali istanze sono sane.', 'No probes: without one the load balancer cannot tell healthy instances.')}</p> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>{L('Nome', 'Name')}</th><th>{L('Protocollo', 'Protocol')}</th><th>{L('Porta', 'Port')}</th><th>{L('Percorso', 'Path')}</th><th>{L('Intervallo', 'Interval')}</th><th>{L('Usato da', 'Used by')}</th><th /></tr></thead>
            <tbody>{probes.map((pr) => (
              <tr key={pr.name}><td className="mono">{pr.name}</td><td>{pr.properties.protocol}</td><td className="mono">{pr.properties.port}</td><td className="mono">{pr.properties.requestPath ?? '—'}</td><td>{pr.properties.intervalInSeconds ?? 5} s</td>
                <td className="small">{usedBy('probe', pr).join(', ') || '—'}</td>
                <td><Button size="sm" variant="ghost" icon={Trash2} aria-label={L('Elimina', 'Delete')} disabled={usedBy('probe', pr).length > 0} onClick={() => void del('probes', pr, L('il probe', 'probe'))} /></td></tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      <Card title={L('Regole di bilanciamento', 'Load balancing rules')} actions={<Button size="sm" icon={Plus} disabled={!fes.length} onClick={() => { setRule({ name: 'rule-80', fe: fes[0]?.id ?? '', pool: pools[0]?.id ?? '', probe: probes[0]?.id ?? '', protocol: 'Tcp', fport: 80, bport: 80, idle: 4, floating: false, persistence: 'Default' }); setOpen('rule'); }}>{L('Regola', 'Rule')}</Button>}>
        {rules.length === 0 ? <p className="muted" style={{ margin: 0 }}>{L('Nessuna regola: il traffico in arrivo sul front-end non viene distribuito.', 'No rules: incoming traffic on the frontend is not distributed.')}</p> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>{L('Nome', 'Name')}</th><th>Front-end</th><th>{L('Porta', 'Port')}</th><th>{L('Pool', 'Pool')}</th><th>Probe</th><th>{L('Persistenza', 'Persistence')}</th><th /></tr></thead>
            <tbody>{rules.map((r) => (
              <tr key={r.name}><td className="mono">{r.name}</td><td className="mono small">{nameOf(r.properties.frontendIPConfiguration?.id)}</td>
                <td className="mono">{r.properties.protocol} {r.properties.frontendPort} → {r.properties.backendPort}</td>
                <td className="mono small">{nameOf(r.properties.backendAddressPool?.id) || '—'}</td><td className="mono small">{nameOf(r.properties.probe?.id) || '—'}</td>
                <td className="small">{r.properties.loadDistribution ?? 'Default'}</td>
                <td><Button size="sm" variant="ghost" icon={Trash2} aria-label={L('Elimina', 'Delete')} onClick={() => void del('loadBalancingRules', r, L('la regola', 'rule'))} /></td></tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      <Panel open={open === 'pool'} onClose={() => setOpen(null)} title={L('Nuovo pool back-end', 'New backend pool')}
        footer={<><Button onClick={() => setOpen(null)}>{L('Annulla', 'Cancel')}</Button><Button variant="primary" loading={busy} disabled={!nameOk(pool, pools)} onClick={() => void write((p) => { p.backendAddressPools = [...(p.backendAddressPools ?? []), { name: pool }]; }, L('Pool aggiunto', 'Pool added'))}>{L('Aggiungi', 'Add')}</Button></>}>
        <Field label={L('Nome', 'Name')} htmlFor="lb-pn" hint={L('Dopo averlo creato, collega le interfacce di rete delle VM dalla loro configurazione IP.', 'After creating it, attach VM network interfaces from their IP configuration.')}><Input id="lb-pn" className="mono" value={pool} onChange={(e) => setPool(e.target.value)} /></Field>
      </Panel>
      <Panel open={open === 'probe'} onClose={() => setOpen(null)} title={L('Nuovo probe di integrità', 'New health probe')}
        footer={<><Button onClick={() => setOpen(null)}>{L('Annulla', 'Cancel')}</Button><Button variant="primary" loading={busy} disabled={!nameOk(probe.name, probes) || probe.port < 1 || probe.port > 65535 || (probe.protocol !== 'Tcp' && !probe.path.startsWith('/'))}
          onClick={() => void write((p) => { p.probes = [...(p.probes ?? []), { name: probe.name, properties: { protocol: probe.protocol, port: probe.port, intervalInSeconds: probe.interval, numberOfProbes: 1, probeThreshold: 1, ...(probe.protocol !== 'Tcp' ? { requestPath: probe.path } : {}) } }]; }, L('Probe aggiunto', 'Probe added'))}>{L('Aggiungi', 'Add')}</Button></>}>
        <Field label={L('Nome', 'Name')} htmlFor="lb-prn"><Input id="lb-prn" className="mono" value={probe.name} onChange={(e) => setProbe({ ...probe, name: e.target.value })} /></Field>
        <Field label={L('Protocollo', 'Protocol')} htmlFor="lb-prp"><Select id="lb-prp" value={probe.protocol} onChange={(e) => setProbe({ ...probe, protocol: e.target.value })}>{['Http', 'Https', 'Tcp'].map((x) => <option key={x}>{x}</option>)}</Select></Field>
        <Field label={L('Porta', 'Port')} htmlFor="lb-prt"><Input id="lb-prt" type="number" min={1} max={65535} value={probe.port} onChange={(e) => setProbe({ ...probe, port: Number(e.target.value) })} /></Field>
        {probe.protocol !== 'Tcp' && <Field label={L('Percorso', 'Path')} htmlFor="lb-pph" hint={L('Deve rispondere 200 per considerare l\'istanza sana.', 'Must answer 200 for the instance to count as healthy.')}><Input id="lb-pph" className="mono" value={probe.path} onChange={(e) => setProbe({ ...probe, path: e.target.value })} /></Field>}
        <Field label={L('Intervallo (secondi)', 'Interval (seconds)')} htmlFor="lb-pi"><Input id="lb-pi" type="number" min={5} max={3600} value={probe.interval} onChange={(e) => setProbe({ ...probe, interval: Number(e.target.value) })} /></Field>
      </Panel>
      <Panel open={open === 'rule'} onClose={() => setOpen(null)} wide title={L('Nuova regola di bilanciamento', 'New load balancing rule')}
        footer={<><Button onClick={() => setOpen(null)}>{L('Annulla', 'Cancel')}</Button><Button variant="primary" loading={busy} disabled={!nameOk(rule.name, rules) || !rule.fe || !!portConflict || [rule.fport, rule.bport].some((x) => x < 0 || x > 65535)}
          onClick={() => void write((p) => {
            p.loadBalancingRules = [...(p.loadBalancingRules ?? []), { name: rule.name, properties: {
              frontendIPConfiguration: { id: rule.fe }, ...(rule.pool ? { backendAddressPool: { id: rule.pool } } : {}), ...(rule.probe ? { probe: { id: rule.probe } } : {}),
              protocol: rule.protocol, frontendPort: rule.fport, backendPort: rule.bport, idleTimeoutInMinutes: rule.idle, enableFloatingIP: rule.floating, loadDistribution: rule.persistence, disableOutboundSnat: false,
            } }];
          }, L('Regola aggiunta', 'Rule added'))}>{L('Aggiungi', 'Add')}</Button></>}>
        <div className="grid cols-2" style={{ gap: '0 16px', alignItems: 'start' }}>
          <Field label={L('Nome', 'Name')} htmlFor="lb-rn"><Input id="lb-rn" className="mono" value={rule.name} onChange={(e) => setRule({ ...rule, name: e.target.value })} /></Field>
          <Field label="Front-end" htmlFor="lb-rf"><Select id="lb-rf" value={rule.fe} onChange={(e) => setRule({ ...rule, fe: e.target.value })}>{fes.map((fe) => <option key={fe.id} value={fe.id}>{feLabel(fe)}</option>)}</Select></Field>
          <Field label={L('Protocollo', 'Protocol')} htmlFor="lb-rp"><Select id="lb-rp" value={rule.protocol} onChange={(e) => setRule({ ...rule, protocol: e.target.value })}>{['Tcp', 'Udp', 'All'].map((x) => <option key={x}>{x}</option>)}</Select></Field>
          <Field label={L('Pool back-end', 'Backend pool')} htmlFor="lb-rb"><Select id="lb-rb" value={rule.pool} onChange={(e) => setRule({ ...rule, pool: e.target.value })}><option value="">—</option>{pools.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
          <Field label={L('Porta front-end', 'Frontend port')} htmlFor="lb-rfp" error={portConflict ? L(`Già usata dalla regola ${portConflict.name}`, `Already used by rule ${portConflict.name}`) : undefined}><Input id="lb-rfp" type="number" min={0} max={65535} value={rule.fport} onChange={(e) => setRule({ ...rule, fport: Number(e.target.value) })} /></Field>
          <Field label={L('Porta back-end', 'Backend port')} htmlFor="lb-rbp"><Input id="lb-rbp" type="number" min={0} max={65535} value={rule.bport} onChange={(e) => setRule({ ...rule, bport: Number(e.target.value) })} /></Field>
          <Field label="Probe" htmlFor="lb-rpr"><Select id="lb-rpr" value={rule.probe} onChange={(e) => setRule({ ...rule, probe: e.target.value })}><option value="">—</option>{probes.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
          <Field label={L('Persistenza della sessione', 'Session persistence')} htmlFor="lb-rs"><Select id="lb-rs" value={rule.persistence} onChange={(e) => setRule({ ...rule, persistence: e.target.value })}><option value="Default">{L('Nessuna', 'None')}</option><option value="SourceIP">{L('IP del client', 'Client IP')}</option><option value="SourceIPProtocol">{L('IP e protocollo del client', 'Client IP and protocol')}</option></Select></Field>
          <Field label={L(`Timeout di inattività: ${rule.idle} min`, `Idle timeout: ${rule.idle} min`)} htmlFor="lb-ri"><input id="lb-ri" type="range" min={4} max={100} value={rule.idle} onChange={(e) => setRule({ ...rule, idle: Number(e.target.value) })} style={{ width: '100%' }} /></Field>
          <div style={{ alignSelf: 'center' }}><Switch checked={rule.floating} onChange={(v) => setRule({ ...rule, floating: v })} label={L('IP mobile (Direct Server Return)', 'Floating IP (Direct Server Return)')} /></div>
        </div>
        {!rule.probe && <Notice tone="warn">{L('Senza probe il traffico va a tutte le istanze, anche a quelle ferme.', 'Without a probe traffic goes to every instance, including stopped ones.')}</Notice>}
      </Panel>
    </div>
  );
}

// ---------------- gateway NAT ----------------

/** IP pubblici in uscita e timeout del gateway NAT. */
export function NatGatewaySettings({ nat }: { nat: any }) {
  const L = useL();
  const ips: string[] = (nat.properties?.publicIpAddresses ?? []).map((x: any) => x.id);
  const prefixes: string[] = (nat.properties?.publicIpPrefixes ?? []).map((x: any) => x.id);
  return (
    <Card title={L('Uscita verso Internet', 'Outbound to the Internet')}>
      <div className="stack" style={{ gap: 6 }}>
        {[...ips, ...prefixes].length === 0 ? <Notice tone="warn">{L('Nessun IP pubblico: le subnet associate non escono su Internet.', 'No public IPs: associated subnets cannot reach the Internet.')}</Notice>
          : [...ips, ...prefixes].map((x) => <div className="row" key={x}><Shield size={14} aria-hidden /><Link className="mono" href={resourceHref(x)}>{nameOf(x)}</Link></div>)}
        <p className="small muted" style={{ margin: 0 }}>{L('Timeout di inattività', 'Idle timeout')}: {nat.properties?.idleTimeoutInMinutes ?? 4} min</p>
      </div>
    </Card>
  );
}
