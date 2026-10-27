'use client';

import { useEffect, useState } from 'react';
import { Check, Eye, EyeOff, Globe, Lock, Plus, ShieldCheck, Trash2, X } from 'lucide-react';
import { arm } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useDirectory } from '@/lib/directory';
import { Badge, Button, Card, CopyButton, Empty, ErrorNotice, Field, Input, Notice, Select, Skeleton, Switch } from '../ui';
import { useConfirm, useToast } from '../overlay';
import { useL, WEB_API } from './common';

const STACKS = ['NODE|22-lts', 'NODE|20-lts', 'PYTHON|3.12', 'PYTHON|3.11', 'DOTNETCORE|8.0', 'DOTNETCORE|9.0', 'JAVA|21-java21', 'JAVA|17-java17', 'PHP|8.3'];

type Row = { name: string; value: string };

/** Impostazioni applicazione, stringhe di connessione e impostazioni generali di un'app web. */
export function WebAppConfig({ id }: { id: string }) {
  const L = useL();
  const toast = useToast();
  const settings = useAsync(async () => (await arm.post<any>(`${id}/config/appsettings/list`, {}, WEB_API)).properties ?? {}, [id]);
  const conns = useAsync(async () => (await arm.post<any>(`${id}/config/connectionstrings/list`, {}, WEB_API)).properties ?? {}, [id]);
  const web = useAsync(async () => (await arm.get<any>(`${id}/config/web`, WEB_API)).properties ?? {}, [id]);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [cs, setCs] = useState<{ name: string; value: string; type: string }[] | null>(null);
  const [general, setGeneral] = useState<any>(null);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { if (settings.data) setRows(Object.entries(settings.data).map(([name, value]) => ({ name, value: String(value) }))); }, [settings.data]);
  useEffect(() => { if (conns.data) setCs(Object.entries(conns.data).map(([name, v]: [string, any]) => ({ name, value: String(v?.value ?? ''), type: String(v?.type ?? 'Custom') }))); }, [conns.data]);
  useEffect(() => { if (web.data) setGeneral({ linuxFxVersion: web.data.linuxFxVersion ?? '', alwaysOn: !!web.data.alwaysOn, http20Enabled: web.data.http20Enabled !== false, webSocketsEnabled: !!web.data.webSocketsEnabled, healthCheckPath: web.data.healthCheckPath ?? '', appCommandLine: web.data.appCommandLine ?? '' }); }, [web.data]);

  const save = async (what: string, fn: () => Promise<unknown>, after: () => void) => {
    setBusy(what);
    try { await fn(); toast.ok(L('Configurazione salvata', 'Configuration saved'), L('L\'app viene riavviata per applicare le modifiche.', 'The app restarts to apply the changes.')); after(); }
    catch (e) { toast.error(e); }
    finally { setBusy(null); }
  };
  const dupe = (list: { name: string }[]) => new Set(list.map((r) => r.name.trim().toLowerCase())).size !== list.length;

  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card title={L('Impostazioni applicazione', 'Application settings')} actions={<Button size="sm" variant="ghost" icon={show ? EyeOff : Eye} onClick={() => setShow(!show)}>{show ? L('Nascondi valori', 'Hide values') : L('Mostra valori', 'Show values')}</Button>}>
        <p className="small muted mb-16">{L('Arrivano all\'app come variabili d\'ambiente. Una modifica riavvia l\'app.', 'They reach the app as environment variables. A change restarts the app.')}</p>
        {settings.error ? <ErrorNotice error={settings.error} onRetry={settings.reload} /> : !rows ? <Skeleton rows={3} /> : (
          <div className="stack" style={{ gap: 8 }}>
            {rows.map((r, i) => (
              <div className="kv-edit" key={i}>
                <Input aria-label={L('Nome', 'Name')} value={r.name} placeholder="NOME" onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                <Input aria-label={L('Valore', 'Value')} type={show ? 'text' : 'password'} autoComplete="off" value={r.value} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                <Button variant="ghost" size="sm" icon={Trash2} aria-label={L('Rimuovi', 'Remove')} onClick={() => setRows(rows.filter((_, j) => j !== i))} />
              </div>
            ))}
            {dupe(rows) && <Notice tone="warn">{L('Ci sono nomi ripetuti.', 'Some names are repeated.')}</Notice>}
            <div className="row">
              <Button size="sm" icon={Plus} onClick={() => setRows([...rows, { name: '', value: '' }])}>{L('Nuova impostazione', 'New setting')}</Button>
              <span style={{ flex: 1 }} />
              <Button size="sm" onClick={() => settings.data && setRows(Object.entries(settings.data).map(([name, value]) => ({ name, value: String(value) })))}>{L('Annulla modifiche', 'Discard changes')}</Button>
              <Button size="sm" variant="primary" loading={busy === 'app'} disabled={dupe(rows) || rows.some((r) => !r.name.trim())}
                onClick={() => save('app', () => arm.put(`${id}/config/appsettings`, { properties: Object.fromEntries(rows.map((r) => [r.name.trim(), r.value])) }, WEB_API), settings.reload)}>{L('Salva', 'Save')}</Button>
            </div>
          </div>
        )}
      </Card>

      <Card title={L('Stringhe di connessione', 'Connection strings')}>
        {!cs ? <Skeleton rows={2} /> : (
          <div className="stack" style={{ gap: 8 }}>
            {cs.length === 0 && <p className="small muted">{L('Nessuna stringa di connessione.', 'No connection strings.')}</p>}
            {cs.map((r, i) => (
              <div className="kv-edit three" key={i}>
                <Input aria-label={L('Nome', 'Name')} value={r.name} onChange={(e) => setCs(cs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                <Input aria-label={L('Valore', 'Value')} type={show ? 'text' : 'password'} autoComplete="off" value={r.value} onChange={(e) => setCs(cs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                <Select aria-label={L('Tipo', 'Type')} value={r.type} onChange={(e) => setCs(cs.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))}>
                  {['SQLAzure', 'SQLServer', 'PostgreSQL', 'MySql', 'Custom', 'RedisCache', 'DocDb', 'ServiceBus', 'EventHub', 'NotificationHub', 'ApiHub'].map((t) => <option key={t}>{t}</option>)}
                </Select>
                <Button variant="ghost" size="sm" icon={Trash2} aria-label={L('Rimuovi', 'Remove')} onClick={() => setCs(cs.filter((_, j) => j !== i))} />
              </div>
            ))}
            <div className="row">
              <Button size="sm" icon={Plus} onClick={() => setCs([...cs, { name: '', value: '', type: 'SQLAzure' }])}>{L('Nuova stringa', 'New string')}</Button>
              <span style={{ flex: 1 }} />
              <Button size="sm" variant="primary" loading={busy === 'cs'} disabled={dupe(cs) || cs.some((r) => !r.name.trim())}
                onClick={() => save('cs', () => arm.put(`${id}/config/connectionstrings`, { properties: Object.fromEntries(cs.map((r) => [r.name.trim(), { value: r.value, type: r.type }])) }, WEB_API), conns.reload)}>{L('Salva', 'Save')}</Button>
            </div>
          </div>
        )}
      </Card>

      <Card title={L('Impostazioni generali', 'General settings')}>
        {!general ? <Skeleton rows={4} /> : (
          <>
            <div className="form-grid">
              <Field label={L('Stack e versione', 'Stack and version')} htmlFor="stk">
                <Select id="stk" value={general.linuxFxVersion} onChange={(e) => setGeneral({ ...general, linuxFxVersion: e.target.value })}>
                  {[...new Set([general.linuxFxVersion, ...STACKS])].filter(Boolean).map((s) => <option key={s}>{s}</option>)}
                </Select>
              </Field>
              <Field label={L('Comando di avvio', 'Startup command')} htmlFor="cmd"><Input id="cmd" value={general.appCommandLine} placeholder="npm start" onChange={(e) => setGeneral({ ...general, appCommandLine: e.target.value })} /></Field>
              <Field label={L('Percorso del controllo di integrità', 'Health check path')} htmlFor="hc" hint={L('L\'istanza che non risponde 2xx viene tolta dal bilanciamento.', 'An instance that does not answer 2xx is removed from load balancing.')}>
                <Input id="hc" value={general.healthCheckPath} placeholder="/health" onChange={(e) => setGeneral({ ...general, healthCheckPath: e.target.value })} />
              </Field>
            </div>
            <div className="stack" style={{ gap: 10 }}>
              <Switch checked={general.alwaysOn} onChange={(v) => setGeneral({ ...general, alwaysOn: v })} label={L('Sempre attiva (niente spegnimento quando è inattiva)', 'Always on (no unload when idle)')} />
              <Switch checked={general.http20Enabled} onChange={(v) => setGeneral({ ...general, http20Enabled: v })} label="HTTP/2" />
              <Switch checked={general.webSocketsEnabled} onChange={(v) => setGeneral({ ...general, webSocketsEnabled: v })} label="Web socket" />
            </div>
            <div className="row mt-16" style={{ justifyContent: 'flex-end' }}>
              <Button variant="primary" loading={busy === 'web'} onClick={() => save('web', () => arm.patch(`${id}/config/web`, { properties: { ...general, healthCheckPath: general.healthCheckPath || null } }, WEB_API), web.reload)}>{L('Salva', 'Save')}</Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

/** Domini personalizzati con verifica DNS reale e certificato gestito gratuito. */
export function WebAppDomains({ id, site, reload }: { id: string; site: any; reload: () => void }) {
  const L = useL();
  const toast = useToast();
  const confirm = useConfirm();
  const { real } = useDirectory();
  const list = useAsync(async () => (await arm.get<{ value: any[] }>(`${id}/hostNameBindings`, WEB_API)).value, [id]);
  const [host, setHost] = useState('');
  const [check, setCheck] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const valid = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(host.trim());
  const verify = async () => {
    setBusy('verify'); setCheck(null);
    try { setCheck(await arm.get(`${id}/analyzeCustomHostname`, WEB_API, { hostName: host.trim() })); }
    catch (e) { toast.error(e); }
    finally { setBusy(null); }
  };
  const add = async () => {
    setBusy('add');
    try {
      const h = host.trim().toLowerCase();
      await arm.put(`${id}/hostNameBindings/${h}`, { properties: { siteName: site.name, hostNameType: 'Verified', customHostNameDnsRecordType: check?.properties?.cNameRecords?.length ? 'CName' : 'A', sslState: 'Disabled' } }, WEB_API);
      toast.ok(L('Dominio aggiunto', 'Domain added'), h);
      setHost(''); setCheck(null); list.reload(); reload();
    } catch (e) { toast.error(e); }
    finally { setBusy(null); }
  };
  const secure = async (b: any) => {
    setBusy(b.name);
    try {
      const rg = id.split('/providers/')[0];
      const certName = `${b.name}-${site.name}`.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 80);
      const cert = await arm.put<any>(`${rg}/providers/Microsoft.Web/certificates/${certName}`, { location: site.location, properties: { canonicalName: b.name, serverFarmId: site.properties?.serverFarmId } }, WEB_API);
      await arm.put(`${id}/hostNameBindings/${b.name}`, { properties: { siteName: site.name, sslState: 'SniEnabled', thumbprint: cert.properties.thumbprint } }, WEB_API);
      toast.ok(L('HTTPS attivo', 'HTTPS enabled'), L(`Certificato gestito per ${b.name}`, `Managed certificate for ${b.name}`));
      list.reload(); reload();
    } catch (e) { toast.error(e); }
    finally { setBusy(null); }
  };
  const remove = async (b: any) => {
    if (!(await confirm({ title: L(`Rimuovere ${b.name}?`, `Remove ${b.name}?`), text: L('Il dominio smette di raggiungere l\'app.', 'The domain stops reaching the app.'), danger: true, confirmLabel: L('Rimuovi', 'Remove') }))) return;
    try { await arm.del(b.id, WEB_API); list.reload(); reload(); } catch (e) { toast.error(e); }
  };
  const p = check?.properties;
  const recs = p ? [
    { type: 'TXT', name: p.expected?.txt?.name ?? `asuid.${host}`, value: p.expected?.txt?.value ?? site.properties?.customDomainVerificationId, ok: (p.txtRecords ?? []).includes(p.expected?.txt?.value ?? site.properties?.customDomainVerificationId) },
    { type: 'CNAME', name: host.trim(), value: p.expected?.cname?.value ?? site.properties?.defaultHostName, ok: (p.cNameRecords ?? []).some((c: string) => c.replace(/\.$/, '').toLowerCase() === String(site.properties?.defaultHostName).toLowerCase()) },
    ...(p.expected?.a?.value ? [{ type: L('A (in alternativa)', 'A (alternative)'), name: host.trim(), value: p.expected.a.value, ok: (p.aRecords ?? []).includes(p.expected.a.value) }] : []),
  ] : [];
  const bindings = (list.data ?? []).filter((b) => b.name.toLowerCase() !== String(site.properties?.defaultHostName).toLowerCase());
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card title={L('Domini dell\'app', 'App domains')}>
        <div className="domain-row"><Globe size={16} aria-hidden /><span className="mono">{site.properties?.defaultHostName}</span><Badge tone="ok">{L('predefinito · HTTPS', 'default · HTTPS')}</Badge></div>
        {list.error ? <ErrorNotice error={list.error} onRetry={list.reload} /> : !list.data ? <Skeleton rows={2} /> : bindings.length === 0 ? (
          <Empty icon={Globe} title={L('Nessun dominio personalizzato', 'No custom domain')} text={L('Collega il tuo dominio qui sotto.', 'Connect your domain below.')} />
        ) : bindings.map((b) => (
          <div className="domain-row" key={b.id}>
            <Globe size={16} aria-hidden />
            <span className="mono">{b.name}</span>
            {b.properties?.sslState === 'SniEnabled' ? <Badge tone="ok">{L('HTTPS · certificato gestito', 'HTTPS · managed certificate')}</Badge> : <Badge tone="warn">{L('senza HTTPS', 'no HTTPS')}</Badge>}
            <span style={{ flex: 1 }} />
            {b.properties?.sslState !== 'SniEnabled' && <Button size="sm" icon={Lock} loading={busy === b.name} onClick={() => void secure(b)}>{L('Aggiungi certificato gratuito', 'Add free certificate')}</Button>}
            <Button size="sm" variant="ghost" icon={Trash2} aria-label={L('Rimuovi', 'Remove')} onClick={() => void remove(b)} />
          </div>
        ))}
      </Card>
      <Card title={L('Aggiungi un dominio personalizzato', 'Add a custom domain')}>
        <div className="row wrap" style={{ alignItems: 'flex-end' }}>
          <Field label={L('Dominio', 'Domain')} htmlFor="dom" hint={L('Per esempio www.contoso.it o api.contoso.it', 'For example www.contoso.com or api.contoso.com')}>
            <Input id="dom" value={host} onChange={(e) => { setHost(e.target.value); setCheck(null); }} placeholder="www.contoso.it" style={{ minWidth: 320 }} />
          </Field>
          <Button icon={ShieldCheck} loading={busy === 'verify'} disabled={!valid} onClick={() => void verify()} style={{ marginBottom: 16 }}>{L('Verifica DNS', 'Check DNS')}</Button>
        </div>
        {p && (
          <>
            <p className="small muted mb-16">{L('Crea questi record presso il tuo provider DNS. Il TXT dimostra che il dominio è tuo; il CNAME (o il record A) porta il traffico all\'app.', 'Create these records at your DNS provider. The TXT proves you own the domain; the CNAME (or the A record) sends traffic to the app.')}</p>
            <div className="scroll-x"><table className="table compact">
              <thead><tr><th>{L('Tipo', 'Type')}</th><th>{L('Nome', 'Name')}</th><th>{L('Valore', 'Value')}</th><th>{L('Stato', 'Status')}</th></tr></thead>
              <tbody>{recs.map((r) => (
                <tr key={r.type}>
                  <td className="mono">{r.type}</td>
                  <td className="mono">{r.name}</td>
                  <td><span className="row" style={{ gap: 4 }}><span className="mono">{r.value}</span><CopyButton value={String(r.value)} /></span></td>
                  <td>{r.ok ? <Badge tone="ok"><Check size={12} aria-hidden />{L('trovato', 'found')}</Badge> : <Badge tone="bad"><X size={12} aria-hidden />{L('mancante', 'missing')}</Badge>}</td>
                </tr>
              ))}</tbody>
            </table></div>
            {p.customDomainVerificationTest === 'Passed'
              ? <div className="row mt-16"><Badge tone="ok">{L('Verifica superata', 'Verification passed')}</Badge><span style={{ flex: 1 }} /><Button variant="primary" icon={Plus} loading={busy === 'add'} onClick={() => void add()}>{L('Aggiungi dominio', 'Add domain')}</Button></div>
              : (
                <div className="stack mt-16" style={{ gap: 10 }}>
                  <Notice tone="warn">{p.customDomainVerificationFailureInfo?.message}</Notice>
                  <div className="row">
                    <Button icon={ShieldCheck} loading={busy === 'verify'} onClick={() => void verify()}>{L('Verifica di nuovo', 'Check again')}</Button>
                    {!real && <Button icon={Plus} loading={busy === 'add'} onClick={() => void add()}>{L('Aggiungi comunque (solo emulatore)', 'Add anyway (emulator only)')}</Button>}
                  </div>
                </div>
              )}
          </>
        )}
      </Card>
    </div>
  );
}

type Rule = { name: string; ipAddress?: string; action: string; priority: number; description?: string };

/** HTTPS, TLS, FTP, certificati client, restrizioni IP, identità gestita e autenticazione. */
export function WebAppSecurity({ id, site, reload }: { id: string; site: any; reload: () => void }) {
  const L = useL();
  const toast = useToast();
  const web = useAsync(async () => (await arm.get<any>(`${id}/config/web`, WEB_API)).properties ?? {}, [id]);
  const auth = useAsync(async () => (await arm.get<any>(`${id}/config/authsettingsV2`, WEB_API)).properties ?? {}, [id]);
  const [busy, setBusy] = useState<string | null>(null);
  const [rule, setRule] = useState<Rule>({ name: '', ipAddress: '', action: 'Allow', priority: 100 });
  const [authForm, setAuthForm] = useState<{ enabled: boolean; clientId: string; issuer: string; action: string } | null>(null);
  useEffect(() => {
    if (!auth.data) return;
    const aad = auth.data.identityProviders?.azureActiveDirectory;
    setAuthForm({ enabled: !!auth.data.platform?.enabled, clientId: aad?.registration?.clientId ?? '', issuer: aad?.registration?.openIdIssuer ?? '', action: auth.data.globalValidation?.unauthenticatedClientAction ?? 'RedirectToLoginPage' });
  }, [auth.data]);
  const run = async (key: string, fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(key);
    try { await fn(); toast.ok(L('Salvato', 'Saved')); after?.(); }
    catch (e) { toast.error(e); }
    finally { setBusy(null); }
  };
  const patchSite = (props: any, extra: any = {}) => run('site', () => arm.patch(id, { ...extra, properties: props }, WEB_API), reload);
  const patchWeb = (props: any) => run('web', () => arm.patch(`${id}/config/web`, { properties: props }, WEB_API), web.reload);
  const rules: Rule[] = (web.data?.ipSecurityRestrictions ?? []).filter((r: Rule) => !(r.ipAddress === 'Any' && r.priority === 2147483647));
  const sys = String(site.identity?.type ?? '').includes('SystemAssigned');
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card title={L('Protocolli', 'Protocols')}>
        {!web.data ? <Skeleton rows={3} /> : (
          <>
            <div className="stack" style={{ gap: 12 }}>
              <Switch checked={!!site.properties?.httpsOnly} onChange={(v) => void patchSite({ httpsOnly: v })} label={L('Solo HTTPS: le richieste HTTP vengono reindirizzate', 'HTTPS only: HTTP requests are redirected')} />
              <Switch checked={!!site.properties?.clientCertEnabled} onChange={(v) => void patchSite({ clientCertEnabled: v, clientCertMode: site.properties?.clientCertMode ?? 'Required' })} label={L('Certificati client in ingresso (mTLS)', 'Incoming client certificates (mTLS)')} />
            </div>
            <div className="form-grid mt-16">
              <Field label={L('Versione TLS minima', 'Minimum TLS version')} htmlFor="tls">
                <Select id="tls" value={web.data.minTlsVersion ?? '1.2'} onChange={(e) => void patchWeb({ minTlsVersion: e.target.value })}>{['1.0', '1.1', '1.2', '1.3'].map((v) => <option key={v}>{v}</option>)}</Select>
              </Field>
              <Field label={L('Stato FTP', 'FTP state')} htmlFor="ftp" hint={L('Disattiva FTP se pubblichi da Git o da pipeline.', 'Disable FTP if you deploy from Git or pipelines.')}>
                <Select id="ftp" value={web.data.ftpsState ?? 'FtpsOnly'} onChange={(e) => void patchWeb({ ftpsState: e.target.value })}>
                  <option value="AllAllowed">{L('FTP e FTPS', 'FTP and FTPS')}</option><option value="FtpsOnly">{L('Solo FTPS', 'FTPS only')}</option><option value="Disabled">{L('Disattivato', 'Disabled')}</option>
                </Select>
              </Field>
              {site.properties?.clientCertEnabled && (
                <Field label={L('Modalità certificato client', 'Client certificate mode')} htmlFor="ccm">
                  <Select id="ccm" value={site.properties?.clientCertMode ?? 'Required'} onChange={(e) => void patchSite({ clientCertMode: e.target.value })}>
                    <option value="Required">{L('Obbligatorio', 'Required')}</option><option value="Optional">{L('Facoltativo', 'Optional')}</option><option value="OptionalInteractiveUser">{L('Facoltativo, interattivo', 'Optional, interactive')}</option>
                  </Select>
                </Field>
              )}
            </div>
          </>
        )}
      </Card>

      <Card title={L('Restrizioni di accesso', 'Access restrictions')}>
        {!web.data ? <Skeleton rows={2} /> : (
          <div className="stack" style={{ gap: 12 }}>
            <Field label={L('Azione per il traffico che non corrisponde a nessuna regola', 'Action for traffic matching no rule')} htmlFor="dflt">
              <Select id="dflt" value={web.data.ipSecurityRestrictionsDefaultAction ?? 'Allow'} onChange={(e) => void patchWeb({ ipSecurityRestrictionsDefaultAction: e.target.value })}>
                <option value="Allow">{L('Consenti', 'Allow')}</option><option value="Deny">{L('Nega', 'Deny')}</option>
              </Select>
            </Field>
            {rules.length > 0 && (
              <div className="scroll-x"><table className="table compact">
                <thead><tr><th>{L('Priorità', 'Priority')}</th><th>{L('Nome', 'Name')}</th><th>{L('Origine', 'Source')}</th><th>{L('Azione', 'Action')}</th><th /></tr></thead>
                <tbody>{rules.sort((a, b) => a.priority - b.priority).map((r) => (
                  <tr key={r.name + r.priority}>
                    <td className="num">{r.priority}</td><td>{r.name}</td><td className="mono">{r.ipAddress}</td>
                    <td><Badge tone={r.action === 'Allow' ? 'ok' : 'bad'}>{r.action === 'Allow' ? L('Consenti', 'Allow') : L('Nega', 'Deny')}</Badge></td>
                    <td><Button size="sm" variant="ghost" icon={Trash2} aria-label={L('Rimuovi', 'Remove')} onClick={() => void patchWeb({ ipSecurityRestrictions: (web.data.ipSecurityRestrictions ?? []).filter((x: Rule) => x !== r) })} /></td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
            <div className="kv-edit four">
              <Input aria-label={L('Nome', 'Name')} placeholder={L('Nome della regola', 'Rule name')} value={rule.name} onChange={(e) => setRule({ ...rule, name: e.target.value })} />
              <Input aria-label="CIDR" placeholder="203.0.113.0/24" value={rule.ipAddress} onChange={(e) => setRule({ ...rule, ipAddress: e.target.value })} />
              <Select aria-label={L('Azione', 'Action')} value={rule.action} onChange={(e) => setRule({ ...rule, action: e.target.value })}><option value="Allow">{L('Consenti', 'Allow')}</option><option value="Deny">{L('Nega', 'Deny')}</option></Select>
              <Input aria-label={L('Priorità', 'Priority')} type="number" min={1} value={rule.priority} onChange={(e) => setRule({ ...rule, priority: Number(e.target.value) })} />
              <Button size="sm" icon={Plus} disabled={!rule.name || !/^[\d.:a-f]+\/\d{1,3}$/i.test(rule.ipAddress ?? '')}
                onClick={() => void patchWeb({ ipSecurityRestrictions: [...(web.data.ipSecurityRestrictions ?? []), { ...rule, tag: 'Default' }] }).then(() => setRule({ name: '', ipAddress: '', action: 'Allow', priority: rule.priority + 10 }))}>{L('Aggiungi', 'Add')}</Button>
            </div>
          </div>
        )}
      </Card>

      <Card title={L('Identità gestita', 'Managed identity')}>
        <Switch checked={sys} onChange={(v) => void patchSite(undefined, { identity: { type: v ? 'SystemAssigned' : 'None' } })} label={L('Identità assegnata dal sistema', 'System-assigned identity')} />
        {sys && site.identity?.principalId && <p className="small muted mt-8">{L('ID oggetto', 'Object ID')}: <span className="mono">{site.identity.principalId}</span> <CopyButton value={site.identity.principalId} /></p>}
        <p className="small muted mt-8">{L('Usala per dare all\'app accesso a Key Vault, archiviazione o database senza segreti.', 'Use it to give the app access to Key Vault, storage or databases without secrets.')}</p>
      </Card>

      <Card title={L('Autenticazione', 'Authentication')}>
        {!authForm ? <Skeleton rows={3} /> : (
          <>
            <Switch checked={authForm.enabled} onChange={(v) => setAuthForm({ ...authForm, enabled: v })} label={L('Richiedi l\'accesso con Microsoft Entra ID', 'Require sign-in with Microsoft Entra ID')} />
            {authForm.enabled && (
              <div className="form-grid mt-16">
                <Field label={L('ID applicazione (client)', 'Application (client) ID')} htmlFor="cid"><Input id="cid" value={authForm.clientId} onChange={(e) => setAuthForm({ ...authForm, clientId: e.target.value })} placeholder="00000000-0000-0000-0000-000000000000" /></Field>
                <Field label={L('URL dell\'emittente', 'Issuer URL')} htmlFor="iss"><Input id="iss" value={authForm.issuer} onChange={(e) => setAuthForm({ ...authForm, issuer: e.target.value })} placeholder="https://login.microsoftonline.com/<tenant>/v2.0" /></Field>
                <Field label={L('Richieste non autenticate', 'Unauthenticated requests')} htmlFor="ua">
                  <Select id="ua" value={authForm.action} onChange={(e) => setAuthForm({ ...authForm, action: e.target.value })}>
                    <option value="RedirectToLoginPage">{L('Reindirizza alla pagina di accesso', 'Redirect to sign-in page')}</option>
                    <option value="Return401">{L('Rispondi 401', 'Return 401')}</option>
                    <option value="Return403">{L('Rispondi 403', 'Return 403')}</option>
                    <option value="AllowAnonymous">{L('Consenti senza accesso', 'Allow anonymous')}</option>
                  </Select>
                </Field>
              </div>
            )}
            <div className="row mt-16" style={{ justifyContent: 'flex-end' }}>
              <Button variant="primary" loading={busy === 'auth'} disabled={authForm.enabled && !/^[0-9a-f-]{36}$/i.test(authForm.clientId)}
                onClick={() => void run('auth', () => arm.put(`${id}/config/authsettingsV2`, { properties: {
                  platform: { enabled: authForm.enabled, runtimeVersion: '~1' },
                  globalValidation: { requireAuthentication: authForm.action !== 'AllowAnonymous', unauthenticatedClientAction: authForm.action, redirectToProvider: 'azureactivedirectory' },
                  identityProviders: { azureActiveDirectory: { enabled: authForm.enabled, registration: { clientId: authForm.clientId, openIdIssuer: authForm.issuer || undefined }, validation: { allowedAudiences: authForm.clientId ? [`api://${authForm.clientId}`] : [] } } },
                  login: { tokenStore: { enabled: true } },
                } }, WEB_API), auth.reload)}>{L('Salva', 'Save')}</Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
