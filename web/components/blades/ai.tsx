'use client';

import { useEffect, useMemo, useState } from 'react';
import { Boxes, ExternalLink, FolderPlus, Plus, Save, Sparkles, Trash2 } from 'lucide-react';
import { arm } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useDirectory } from '@/lib/directory';
import { Badge, Button, Card, CopyButton, Empty, ErrorNotice, Field, Input, Notice, Select, Skeleton, Switch, Textarea } from '../ui';
import { Panel, useConfirm, useToast } from '../overlay';
import { KeysCard } from './keys';
import { NetworkAccessCard, readNetwork, type NetworkState } from './storage';
import { useL } from './common';

export const AI_ACCOUNT_API = '2025-06-01';
const PTU = /Provisioned/;

interface ModelSku { name: string; capacity?: { minimum?: number; maximum?: number; step?: number; default?: number } }
interface AccountModel { format: string; name: string; version: string; isDefaultVersion?: boolean; lifecycleStatus?: string; capabilities?: Record<string, string>; skus?: ModelSku[] }

/** Tipi di distribuzione di Azure OpenAI / Foundry con una riga che dice cosa cambia. */
function useSkuText() {
  const L = useL();
  return (sku: string): [string, string] => ({
    GlobalStandard: [L('Globale standard', 'Global standard'), L('A token, elaborato in qualsiasi area Azure: quota più alta, prezzo più basso.', 'Pay per token, processed in any Azure region: highest quota, lowest price.')],
    DataZoneStandard: [L('Zona dati standard', 'Data zone standard'), L('A token, elaborato solo nella zona dati (UE o USA).', 'Pay per token, processed only within the data zone (EU or US).')],
    Standard: [L('Standard regionale', 'Regional standard'), L('A token, elaborato nell\'area della risorsa.', 'Pay per token, processed in the resource\'s region.')],
    GlobalBatch: [L('Batch globale', 'Global batch'), L('Richieste asincrone entro 24 ore, a metà prezzo.', 'Asynchronous requests within 24 hours, at half price.')],
    GlobalProvisionedManaged: [L('Velocità effettiva riservata globale', 'Global provisioned throughput'), L('PTU riservate a ore: latenza stabile, si paga anche senza traffico.', 'Hourly reserved PTUs: stable latency, billed even with no traffic.')],
    DataZoneProvisionedManaged: [L('Velocità effettiva riservata zona dati', 'Data zone provisioned throughput'), L('PTU riservate nella zona dati.', 'Reserved PTUs within the data zone.')],
    ProvisionedManaged: [L('Velocità effettiva riservata regionale', 'Regional provisioned throughput'), L('PTU riservate nell\'area della risorsa.', 'Reserved PTUs in the resource\'s region.')],
  } as Record<string, [string, string]>)[sku] ?? [sku, ''];
}

const kindOf = (account: any) => String(account?.kind ?? '').toLowerCase();
export const supportsDeployments = (account: any) => ['openai', 'aiservices'].includes(kindOf(account));

/** Distribuzioni di modelli: elenco, nuova distribuzione dal catalogo dell'account, capacità, eliminazione. */
export function AiDeployments({ id }: { id: string }) {
  const L = useL();
  const toast = useToast();
  const confirm = useConfirm();
  const skuText = useSkuText();
  const list = useAsync(async () => (await arm.get<{ value: any[] }>(`${id}/deployments`, AI_ACCOUNT_API)).value, [id]);
  const models = useAsync(async () => (await arm.get<{ value: AccountModel[] }>(`${id}/models`, AI_ACCOUNT_API)).value, [id]);
  const [form, setForm] = useState<null | { model: string; sku: string; capacity: number; name: string; upgrade: string }>(null);
  const [cap, setCap] = useState<null | { dep: any; capacity: number }>(null);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);

  const usable = useMemo(() => (models.data ?? []).filter((m) => (m.skus ?? []).length > 0 && m.lifecycleStatus !== 'Deprecated'), [models.data]);
  const keyOf = (m: AccountModel) => `${m.format}|${m.name}|${m.version}`;
  const picked = usable.find((m) => keyOf(m) === form?.model);
  const pickedSku = picked?.skus?.find((s) => s.name === form?.sku);
  const kind = (m: AccountModel) => {
    const c = m.capabilities ?? {};
    return c.embeddings === 'true' ? L('Embedding', 'Embeddings') : c.imageGenerations === 'true' ? L('Immagini', 'Images') : c.audio === 'true' ? 'Audio' : c.reasoning === 'true' ? L('Chat con ragionamento', 'Chat with reasoning') : 'Chat';
  };
  const pick = (k: string) => {
    const m = usable.find((x) => keyOf(x) === k);
    if (!m || !form) return;
    const sku = m.skus!.find((s) => s.name === 'GlobalStandard') ?? m.skus![0];
    const taken = new Set((list.data ?? []).map((d) => d.name.toLowerCase()));
    let name = m.name.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 64);
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${m.name}-${i}`.slice(0, 64);
    setForm({ ...form, model: k, sku: sku.name, capacity: sku.capacity?.default ?? 10, name });
  };
  const create = async () => {
    if (!form || !picked) return;
    setBusy(true);
    try {
      await arm.put(`${id}/deployments/${encodeURIComponent(form.name)}`, {
        sku: { name: form.sku, capacity: form.capacity },
        properties: { model: { format: picked.format, name: picked.name, version: picked.version }, versionUpgradeOption: form.upgrade, raiPolicyName: 'Microsoft.DefaultV2' },
      }, AI_ACCOUNT_API);
      toast.ok(L('Modello distribuito', 'Model deployed'), form.name);
      setForm(null);
      list.reload();
    } catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  const saveCapacity = async () => {
    if (!cap) return;
    setBusy(true);
    try {
      const d = cap.dep;
      await arm.put(`${id}/deployments/${encodeURIComponent(d.name)}`, { sku: { ...d.sku, capacity: cap.capacity }, properties: { model: d.properties?.model, versionUpgradeOption: d.properties?.versionUpgradeOption, raiPolicyName: d.properties?.raiPolicyName } }, AI_ACCOUNT_API);
      toast.ok(L('Capacità aggiornata', 'Capacity updated'), d.name);
      setCap(null);
      list.reload();
    } catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  const remove = async (d: any) => {
    if (!(await confirm({ title: L(`Eliminare la distribuzione ${d.name}?`, `Delete deployment ${d.name}?`), text: L('Le app che chiamano questo nome di distribuzione ricevono 404.', 'Apps calling this deployment name get 404.'), danger: true, confirmLabel: L('Elimina', 'Delete') }))) return;
    try { await arm.del(`${id}/deployments/${encodeURIComponent(d.name)}`, AI_ACCOUNT_API); list.reload(); } catch (e) { toast.error(e); }
  };
  const capLabel = (sku: string, n: number) => (PTU.test(sku) ? `${n} PTU` : `${n}K TPM`);
  const capRange = (s?: ModelSku) => ({ min: s?.capacity?.minimum ?? 1, max: s?.capacity?.maximum ?? 1000, step: s?.capacity?.step ?? 1 });
  const r = capRange(pickedSku);
  const nameTaken = !!form && (list.data ?? []).some((d) => d.name.toLowerCase() === form.name.toLowerCase());
  const validForm = !!form && !!picked && !!pickedSku && /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,63}$/.test(form.name) && !nameTaken && Number.isInteger(form.capacity) && form.capacity >= r.min && form.capacity <= r.max;
  const capModelSku = cap ? (models.data ?? []).find((m) => m.name === cap.dep.properties?.model?.name && m.version === cap.dep.properties?.model?.version)?.skus?.find((s) => s.name === cap.dep.sku?.name) : undefined;
  const cr = capRange(capModelSku);
  const shown = usable.filter((m) => !filter || `${m.name} ${m.format}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <Card title={L('Distribuzioni di modelli', 'Model deployments')} actions={<Button size="sm" variant="primary" icon={Plus} disabled={!models.data} onClick={() => { setFilter(''); setForm({ model: '', sku: '', capacity: 10, name: '', upgrade: 'OnceNewDefaultVersionAvailable' }); }}>{L('Distribuisci modello', 'Deploy model')}</Button>}>
      {list.error ? <ErrorNotice error={list.error} onRetry={list.reload} /> : !list.data ? <Skeleton rows={3} /> : list.data.length === 0 ? (
        <Empty icon={Boxes} title={L('Nessun modello distribuito', 'No models deployed')} text={L('Per chiamare un modello serve una distribuzione: il suo nome è quello che usi nel codice (model o deployment).', 'To call a model you need a deployment: its name is what you use in code (model or deployment).')} />
      ) : (
        <div className="table-wrap" style={{ border: 0, boxShadow: 'none' }}><table className="table">
          <thead><tr><th>{L('Distribuzione', 'Deployment')}</th><th>{L('Modello', 'Model')}</th><th>{L('Tipo', 'Type')}</th><th>{L('Capacità', 'Capacity')}</th><th>{L('Limiti', 'Limits')}</th><th>{L('Stato', 'State')}</th><th /></tr></thead>
          <tbody>{list.data.map((d) => {
            const p = d.properties ?? {};
            const tok = (p.rateLimits ?? []).find((x: any) => x.key === 'token');
            const req = (p.rateLimits ?? []).find((x: any) => x.key === 'request');
            return (
              <tr key={d.id}>
                <td className="mono">{d.name}</td>
                <td><span className="mono">{p.model?.name}</span> <span className="small muted">{p.model?.version}</span>{p.model?.format && p.model.format !== 'OpenAI' && <><br /><span className="small muted">{p.model.format}</span></>}</td>
                <td className="small">{skuText(d.sku?.name)[0]}</td>
                <td className="small">{capLabel(d.sku?.name, Number(d.sku?.capacity ?? 0))}</td>
                <td className="small muted">{tok ? `${Number(tok.count).toLocaleString()} ${L('token/min', 'tokens/min')}` : ''}{req ? ` · ${Math.round(Number(req.count) * 60 / Number(req.renewalPeriod || 60))} ${L('rich./min', 'req/min')}` : ''}</td>
                <td><Badge tone={p.provisioningState === 'Succeeded' ? 'ok' : p.provisioningState === 'Failed' ? 'bad' : 'info'}>{p.provisioningState ?? '—'}</Badge></td>
                <td><div className="row">
                  <Button size="sm" variant="ghost" onClick={() => setCap({ dep: d, capacity: Number(d.sku?.capacity ?? 1) })}>{L('Capacità', 'Capacity')}</Button>
                  <Button size="sm" variant="ghost" icon={Trash2} aria-label={L('Elimina', 'Delete')} onClick={() => void remove(d)} />
                </div></td>
              </tr>
            );
          })}</tbody>
        </table></div>
      )}
      <p className="small muted" style={{ marginBottom: 0 }}>{L('Le distribuzioni a token si pagano per milioni di token in ingresso e in uscita; quelle con PTU a ore. La capacità standard è in migliaia di token al minuto (TPM) e consuma la quota della sottoscrizione.', 'Token deployments are billed per million input and output tokens; PTU deployments per hour. Standard capacity is in thousands of tokens per minute (TPM) and uses the subscription quota.')}</p>

      <Panel open={!!form} onClose={() => setForm(null)} wide title={L('Distribuisci un modello', 'Deploy a model')}
        footer={<><Button onClick={() => setForm(null)}>{L('Annulla', 'Cancel')}</Button><Button variant="primary" icon={Sparkles} loading={busy} disabled={!validForm} onClick={() => void create()}>{L('Distribuisci', 'Deploy')}</Button></>}>
        {form && (
          <div className="stack" style={{ gap: 14 }}>
            {models.error ? <ErrorNotice error={models.error} onRetry={models.reload} /> : !models.data ? <Skeleton rows={4} /> : (
              <>
                <Field label={L('Modello', 'Model')} htmlFor="dm-f">
                  <Input id="dm-f" placeholder={L('Filtra: gpt, embedding, Llama…', 'Filter: gpt, embedding, Llama…')} value={filter} onChange={(e) => setFilter(e.target.value)} />
                </Field>
                <div className="radio-cards" style={{ maxHeight: 300, overflow: 'auto' }}>
                  {shown.map((m) => (
                    <label className="radio-card" key={keyOf(m)}>
                      <input type="radio" name="dm-model" checked={form.model === keyOf(m)} onChange={() => pick(keyOf(m))} />
                      <span><strong className="mono">{m.name}</strong> <span className="small muted">{m.version}</span>{m.lifecycleStatus === 'Preview' && <> <Badge tone="info">preview</Badge></>}<br /><span className="small muted">{m.format} · {kind(m)}{m.capabilities?.maxContextToken ? ` · ${Number(m.capabilities.maxContextToken).toLocaleString()} ${L('token di contesto', 'context tokens')}` : ''}</span></span>
                    </label>
                  ))}
                  {shown.length === 0 && <p className="muted small">{L('Nessun modello corrisponde.', 'No model matches.')}</p>}
                </div>
              </>
            )}
            {picked && (
              <>
                <Field label={L('Tipo di distribuzione', 'Deployment type')} htmlFor="dm-s" hint={skuText(form.sku)[1]}>
                  <Select id="dm-s" value={form.sku} onChange={(e) => { const s = picked.skus!.find((x) => x.name === e.target.value); setForm({ ...form, sku: e.target.value, capacity: s?.capacity?.default ?? (PTU.test(e.target.value) ? 15 : 10) }); }}>
                    {picked.skus!.map((s) => <option key={s.name} value={s.name}>{skuText(s.name)[0]}</option>)}
                  </Select>
                </Field>
                <Field label={PTU.test(form.sku) ? L('Unità riservate (PTU)', 'Provisioned throughput units (PTU)') : L('Limite di velocità (migliaia di token al minuto)', 'Rate limit (thousands of tokens per minute)')} htmlFor="dm-c"
                  hint={L(`Tra ${r.min} e ${r.max}${r.step > 1 ? `, a passi di ${r.step}` : ''}.`, `Between ${r.min} and ${r.max}${r.step > 1 ? `, in steps of ${r.step}` : ''}.`)}>
                  <Input id="dm-c" type="number" min={r.min} max={r.max} step={r.step} value={form.capacity} onChange={(e) => setForm({ ...form, capacity: Number(e.target.value) })} />
                </Field>
                <Field label={L('Nome della distribuzione', 'Deployment name')} htmlFor="dm-n" error={nameTaken ? L('Esiste già una distribuzione con questo nome.', 'A deployment with this name already exists.') : undefined} hint={L('È il nome da passare all\'SDK.', 'This is the name you pass to the SDK.')}>
                  <Input id="dm-n" className="mono" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </Field>
                <Field label={L('Aggiornamento della versione', 'Version update')} htmlFor="dm-u">
                  <Select id="dm-u" value={form.upgrade} onChange={(e) => setForm({ ...form, upgrade: e.target.value })}>
                    <option value="OnceNewDefaultVersionAvailable">{L('Alla nuova versione predefinita', 'When a new default version is available')}</option>
                    <option value="OnceCurrentVersionExpired">{L('Quando la versione attuale scade', 'When the current version expires')}</option>
                    <option value="NoAutoUpgrade">{L('Mai (la distribuzione si ferma alla scadenza)', 'Never (the deployment stops at expiry)')}</option>
                  </Select>
                </Field>
              </>
            )}
          </div>
        )}
      </Panel>
      <Panel open={!!cap} onClose={() => setCap(null)} title={L(`Capacità di ${cap?.dep.name ?? ''}`, `Capacity of ${cap?.dep.name ?? ''}`)}
        footer={<><Button onClick={() => setCap(null)}>{L('Annulla', 'Cancel')}</Button><Button variant="primary" loading={busy} disabled={!cap || cap.capacity === Number(cap.dep.sku?.capacity) || cap.capacity < cr.min || cap.capacity > cr.max} onClick={() => void saveCapacity()}>{L('Salva', 'Save')}</Button></>}>
        {cap && (
          <Field label={PTU.test(cap.dep.sku?.name) ? 'PTU' : L('Migliaia di token al minuto', 'Thousands of tokens per minute')} htmlFor="dc-c" hint={L(`Tra ${cr.min} e ${cr.max}, entro la quota disponibile.`, `Between ${cr.min} and ${cr.max}, within available quota.`)}>
            <Input id="dc-c" type="number" min={cr.min} max={cr.max} step={cr.step} value={cap.capacity} onChange={(e) => setCap({ ...cap, capacity: Number(e.target.value) })} />
          </Field>
        )}
      </Panel>
    </Card>
  );
}

/** Endpoint e chiavi dell'account. */
export function AiKeys({ id, account }: { id: string; account: any }) {
  const L = useL();
  const p = account.properties ?? {};
  const endpoints: [string, string][] = Object.entries(p.endpoints ?? (p.endpoint ? { Endpoint: p.endpoint } : {})) as [string, string][];
  const load = async () => {
    const k = await arm.post<{ key1: string; key2: string }>(`${id}/listKeys`, {}, AI_ACCOUNT_API);
    return [
      { key: 'k1', label: 'KEY 1', value: k.key1, regen: () => arm.post(`${id}/regenerateKey`, { keyName: 'Key1' }, AI_ACCOUNT_API) },
      { key: 'k2', label: 'KEY 2', value: k.key2, regen: () => arm.post(`${id}/regenerateKey`, { keyName: 'Key2' }, AI_ACCOUNT_API) },
    ];
  };
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card title="Endpoint">
        <div className="stack" style={{ gap: 8 }}>{endpoints.map(([name, url]) => (
          <div key={name} className="kv-edit"><span>{name}</span><span className="mono small">{url}</span><CopyButton value={url} /></div>
        ))}</div>
      </Card>
      <KeysCard title={L('Chiavi', 'Keys')} load={load}
        disabled={p.disableLocalAuth ? L('L\'autenticazione con chiave è disattivata: le app usano Microsoft Entra ID (ruolo Cognitive Services OpenAI User o Azure AI User).', 'Key authentication is disabled: apps use Microsoft Entra ID (Cognitive Services OpenAI User or Azure AI User role).') : undefined}
        note={L('Due chiavi per ruotarle senza interruzioni: passa le app alla seconda, poi rigenera la prima.', 'Two keys so you can rotate without downtime: move apps to the second, then regenerate the first.')} />
    </div>
  );
}

/** Autenticazione con chiave e accesso dalla rete pubblica. */
export function AiNetworking({ id, account, reload }: { id: string; account: any; reload: () => void }) {
  const L = useL();
  const toast = useToast();
  const confirm = useConfirm();
  const p = account.properties ?? {};
  const [localAuth, setLocalAuth] = useState(!p.disableLocalAuth);
  useEffect(() => setLocalAuth(!p.disableLocalAuth), [account]); // eslint-disable-line react-hooks/exhaustive-deps
  const saveAuth = async () => {
    if (!localAuth && !(await confirm({ title: L('Disattivare le chiavi?', 'Disable keys?'), text: L('Le app che usano una chiave smettono subito di funzionare.', 'Apps using a key stop working immediately.'), danger: true, confirmLabel: L('Disattiva', 'Disable') }))) return;
    try { await arm.patch(id, { properties: { disableLocalAuth: !localAuth } }, AI_ACCOUNT_API); toast.ok(L('Autenticazione aggiornata', 'Authentication updated')); reload(); }
    catch (e) { toast.error(e); }
  };
  const saveNet = async (s: NetworkState) => {
    await arm.patch(id, {
      properties: {
        publicNetworkAccess: s.mode === 'disabled' ? 'Disabled' : 'Enabled',
        networkAcls: {
          defaultAction: s.mode === 'selected' ? 'Deny' : 'Allow', bypass: s.bypass ? 'AzureServices' : 'None',
          ipRules: s.mode === 'selected' ? s.ipRules.map((value) => ({ value })) : [],
          virtualNetworkRules: s.mode === 'selected' ? s.subnets.map((sid) => ({ id: sid, ignoreMissingVnetServiceEndpoint: false })) : [],
        },
      },
    }, AI_ACCOUNT_API);
    reload();
  };
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card title={L('Autenticazione', 'Authentication')} actions={<Button variant="primary" icon={Save} disabled={localAuth === !p.disableLocalAuth} onClick={() => void saveAuth()}>{L('Salva', 'Save')}</Button>}>
        <Switch checked={localAuth} onChange={setLocalAuth} label={L('Consenti l\'accesso con chiave API', 'Allow API key access')} />
        <p className="small muted" style={{ marginBottom: 0 }}>{L('Senza chiavi, le app si autenticano con Microsoft Entra ID e un ruolo sull\'account: niente segreti da ruotare.', 'Without keys, apps authenticate with Microsoft Entra ID and a role on the account: no secrets to rotate.')}</p>
      </Card>
      <NetworkAccessCard id={id} state={readNetwork(p)} endpoint="Microsoft.CognitiveServices" bypass={L('Consenti ai servizi Azure attendibili (AI Search, Foundry…)', 'Allow trusted Azure services (AI Search, Foundry…)')} onSave={saveNet} />
    </div>
  );
}

/** Progetti Foundry dell'account AI Services. */
export function AiProjects({ id, account }: { id: string; account: any }) {
  const L = useL();
  const toast = useToast();
  const confirm = useConfirm();
  const { real, state } = useDirectory();
  const list = useAsync(async () => (await arm.get<{ value: any[] }>(`${id}/projects`, AI_ACCOUNT_API)).value, [id]);
  const [form, setForm] = useState<null | { name: string; displayName: string; description: string }>(null);
  const [busy, setBusy] = useState(false);
  const enabled = !!account.properties?.allowProjectManagement;
  const create = async () => {
    if (!form) return;
    setBusy(true);
    try {
      await arm.put(`${id}/projects/${encodeURIComponent(form.name)}`, { location: account.location, identity: { type: 'SystemAssigned' }, properties: { displayName: form.displayName || form.name, description: form.description } }, AI_ACCOUNT_API);
      toast.ok(L('Progetto creato', 'Project created'), form.name);
      setForm(null);
      list.reload();
    } catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  const remove = async (pr: any) => {
    if (!(await confirm({ title: L(`Eliminare il progetto ${pr.name}?`, `Delete project ${pr.name}?`), text: L('Agenti, thread e file del progetto vengono eliminati.', 'The project\'s agents, threads and files are deleted.'), danger: true, confirmLabel: L('Elimina', 'Delete') }))) return;
    try { await arm.del(`${id}/projects/${encodeURIComponent(pr.name)}`, AI_ACCOUNT_API); list.reload(); } catch (e) { toast.error(e); }
  };
  const taken = !!form && (list.data ?? []).some((x) => x.name.toLowerCase() === form.name.toLowerCase());
  return (
    <Card title={L('Progetti Foundry', 'Foundry projects')} actions={enabled ? <Button size="sm" variant="primary" icon={FolderPlus} onClick={() => setForm({ name: '', displayName: '', description: '' })}>{L('Nuovo progetto', 'New project')}</Button> : null}>
      {!enabled ? <Notice>{L('Questa risorsa non ha la gestione dei progetti attiva (allowProjectManagement): è una risorsa AI Services classica.', 'This resource does not have project management enabled (allowProjectManagement): it is a classic AI Services resource.')}</Notice>
        : list.error ? <ErrorNotice error={list.error} onRetry={list.reload} /> : !list.data ? <Skeleton rows={2} /> : list.data.length === 0 ? (
          <Empty icon={FolderPlus} title={L('Nessun progetto', 'No projects')} text={L('I progetti separano agenti, valutazioni e file per team o applicazione, con i modelli distribuiti sulla risorsa.', 'Projects separate agents, evaluations and files per team or app, using the models deployed on the resource.')} />
        ) : (
          <div className="table-wrap" style={{ border: 0, boxShadow: 'none' }}><table className="table">
            <thead><tr><th>{L('Progetto', 'Project')}</th><th>Endpoint</th><th /></tr></thead>
            <tbody>{list.data.map((pr) => {
              const ep = Object.values(pr.properties?.endpoints ?? {})[0] as string | undefined;
              return (
                <tr key={pr.id}>
                  <td><strong>{pr.properties?.displayName ?? pr.name}</strong>{pr.properties?.isDefault && <> <Badge>{L('predefinito', 'default')}</Badge></>}<br /><span className="small muted">{pr.properties?.description || pr.name}</span></td>
                  <td className="small">{ep ? <><span className="mono">{ep}</span> <CopyButton value={ep} /></> : '—'}</td>
                  <td><div className="row">
                    {real ? <a className="btn sm ghost" href={`https://ai.azure.com/resource/overview?wsid=${encodeURIComponent(pr.id)}&tid=${state?.active ?? ''}`} target="_blank" rel="noreferrer noopener">Foundry <ExternalLink size={12} aria-hidden /></a>
                      : <span className="small muted" title={L('Il portale Foundry apre solo risorse Azure reali.', 'The Foundry portal only opens real Azure resources.')}>Foundry —</span>}
                    <Button size="sm" variant="ghost" icon={Trash2} aria-label={L('Elimina', 'Delete')} onClick={() => void remove(pr)} />
                  </div></td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      <Panel open={!!form} onClose={() => setForm(null)} title={L('Nuovo progetto Foundry', 'New Foundry project')}
        footer={<><Button onClick={() => setForm(null)}>{L('Annulla', 'Cancel')}</Button><Button variant="primary" loading={busy} disabled={!form || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}$/.test(form.name) || taken} onClick={() => void create()}>{L('Crea', 'Create')}</Button></>}>
        {form && (
          <div className="stack" style={{ gap: 12 }}>
            <Field label={L('Nome', 'Name')} htmlFor="fp-n" error={taken ? L('Esiste già.', 'Already exists.') : undefined}><Input id="fp-n" className="mono" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label={L('Nome visualizzato', 'Display name')} htmlFor="fp-d"><Input id="fp-d" value={form.displayName} placeholder={form.name} onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></Field>
            <Field label={L('Descrizione', 'Description')} htmlFor="fp-s"><Textarea id="fp-s" rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
          </div>
        )}
      </Panel>
    </Card>
  );
}
