'use client';

import { useMemo, useState } from 'react';
import { Database, Plus, RotateCcw, Search, Trash2 } from 'lucide-react';
import { arm } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { money } from '@/lib/money';
import { useI18n } from '@/i18n';
import { Badge, Button, Card, CodeBlock, Empty, ErrorNotice, Field, Input, Notice, Select, Skeleton, Switch } from '../ui';
import { Panel, useConfirm, useToast } from '../overlay';
import { loadPricing, type PriceType } from '../pricing';
import { useL } from './common';

export type DbKind = 'sql' | 'postgres' | 'mysql';
export const dbKind = (type: string): DbKind | null => {
  const t = type.toLowerCase();
  if (t === 'microsoft.sql/servers') return 'sql';
  if (t === 'microsoft.dbforpostgresql/flexibleservers') return 'postgres';
  if (t === 'microsoft.dbformysql/flexibleservers') return 'mysql';
  return null;
};
const API: Record<DbKind, string> = { sql: '2023-08-01-preview', postgres: '2024-08-01', mysql: '2023-12-30' };

const SQL_TIERS = [
  { sku: 'Basic', tier: 'Basic', it: 'Basic · 5 DTU · per test e piccoli carichi', en: 'Basic · 5 DTU · for tests and small loads', maxGb: [2] },
  { sku: 'S0', tier: 'Standard', it: 'Standard S0 · 10 DTU', en: 'Standard S0 · 10 DTU', maxGb: [10, 50, 100, 250] },
  { sku: 'S1', tier: 'Standard', it: 'Standard S1 · 20 DTU', en: 'Standard S1 · 20 DTU', maxGb: [10, 50, 100, 250] },
  { sku: 'GP_S_Gen5', tier: 'GeneralPurpose', family: 'Gen5', capacity: 1, it: 'Serverless · si ferma da solo quando non lo usi', en: 'Serverless · pauses itself when idle', maxGb: [32, 64, 128, 256] },
  { sku: 'GP_Gen5', tier: 'GeneralPurpose', family: 'Gen5', capacity: 2, it: 'Per uso generico · 2 vCore', en: 'General Purpose · 2 vCores', maxGb: [32, 64, 128, 256, 512] },
  { sku: 'BC_Gen5', tier: 'BusinessCritical', family: 'Gen5', capacity: 2, it: 'Business Critical · 2 vCore · bassa latenza', en: 'Business Critical · 2 vCores · low latency', maxGb: [32, 64, 128, 256] },
];

/** Database di un server: elenco e aggiunta guidata. */
export function DbDatabases({ serverId, server, kind }: { serverId: string; server: any; kind: DbKind }) {
  const L = useL();
  const { locale } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const list = useAsync(async () => (await arm.get<{ value: any[] }>(`${serverId}/databases`, API[kind])).value.filter((d) => !(kind === 'sql' && d.name === 'master') && !['azure_maintenance', 'azure_sys', 'information_schema', 'mysql', 'performance_schema', 'sys'].includes(d.name)), [serverId]);
  const pools = useAsync(async () => (kind === 'sql' ? (await arm.get<{ value: any[] }>(`${serverId}/elasticPools`, API.sql)).value : []), [serverId]);
  const pricing = useAsync(() => loadPricing(), []);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [tier, setTier] = useState('GP_S_Gen5');
  const [maxGb, setMaxGb] = useState(32);
  const [collation, setCollation] = useState(kind === 'sql' ? 'SQL_Latin1_General_CP1_CI_AS' : kind === 'postgres' ? 'en_US.utf8' : 'utf8mb4_0900_ai_ci');
  const [charset, setCharset] = useState(kind === 'postgres' ? 'UTF8' : 'utf8mb4');
  const [backup, setBackup] = useState('Local');
  const [pool, setPool] = useState('');
  const [busy, setBusy] = useState(false);
  const priceOf = (sku: string) => {
    const p = (pricing.data?.types as PriceType[] | undefined)?.find((x) => x.type === 'Microsoft.Sql/servers/databases');
    const pl = p?.plans.find((x) => x.sku === sku);
    const t = SQL_TIERS.find((x) => x.sku === sku);
    if (!pl) return null;
    if (pl.monthly !== null) return pl.monthly * (t?.capacity && pl.hourly ? t.capacity : 1);
    return null;
  };
  const nameOk = kind === 'sql' ? /^[^<>*%&:\\/?]{1,128}$/.test(name) && !/[. ]$/.test(name) : /^[a-zA-Z_][a-zA-Z0-9_$-]{0,62}$/.test(name);
  const t = SQL_TIERS.find((x) => x.sku === tier)!;
  const create = async () => {
    setBusy(true);
    try {
      const body = kind === 'sql'
        ? {
          location: server.location,
          sku: pool ? undefined : { name: t.sku, tier: t.tier, ...(t.family ? { family: t.family, capacity: t.capacity } : {}) },
          properties: { collation, maxSizeBytes: maxGb * 1024 ** 3, requestedBackupStorageRedundancy: backup, ...(pool ? { elasticPoolId: pool } : {}), ...(t.sku === 'GP_S_Gen5' ? { autoPauseDelay: 60, minCapacity: 0.5 } : {}) },
        }
        : { properties: { charset, collation } };
      await arm.put(`${serverId}/databases/${encodeURIComponent(name)}`, body, API[kind]);
      toast.ok(L('Database creato', 'Database created'), name);
      setOpen(false); setName(''); list.reload();
    } catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row"><Button variant="primary" icon={Plus} onClick={() => setOpen(true)}>{L('Aggiungi database', 'Add database')}</Button></div>
      {list.error ? <ErrorNotice error={list.error} onRetry={list.reload} /> : !list.data ? <Skeleton rows={3} /> : list.data.length === 0 ? (
        <Empty icon={Database} title={L('Nessun database', 'No databases')} text={L('Il server è pronto: aggiungi il primo database.', 'The server is ready: add the first database.')} action={<Button variant="primary" icon={Plus} onClick={() => setOpen(true)}>{L('Aggiungi database', 'Add database')}</Button>} />
      ) : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>{L('Nome', 'Name')}</th>{kind === 'sql' ? <><th>{L('Piano', 'Plan')}</th><th>{L('Dimensione massima', 'Max size')}</th><th>{L('Stato', 'Status')}</th></> : <><th>Charset</th><th>Collation</th></>}<th /></tr></thead>
          <tbody>{list.data.map((d) => (
            <tr key={d.id}>
              <td><div className="cell-main"><Database size={16} aria-hidden /><a href={`/resource?id=${encodeURIComponent(d.id)}`}>{d.name}</a></div></td>
              {kind === 'sql'
                ? <><td className="mono">{d.properties?.elasticPoolId ? L('pool elastico', 'elastic pool') : d.sku?.name}</td><td className="num">{d.properties?.maxSizeBytes ? `${Math.round(d.properties.maxSizeBytes / 1024 ** 3)} GB` : '—'}</td><td><Badge tone="ok">{d.properties?.status ?? 'Online'}</Badge></td></>
                : <><td className="mono">{d.properties?.charset}</td><td className="mono">{d.properties?.collation}</td></>}
              <td style={{ textAlign: 'right' }}><Button size="sm" variant="ghost" icon={Trash2} aria-label={L('Elimina', 'Delete')} onClick={async () => {
                if (!(await confirm({ title: L(`Eliminare il database ${d.name}?`, `Delete database ${d.name}?`), text: L('I dati vengono persi.', 'The data is lost.'), danger: true, confirmLabel: L('Elimina', 'Delete'), typeToConfirm: d.name }))) return;
                try { await arm.del(d.id, API[kind]); list.reload(); } catch (e) { toast.error(e); }
              }} /></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      <Panel open={open} onClose={() => setOpen(false)} title={L('Nuovo database', 'New database')} subtitle={`PUT ${serverId.split('/').slice(-3).join('/')}/databases/${name || '{nome}'}`}
        footer={<><Button variant="primary" loading={busy} disabled={!nameOk} onClick={() => void create()}>{L('Crea', 'Create')}</Button><Button onClick={() => setOpen(false)}>{L('Annulla', 'Cancel')}</Button></>}>
        <div className="stack" style={{ gap: 4 }}>
          <Field label={L('Nome del database', 'Database name')} htmlFor="dbn" error={name && !nameOk ? L('Nome non valido', 'Invalid name') : undefined}><Input id="dbn" value={name} autoFocus onChange={(e) => setName(e.target.value)} /></Field>
          {kind === 'sql' ? (
            <>
              {(pools.data ?? []).length > 0 && (
                <Field label={L('Pool elastico', 'Elastic pool')} htmlFor="pool" hint={L('Nel pool il database condivide le risorse e non ha un piano proprio.', 'In a pool the database shares resources and has no plan of its own.')}>
                  <Select id="pool" value={pool} onChange={(e) => setPool(e.target.value)}><option value="">{L('Nessuno', 'None')}</option>{pools.data!.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
                </Field>
              )}
              {!pool && (
                <Field label={L('Piano di calcolo', 'Compute tier')}>
                  <div className="radio-cards">{SQL_TIERS.map((x) => {
                    const price = priceOf(x.sku);
                    return (
                      <label className="radio-card" key={x.sku}>
                        <input type="radio" name="tier" checked={tier === x.sku} onChange={() => { setTier(x.sku); setMaxGb(x.maxGb[0]); }} />
                        <span><strong className="mono">{x.sku}</strong><br /><span className="small muted">{locale === 'it' ? x.it : x.en}</span><br /><span className="small">{price !== null ? `${money(price, locale)} ${L('al mese', 'per month')}` : L('a consumo: si paga il calcolo usato', 'usage-based: you pay for compute used')}</span></span>
                      </label>
                    );
                  })}</div>
                </Field>
              )}
              <div className="form-grid">
                <Field label={L('Dimensione massima', 'Max size')} htmlFor="mx"><Select id="mx" value={maxGb} onChange={(e) => setMaxGb(Number(e.target.value))}>{(pool ? [32, 64, 128, 256] : t.maxGb).map((g) => <option key={g} value={g}>{g} GB</option>)}</Select></Field>
                <Field label={L('Ridondanza dei backup', 'Backup redundancy')} htmlFor="bk"><Select id="bk" value={backup} onChange={(e) => setBackup(e.target.value)}><option value="Local">{L('Locale (LRS)', 'Local (LRS)')}</option><option value="Zone">{L('Zona (ZRS)', 'Zone (ZRS)')}</option><option value="Geo">{L('Geografica (GRS)', 'Geo (GRS)')}</option></Select></Field>
                <Field label="Collation" htmlFor="col"><Input id="col" value={collation} onChange={(e) => setCollation(e.target.value)} /></Field>
              </div>
            </>
          ) : (
            <div className="form-grid">
              <Field label="Charset" htmlFor="cs"><Select id="cs" value={charset} onChange={(e) => setCharset(e.target.value)}>{(kind === 'postgres' ? ['UTF8', 'LATIN1', 'SQL_ASCII'] : ['utf8mb4', 'utf8mb3', 'latin1']).map((c) => <option key={c}>{c}</option>)}</Select></Field>
              <Field label="Collation" htmlFor="col"><Select id="col" value={collation} onChange={(e) => setCollation(e.target.value)}>{(kind === 'postgres' ? ['en_US.utf8', 'it_IT.utf8', 'C', 'POSIX'] : ['utf8mb4_0900_ai_ci', 'utf8mb4_general_ci', 'utf8mb4_unicode_ci', 'utf8mb4_bin']).map((c) => <option key={c}>{c}</option>)}</Select></Field>
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}

/** Parametri del server (PostgreSQL / MySQL flessibili). */
export function DbParams({ serverId, kind }: { serverId: string; kind: DbKind }) {
  const L = useL();
  const toast = useToast();
  const list = useAsync(async () => (await arm.get<{ value: any[] }>(`${serverId}/configurations`, API[kind])).value, [serverId]);
  const [q, setQ] = useState('');
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const rows = useMemo(() => (list.data ?? []).filter((p) => (!q || `${p.name} ${p.properties.description}`.toLowerCase().includes(q.toLowerCase())) && (!onlyChanged || p.properties.source === 'user-override' || p.name in edits)), [list.data, q, onlyChanged, edits]);
  const pending = Object.keys(edits).length;
  const restart = (list.data ?? []).some((p) => p.name in edits && !p.properties.isDynamicConfig);
  const save = async () => {
    setBusy(true);
    try {
      for (const [name, value] of Object.entries(edits)) await arm.put(`${serverId}/configurations/${name}`, { properties: { value, source: 'user-override' } }, API[kind]);
      toast.ok(L('Parametri salvati', 'Parameters saved'), restart ? L('Alcuni richiedono il riavvio del server.', 'Some require a server restart.') : undefined);
      setEdits({}); list.reload();
    } catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  const control = (p: any) => {
    const v = edits[p.name] ?? p.properties.value;
    const set = (x: string) => setEdits((e) => { const n = { ...e }; if (x === p.properties.value) delete n[p.name]; else n[p.name] = x; return n; });
    if (p.properties.isReadOnly) return <span className="mono">{v}</span>;
    if (p.properties.dataType === 'Boolean' || p.properties.dataType === 'Enumeration') return <Select aria-label={p.name} value={v} onChange={(e) => set(e.target.value)}>{String(p.properties.allowedValues).split(',').map((o: string) => <option key={o}>{o}</option>)}</Select>;
    return <Input aria-label={p.name} value={v} onChange={(e) => set(e.target.value)} />;
  };
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row wrap">
        <div className="input-icon"><Search size={16} aria-hidden /><Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={L('Cerca un parametro', 'Search a parameter')} aria-label={L('Cerca un parametro', 'Search a parameter')} /></div>
        <Switch checked={onlyChanged} onChange={setOnlyChanged} label={L('Solo modificati', 'Changed only')} />
        <span style={{ flex: 1 }} />
        {pending > 0 && <Button onClick={() => setEdits({})}>{L('Annulla', 'Discard')}</Button>}
        <Button variant="primary" loading={busy} disabled={!pending} onClick={() => void save()}>{pending ? L(`Salva ${pending} modifiche`, `Save ${pending} changes`) : L('Salva', 'Save')}</Button>
      </div>
      {restart && <Notice tone="warn">{L('Hai cambiato parametri statici: valgono dopo il riavvio del server.', 'You changed static parameters: they apply after a server restart.')}</Notice>}
      {list.error ? <ErrorNotice error={list.error} onRetry={list.reload} /> : !list.data ? <Skeleton rows={6} /> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>{L('Parametro', 'Parameter')}</th><th style={{ width: 280 }}>{L('Valore', 'Value')}</th><th>{L('Predefinito', 'Default')}</th><th>{L('Tipo', 'Type')}</th><th /></tr></thead>
          <tbody>{rows.map((p) => (
            <tr key={p.name} className={p.name in edits ? 'current' : ''}>
              <td><div className="mono">{p.name}</div><div className="small muted" style={{ whiteSpace: 'normal', maxWidth: 520 }}>{p.properties.description}{p.properties.unit ? ` (${p.properties.unit})` : ''}</div></td>
              <td>{control(p)}</td>
              <td className="mono small">{p.properties.defaultValue || '—'}</td>
              <td>{p.properties.isReadOnly ? <Badge>{L('sola lettura', 'read-only')}</Badge> : p.properties.isDynamicConfig ? <Badge tone="ok">{L('dinamico', 'dynamic')}</Badge> : <Badge tone="warn">{L('serve riavvio', 'needs restart')}</Badge>}</td>
              <td>{p.properties.source === 'user-override' && !p.properties.isReadOnly && <Button size="sm" variant="ghost" icon={RotateCcw} aria-label={L('Ripristina il predefinito', 'Reset to default')} title={L('Ripristina il predefinito', 'Reset to default')} onClick={() => setEdits((e) => ({ ...e, [p.name]: p.properties.defaultValue }))} />}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  );
}

/** Rete: accesso pubblico, servizi Azure, regole firewall, TLS minimo. */
export function DbNetworking({ serverId, server, kind, reload }: { serverId: string; server: any; kind: DbKind; reload: () => void }) {
  const L = useL();
  const toast = useToast();
  const rules = useAsync(async () => (await arm.get<{ value: any[] }>(`${serverId}/firewallRules`, API[kind])).value, [serverId]);
  const [form, setForm] = useState({ name: '', start: '', end: '' });
  const [busy, setBusy] = useState<string | null>(null);
  const azureRule = (rules.data ?? []).find((r) => r.properties?.startIpAddress === '0.0.0.0' && r.properties?.endIpAddress === '0.0.0.0');
  const publicOn = kind === 'sql' ? server.properties?.publicNetworkAccess !== 'Disabled' : (server.properties?.network?.publicNetworkAccess ?? 'Enabled') !== 'Disabled';
  const ip = /^(\d{1,3}\.){3}\d{1,3}$/;
  const act = async (key: string, fn: () => Promise<unknown>, after: () => void) => {
    setBusy(key);
    try { await fn(); after(); } catch (e) { toast.error(e); } finally { setBusy(null); }
  };
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card title={L('Accesso', 'Access')}>
        <div className="stack" style={{ gap: 12 }}>
          <Switch checked={publicOn} onChange={(v) => void act('pub', () => arm.patch(serverId, { properties: kind === 'sql' ? { publicNetworkAccess: v ? 'Enabled' : 'Disabled' } : { network: { ...(server.properties?.network ?? {}), publicNetworkAccess: v ? 'Enabled' : 'Disabled' } } }, API[kind]), reload)} label={L('Accesso dalla rete pubblica', 'Public network access')} />
          <Switch checked={!!azureRule} onChange={(v) => void act('azure', () => (v
            ? arm.put(`${serverId}/firewallRules/${kind === 'sql' ? 'AllowAllWindowsAzureIps' : `AllowAllAzureServicesAndResourcesWithinAzureIps_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`}`, { properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' } }, API[kind])
            : arm.del(azureRule!.id, API[kind])), rules.reload)} label={L('Consenti ai servizi e alle risorse di Azure di accedere al server', 'Allow Azure services and resources to access this server')} />
          {kind === 'sql' && (
            <Field label={L('Versione TLS minima', 'Minimum TLS version')} htmlFor="tls">
              <Select id="tls" value={server.properties?.minimalTlsVersion ?? '1.2'} onChange={(e) => void act('tls', () => arm.patch(serverId, { properties: { minimalTlsVersion: e.target.value } }, API.sql), reload)}>{['1.0', '1.1', '1.2', '1.3'].map((v) => <option key={v}>{v}</option>)}</Select>
            </Field>
          )}
        </div>
      </Card>
      <Card title={L('Regole del firewall', 'Firewall rules')}>
        {rules.error ? <ErrorNotice error={rules.error} onRetry={rules.reload} /> : !rules.data ? <Skeleton rows={2} /> : (
          <div className="stack" style={{ gap: 10 }}>
            {rules.data.filter((r) => r !== azureRule).map((r) => (
              <div className="kv-edit four" key={r.id}>
                <span>{r.name}</span><span className="mono">{r.properties?.startIpAddress}</span><span className="mono">{r.properties?.endIpAddress}</span><span />
                <Button size="sm" variant="ghost" icon={Trash2} aria-label={L('Rimuovi', 'Remove')} onClick={() => void act(r.id, () => arm.del(r.id, API[kind]), rules.reload)} />
              </div>
            ))}
            <div className="kv-edit four">
              <Input aria-label={L('Nome della regola', 'Rule name')} placeholder={L('Nome della regola', 'Rule name')} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <Input aria-label={L('IP iniziale', 'Start IP')} placeholder="203.0.113.10" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value, end: form.end || e.target.value })} />
              <Input aria-label={L('IP finale', 'End IP')} placeholder="203.0.113.10" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} />
              <span />
              <Button size="sm" icon={Plus} loading={busy === 'add'} disabled={!/^[\w.-]{1,128}$/.test(form.name) || !ip.test(form.start) || !ip.test(form.end)}
                onClick={() => void act('add', () => arm.put(`${serverId}/firewallRules/${form.name}`, { properties: { startIpAddress: form.start, endIpAddress: form.end } }, API[kind]), () => { setForm({ name: '', start: '', end: '' }); rules.reload(); })}>{L('Aggiungi', 'Add')}</Button>
            </div>
            <p className="small muted">{L('Per collegarti da questo computer aggiungi il tuo IP pubblico (lo trovi cercando «what is my ip»).', 'To connect from this computer add your public IP (search "what is my ip").')}</p>
          </div>
        )}
      </Card>
    </div>
  );
}

/** Stringhe di connessione pronte per i linguaggi più usati (come nel portale Azure, calcolate qui). */
export function DbConnect({ server, kind, database }: { server: any; kind: DbKind; database?: string }) {
  const L = useL();
  const dbs = useAsync(async () => (database ? [] : (await arm.get<{ value: any[] }>(`${server.id}/databases`, API[kind])).value.map((d) => d.name).filter((n: string) => !['master', 'azure_maintenance', 'azure_sys', 'information_schema', 'mysql', 'performance_schema', 'sys'].includes(n))), [server.id, database]);
  const [db, setDb] = useState(database ?? '');
  const name = db || database || dbs.data?.[0] || (kind === 'sql' ? 'mydb' : kind === 'postgres' ? 'postgres' : 'mysql');
  const host = server.properties?.fullyQualifiedDomainName ?? '';
  const user = server.properties?.administratorLogin ?? (kind === 'sql' ? 'sqladmin' : 'dbadmin');
  const snippets: [string, string][] = kind === 'sql' ? [
    ['ADO.NET', `Server=tcp:${host},1433;Initial Catalog=${name};Persist Security Info=False;User ID=${user};Password={your_password};MultipleActiveResultSets=False;Encrypt=True;TrustServerCertificate=False;Connection Timeout=30;`],
    [L('ADO.NET con Microsoft Entra (senza password)', 'ADO.NET with Microsoft Entra (passwordless)'), `Server=tcp:${host},1433;Initial Catalog=${name};Encrypt=True;TrustServerCertificate=False;Connection Timeout=30;Authentication="Active Directory Default";`],
    ['JDBC', `jdbc:sqlserver://${host}:1433;database=${name};user=${user}@${host.split('.')[0]};password={your_password};encrypt=true;trustServerCertificate=false;hostNameInCertificate=*.database.windows.net;loginTimeout=30;`],
    ['ODBC', `Driver={ODBC Driver 18 for SQL Server};Server=tcp:${host},1433;Database=${name};Uid=${user};Pwd={your_password};Encrypt=yes;TrustServerCertificate=no;Connection Timeout=30;`],
    ['Node.js (mssql)', `const config = {\n  server: '${host}',\n  database: '${name}',\n  user: '${user}',\n  password: process.env.SQL_PASSWORD,\n  options: { encrypt: true },\n};`],
    ['sqlcmd', `sqlcmd -S ${host} -d ${name} -U ${user} -P '<password>' -N`],
  ] : kind === 'postgres' ? [
    ['psql', `psql "host=${host} port=5432 dbname=${name} user=${user} sslmode=require"`],
    ['JDBC', `jdbc:postgresql://${host}:5432/${name}?user=${user}&password={your_password}&sslmode=require`],
    ['.NET (Npgsql)', `Server=${host};Database=${name};Port=5432;User Id=${user};Password={your_password};Ssl Mode=Require;`],
    ['Node.js (pg)', `PGHOST=${host}\nPGPORT=5432\nPGDATABASE=${name}\nPGUSER=${user}\nPGPASSWORD=<password>\nPGSSLMODE=require`],
    ['Python (psycopg)', `psycopg.connect(host="${host}", dbname="${name}", user="${user}", password=os.environ["PGPASSWORD"], sslmode="require")`],
  ] : [
    ['mysql', `mysql -h ${host} -u ${user} -p --ssl-mode=REQUIRED ${name}`],
    ['JDBC', `jdbc:mysql://${host}:3306/${name}?useSSL=true&requireSSL=true`],
    ['.NET (MySqlConnector)', `Server=${host};Port=3306;Database=${name};Uid=${user};Pwd={your_password};SslMode=Required;`],
    ['Node.js (mysql2)', `mysql.createConnection({ host: '${host}', user: '${user}', password: process.env.MYSQL_PASSWORD, database: '${name}', ssl: { rejectUnauthorized: true } })`],
  ];
  return (
    <div className="stack" style={{ gap: 14 }}>
      {!database && (dbs.data?.length ?? 0) > 0 && (
        <Field label={L('Database', 'Database')} htmlFor="cdb"><Select id="cdb" value={name} onChange={(e) => setDb(e.target.value)}>{dbs.data!.map((d: string) => <option key={d}>{d}</option>)}</Select></Field>
      )}
      <Notice>{L('La password non è mai mostrata: sostituisci il segnaposto o usa l\'accesso con Microsoft Entra.', 'The password is never shown: replace the placeholder or use Microsoft Entra sign-in.')}</Notice>
      {snippets.map(([label, code]) => (
        <Card key={label} title={label}><CodeBlock value={code} /></Card>
      ))}
    </div>
  );
}
