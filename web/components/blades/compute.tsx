'use client';

import { useEffect, useState } from 'react';
import { HardDrive, Link2, Plus, Trash2, Unlink } from 'lucide-react';
import { arm } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { money } from '@/lib/money';
import { useI18n } from '@/i18n';
import { Badge, Button, Card, Empty, ErrorNotice, Field, Input, Notice, Select, Skeleton } from '../ui';
import { Panel, useConfirm, useToast } from '../overlay';
import { loadPricing, type PriceType } from '../pricing';
import { useL } from './common';

export const VM_API = '2024-07-01';
const DISK_API = '2024-03-02';
const NET_API = '2024-01-01';
const DISK_SKUS: [string, string, string][] = [['Premium_LRS', 'SSD Premium', 'Premium SSD'], ['StandardSSD_LRS', 'SSD Standard', 'Standard SSD'], ['Standard_LRS', 'HDD Standard', 'Standard HDD']];
const rgOf = (id: string) => id.split('/providers/')[0];
const nameOf = (id?: string) => id?.split('/').pop() ?? '';

/** Dimensioni della VM: cambio con il prezzo mensile di ogni taglia. */
export function VmSize({ id, vm, reload }: { id: string; vm: any; reload: () => void }) {
  const L = useL();
  const { locale } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const pricing = useAsync(() => loadPricing(), []);
  const current = vm.properties?.hardwareProfile?.vmSize ?? '';
  const [sel, setSel] = useState(current);
  const [busy, setBusy] = useState(false);
  useEffect(() => setSel(current), [current]);
  const plans = ((pricing.data?.types as PriceType[] | undefined)?.find((x) => x.type === 'Microsoft.Compute/virtualMachines')?.plans ?? []);
  const families = [...new Set(plans.map((p) => p.sku.replace(/^Standard_/, '').replace(/[0-9].*$/, '')))];
  const famLabel: Record<string, [string, string]> = { B: ['Serie B · burstable, per carichi leggeri', 'B series · burstable, for light loads'], D: ['Serie D · uso generico', 'D series · general purpose'], E: ['Serie E · ottimizzate per la memoria', 'E series · memory optimized'], F: ['Serie F · ottimizzate per il calcolo', 'F series · compute optimized'], NC: ['Serie NC · GPU', 'NC series · GPU'] };
  const apply = async () => {
    if (!(await confirm({ title: L(`Passare a ${sel}?`, `Resize to ${sel}?`), text: L('Azure riavvia la VM per cambiare dimensione: le connessioni attive cadono.', 'Azure restarts the VM to resize it: active connections drop.'), confirmLabel: L('Ridimensiona', 'Resize') }))) return;
    setBusy(true);
    try { await arm.patch(id, { properties: { hardwareProfile: { vmSize: sel } } }, VM_API); toast.ok(L('Ridimensionamento avviato', 'Resize started'), sel); reload(); }
    catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  if (pricing.error) return <ErrorNotice error={pricing.error} onRetry={pricing.reload} />;
  if (!pricing.data) return <Skeleton rows={4} />;
  return (
    <div className="stack" style={{ gap: 16 }}>
      {families.map((f) => (
        <Card key={f} title={famLabel[f] ? L(...famLabel[f]) : f}>
          <div className="radio-cards">{plans.filter((p) => p.sku.replace(/^Standard_/, '').replace(/[0-9].*$/, '') === f).map((p) => (
            <label className="radio-card" key={p.sku}>
              <input type="radio" name="vm-size" checked={sel === p.sku} onChange={() => setSel(p.sku)} />
              <span><strong className="mono">{p.sku}</strong> {p.sku === current && <Badge tone="info">{L('attuale', 'current')}</Badge>}<br /><span className="small muted">{p.specs[locale]}</span>{p.monthly !== null && <><br /><span className="small">{money(p.monthly, locale)} {L('al mese', 'per month')}</span></>}</span>
            </label>
          ))}</div>
        </Card>
      ))}
      <div className="row" style={{ justifyContent: 'flex-end' }}><Button variant="primary" loading={busy} disabled={!sel || sel === current} onClick={() => void apply()}>{L('Ridimensiona', 'Resize')}</Button></div>
    </div>
  );
}

/** Dischi: sistema operativo e dischi dati, aggiunta di un disco nuovo o esistente, scollegamento. */
export function VmDisks({ id, vm, reload }: { id: string; vm: any; reload: () => void }) {
  const L = useL();
  const toast = useToast();
  const confirm = useConfirm();
  const os = vm.properties?.storageProfile?.osDisk;
  const data: any[] = vm.properties?.storageProfile?.dataDisks ?? [];
  const available = useAsync(async () => (await arm.get<{ value: any[] }>(`${rgOf(id)}/providers/Microsoft.Compute/disks`, DISK_API)).value.filter((d) => !d.managedBy && d.location === vm.location && !d.properties?.osType), [id]);
  const [open, setOpen] = useState<'new' | 'attach' | null>(null);
  const [form, setForm] = useState({ name: `${vm.name}_DataDisk_${data.length}`, size: 64, sku: 'Premium_LRS', caching: 'ReadOnly', disk: '' });
  const [busy, setBusy] = useState(false);
  const freeLun = () => { let l = 0; while (data.some((d) => Number(d.lun) === l)) l++; return l; };
  const save = async (disks: any[], msg: string) => {
    setBusy(true);
    try { await arm.patch(id, { properties: { storageProfile: { dataDisks: disks } } }, VM_API); toast.ok(msg); setOpen(null); reload(); available.reload(); }
    catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  const keep = data.map((d) => ({ lun: d.lun, name: d.name, createOption: 'Attach', caching: d.caching, deleteOption: d.deleteOption, managedDisk: { id: d.managedDisk?.id } }));
  const detach = async (d: any) => {
    if (!(await confirm({ title: L(`Scollegare ${d.name}?`, `Detach ${d.name}?`), text: L('Il disco resta nel gruppo di risorse con i suoi dati e continua a essere fatturato. Smonta prima il file system nella VM.', 'The disk stays in the resource group with its data and is still billed. Unmount the file system in the VM first.'), confirmLabel: L('Scollega', 'Detach') }))) return;
    await save(keep.filter((x) => x.lun !== d.lun), L('Disco scollegato', 'Disk detached'));
  };
  const nameOk = /^[a-zA-Z0-9][\w.-]{0,78}[\w]$/.test(form.name);
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card title={L('Disco del sistema operativo', 'OS disk')}>
        {os ? <p className="row wrap" style={{ margin: 0 }}><HardDrive size={16} aria-hidden /><a className="mono" href={`/resource?id=${encodeURIComponent(os.managedDisk?.id ?? '')}`}>{os.name}</a><Badge>{os.managedDisk?.storageAccountType ?? '—'}</Badge>{os.diskSizeGB && <Badge>{os.diskSizeGB} GiB</Badge>}<Badge>{os.osType}</Badge></p> : <p className="muted">—</p>}
      </Card>
      <Card title={L('Dischi dati', 'Data disks')} actions={<div className="row"><Button size="sm" icon={Plus} onClick={() => { setForm({ ...form, name: `${vm.name}_DataDisk_${freeLun()}` }); setOpen('new'); }}>{L('Nuovo disco', 'New disk')}</Button><Button size="sm" icon={Link2} onClick={() => setOpen('attach')}>{L('Collega esistente', 'Attach existing')}</Button></div>}>
        {data.length === 0 ? <Empty icon={HardDrive} title={L('Nessun disco dati', 'No data disks')} text={L('Aggiungi un disco per i dati dell\'applicazione: sopravvive alla ricreazione della VM.', 'Add a disk for application data: it survives recreating the VM.')} /> : (
          <div className="stack" style={{ gap: 8 }}>
            {data.map((d) => (
              <div className="kv-edit three" key={d.lun}>
                <span className="mono">LUN {d.lun}</span>
                <a className="mono" href={`/resource?id=${encodeURIComponent(d.managedDisk?.id ?? '')}`}>{d.name}</a>
                <span className="small muted">{d.diskSizeGB ? `${d.diskSizeGB} GiB · ` : ''}{d.managedDisk?.storageAccountType ?? ''} · {L('cache', 'caching')} {d.caching ?? 'None'}</span>
                <Button size="sm" variant="ghost" icon={Unlink} loading={busy} onClick={() => void detach(d)}>{L('Scollega', 'Detach')}</Button>
              </div>
            ))}
          </div>
        )}
      </Card>
      <Panel open={open === 'new'} onClose={() => setOpen(null)} title={L('Nuovo disco dati', 'New data disk')}
        footer={<><Button onClick={() => setOpen(null)}>{L('Annulla', 'Cancel')}</Button><Button variant="primary" loading={busy} disabled={!nameOk || form.size < 4}
          onClick={() => void save([...keep, { lun: freeLun(), name: form.name, createOption: 'Empty', diskSizeGB: form.size, caching: form.caching, deleteOption: 'Detach', managedDisk: { storageAccountType: form.sku } }], L('Disco creato e collegato', 'Disk created and attached'))}>{L('Crea e collega', 'Create and attach')}</Button></>}>
        <Field label={L('Nome', 'Name')} htmlFor="dn" error={!nameOk ? L('Lettere, numeri, punti, trattini e trattini bassi', 'Letters, digits, dots, hyphens and underscores') : undefined}><Input id="dn" className="mono" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label={L('Dimensione (GiB)', 'Size (GiB)')} htmlFor="ds"><Select id="ds" value={form.size} onChange={(e) => setForm({ ...form, size: Number(e.target.value) })}>{[4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048].map((n) => <option key={n} value={n}>{n}</option>)}</Select></Field>
        <Field label={L('Tipo di disco', 'Disk type')} htmlFor="dk"><Select id="dk" value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })}>{DISK_SKUS.map(([k, it, en]) => <option key={k} value={k}>{L(it, en)}</option>)}</Select></Field>
        <Field label={L('Cache dell\'host', 'Host caching')} htmlFor="dc" hint={L('Sola lettura va bene per i database; nessuna per i log in scrittura.', 'Read-only suits databases; none for write-heavy logs.')}><Select id="dc" value={form.caching} onChange={(e) => setForm({ ...form, caching: e.target.value })}>{['None', 'ReadOnly', 'ReadWrite'].map((c) => <option key={c}>{c}</option>)}</Select></Field>
      </Panel>
      <Panel open={open === 'attach'} onClose={() => setOpen(null)} title={L('Collega un disco esistente', 'Attach an existing disk')}
        footer={<><Button onClick={() => setOpen(null)}>{L('Annulla', 'Cancel')}</Button><Button variant="primary" loading={busy} disabled={!form.disk}
          onClick={() => void save([...keep, { lun: freeLun(), createOption: 'Attach', caching: form.caching, managedDisk: { id: form.disk } }], L('Disco collegato', 'Disk attached'))}>{L('Collega', 'Attach')}</Button></>}>
        {available.error ? <ErrorNotice error={available.error} onRetry={available.reload} /> : !available.data ? <Skeleton rows={2} /> : available.data.length === 0 ? <Notice>{L('Nessun disco libero nello stesso gruppo di risorse e area geografica.', 'No unattached disks in the same resource group and region.')}</Notice> : (
          <>
            <Field label={L('Disco', 'Disk')} htmlFor="da"><Select id="da" value={form.disk} onChange={(e) => setForm({ ...form, disk: e.target.value })}><option value="">—</option>{available.data.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.properties?.diskSizeGB} GiB · {d.sku?.name}</option>)}</Select></Field>
            <Field label={L('Cache dell\'host', 'Host caching')} htmlFor="dc2"><Select id="dc2" value={form.caching} onChange={(e) => setForm({ ...form, caching: e.target.value })}>{['None', 'ReadOnly', 'ReadWrite'].map((c) => <option key={c}>{c}</option>)}</Select></Field>
          </>
        )}
      </Panel>
    </div>
  );
}

const PORTS: [string, string][] = [['22', 'SSH'], ['3389', 'RDP'], ['80', 'HTTP'], ['443', 'HTTPS'], ['5432', 'PostgreSQL'], ['1433', 'SQL Server']];

/** Rete: interfacce della VM e regole del gruppo di sicurezza (porte in ingresso). */
export function VmNetworking({ vm }: { vm: any }) {
  const L = useL();
  const nics: string[] = (vm.properties?.networkProfile?.networkInterfaces ?? []).map((n: any) => n.id);
  return (
    <div className="stack" style={{ gap: 16 }}>
      {nics.length === 0 ? <Notice>{L('La VM non ha interfacce di rete.', 'The VM has no network interfaces.')}</Notice> : nics.map((n) => <NicCard key={n} nicId={n} />)}
    </div>
  );
}

function NicCard({ nicId }: { nicId: string }) {
  const L = useL();
  const nic = useAsync(() => arm.get<any>(nicId, NET_API), [nicId]);
  const ip = nic.data?.properties?.ipConfigurations?.[0];
  const subnetId: string | undefined = ip?.properties?.subnet?.id;
  const subnet = useAsync(async () => (subnetId ? arm.get<any>(subnetId, NET_API) : null), [subnetId]);
  const nsgs = [
    ...(nic.data?.properties?.networkSecurityGroup?.id ? [{ id: nic.data.properties.networkSecurityGroup.id as string, where: L('interfaccia di rete', 'network interface') }] : []),
    ...(subnet.data?.properties?.networkSecurityGroup?.id ? [{ id: subnet.data.properties.networkSecurityGroup.id as string, where: L('subnet', 'subnet') }] : []),
  ];
  if (nic.error) return <ErrorNotice error={nic.error} onRetry={nic.reload} />;
  if (!nic.data) return <Skeleton rows={3} />;
  return (
    <>
      <Card title={<span className="mono">{nic.data.name}</span>}>
        <div className="row wrap">
          <Badge>{L('IP privato', 'Private IP')} {ip?.properties?.privateIPAddress ?? '—'}</Badge>
          {ip?.properties?.publicIPAddress?.id && <Badge tone="info">{L('IP pubblico', 'Public IP')} {nameOf(ip.properties.publicIPAddress.id)}</Badge>}
          {subnetId && <Badge>{nameOf(subnetId.split('/subnets/')[0])} / {nameOf(subnetId)}</Badge>}
          {nic.data.properties?.enableAcceleratedNetworking && <Badge tone="ok">{L('Rete accelerata', 'Accelerated networking')}</Badge>}
        </div>
      </Card>
      {nsgs.length === 0 && !subnet.loading && <Notice tone="warn">{L('Nessun gruppo di sicurezza di rete: tutto il traffico consentito dalla subnet arriva alla VM.', 'No network security group: all traffic the subnet allows reaches the VM.')}</Notice>}
      {nsgs.map((g) => <NsgRules key={g.id} nsgId={g.id} where={g.where} />)}
    </>
  );
}

function NsgRules({ nsgId, where }: { nsgId: string; where: string }) {
  const L = useL();
  const toast = useToast();
  const confirm = useConfirm();
  const nsg = useAsync(() => arm.get<any>(nsgId, NET_API), [nsgId]);
  const [form, setForm] = useState({ name: '', port: '22', source: '*', protocol: 'Tcp', access: 'Allow', priority: 300 });
  const [busy, setBusy] = useState(false);
  const rules: any[] = nsg.data?.properties?.securityRules ?? [];
  const defaults: any[] = nsg.data?.properties?.defaultSecurityRules ?? [];
  const inbound = [...rules, ...defaults].filter((r) => r.properties?.direction === 'Inbound').sort((a, b) => a.properties.priority - b.properties.priority);
  const usedPrio = new Set(rules.filter((r) => r.properties?.direction === 'Inbound').map((r) => Number(r.properties.priority)));
  useEffect(() => { let p = 300; while (usedPrio.has(p)) p += 10; setForm((f) => ({ ...f, priority: p })); }, [nsg.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const portOk = /^(\*|\d{1,5}(-\d{1,5})?)$/.test(form.port);
  const nameOk = /^[a-zA-Z0-9][\w.-]{0,78}$/.test(form.name);
  const add = async () => {
    setBusy(true);
    try {
      await arm.put(`${nsgId}/securityRules/${form.name}`, { properties: { priority: form.priority, direction: 'Inbound', access: form.access, protocol: form.protocol, sourceAddressPrefix: form.source || '*', sourcePortRange: '*', destinationAddressPrefix: '*', destinationPortRange: form.port } }, NET_API);
      toast.ok(L('Regola aggiunta', 'Rule added'), form.name);
      setForm({ ...form, name: '' });
      nsg.reload();
    } catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  const remove = async (r: any) => {
    if (!(await confirm({ title: L(`Eliminare la regola ${r.name}?`, `Delete rule ${r.name}?`), danger: true, confirmLabel: L('Elimina', 'Delete') }))) return;
    try { await arm.del(r.id, NET_API); nsg.reload(); } catch (e) { toast.error(e); }
  };
  const risky = form.access === 'Allow' && (form.source === '*' || form.source === 'Internet') && ['22', '3389', '*'].includes(form.port);
  return (
    <Card title={<span>{L('Porte in ingresso', 'Inbound ports')} · <span className="mono">{nameOf(nsgId)}</span> <span className="small muted">({where})</span></span>}>
      {nsg.error ? <ErrorNotice error={nsg.error} onRetry={nsg.reload} /> : !nsg.data ? <Skeleton rows={3} /> : (
        <div className="stack" style={{ gap: 12 }}>
          <div className="table-wrap"><table className="table">
            <thead><tr><th>{L('Priorità', 'Priority')}</th><th>{L('Nome', 'Name')}</th><th>{L('Porta', 'Port')}</th><th>{L('Protocollo', 'Protocol')}</th><th>{L('Origine', 'Source')}</th><th>{L('Azione', 'Action')}</th><th /></tr></thead>
            <tbody>{inbound.map((r) => (
              <tr key={r.id}>
                <td className="mono">{r.properties.priority}</td>
                <td className="mono">{r.name}</td>
                <td className="mono">{r.properties.destinationPortRange ?? (r.properties.destinationPortRanges ?? []).join(', ')}</td>
                <td>{r.properties.protocol}</td>
                <td className="mono">{r.properties.sourceAddressPrefix ?? (r.properties.sourceAddressPrefixes ?? []).join(', ')}</td>
                <td><Badge tone={r.properties.access === 'Allow' ? 'ok' : 'bad'}>{r.properties.access === 'Allow' ? L('Consenti', 'Allow') : L('Nega', 'Deny')}</Badge></td>
                <td>{r.type?.toLowerCase().endsWith('/securityrules') && <Button size="sm" variant="ghost" icon={Trash2} aria-label={L('Elimina', 'Delete')} onClick={() => void remove(r)} />}</td>
              </tr>
            ))}</tbody>
          </table></div>
          <div className="grid cols-3" style={{ alignItems: 'end', gap: 10 }}>
            <Field label={L('Nome regola', 'Rule name')} htmlFor={`rn-${nsgId}`}><Input id={`rn-${nsgId}`} className="mono" placeholder="allow-https" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label={L('Porta di destinazione', 'Destination port')} htmlFor={`rp-${nsgId}`} error={!portOk ? L('Numero, intervallo (8000-8100) o *', 'Number, range (8000-8100) or *') : undefined}>
              <Input id={`rp-${nsgId}`} className="mono" list={`ports-${nsgId}`} value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} />
              <datalist id={`ports-${nsgId}`}>{PORTS.map(([p, n]) => <option key={p} value={p}>{n}</option>)}</datalist>
            </Field>
            <Field label={L('Origine (IP, CIDR o tag)', 'Source (IP, CIDR or tag)')} htmlFor={`rs-${nsgId}`}><Input id={`rs-${nsgId}`} className="mono" placeholder="203.0.113.10/32" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} /></Field>
            <Field label={L('Protocollo', 'Protocol')} htmlFor={`rpr-${nsgId}`}><Select id={`rpr-${nsgId}`} value={form.protocol} onChange={(e) => setForm({ ...form, protocol: e.target.value })}>{['Tcp', 'Udp', 'Icmp', '*'].map((p) => <option key={p}>{p}</option>)}</Select></Field>
            <Field label={L('Azione', 'Action')} htmlFor={`ra-${nsgId}`}><Select id={`ra-${nsgId}`} value={form.access} onChange={(e) => setForm({ ...form, access: e.target.value })}><option value="Allow">{L('Consenti', 'Allow')}</option><option value="Deny">{L('Nega', 'Deny')}</option></Select></Field>
            <Field label={L('Priorità (100-4096, più bassa vince)', 'Priority (100-4096, lower wins)')} htmlFor={`rpi-${nsgId}`}><Input id={`rpi-${nsgId}`} type="number" min={100} max={4096} value={form.priority} onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })} invalid={usedPrio.has(form.priority)} /></Field>
          </div>
          {risky && <Notice tone="warn">{L('Stai aprendo una porta di amministrazione a tutta Internet: limita l\'origine al tuo IP o usa Azure Bastion.', 'You are opening an admin port to the whole Internet: restrict the source to your IP or use Azure Bastion.')}</Notice>}
          <div className="row" style={{ justifyContent: 'flex-end' }}><Button variant="primary" icon={Plus} loading={busy} disabled={!nameOk || !portOk || form.priority < 100 || form.priority > 4096 || usedPrio.has(form.priority)} onClick={() => void add()}>{L('Aggiungi regola in ingresso', 'Add inbound rule')}</Button></div>
        </div>
      )}
    </Card>
  );
}
