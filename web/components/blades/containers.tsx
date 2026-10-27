'use client';

import { useEffect, useState } from 'react';
import { Activity, Plus, Power, RotateCw, Save, Send, Trash2, Webhook } from 'lucide-react';
import { arm } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { money } from '@/lib/money';
import { useI18n } from '@/i18n';
import { Badge, Button, Card, Checkbox, CodeBlock, CopyButton, Empty, ErrorNotice, Field, Input, Notice, Select, SecretValue, Skeleton, Switch } from '../ui';
import { Panel, useConfirm, useToast } from '../overlay';
import { loadPricing, type PriceType } from '../pricing';
import { useL } from './common';
import { KeysCard } from './keys';

export const CA_API = '2024-03-01';
export const ACR_API = '2023-07-01';
export const AKS_API = '2024-09-01';

// ---------------- App contenitore ----------------

/** Ingresso HTTP: esposizione, porta, trasporto. */
export function CaIngress({ id, app, reload }: { id: string; app: any; reload: () => void }) {
  const L = useL();
  const toast = useToast();
  const ing = app.properties?.configuration?.ingress ?? null;
  const [on, setOn] = useState(!!ing);
  const [f, setF] = useState({ external: ing?.external ?? true, targetPort: ing?.targetPort ?? 80, transport: ing?.transport ?? 'auto', allowInsecure: !!ing?.allowInsecure });
  const [busy, setBusy] = useState(false);
  useEffect(() => { setOn(!!ing); setF({ external: ing?.external ?? true, targetPort: ing?.targetPort ?? 80, transport: ing?.transport ?? 'auto', allowInsecure: !!ing?.allowInsecure }); }, [app]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    setBusy(true);
    try {
      await arm.patch(id, { properties: { configuration: { ingress: on ? { ...(ing ?? {}), external: f.external, targetPort: Number(f.targetPort), transport: f.transport, allowInsecure: f.allowInsecure } : null } } }, CA_API);
      toast.ok(L('Ingresso aggiornato', 'Ingress updated'));
      reload();
    } catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  const portOk = Number.isInteger(Number(f.targetPort)) && Number(f.targetPort) > 0 && Number(f.targetPort) < 65536;
  return (
    <Card title={L('Ingresso', 'Ingress')} actions={<Button variant="primary" icon={Save} loading={busy} disabled={on && !portOk} onClick={() => void save()}>{L('Salva', 'Save')}</Button>}>
      <div className="stack" style={{ gap: 12 }}>
        {ing?.fqdn && <p style={{ margin: 0 }}><a className="mono" href={`https://${ing.fqdn}`} target="_blank" rel="noreferrer">https://{ing.fqdn}</a> <CopyButton value={`https://${ing.fqdn}`} /></p>}
        <Switch checked={on} onChange={setOn} label={L('Accetta traffico HTTP o TCP', 'Accept HTTP or TCP traffic')} />
        {on && (
          <>
            <div className="radio-cards">
              <label className="radio-card"><input type="radio" name="ext" checked={f.external} onChange={() => setF({ ...f, external: true })} /><span><strong>{L('Da Internet', 'From the Internet')}</strong><br /><span className="small muted">{L('Chiunque raggiunge l\'URL pubblico.', 'Anyone can reach the public URL.')}</span></span></label>
              <label className="radio-card"><input type="radio" name="ext" checked={!f.external} onChange={() => setF({ ...f, external: false })} /><span><strong>{L('Solo nell\'ambiente', 'Environment only')}</strong><br /><span className="small muted">{L('Solo le altre app dello stesso ambiente.', 'Only other apps in the same environment.')}</span></span></label>
            </div>
            <div className="grid cols-2">
              <Field label={L('Porta del contenitore', 'Container port')} htmlFor="tp" error={!portOk ? L('Da 1 a 65535', '1 to 65535') : undefined}><Input id="tp" type="number" value={f.targetPort} onChange={(e) => setF({ ...f, targetPort: Number(e.target.value) })} /></Field>
              <Field label={L('Trasporto', 'Transport')} htmlFor="tr"><Select id="tr" value={f.transport} onChange={(e) => setF({ ...f, transport: e.target.value })}>{['auto', 'http', 'http2', 'tcp'].map((x) => <option key={x}>{x}</option>)}</Select></Field>
            </div>
            <Switch checked={f.allowInsecure} onChange={(v) => setF({ ...f, allowInsecure: v })} label={L('Consenti HTTP non cifrato (altrimenti reindirizza a HTTPS)', 'Allow plain HTTP (otherwise redirect to HTTPS)')} />
          </>
        )}
      </div>
    </Card>
  );
}

const CPU_MEM: [number, string][] = [[0.25, '0.5Gi'], [0.5, '1Gi'], [0.75, '1.5Gi'], [1, '2Gi'], [1.25, '2.5Gi'], [1.5, '3Gi'], [1.75, '3.5Gi'], [2, '4Gi'], [3, '6Gi'], [4, '8Gi']];

/** Scalabilità: repliche minime e massime. */
export function CaScale({ id, app, reload }: { id: string; app: any; reload: () => void }) {
  const L = useL();
  const toast = useToast();
  const sc = app.properties?.template?.scale ?? {};
  const [min, setMin] = useState(Number(sc.minReplicas ?? 0));
  const [max, setMax] = useState(Number(sc.maxReplicas ?? 10));
  const [busy, setBusy] = useState(false);
  useEffect(() => { setMin(Number(sc.minReplicas ?? 0)); setMax(Number(sc.maxReplicas ?? 10)); }, [app]); // eslint-disable-line react-hooks/exhaustive-deps
  const ok = min >= 0 && max >= 1 && max <= 1000 && min <= max;
  const save = async () => {
    setBusy(true);
    try { await arm.patch(id, { properties: { template: { ...app.properties.template, scale: { ...sc, minReplicas: min, maxReplicas: max } } } }, CA_API); toast.ok(L('Scalabilità aggiornata', 'Scale updated')); reload(); }
    catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  return (
    <Card title={L('Repliche', 'Replicas')} actions={<Button variant="primary" icon={Save} loading={busy} disabled={!ok} onClick={() => void save()}>{L('Salva', 'Save')}</Button>}>
      <div className="grid cols-2">
        <Field label={L('Minimo', 'Minimum')} htmlFor="mn" hint={min === 0 ? L('Con 0 l\'app si spegne quando non riceve richieste e non costa nulla (avvio a freddo alla prima).', 'With 0 the app scales to zero when idle and costs nothing (cold start on the first request).') : L('Repliche sempre accese: si pagano anche a riposo.', 'Always-on replicas: billed even when idle.')}><Input id="mn" type="number" min={0} value={min} onChange={(e) => setMin(Number(e.target.value))} /></Field>
        <Field label={L('Massimo', 'Maximum')} htmlFor="mx" error={!ok ? L('Il massimo deve essere almeno 1 e non minore del minimo', 'Maximum must be at least 1 and not below the minimum') : undefined}><Input id="mx" type="number" min={1} max={1000} value={max} onChange={(e) => setMax(Number(e.target.value))} /></Field>
      </div>
      {(sc.rules ?? []).length > 0 && <p className="small muted">{L('Regole di scalabilità', 'Scale rules')}: {(sc.rules ?? []).map((r: any) => r.name).join(', ')}</p>}
    </Card>
  );
}

/** Contenitori: immagine, risorse e variabili d'ambiente (anche da segreti). */
export function CaContainers({ id, app, reload }: { id: string; app: any; reload: () => void }) {
  const L = useL();
  const toast = useToast();
  const secrets: string[] = (app.properties?.configuration?.secrets ?? []).map((s: any) => s.name);
  const [list, setList] = useState<any[]>(app.properties?.template?.containers ?? []);
  const [busy, setBusy] = useState(false);
  useEffect(() => setList(app.properties?.template?.containers ?? []), [app]);
  const upd = (i: number, patch: any) => setList(list.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const updEnv = (i: number, k: number, patch: any) => upd(i, { env: (list[i].env ?? []).map((e: any, j: number) => (j === k ? { ...e, ...patch } : e)) });
  const save = async () => {
    setBusy(true);
    try {
      const containers = list.map((c) => ({ ...c, env: (c.env ?? []).filter((e: any) => e.name).map((e: any) => (e.secretRef ? { name: e.name, secretRef: e.secretRef } : { name: e.name, value: e.value ?? '' })) }));
      await arm.patch(id, { properties: { template: { ...app.properties.template, containers } } }, CA_API);
      toast.ok(L('Nuova revisione in distribuzione', 'New revision deploying'));
      reload();
    } catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  const dirty = JSON.stringify(list) !== JSON.stringify(app.properties?.template?.containers ?? []);
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Notice>{L('Cambiare immagine, risorse o variabili crea una nuova revisione dell\'app.', 'Changing the image, resources or variables creates a new revision of the app.')}</Notice>
      {list.map((c, i) => (
        <Card key={i} title={<span className="mono">{c.name}</span>}>
          <div className="stack" style={{ gap: 12 }}>
            <Field label={L('Immagine', 'Image')} htmlFor={`img-${i}`}><Input id={`img-${i}`} className="mono" value={c.image ?? ''} onChange={(e) => upd(i, { image: e.target.value })} /></Field>
            <Field label={L('CPU e memoria', 'CPU and memory')} htmlFor={`res-${i}`}>
              <Select id={`res-${i}`} value={`${c.resources?.cpu ?? 0.5}|${c.resources?.memory ?? '1Gi'}`} onChange={(e) => { const [cpu, memory] = e.target.value.split('|'); upd(i, { resources: { ...(c.resources ?? {}), cpu: Number(cpu), memory } }); }}>
                {CPU_MEM.map(([cpu, mem]) => <option key={cpu} value={`${cpu}|${mem}`}>{cpu} vCPU · {mem}</option>)}
                {!CPU_MEM.some(([cpu, mem]) => cpu === Number(c.resources?.cpu) && mem === c.resources?.memory) && c.resources && <option value={`${c.resources.cpu}|${c.resources.memory}`}>{c.resources.cpu} vCPU · {c.resources.memory}</option>}
              </Select>
            </Field>
            <div>
              <div className="small muted" style={{ marginBottom: 8 }}>{L('Variabili d\'ambiente', 'Environment variables')}</div>
              <div className="stack" style={{ gap: 8 }}>
                {(c.env ?? []).map((e: any, k: number) => (
                  <div className="kv-edit three" key={k}>
                    <Input aria-label={L('Nome', 'Name')} className="mono" placeholder="NAME" value={e.name} onChange={(ev) => updEnv(i, k, { name: ev.target.value })} />
                    {e.secretRef !== undefined ? (
                      <Select aria-label={L('Segreto', 'Secret')} value={e.secretRef} onChange={(ev) => updEnv(i, k, { secretRef: ev.target.value })}>{secrets.map((s) => <option key={s}>{s}</option>)}</Select>
                    ) : <Input aria-label={L('Valore', 'Value')} className="mono" value={e.value ?? ''} onChange={(ev) => updEnv(i, k, { value: ev.target.value })} />}
                    <Select aria-label={L('Origine', 'Source')} value={e.secretRef !== undefined ? 'secret' : 'value'} onChange={(ev) => updEnv(i, k, ev.target.value === 'secret' ? { secretRef: secrets[0] ?? '', value: undefined } : { secretRef: undefined, value: '' })}>
                      <option value="value">{L('Valore', 'Value')}</option>
                      <option value="secret" disabled={!secrets.length}>{L('Riferimento a segreto', 'Secret reference')}</option>
                    </Select>
                    <Button size="sm" variant="ghost" icon={Trash2} aria-label={L('Rimuovi', 'Remove')} onClick={() => upd(i, { env: (c.env ?? []).filter((_: any, j: number) => j !== k) })} />
                  </div>
                ))}
                <div><Button size="sm" icon={Plus} onClick={() => upd(i, { env: [...(c.env ?? []), { name: '', value: '' }] })}>{L('Aggiungi variabile', 'Add variable')}</Button></div>
              </div>
            </div>
          </div>
        </Card>
      ))}
      <div className="row" style={{ justifyContent: 'flex-end' }}><Button variant="primary" icon={Save} loading={busy} disabled={!dirty || list.some((c) => !c.image)} onClick={() => void save()}>{L('Salva e crea revisione', 'Save and create revision')}</Button></div>
    </div>
  );
}

/** Segreti dell'app: valori visibili solo su richiesta, aggiunta e rimozione. */
export function CaSecrets({ id, app, reload }: { id: string; app: any; reload: () => void }) {
  const L = useL();
  const toast = useToast();
  const confirm = useConfirm();
  const names: string[] = (app.properties?.configuration?.secrets ?? []).map((s: any) => s.name);
  const [values, setValues] = useState<any[] | null>(null);
  const [form, setForm] = useState({ name: '', value: '' });
  const [busy, setBusy] = useState(false);
  const used = (n: string) => (app.properties?.template?.containers ?? []).some((c: any) => (c.env ?? []).some((e: any) => e.secretRef === n));
  const current = async () => values ?? (await arm.post<{ value: any[] }>(`${id}/listSecrets`, {}, CA_API)).value;
  const write = async (secrets: any[], msg: string) => {
    setBusy(true);
    try { await arm.patch(id, { properties: { configuration: { secrets } } }, CA_API); setValues(null); toast.ok(msg); reload(); }
    catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  const nameOk = /^[a-z0-9]([a-z0-9-.]{0,251}[a-z0-9])?$/.test(form.name) && !names.includes(form.name);
  return (
    <Card title={L('Segreti', 'Secrets')} actions={!values && names.length > 0 ? <Button size="sm" onClick={async () => { try { setValues(await current()); } catch (e) { toast.error(e); } }}>{L('Mostra i valori', 'Show values')}</Button> : null}>
      <div className="stack" style={{ gap: 10 }}>
        {names.length === 0 && <p className="small muted" style={{ margin: 0 }}>{L('Nessun segreto. Le variabili d\'ambiente possono riferirsi a un segreto invece di contenere il valore.', 'No secrets. Environment variables can reference a secret instead of holding the value.')}</p>}
        {names.map((n) => {
          const v = values?.find((x) => x.name === n);
          return (
            <div className="kv-edit" key={n}>
              <span className="mono">{n} {used(n) && <Badge tone="info">{L('in uso', 'in use')}</Badge>}</span>
              {v ? (v.keyVaultUrl ? <span className="mono small">{v.keyVaultUrl}</span> : <SecretValue value={v.value ?? ''} />) : <span className="muted">••••••••</span>}
              <Button size="sm" variant="ghost" icon={Trash2} aria-label={L('Rimuovi', 'Remove')} disabled={used(n) || busy} title={used(n) ? L('Usato da una variabile d\'ambiente', 'Used by an environment variable') : undefined}
                onClick={async () => { if (!(await confirm({ title: L(`Rimuovere il segreto ${n}?`, `Remove secret ${n}?`), danger: true, confirmLabel: L('Rimuovi', 'Remove') }))) return; try { await write((await current()).filter((x) => x.name !== n), L('Segreto rimosso', 'Secret removed')); } catch (e) { toast.error(e); } }} />
            </div>
          );
        })}
        <div className="kv-edit">
          <Input aria-label={L('Nome', 'Name')} className="mono" placeholder="db-password" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <Input aria-label={L('Valore', 'Value')} type="password" autoComplete="off" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
          <Button size="sm" icon={Plus} loading={busy} disabled={!nameOk || !form.value}
            onClick={async () => { try { await write([...(await current()), { name: form.name, value: form.value }], L('Segreto aggiunto', 'Secret added')); setForm({ name: '', value: '' }); } catch (e) { toast.error(e); } }}>{L('Aggiungi', 'Add')}</Button>
        </div>
        <p className="small muted" style={{ margin: 0 }}>{L('Nomi: minuscole, numeri, trattini e punti.', 'Names: lowercase letters, digits, hyphens and dots.')}</p>
      </div>
    </Card>
  );
}

/** Revisioni: modalità singola o multipla, attivazione e riavvio. */
export function CaRevisions({ id, app, reload }: { id: string; app: any; reload: () => void }) {
  const L = useL();
  const toast = useToast();
  const revs = useAsync(async () => (await arm.get<{ value: any[] }>(`${id}/revisions`, CA_API)).value.sort((a, b) => String(b.properties?.createdTime).localeCompare(String(a.properties?.createdTime))), [id, app.properties?.latestRevisionName]);
  const mode = app.properties?.configuration?.activeRevisionsMode ?? 'Single';
  const act = async (rev: string, action: string) => {
    try { await arm.post(`${id}/revisions/${rev}/${action}`, {}, CA_API); toast.ok(L('Fatto', 'Done'), rev); revs.reload(); } catch (e) { toast.error(e); }
  };
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card title={L('Modalità delle revisioni', 'Revision mode')}>
        <Select aria-label={L('Modalità', 'Mode')} value={mode} onChange={async (e) => { try { await arm.patch(id, { properties: { configuration: { activeRevisionsMode: e.target.value } } }, CA_API); reload(); } catch (err) { toast.error(err); } }}>
          <option value="Single">{L('Singola · solo l\'ultima revisione riceve traffico', 'Single · only the latest revision gets traffic')}</option>
          <option value="Multiple">{L('Multipla · più revisioni attive, traffico diviso', 'Multiple · several active revisions, split traffic')}</option>
        </Select>
      </Card>
      <Card title={L('Revisioni', 'Revisions')} padded={false}>
        {revs.error ? <div style={{ padding: 16 }}><ErrorNotice error={revs.error} onRetry={revs.reload} /></div> : !revs.data ? <div style={{ padding: 16 }}><Skeleton rows={3} /></div> : (
          <div className="table-wrap" style={{ border: 0, boxShadow: 'none' }}><table className="table">
            <thead><tr><th>{L('Nome', 'Name')}</th><th>{L('Creata', 'Created')}</th><th>{L('Stato', 'State')}</th><th>{L('Traffico', 'Traffic')}</th><th>{L('Repliche', 'Replicas')}</th><th /></tr></thead>
            <tbody>{revs.data.map((r) => (
              <tr key={r.id}>
                <td><span className="mono">{r.name}</span>{r.name === app.properties?.latestRevisionName && <> <Badge tone="info">{L('ultima', 'latest')}</Badge></>}</td>
                <td className="small">{r.properties?.createdTime ? new Date(r.properties.createdTime).toLocaleString() : '—'}</td>
                <td><Badge tone={r.properties?.active ? 'ok' : undefined}>{r.properties?.active ? L('Attiva', 'Active') : L('Inattiva', 'Inactive')}</Badge> <span className="small muted">{r.properties?.runningState}</span></td>
                <td className="mono">{r.properties?.trafficWeight ?? 0}%</td>
                <td className="mono">{r.properties?.replicas ?? 0}</td>
                <td><div className="row">
                  {r.properties?.active
                    ? <><Button size="sm" variant="ghost" icon={RotateCw} onClick={() => void act(r.name, 'restart')}>{L('Riavvia', 'Restart')}</Button>{mode === 'Multiple' && <Button size="sm" variant="ghost" icon={Power} onClick={() => void act(r.name, 'deactivate')}>{L('Disattiva', 'Deactivate')}</Button>}</>
                    : <Button size="sm" variant="ghost" icon={Activity} onClick={() => void act(r.name, 'activate')}>{L('Attiva', 'Activate')}</Button>}
                </div></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
    </div>
  );
}

// ---------------- Registro contenitori ----------------

/** Utente amministratore e credenziali per docker login. */
export function AcrAccess({ id, r, reload }: { id: string; r: any; reload: () => void }) {
  const L = useL();
  const toast = useToast();
  const admin = !!r.properties?.adminUserEnabled;
  const login = r.properties?.loginServer ?? '';
  const toggle = async (v: boolean) => {
    try { await arm.patch(id, { properties: { adminUserEnabled: v } }, ACR_API); toast.ok(v ? L('Utente amministratore attivato', 'Admin user enabled') : L('Utente amministratore disattivato', 'Admin user disabled')); reload(); } catch (e) { toast.error(e); }
  };
  const load = async () => {
    const c = await arm.post<any>(`${id}/listCredentials`, {}, ACR_API);
    return [{ key: 'u', label: L('Nome utente', 'Username'), value: c.username }, ...c.passwords.map((p: any) => ({ key: p.name, label: p.name, value: p.value, regen: () => arm.post(`${id}/regenerateCredential`, { name: p.name }, ACR_API) }))];
  };
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card title={L('Server di accesso', 'Login server')}><p style={{ margin: 0 }}><span className="mono">{login}</span> <CopyButton value={login} /></p></Card>
      <Card title={L('Utente amministratore', 'Admin user')}>
        <Switch checked={admin} onChange={(v) => void toggle(v)} label={L('Consenti docker login con nome utente e password del registro', 'Allow docker login with the registry username and password')} />
        <p className="small muted">{L('Per pipeline e servizi Azure è meglio un\'identità gestita con il ruolo AcrPull o AcrPush.', 'For pipelines and Azure services prefer a managed identity with the AcrPull or AcrPush role.')}</p>
      </Card>
      <KeysCard key={String(admin)} title={L('Credenziali', 'Credentials')} load={load} disabled={!admin ? L('Attiva l\'utente amministratore per vedere le credenziali.', 'Enable the admin user to see the credentials.') : undefined} />
      <Card title="Docker"><CodeBlock value={`az acr login --name ${r.name}\n# oppure / or\ndocker login ${login} -u ${r.name}\ndocker tag app:latest ${login}/app:latest\ndocker push ${login}/app:latest`} /></Card>
    </div>
  );
}

const ACR_SKUS: [string, string, string][] = [
  ['Basic', '10 GiB inclusi, 2 webhook · per sviluppo', '10 GiB included, 2 webhooks · for development'],
  ['Standard', '100 GiB inclusi, 10 webhook · produzione', '100 GiB included, 10 webhooks · production'],
  ['Premium', '500 GiB, 500 webhook, geo-replica, rete privata', '500 GiB, 500 webhooks, geo-replication, private networking'],
];

export function AcrSku({ id, r, reload }: { id: string; r: any; reload: () => void }) {
  const L = useL();
  const { locale } = useI18n();
  const toast = useToast();
  const pricing = useAsync(() => loadPricing(), []);
  const current = r.sku?.name ?? 'Basic';
  const [sel, setSel] = useState(current);
  const [busy, setBusy] = useState(false);
  useEffect(() => setSel(current), [current]);
  const price = (sku: string) => (pricing.data?.types as PriceType[] | undefined)?.find((x) => x.type === 'Microsoft.ContainerRegistry/registries')?.plans.find((p) => p.sku === sku)?.monthly ?? null;
  return (
    <Card title={L('Piano', 'Tier')} actions={<Button variant="primary" loading={busy} disabled={sel === current} onClick={async () => { setBusy(true); try { await arm.patch(id, { sku: { name: sel } }, ACR_API); toast.ok(L('Piano aggiornato', 'Tier updated'), sel); reload(); } catch (e) { toast.error(e); } finally { setBusy(false); } }}>{L('Applica', 'Apply')}</Button>}>
      <div className="radio-cards">{ACR_SKUS.map(([k, it, en]) => (
        <label className="radio-card" key={k}>
          <input type="radio" name="acr-sku" checked={sel === k} onChange={() => setSel(k)} />
          <span><strong>{k}</strong> {k === current && <Badge tone="info">{L('attuale', 'current')}</Badge>}<br /><span className="small muted">{L(it, en)}</span>{price(k) !== null && <><br /><span className="small">{money(price(k)!, locale)} {L('al mese', 'per month')}</span></>}</span>
        </label>
      ))}</div>
    </Card>
  );
}

const HOOK_ACTIONS = ['push', 'delete', 'quarantine', 'chart_push', 'chart_delete'];

export function AcrWebhooks({ id, r }: { id: string; r: any }) {
  const L = useL();
  const toast = useToast();
  const confirm = useConfirm();
  const hooks = useAsync(async () => (await arm.get<{ value: any[] }>(`${id}/webhooks`, ACR_API)).value, [id]);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: '', uri: '', actions: ['push'], scope: '' });
  const [busy, setBusy] = useState(false);
  const nameOk = /^[a-zA-Z0-9]{5,50}$/.test(f.name);
  const uriOk = /^https?:\/\/\S+$/.test(f.uri);
  const create = async () => {
    setBusy(true);
    try { await arm.put(`${id}/webhooks/${f.name}`, { location: r.location, properties: { serviceUri: f.uri, actions: f.actions, scope: f.scope, status: 'enabled' } }, ACR_API); toast.ok(L('Webhook creato', 'Webhook created'), f.name); setOpen(false); setF({ name: '', uri: '', actions: ['push'], scope: '' }); hooks.reload(); }
    catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  return (
    <Card title={L('Webhook', 'Webhooks')} actions={<Button size="sm" icon={Plus} onClick={() => setOpen(true)}>{L('Aggiungi', 'Add')}</Button>}>
      {hooks.error ? <ErrorNotice error={hooks.error} onRetry={hooks.reload} /> : !hooks.data ? <Skeleton rows={2} /> : hooks.data.length === 0 ? <Empty icon={Webhook} title={L('Nessun webhook', 'No webhooks')} text={L('Avvisa un servizio quando un\'immagine viene caricata o eliminata, per esempio per ridistribuire un\'app.', 'Notify a service when an image is pushed or deleted, for example to redeploy an app.')} /> : (
        <div className="stack" style={{ gap: 8 }}>
          {hooks.data.map((h) => (
            <div className="kv-edit three" key={h.id}>
              <span className="mono">{h.name}</span>
              <span className="small">{(h.properties?.actions ?? []).join(', ')}{h.properties?.scope ? ` · ${h.properties.scope}` : ''}</span>
              <Switch checked={h.properties?.status !== 'disabled'} onChange={async (v) => { try { await arm.patch(h.id, { properties: { status: v ? 'enabled' : 'disabled' } }, ACR_API); hooks.reload(); } catch (e) { toast.error(e); } }} label={h.properties?.status !== 'disabled' ? L('Attivo', 'On') : L('Spento', 'Off')} />
              <div className="row">
                <Button size="sm" variant="ghost" icon={Send} onClick={async () => { try { await arm.post(`${h.id}/ping`, {}, ACR_API); toast.ok(L('Ping inviato', 'Ping sent')); } catch (e) { toast.error(e); } }}>Ping</Button>
                <Button size="sm" variant="ghost" icon={Trash2} aria-label={L('Elimina', 'Delete')} onClick={async () => { if (!(await confirm({ title: L(`Eliminare ${h.name}?`, `Delete ${h.name}?`), danger: true, confirmLabel: L('Elimina', 'Delete') }))) return; try { await arm.del(h.id, ACR_API); hooks.reload(); } catch (e) { toast.error(e); } }} />
              </div>
            </div>
          ))}
        </div>
      )}
      <Panel open={open} onClose={() => setOpen(false)} title={L('Nuovo webhook', 'New webhook')}
        footer={<><Button onClick={() => setOpen(false)}>{L('Annulla', 'Cancel')}</Button><Button variant="primary" loading={busy} disabled={!nameOk || !uriOk || !f.actions.length} onClick={() => void create()}>{L('Crea', 'Create')}</Button></>}>
        <Field label={L('Nome', 'Name')} htmlFor="wn" error={f.name && !nameOk ? L('Da 5 a 50 lettere o numeri', '5 to 50 letters or digits') : undefined}><Input id="wn" className="mono" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label={L('URI del servizio', 'Service URI')} htmlFor="wu"><Input id="wu" className="mono" placeholder="https://example.com/hooks/acr" value={f.uri} onChange={(e) => setF({ ...f, uri: e.target.value })} /></Field>
        <Field label={L('Eventi', 'Events')}><div className="stack" style={{ gap: 6 }}>{HOOK_ACTIONS.map((a) => <Checkbox key={a} checked={f.actions.includes(a)} onChange={(v) => setF({ ...f, actions: v ? [...f.actions, a] : f.actions.filter((x) => x !== a) })} label={<span className="mono">{a}</span>} />)}</div></Field>
        <Field label={L('Ambito (facoltativo)', 'Scope (optional)')} htmlFor="ws" hint={L('Repository e tag, per esempio app:* — vuoto per tutto il registro.', 'Repository and tag, e.g. app:* — empty for the whole registry.')}><Input id="ws" className="mono" value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })} /></Field>
      </Panel>
    </Card>
  );
}

// ---------------- Kubernetes ----------------

const NODE_SIZES = ['Standard_B2s', 'Standard_B4ms', 'Standard_D2s_v5', 'Standard_D4s_v5', 'Standard_D8s_v5', 'Standard_E4s_v5', 'Standard_F4s_v2'];
const K8S_VERSIONS = ['1.29', '1.30', '1.31', '1.32', '1.33'];

/** Pool di nodi: elenco, scalabilità, aggiunta ed eliminazione. */
export function AksPools({ id, cluster, reload }: { id: string; cluster: any; reload: () => void }) {
  const L = useL();
  const { locale } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const pools = useAsync(async () => (await arm.get<{ value: any[] }>(`${id}/agentPools`, AKS_API)).value, [id]);
  const pricing = useAsync(() => loadPricing(), []);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: '', vmSize: 'Standard_D2s_v5', count: 1, mode: 'User' });
  const [busy, setBusy] = useState<string | null>(null);
  const vmPrice = (size: string) => (pricing.data?.types as PriceType[] | undefined)?.find((x) => x.type === 'Microsoft.Compute/virtualMachines')?.plans.find((p) => p.sku === size)?.monthly ?? null;
  const scale = async (p: any) => {
    setBusy(p.name);
    try {
      const cur = await arm.get<any>(p.id, AKS_API);
      await arm.put(p.id, { properties: { ...cur.properties, count: counts[p.name] } }, AKS_API);
      toast.ok(L('Scalabilità avviata', 'Scaling started'), `${p.name} → ${counts[p.name]}`);
      setCounts(({ [p.name]: _, ...rest }) => rest);
      pools.reload(); reload();
    } catch (e) { toast.error(e); }
    finally { setBusy(null); }
  };
  const remove = async (p: any) => {
    if (!(await confirm({ title: L(`Eliminare il pool ${p.name}?`, `Delete node pool ${p.name}?`), text: L('I nodi vengono svuotati e i pod spostati sugli altri pool.', 'Nodes are drained and pods move to the other pools.'), danger: true, confirmLabel: L('Elimina', 'Delete'), typeToConfirm: p.name }))) return;
    try { await arm.del(p.id, AKS_API); toast.ok(L('Pool eliminato', 'Node pool deleted')); pools.reload(); reload(); } catch (e) { toast.error(e); }
  };
  const create = async () => {
    setBusy('new');
    try { await arm.put(`${id}/agentPools/${f.name}`, { properties: { count: f.count, vmSize: f.vmSize, mode: f.mode, osType: 'Linux', type: 'VirtualMachineScaleSets', orchestratorVersion: cluster.properties?.kubernetesVersion } }, AKS_API); toast.ok(L('Pool creato', 'Node pool created'), f.name); setOpen(false); setF({ ...f, name: '' }); pools.reload(); reload(); }
    catch (e) { toast.error(e); }
    finally { setBusy(null); }
  };
  const nameOk = /^[a-z][a-z0-9]{0,11}$/.test(f.name) && !(pools.data ?? []).some((p) => p.name === f.name);
  return (
    <Card title={L('Pool di nodi', 'Node pools')} actions={<Button size="sm" icon={Plus} onClick={() => setOpen(true)}>{L('Aggiungi pool', 'Add node pool')}</Button>}>
      {pools.error ? <ErrorNotice error={pools.error} onRetry={pools.reload} /> : !pools.data ? <Skeleton rows={2} /> : (
        <div className="stack" style={{ gap: 10 }}>
          {pools.data.map((p) => {
            const n = counts[p.name] ?? p.properties?.count ?? 0;
            const price = vmPrice(p.properties?.vmSize);
            return (
              <div className="kv-edit four" key={p.id}>
                <span><strong className="mono">{p.name}</strong> <Badge tone={p.properties?.mode === 'System' ? 'info' : undefined}>{p.properties?.mode}</Badge></span>
                <span className="small"><span className="mono">{p.properties?.vmSize}</span> · {p.properties?.osType} · v{p.properties?.currentOrchestratorVersion ?? p.properties?.orchestratorVersion ?? cluster.properties?.kubernetesVersion}{price !== null && <><br />≈ {money(price * n, locale)} {L('al mese', 'per month')}</>}</span>
                <Input aria-label={L('Nodi', 'Nodes')} type="number" min={p.properties?.mode === 'System' ? 1 : 0} max={1000} value={n} onChange={(e) => setCounts({ ...counts, [p.name]: Number(e.target.value) })} />
                <Button size="sm" loading={busy === p.name} disabled={counts[p.name] === undefined || counts[p.name] === p.properties?.count} onClick={() => void scale(p)}>{L('Scala', 'Scale')}</Button>
                <Button size="sm" variant="ghost" icon={Trash2} aria-label={L('Elimina', 'Delete')} onClick={() => void remove(p)} />
              </div>
            );
          })}
        </div>
      )}
      <Panel open={open} onClose={() => setOpen(false)} title={L('Nuovo pool di nodi', 'New node pool')}
        footer={<><Button onClick={() => setOpen(false)}>{L('Annulla', 'Cancel')}</Button><Button variant="primary" loading={busy === 'new'} disabled={!nameOk || f.count < (f.mode === 'System' ? 1 : 0)} onClick={() => void create()}>{L('Crea', 'Create')}</Button></>}>
        <Field label={L('Nome', 'Name')} htmlFor="pn" error={f.name && !nameOk ? L('Minuscole e numeri, inizia con una lettera, massimo 12', 'Lowercase letters and digits, starts with a letter, up to 12') : undefined}><Input id="pn" className="mono" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label={L('Modalità', 'Mode')} htmlFor="pm" hint={L('I pool di sistema ospitano i componenti di Kubernetes; le app vanno nei pool utente.', 'System pools host Kubernetes components; apps go in user pools.')}><Select id="pm" value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}><option value="User">User</option><option value="System">System</option></Select></Field>
        <Field label={L('Dimensioni nodo', 'Node size')} htmlFor="ps"><Select id="ps" value={f.vmSize} onChange={(e) => setF({ ...f, vmSize: e.target.value })}>{NODE_SIZES.map((s) => <option key={s} value={s}>{s}{vmPrice(s) !== null ? ` · ${money(vmPrice(s)!, locale)}/${L('mese', 'month')}` : ''}</option>)}</Select></Field>
        <Field label={L('Numero di nodi', 'Node count')} htmlFor="pc"><Input id="pc" type="number" min={0} max={1000} value={f.count} onChange={(e) => setF({ ...f, count: Number(e.target.value) })} /></Field>
      </Panel>
    </Card>
  );
}

/** Versione di Kubernetes: aggiornamento del piano di controllo e dei nodi. */
export function AksUpgrade({ id, cluster, reload }: { id: string; cluster: any; reload: () => void }) {
  const L = useL();
  const toast = useToast();
  const confirm = useConfirm();
  const current = cluster.properties?.currentKubernetesVersion ?? cluster.properties?.kubernetesVersion ?? '';
  const profile = useAsync(async () => {
    try { return (await arm.get<any>(`${id}/upgradeProfiles/default`, AKS_API)).properties?.controlPlaneProfile?.upgrades?.map((u: any) => u.kubernetesVersion) as string[] | undefined; } catch { return undefined; }
  }, [id]);
  const cmp = (a: string, b: string) => { const x = a.split('.').map(Number); const y = b.split('.').map(Number); return x[0] - y[0] || x[1] - y[1] || (x[2] ?? 0) - (y[2] ?? 0); };
  // senza profilo di aggiornamento (emulatore): la minore successiva
  const nextMinor = (v: string) => { const [maj, min] = current.split('.').map(Number); const [a, b] = v.split('.').map(Number); return a === maj && b === min + 1; };
  const options = (profile.data?.length ? profile.data : K8S_VERSIONS.filter(nextMinor)).sort(cmp);
  const [sel, setSel] = useState('');
  const [busy, setBusy] = useState(false);
  const upgrade = async () => {
    if (!(await confirm({ title: L(`Aggiornare a Kubernetes ${sel}?`, `Upgrade to Kubernetes ${sel}?`), text: L('Il piano di controllo e poi i nodi vengono aggiornati uno alla volta; non si torna indietro.', 'The control plane and then the nodes are upgraded one at a time; it cannot be rolled back.'), confirmLabel: L('Aggiorna', 'Upgrade') }))) return;
    setBusy(true);
    try {
      const cur = await arm.get<any>(id, AKS_API);
      await arm.put(id, { location: cur.location, sku: cur.sku, identity: cur.identity, tags: cur.tags, properties: { ...cur.properties, kubernetesVersion: sel, agentPoolProfiles: (cur.properties.agentPoolProfiles ?? []).map((p: any) => ({ ...p, orchestratorVersion: sel })) } }, AKS_API);
      toast.ok(L('Aggiornamento avviato', 'Upgrade started'), sel);
      reload();
    } catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  return (
    <Card title={L('Versione di Kubernetes', 'Kubernetes version')}>
      <p style={{ marginTop: 0 }}>{L('Versione attuale', 'Current version')}: <strong className="mono">{current}</strong></p>
      {profile.loading ? <Skeleton rows={1} /> : options.length === 0 ? <Notice tone="ok">{L('Il cluster è alla versione più recente disponibile.', 'The cluster is on the latest available version.')}</Notice> : (
        <div className="row wrap">
          <Select aria-label={L('Nuova versione', 'New version')} value={sel} onChange={(e) => setSel(e.target.value)}><option value="">{L('Scegli la versione…', 'Choose a version…')}</option>{options.map((v) => <option key={v}>{v}</option>)}</Select>
          <Button variant="primary" loading={busy} disabled={!sel} onClick={() => void upgrade()}>{L('Aggiorna', 'Upgrade')}</Button>
        </div>
      )}
      <p className="small muted" style={{ marginBottom: 0 }}>{L('Kubernetes si aggiorna una versione minore alla volta.', 'Kubernetes upgrades one minor version at a time.')}</p>
    </Card>
  );
}
