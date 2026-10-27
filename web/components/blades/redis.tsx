'use client';

import { useEffect, useState } from 'react';
import { Eye, EyeOff, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { arm } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { money } from '@/lib/money';
import { useI18n } from '@/i18n';
import { Badge, Button, Card, CodeBlock, CopyButton, ErrorNotice, Field, Input, Notice, Select, Skeleton, Switch } from '../ui';
import { useConfirm, useToast } from '../overlay';
import { loadPricing, type PriceType } from '../pricing';
import { useL } from './common';

export const isManagedRedis = (type: string) => type.toLowerCase() === 'microsoft.cache/redisenterprise';

const MANAGED_SKUS: [string, string][] = [
  ['Balanced_B0', '0,5 GB'], ['Balanced_B1', '1 GB'], ['Balanced_B3', '3 GB'], ['Balanced_B5', '6 GB'], ['Balanced_B10', '12 GB'], ['Balanced_B20', '24 GB'], ['Balanced_B50', '60 GB'], ['Balanced_B100', '120 GB'],
  ['MemoryOptimized_M10', '12 GB'], ['MemoryOptimized_M20', '24 GB'], ['MemoryOptimized_M50', '60 GB'],
  ['ComputeOptimized_X3', '3 GB'], ['ComputeOptimized_X5', '6 GB'], ['ComputeOptimized_X10', '12 GB'],
];
const CLASSIC_SKUS: { name: string; family: string; capacity: number; size: string }[] = [
  ...[0, 1, 2, 3, 4, 5, 6].flatMap((c) => [{ name: 'Basic', family: 'C', capacity: c, size: ['250 MB', '1 GB', '2,5 GB', '6 GB', '13 GB', '26 GB', '53 GB'][c] }, { name: 'Standard', family: 'C', capacity: c, size: ['250 MB', '1 GB', '2,5 GB', '6 GB', '13 GB', '26 GB', '53 GB'][c] }]),
  ...[1, 2, 3, 4, 5].map((c) => ({ name: 'Premium', family: 'P', capacity: c, size: ['6 GB', '13 GB', '26 GB', '53 GB', '120 GB'][c - 1] })),
];

/** Chiavi di accesso e stringhe di connessione. */
export function RedisConnect({ id, r, apiVersion }: { id: string; r: any; apiVersion: string }) {
  const L = useL();
  const toast = useToast();
  const confirm = useConfirm();
  const managed = isManagedRedis(r.type);
  const db = useAsync(async () => (managed ? arm.get<any>(`${id}/databases/default`, apiVersion) : null), [id, apiVersion]);
  const keysPath = managed ? `${id}/databases/default` : id;
  const [keys, setKeys] = useState<{ primaryKey: string; secondaryKey: string } | null>(null);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const keyAuth = managed ? db.data?.properties?.accessKeysAuthentication !== 'Disabled' : !r.properties?.disableAccessKeyAuthentication;
  const load = async () => {
    setBusy(true);
    try { setKeys(await arm.post(`${keysPath}/listKeys`, {}, apiVersion)); setShow(true); }
    catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  const regen = async (keyType: 'Primary' | 'Secondary') => {
    if (!(await confirm({ title: L(`Rigenerare la chiave ${keyType === 'Primary' ? 'primaria' : 'secondaria'}?`, `Regenerate the ${keyType.toLowerCase()} key?`), text: L('Le app che la usano smettono di connettersi finché non la aggiorni.', 'Apps using it stop connecting until you update them.'), danger: true, confirmLabel: L('Rigenera', 'Regenerate') }))) return;
    try { setKeys(await arm.post(`${keysPath}/regenerateKey`, { keyType }, apiVersion)); toast.ok(L('Chiave rigenerata', 'Key regenerated')); } catch (e) { toast.error(e); }
  };
  const host = r.properties?.hostName ?? '';
  const port = managed ? db.data?.properties?.port ?? 10000 : r.properties?.sslPort ?? 6380;
  const key = keys?.primaryKey && show ? keys.primaryKey : '<access-key>';
  const snippets: [string, string][] = [
    ['redis-cli', `redis-cli -h ${host} -p ${port} --tls -a '${key}'${managed && db.data?.properties?.clusteringPolicy === 'OSSCluster' ? ' -c' : ''}`],
    ['StackExchange.Redis (.NET)', `${host}:${port},password=${key},ssl=True,abortConnect=False`],
    ['Node.js (ioredis)', managed && db.data?.properties?.clusteringPolicy === 'OSSCluster'
      ? `new Redis.Cluster([{ host: '${host}', port: ${port} }], { redisOptions: { password: process.env.REDIS_KEY, tls: { servername: '${host}' } }, dnsLookup: (a, cb) => cb(null, a) })`
      : `new Redis({ host: '${host}', port: ${port}, password: process.env.REDIS_KEY, tls: { servername: '${host}' } })`],
    ['Python (redis-py)', `redis.Redis(host="${host}", port=${port}, password=os.environ["REDIS_KEY"], ssl=True)`],
  ];
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card title={L('Endpoint', 'Endpoint')}>
        <p><span className="mono">{host}:{port}</span> <CopyButton value={`${host}:${port}`} /> <Badge tone="ok">TLS</Badge>{managed && db.data && <> <Badge>{db.data.properties?.clusteringPolicy}</Badge></>}</p>
      </Card>
      <Card title={L('Chiavi di accesso', 'Access keys')} actions={keys ? <Button size="sm" variant="ghost" icon={show ? EyeOff : Eye} onClick={() => setShow(!show)}>{show ? L('Nascondi', 'Hide') : L('Mostra', 'Show')}</Button> : null}>
        {!keyAuth ? <Notice>{L('L\'accesso con chiavi è disattivato: le app si autenticano con Microsoft Entra ID. Puoi riattivarlo in Impostazioni.', 'Access-key authentication is disabled: apps authenticate with Microsoft Entra ID. You can enable it in Settings.')}</Notice> : !keys ? (
          <Button icon={Eye} loading={busy} onClick={() => void load()}>{L('Mostra le chiavi', 'Show keys')}</Button>
        ) : (
          <div className="stack" style={{ gap: 10 }}>
            {(['Primary', 'Secondary'] as const).map((k) => {
              const v = k === 'Primary' ? keys.primaryKey : keys.secondaryKey;
              return (
                <div className="kv-edit" key={k}>
                  <span>{k === 'Primary' ? L('Primaria', 'Primary') : L('Secondaria', 'Secondary')}</span>
                  <span className="secret"><span>{show ? v : '•'.repeat(24)}</span><CopyButton value={v} /></span>
                  <Button size="sm" icon={RefreshCw} onClick={() => void regen(k)}>{L('Rigenera', 'Regenerate')}</Button>
                </div>
              );
            })}
          </div>
        )}
      </Card>
      {snippets.map(([label, code]) => <Card key={label} title={label}><CodeBlock value={code} /></Card>)}
    </div>
  );
}

/** Cambio di piano / dimensione. */
export function RedisScale({ id, r, apiVersion, reload }: { id: string; r: any; apiVersion: string; reload: () => void }) {
  const L = useL();
  const { locale } = useI18n();
  const toast = useToast();
  const pricing = useAsync(() => loadPricing(), []);
  const managed = isManagedRedis(r.type);
  const current = managed ? r.sku?.name : `${r.properties?.sku?.name}|${r.properties?.sku?.family}|${r.properties?.sku?.capacity}`;
  const [sel, setSel] = useState(current);
  const [busy, setBusy] = useState(false);
  useEffect(() => setSel(current), [current]);
  const priceOf = (key: string) => {
    const types = pricing.data?.types as PriceType[] | undefined;
    if (managed) return types?.find((x) => x.type === 'Microsoft.Cache/redisEnterprise')?.plans.find((p) => p.sku === key)?.monthly ?? null;
    const [n, f, c] = key.split('|');
    return types?.find((x) => x.type === 'Microsoft.Cache/redis')?.plans.find((p) => p.sku === `${n} ${f}${c}`)?.monthly ?? null;
  };
  const apply = async () => {
    setBusy(true);
    try {
      if (managed) await arm.patch(id, { sku: { name: sel } }, apiVersion);
      else { const [name, family, capacity] = sel.split('|'); await arm.patch(id, { properties: { sku: { name, family, capacity: Number(capacity) } } }, apiVersion); }
      toast.ok(L('Ridimensionamento avviato', 'Scaling started'), L('Azure applica il cambio senza fermare la cache.', 'Azure applies the change without stopping the cache.'));
      reload();
    } catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  const options = managed ? MANAGED_SKUS.map(([k, size]) => ({ key: k, label: k.replace('_', ' '), size })) : CLASSIC_SKUS.map((x) => ({ key: `${x.name}|${x.family}|${x.capacity}`, label: `${x.name} ${x.family}${x.capacity}`, size: x.size }));
  const groups = managed ? ['Balanced', 'MemoryOptimized', 'ComputeOptimized'] : ['Basic', 'Standard', 'Premium'];
  const groupLabel: Record<string, string> = { Balanced: L('Bilanciato', 'Balanced'), MemoryOptimized: L('Ottimizzato per la memoria', 'Memory optimized'), ComputeOptimized: L('Ottimizzato per il calcolo', 'Compute optimized'), Basic: L('Basic · nodo singolo, senza SLA', 'Basic · single node, no SLA'), Standard: L('Standard · con replica', 'Standard · replicated'), Premium: L('Premium · cluster, persistenza, rete virtuale', 'Premium · clustering, persistence, virtual network') };
  return (
    <div className="stack" style={{ gap: 16 }}>
      {!managed && <Notice>{L('Da Basic si può salire a Standard o Premium; non si può scendere da Premium.', 'From Basic you can move up to Standard or Premium; you cannot move down from Premium.')}</Notice>}
      {groups.map((g) => (
        <Card key={g} title={groupLabel[g]}>
          <div className="radio-cards">{options.filter((o) => o.key.startsWith(g)).map((o) => {
            const price = priceOf(o.key);
            return (
              <label className="radio-card" key={o.key}>
                <input type="radio" name="redis-sku" checked={sel === o.key} onChange={() => setSel(o.key)} />
                <span><strong className="mono">{o.label}</strong> {o.key === current && <Badge tone="info">{L('attuale', 'current')}</Badge>}<br /><span className="small muted">{o.size}</span>{price !== null && <><br /><span className="small">{money(price, locale)} {L('al mese', 'per month')}</span></>}</span>
              </label>
            );
          })}</div>
        </Card>
      ))}
      <div className="row" style={{ justifyContent: 'flex-end' }}><Button variant="primary" loading={busy} disabled={sel === current} onClick={() => void apply()}>{L('Applica', 'Apply')}</Button></div>
    </div>
  );
}

/** Impostazioni: sicurezza, rete, criteri di memoria e persistenza. */
export function RedisSettings({ id, r, apiVersion, reload }: { id: string; r: any; apiVersion: string; reload: () => void }) {
  const L = useL();
  const toast = useToast();
  const managed = isManagedRedis(r.type);
  const db = useAsync(async () => (managed ? arm.get<any>(`${id}/databases/default`, apiVersion) : null), [id, apiVersion]);
  const [busy, setBusy] = useState<string | null>(null);
  const patch = async (key: string, path: string, body: any, after: () => void) => {
    setBusy(key);
    try { await arm.patch(path, body, apiVersion); toast.ok(L('Salvato', 'Saved')); after(); }
    catch (e) { toast.error(e); }
    finally { setBusy(null); }
  };
  const p = r.properties ?? {};
  const POLICIES = managed ? ['AllKeysLFU', 'AllKeysLRU', 'AllKeysRandom', 'VolatileLRU', 'VolatileLFU', 'VolatileTTL', 'VolatileRandom', 'NoEviction'] : ['volatile-lru', 'allkeys-lru', 'volatile-lfu', 'allkeys-lfu', 'volatile-random', 'allkeys-random', 'volatile-ttl', 'noeviction'];
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card title={L('Sicurezza e rete', 'Security and network')}>
        <div className="stack" style={{ gap: 12 }}>
          <Switch checked={(p.publicNetworkAccess ?? 'Enabled') !== 'Disabled'} onChange={(v) => void patch('pub', id, { properties: { publicNetworkAccess: v ? 'Enabled' : 'Disabled' } }, reload)} label={L('Accesso dalla rete pubblica', 'Public network access')} />
          {managed
            ? <Switch checked={db.data?.properties?.accessKeysAuthentication !== 'Disabled'} onChange={(v) => void patch('keys', `${id}/databases/default`, { properties: { accessKeysAuthentication: v ? 'Enabled' : 'Disabled' } }, db.reload)} label={L('Autenticazione con chiavi di accesso (altrimenti solo Microsoft Entra ID)', 'Access-key authentication (otherwise Microsoft Entra ID only)')} />
            : <Switch checked={!!p.enableNonSslPort} onChange={(v) => void patch('nonssl', id, { properties: { enableNonSslPort: v } }, reload)} label={L('Porta non TLS 6379 (sconsigliata)', 'Non-TLS port 6379 (not recommended)')} />}
          {managed && <Switch checked={(p.highAvailability ?? 'Enabled') === 'Enabled'} onChange={(v) => void patch('ha', id, { properties: { highAvailability: v ? 'Enabled' : 'Disabled' } }, reload)} label={L('Alta disponibilità (replica)', 'High availability (replica)')} />}
          <Field label={L('Versione TLS minima', 'Minimum TLS version')} htmlFor="tls">
            <Select id="tls" value={p.minimumTlsVersion ?? '1.2'} onChange={(e) => void patch('tls', id, { properties: { minimumTlsVersion: e.target.value } }, reload)}>{(managed ? ['1.2'] : ['1.0', '1.1', '1.2']).map((v) => <option key={v}>{v}</option>)}</Select>
          </Field>
        </div>
      </Card>
      <Card title={L('Memoria e persistenza', 'Memory and persistence')}>
        {managed && !db.data ? (db.error ? <ErrorNotice error={db.error} onRetry={db.reload} /> : <Skeleton rows={3} />) : (
          <div className="stack" style={{ gap: 12 }}>
            <Field label={L('Criterio di rimozione delle chiavi quando la memoria è piena', 'Eviction policy when memory is full')} htmlFor="ev">
              <Select id="ev" value={managed ? db.data?.properties?.evictionPolicy ?? 'VolatileLRU' : p.redisConfiguration?.['maxmemory-policy'] ?? 'volatile-lru'}
                onChange={(e) => void (managed ? patch('ev', `${id}/databases/default`, { properties: { evictionPolicy: e.target.value } }, db.reload) : patch('ev', id, { properties: { redisConfiguration: { 'maxmemory-policy': e.target.value } } }, reload))}>
                {POLICIES.map((v) => <option key={v}>{v}</option>)}
              </Select>
            </Field>
            {managed && (
              <>
                <Switch checked={!!db.data?.properties?.persistence?.aofEnabled} onChange={(v) => void patch('aof', `${id}/databases/default`, { properties: { persistence: { ...(db.data?.properties?.persistence ?? {}), aofEnabled: v, rdbEnabled: v ? false : db.data?.properties?.persistence?.rdbEnabled, ...(v ? { aofFrequency: '1s' } : {}) } } }, db.reload)} label={L('Persistenza AOF (ogni secondo)', 'AOF persistence (every second)')} />
                <Switch checked={!!db.data?.properties?.persistence?.rdbEnabled} onChange={(v) => void patch('rdb', `${id}/databases/default`, { properties: { persistence: { ...(db.data?.properties?.persistence ?? {}), rdbEnabled: v, aofEnabled: v ? false : db.data?.properties?.persistence?.aofEnabled, ...(v ? { rdbFrequency: '1h' } : {}) } } }, db.reload)} label={L('Snapshot RDB (ogni ora)', 'RDB snapshots (hourly)')} />
                <p className="small muted">{L('Clustering e moduli si scelgono alla creazione e non si possono cambiare.', 'Clustering and modules are chosen at creation and cannot be changed.')} {db.data?.properties?.modules?.length ? `${L('Moduli', 'Modules')}: ${db.data.properties.modules.map((m: any) => m.name).join(', ')}` : ''}</p>
              </>
            )}
          </div>
        )}
      </Card>
      {busy && <span className="spinner" aria-label="…" />}
    </div>
  );
}

/** Regole firewall (cache Redis classica). */
export function RedisFirewall({ id, apiVersion }: { id: string; apiVersion: string }) {
  const L = useL();
  const toast = useToast();
  const rules = useAsync(async () => (await arm.get<{ value: any[] }>(`${id}/firewallRules`, apiVersion)).value, [id, apiVersion]);
  const [form, setForm] = useState({ name: '', start: '', end: '' });
  const ip = /^(\d{1,3}\.){3}\d{1,3}$/;
  return (
    <Card title={L('Regole del firewall', 'Firewall rules')}>
      {rules.error ? <ErrorNotice error={rules.error} onRetry={rules.reload} /> : !rules.data ? <Skeleton rows={2} /> : (
        <div className="stack" style={{ gap: 10 }}>
          {rules.data.length === 0 && <p className="small muted">{L('Nessuna regola: se l\'accesso pubblico è attivo, la cache accetta connessioni da qualunque IP con la chiave.', 'No rules: with public access on, the cache accepts connections from any IP with the key.')}</p>}
          {rules.data.map((x) => (
            <div className="kv-edit four" key={x.id}>
              <span>{x.name}</span><span className="mono">{x.properties?.startIP}</span><span className="mono">{x.properties?.endIP}</span><span />
              <Button size="sm" variant="ghost" icon={Trash2} aria-label={L('Rimuovi', 'Remove')} onClick={async () => { try { await arm.del(x.id, apiVersion); rules.reload(); } catch (e) { toast.error(e); } }} />
            </div>
          ))}
          <div className="kv-edit four">
            <Input aria-label={L('Nome', 'Name')} placeholder={L('Nome', 'Name')} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <Input aria-label={L('IP iniziale', 'Start IP')} placeholder="203.0.113.10" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value, end: form.end || e.target.value })} />
            <Input aria-label={L('IP finale', 'End IP')} placeholder="203.0.113.10" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} />
            <span />
            <Button size="sm" icon={Plus} disabled={!/^\w{1,80}$/.test(form.name) || !ip.test(form.start) || !ip.test(form.end)}
              onClick={async () => { try { await arm.put(`${id}/firewallRules/${form.name}`, { properties: { startIP: form.start, endIP: form.end } }, apiVersion); setForm({ name: '', start: '', end: '' }); rules.reload(); } catch (e) { toast.error(e); } }}>{L('Aggiungi', 'Add')}</Button>
          </div>
        </div>
      )}
    </Card>
  );
}
