'use client';

import { useState } from 'react';
import { KeySquare, Plus, ShieldCheck, Trash2, UserPlus } from 'lucide-react';
import { arm, graph } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useDirectory } from '@/lib/directory';
import { useI18n } from '@/i18n';
import { Badge, Button, Card, Checkbox, CopyButton, Empty, ErrorNotice, Field, Input, KV, Notice, Select, Skeleton, Switch } from '../ui';
import { Panel, useConfirm, useToast } from '../overlay';
import { PrincipalPicker, type PrincipalRef } from '../pickers';
import { NetworkAccessCard, readNetwork, type NetworkState } from './storage';
import { useL } from './common';

export const KV_API = '2023-07-01';

/** Chiavi crittografiche del vault (Microsoft.KeyVault/vaults/keys). */
export function VaultKeys({ id }: { id: string }) {
  const L = useL();
  const { fmtDate } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const { real } = useDirectory();
  const list = useAsync(async () => (await arm.get<{ value: any[] }>(`${id}/keys`, KV_API)).value, [id]);
  const [form, setForm] = useState<null | { name: string; kty: string; size: number; curve: string; ops: string[]; exp: string }>(null);
  const [busy, setBusy] = useState(false);
  const RSA_OPS = ['encrypt', 'decrypt', 'sign', 'verify', 'wrapKey', 'unwrapKey'];
  const EC_OPS = ['sign', 'verify'];
  const ec = form?.kty.startsWith('EC');
  const exists = !!form && (list.data ?? []).some((k) => k.name.toLowerCase() === form.name.toLowerCase());
  const create = async () => {
    if (!form) return;
    setBusy(true);
    try {
      const attributes: any = { enabled: true };
      if (form.exp) attributes.exp = Math.floor(Date.parse(`${form.exp}T23:59:59Z`) / 1000);
      await arm.put(`${id}/keys/${encodeURIComponent(form.name)}`, { properties: { kty: form.kty, ...(ec ? { curveName: form.curve } : { keySize: form.size }), keyOps: form.ops, attributes } }, KV_API);
      toast.ok(L('Chiave creata', 'Key created'), form.name);
      setForm(null);
      list.reload();
    } catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  const toggle = async (k: any) => {
    try { await arm.patch(`${id}/keys/${encodeURIComponent(k.name)}`, { properties: { attributes: { enabled: !k.properties?.attributes?.enabled } } }, KV_API); list.reload(); }
    catch (e) { toast.error(e); }
  };
  const remove = async (k: any) => {
    if (!(await confirm({ title: L(`Eliminare la chiave ${k.name}?`, `Delete key ${k.name}?`), text: L('Ciò che è cifrato con questa chiave diventa illeggibile. Con l\'eliminazione temporanea resta recuperabile per il periodo di conservazione.', 'Anything encrypted with this key becomes unreadable. With soft delete it stays recoverable for the retention period.'), danger: true, confirmLabel: L('Elimina', 'Delete') }))) return;
    try { await arm.del(`${id}/keys/${encodeURIComponent(k.name)}`, KV_API); list.reload(); } catch (e) { toast.error(e); }
  };
  const date = (s?: number) => (s ? fmtDate(new Date(s * 1000).toISOString()) : '—');
  return (
    <Card title={L('Chiavi', 'Keys')} actions={<Button size="sm" variant="primary" icon={Plus} onClick={() => setForm({ name: '', kty: 'RSA', size: 2048, curve: 'P-256', ops: RSA_OPS, exp: '' })}>{L('Genera chiave', 'Generate key')}</Button>}>
      {real && <Notice>{L('Su Azure, Resource Manager crea ed elenca le chiavi; abilitarle, ruotarle o eliminarle passa dal piano dati: az keyvault key set-attributes / rotate / delete.', 'On Azure, Resource Manager creates and lists keys; enabling, rotating or deleting them goes through the data plane: az keyvault key set-attributes / rotate / delete.')}</Notice>}
      {list.error ? <ErrorNotice error={list.error} onRetry={list.reload} /> : !list.data ? <Skeleton rows={3} /> : list.data.length === 0 ? (
        <Empty icon={KeySquare} title={L('Nessuna chiave', 'No keys')} text={L('Chiavi RSA o a curva ellittica per cifrare dati, firmare token o proteggere dischi e account con chiavi gestite dal cliente.', 'RSA or elliptic-curve keys to encrypt data, sign tokens or protect disks and accounts with customer-managed keys.')} />
      ) : (
        <div className="table-wrap" style={{ border: 0, boxShadow: 'none' }}><table className="table">
          <thead><tr><th>{L('Nome', 'Name')}</th><th>{L('Tipo', 'Type')}</th><th>{L('Stato', 'Status')}</th><th>{L('Creata', 'Created')}</th><th>{L('Scadenza', 'Expires')}</th><th>URI</th><th /></tr></thead>
          <tbody>{list.data.map((k) => {
            const p = k.properties ?? {};
            const expired = p.attributes?.exp && p.attributes.exp * 1000 < Date.now();
            return (
              <tr key={k.id}>
                <td className="mono">{k.name}</td>
                <td className="small">{p.kty} {p.keySize ?? p.curveName}</td>
                <td>{expired ? <Badge tone="bad">{L('scaduta', 'expired')}</Badge> : <Badge tone={p.attributes?.enabled === false ? undefined : 'ok'}>{p.attributes?.enabled === false ? L('disattivata', 'disabled') : L('attiva', 'enabled')}</Badge>}</td>
                <td className="small">{date(p.attributes?.created)}</td>
                <td className="small">{date(p.attributes?.exp)}</td>
                <td className="small"><CopyButton value={p.keyUri ?? ''} label={L('Copia', 'Copy')} /></td>
                <td>{!real && <div className="row">
                  <Button size="sm" variant="ghost" onClick={() => void toggle(k)}>{p.attributes?.enabled === false ? L('Attiva', 'Enable') : L('Disattiva', 'Disable')}</Button>
                  <Button size="sm" variant="ghost" icon={Trash2} aria-label={L('Elimina', 'Delete')} onClick={() => void remove(k)} />
                </div>}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      )}
      <Panel open={!!form} onClose={() => setForm(null)} title={L('Genera chiave', 'Generate key')}
        footer={<><Button onClick={() => setForm(null)}>{L('Annulla', 'Cancel')}</Button><Button variant="primary" loading={busy} disabled={!form || !/^[a-zA-Z0-9-]{1,127}$/.test(form.name) || exists || form.ops.length === 0} onClick={() => void create()}>{L('Crea', 'Create')}</Button></>}>
        {form && (
          <div className="stack" style={{ gap: 12 }}>
            <Field label={L('Nome', 'Name')} htmlFor="kk-n" error={exists ? L('Esiste già una chiave con questo nome.', 'A key with this name already exists.') : undefined} hint={L('Lettere, numeri e trattini.', 'Letters, digits and dashes.')}><Input id="kk-n" className="mono" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label={L('Tipo di chiave', 'Key type')} htmlFor="kk-t">
              <Select id="kk-t" value={form.kty} onChange={(e) => setForm({ ...form, kty: e.target.value, ops: e.target.value.startsWith('EC') ? EC_OPS : RSA_OPS })}>
                <option value="RSA">RSA</option><option value="EC">EC ({L('curva ellittica', 'elliptic curve')})</option>
                <option value="RSA-HSM">RSA-HSM (Premium)</option><option value="EC-HSM">EC-HSM (Premium)</option>
              </Select>
            </Field>
            {ec ? (
              <Field label={L('Curva', 'Curve')} htmlFor="kk-c"><Select id="kk-c" value={form.curve} onChange={(e) => setForm({ ...form, curve: e.target.value })}>{['P-256', 'P-384', 'P-521', 'P-256K'].map((c) => <option key={c}>{c}</option>)}</Select></Field>
            ) : (
              <Field label={L('Dimensione', 'Size')} htmlFor="kk-s"><Select id="kk-s" value={form.size} onChange={(e) => setForm({ ...form, size: Number(e.target.value) })}>{[2048, 3072, 4096].map((n) => <option key={n} value={n}>{n} bit</option>)}</Select></Field>
            )}
            <Field label={L('Operazioni consentite', 'Permitted operations')}>
              <div className="row" style={{ flexWrap: 'wrap' }}>{(ec ? EC_OPS : RSA_OPS).map((o) => <Checkbox key={o} checked={form.ops.includes(o)} onChange={(v) => setForm({ ...form, ops: v ? [...form.ops, o] : form.ops.filter((x) => x !== o) })} label={o} />)}</div>
            </Field>
            <Field label={L('Scadenza (facoltativa)', 'Expiry (optional)')} htmlFor="kk-e"><Input id="kk-e" type="date" value={form.exp} onChange={(e) => setForm({ ...form, exp: e.target.value })} /></Field>
            {form.kty.endsWith('HSM') && <Notice>{L('Le chiavi HSM richiedono il piano Premium del vault.', 'HSM keys require the vault\'s Premium tier.')}</Notice>}
          </div>
        )}
      </Panel>
    </Card>
  );
}

const PERMS = {
  keys: ['get', 'list', 'update', 'create', 'import', 'delete', 'recover', 'backup', 'restore', 'decrypt', 'encrypt', 'unwrapKey', 'wrapKey', 'verify', 'sign', 'purge', 'release', 'rotate', 'getrotationpolicy', 'setrotationpolicy'],
  secrets: ['get', 'list', 'set', 'delete', 'recover', 'backup', 'restore', 'purge'],
  certificates: ['get', 'list', 'update', 'create', 'import', 'delete', 'recover', 'backup', 'restore', 'managecontacts', 'manageissuers', 'getissuers', 'listissuers', 'setissuers', 'deleteissuers', 'purge'],
} as const;
type Perms = { keys: string[]; secrets: string[]; certificates: string[] };
const TEMPLATES: { key: string; it: string; en: string; p: Perms }[] = [
  { key: 'secret-reader', it: 'Lettura segreti (app)', en: 'Secret reader (apps)', p: { keys: [], secrets: ['get', 'list'], certificates: [] } },
  { key: 'secret-mgmt', it: 'Gestione segreti', en: 'Secret management', p: { keys: [], secrets: ['get', 'list', 'set', 'delete', 'recover', 'backup', 'restore'], certificates: [] } },
  { key: 'key-crypto', it: 'Uso delle chiavi (cifratura)', en: 'Key usage (crypto)', p: { keys: ['get', 'list', 'decrypt', 'encrypt', 'unwrapKey', 'wrapKey', 'verify', 'sign'], secrets: [], certificates: [] } },
  { key: 'all', it: 'Gestione di chiavi, segreti e certificati', en: 'Key, secret & certificate management', p: { keys: PERMS.keys.filter((x) => !['purge', 'release'].includes(x)), secrets: PERMS.secrets.filter((x) => x !== 'purge'), certificates: PERMS.certificates.filter((x) => x !== 'purge') } },
];

/** Modello di autorizzazione (Azure RBAC o criteri di accesso), criteri, recupero. */
export function VaultAccess({ id, vault, reload }: { id: string; vault: any; reload: () => void }) {
  const L = useL();
  const toast = useToast();
  const confirm = useConfirm();
  const p = vault.properties ?? {};
  const policies: any[] = p.accessPolicies ?? [];
  const names = useAsync(async () => {
    const ids = [...new Set(policies.map((x) => x.objectId))];
    if (!ids.length) return {} as Record<string, string>;
    const objs = await graph.post<{ value: any[] }>('/directoryObjects/getByIds', { ids }).then((r) => r.value).catch(() => [] as any[]);
    return Object.fromEntries(objs.map((o) => [o.id, o.displayName ?? o.userPrincipalName ?? o.id])) as Record<string, string>;
  }, [JSON.stringify(policies.map((x) => x.objectId))]);
  const [edit, setEdit] = useState<null | { principal?: PrincipalRef; objectId: string; perms: Perms; isNew: boolean }>(null);
  const [busy, setBusy] = useState(false);

  const switchModel = async () => {
    const toRbac = !p.enableRbacAuthorization;
    if (!(await confirm({
      title: toRbac ? L('Passare ad Azure RBAC?', 'Switch to Azure RBAC?') : L('Tornare ai criteri di accesso?', 'Switch back to access policies?'),
      text: toRbac
        ? L('I criteri di accesso smettono di valere subito: assegna prima i ruoli Key Vault (Key Vault Secrets User, Crypto User…) a utenti e app, o perderanno l\'accesso.', 'Access policies stop applying immediately: assign Key Vault roles (Key Vault Secrets User, Crypto User…) to users and apps first, or they lose access.')
        : L('Le assegnazioni di ruolo sul piano dati smettono di valere: chi non ha un criterio di accesso perde l\'accesso.', 'Data-plane role assignments stop applying: anyone without an access policy loses access.'),
      danger: true, confirmLabel: L('Cambia', 'Switch'),
    }))) return;
    try { await arm.patch(id, { properties: { enableRbacAuthorization: toRbac } }, KV_API); toast.ok(L('Modello di autorizzazione aggiornato', 'Permission model updated')); reload(); }
    catch (e) { toast.error(e); }
  };
  const savePolicy = async () => {
    if (!edit) return;
    setBusy(true);
    try {
      await arm.put(`${id}/accessPolicies/${edit.isNew ? 'add' : 'replace'}`, { properties: { accessPolicies: [{ tenantId: p.tenantId, objectId: edit.objectId, permissions: edit.perms }] } }, KV_API);
      toast.ok(L('Criterio salvato', 'Policy saved'));
      setEdit(null);
      reload();
    } catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  const removePolicy = async (ap: any) => {
    if (!(await confirm({ title: L('Rimuovere questo criterio di accesso?', 'Remove this access policy?'), danger: true, confirmLabel: L('Rimuovi', 'Remove') }))) return;
    try { await arm.put(`${id}/accessPolicies/remove`, { properties: { accessPolicies: [{ tenantId: ap.tenantId, objectId: ap.objectId, permissions: ap.permissions }] } }, KV_API); reload(); }
    catch (e) { toast.error(e); }
  };
  const recovery = async (body: any, msg: string) => {
    try { await arm.patch(id, { properties: body }, KV_API); toast.ok(msg); reload(); } catch (e) { toast.error(e); }
  };
  const summary = (perm: Perms) => (['keys', 'secrets', 'certificates'] as const).map((k) => (perm?.[k]?.length ? `${({ keys: L('Chiavi', 'Keys'), secrets: L('Segreti', 'Secrets'), certificates: L('Certificati', 'Certificates') })[k]}: ${perm[k].length === PERMS[k].length ? L('tutte', 'all') : perm[k].join(', ')}` : '')).filter(Boolean).join(' · ') || '—';
  const sub = id.split('/')[2];

  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card title={L('Modello di autorizzazione', 'Permission model')} actions={<Button onClick={() => void switchModel()}>{p.enableRbacAuthorization ? L('Usa i criteri di accesso', 'Use access policies') : L('Usa Azure RBAC', 'Use Azure RBAC')}</Button>}>
        <p style={{ margin: 0 }}>
          {p.enableRbacAuthorization
            ? <><Badge tone="ok">Azure RBAC</Badge> {L('L\'accesso a chiavi, segreti e certificati si concede con i ruoli nel Controllo di accesso (IAM). È il modello consigliato.', 'Access to keys, secrets and certificates is granted with roles in Access control (IAM). This is the recommended model.')} <a href={`/iam?scope=${encodeURIComponent(id)}`}>{L('Apri IAM', 'Open IAM')}</a></>
            : <><Badge tone="warn">{L('Criteri di accesso', 'Access policies')}</Badge> {L('Modello legacy: permessi per identità definiti sul vault.', 'Legacy model: per-identity permissions set on the vault.')}</>}
        </p>
      </Card>
      {!p.enableRbacAuthorization && (
        <Card title={L('Criteri di accesso', 'Access policies')} actions={<Button size="sm" variant="primary" icon={UserPlus} onClick={() => setEdit({ objectId: '', perms: TEMPLATES[0].p, isNew: true })}>{L('Aggiungi', 'Add')}</Button>}>
          {policies.length === 0 ? <Empty icon={ShieldCheck} title={L('Nessun criterio', 'No policies')} text={L('Senza criteri nessuno può leggere o scrivere i dati del vault.', 'Without policies nobody can read or write the vault\'s data.')} /> : (
            <div className="table-wrap" style={{ border: 0, boxShadow: 'none' }}><table className="table">
              <thead><tr><th>{L('Identità', 'Identity')}</th><th>{L('Autorizzazioni', 'Permissions')}</th><th /></tr></thead>
              <tbody>{policies.map((ap) => (
                <tr key={ap.objectId + (ap.applicationId ?? '')}>
                  <td>{names.data?.[ap.objectId] ?? <span className="mono small">{ap.objectId}</span>}</td>
                  <td className="small">{summary(ap.permissions)}</td>
                  <td><div className="row">
                    <Button size="sm" variant="ghost" onClick={() => setEdit({ objectId: ap.objectId, perms: { keys: ap.permissions?.keys ?? [], secrets: ap.permissions?.secrets ?? [], certificates: ap.permissions?.certificates ?? [] }, isNew: false })}>{L('Modifica', 'Edit')}</Button>
                    <Button size="sm" variant="ghost" icon={Trash2} aria-label={L('Rimuovi', 'Remove')} onClick={() => void removePolicy(ap)} />
                  </div></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
      )}
      <Card title={L('Recupero', 'Recovery')}>
        <div className="stack" style={{ gap: 12 }}>
          <KV items={[
            [L('Conservazione degli elementi eliminati', 'Deleted item retention'), L(`${p.softDeleteRetentionInDays ?? 90} giorni`, `${p.softDeleteRetentionInDays ?? 90} days`)],
            [L('Eliminazione temporanea', 'Soft delete'), p.enableSoftDelete === false ? <Badge tone="warn">{L('disattivata', 'disabled')}</Badge> : <Badge tone="ok">{L('attiva', 'enabled')}</Badge>],
            [L('Protezione dall\'eliminazione definitiva', 'Purge protection'), p.enablePurgeProtection ? <Badge tone="ok">{L('attiva (irreversibile)', 'enabled (irreversible)')}</Badge> : <Badge>{L('disattivata', 'disabled')}</Badge>],
          ]} />
          {!p.enablePurgeProtection && (
            <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
              <span className="small muted">{L('Impedisce di eliminare definitivamente vault e oggetti prima della fine della conservazione, anche agli amministratori.', 'Prevents permanently deleting the vault and its objects before retention ends, even for administrators.')}</span>
              <Button onClick={async () => { if (!(await confirm({ title: L('Attivare la protezione dall\'eliminazione?', 'Enable purge protection?'), text: L('Non si può più disattivare.', 'It cannot be turned off again.'), confirmLabel: L('Attiva', 'Enable') }))) return; void recovery({ enablePurgeProtection: true }, L('Protezione attivata', 'Purge protection enabled')); }}>{L('Attiva la protezione', 'Enable purge protection')}</Button>
            </div>
          )}
        </div>
      </Card>
      <Panel open={!!edit} onClose={() => setEdit(null)} wide title={edit?.isNew ? L('Nuovo criterio di accesso', 'New access policy') : L('Modifica criterio', 'Edit policy')}
        footer={<><Button onClick={() => setEdit(null)}>{L('Annulla', 'Cancel')}</Button><Button variant="primary" loading={busy} disabled={!edit?.objectId || !(edit.perms.keys.length + edit.perms.secrets.length + edit.perms.certificates.length)} onClick={() => void savePolicy()}>{L('Salva', 'Save')}</Button></>}>
        {edit && (
          <div className="stack" style={{ gap: 14 }}>
            {edit.isNew ? (
              <Field label={L('Identità', 'Identity')}>
                {edit.objectId ? <p style={{ margin: 0 }}><strong>{edit.principal?.displayName ?? edit.objectId}</strong> <span className="small muted">{edit.principal?.type}</span> <button type="button" className="link-btn" onClick={() => setEdit({ ...edit, objectId: '', principal: undefined })}>{L('Cambia', 'Change')}</button></p>
                  : <PrincipalPicker onPick={(pr) => setEdit({ ...edit, principal: pr, objectId: pr.id })} exclude={policies.map((x) => x.objectId)} />}
              </Field>
            ) : <p style={{ margin: 0 }}><strong>{names.data?.[edit.objectId] ?? edit.objectId}</strong></p>}
            <Field label={L('Modello', 'Template')} htmlFor="ap-t">
              <Select id="ap-t" value="" onChange={(e) => { const t = TEMPLATES.find((x) => x.key === e.target.value); if (t) setEdit({ ...edit, perms: t.p }); }}>
                <option value="">{L('Scegli un modello…', 'Choose a template…')}</option>
                {TEMPLATES.map((t) => <option key={t.key} value={t.key}>{L(t.it, t.en)}</option>)}
              </Select>
            </Field>
            {(['keys', 'secrets', 'certificates'] as const).map((k) => (
              <Field key={k} label={({ keys: L('Chiavi', 'Keys'), secrets: L('Segreti', 'Secrets'), certificates: L('Certificati', 'Certificates') })[k]}>
                <div className="row" style={{ flexWrap: 'wrap', gap: '4px 14px' }}>{PERMS[k].map((perm) => (
                  <Checkbox key={perm} checked={edit.perms[k].includes(perm)} onChange={(v) => setEdit({ ...edit, perms: { ...edit.perms, [k]: v ? [...edit.perms[k], perm] : edit.perms[k].filter((x) => x !== perm) } })} label={perm} />
                ))}</div>
              </Field>
            ))}
            <p className="small muted" style={{ margin: 0 }}>{L(`Tenant: ${p.tenantId} · sottoscrizione ${sub}`, `Tenant: ${p.tenantId} · subscription ${sub}`)}</p>
          </div>
        )}
      </Panel>
    </div>
  );
}

/** Rete del vault. */
export function VaultNetworking({ id, vault, reload }: { id: string; vault: any; reload: () => void }) {
  const L = useL();
  const save = async (s: NetworkState) => {
    await arm.patch(id, {
      properties: {
        publicNetworkAccess: s.mode === 'disabled' ? 'Disabled' : 'Enabled',
        networkAcls: {
          defaultAction: s.mode === 'selected' ? 'Deny' : 'Allow', bypass: s.bypass ? 'AzureServices' : 'None',
          ipRules: s.mode === 'selected' ? s.ipRules.map((value) => ({ value })) : [],
          virtualNetworkRules: s.mode === 'selected' ? s.subnets.map((sid) => ({ id: sid })) : [],
        },
      },
    }, KV_API);
    reload();
  };
  return <NetworkAccessCard id={id} state={readNetwork(vault.properties)} endpoint="Microsoft.KeyVault" bypass={L('Consenti ai servizi Microsoft attendibili di ignorare il firewall', 'Allow trusted Microsoft services to bypass this firewall')} onSave={save} />;
}
