'use client';

import { useState } from 'react';
import { Pencil, Plus, Settings2, Trash2 } from 'lucide-react';
import { arm } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { Badge, Button, Card, Empty, ErrorNotice, Field, Input, Notice, Skeleton, Textarea } from '../ui';
import { Panel, useConfirm, useToast } from '../overlay';
import { useL } from './common';
import { KeysCard } from './keys';

export const APPCFG_API = '2024-05-01';
/** Nome ARM di una coppia chiave-valore: chiave$etichetta, con i caratteri riservati codificati. */
const armName = (key: string, label: string) => encodeURIComponent(label ? `${key}$${label}` : key);

/** Valori chiave dell'archivio di configurazione. */
export function AppConfigValues({ id, store }: { id: string; store: any }) {
  const L = useL();
  const toast = useToast();
  const confirm = useConfirm();
  const list = useAsync(async () => (await arm.get<{ value: any[] }>(`${id}/keyValues`, APPCFG_API)).value, [id]);
  const [edit, setEdit] = useState<null | { key: string; label: string; value: string; contentType: string; isNew: boolean }>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!edit) return;
    setBusy(true);
    try {
      await arm.put(`${id}/keyValues/${armName(edit.key, edit.label)}`, { properties: { value: edit.value, contentType: edit.contentType || undefined } }, APPCFG_API);
      toast.ok(L('Valore salvato', 'Value saved'), edit.key);
      setEdit(null); list.reload();
    } catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  const keyOf = (kv: any) => kv.properties?.key ?? String(kv.name).split('$')[0];
  const labelOf = (kv: any) => kv.properties?.label ?? (String(kv.name).includes('$') ? String(kv.name).split('$').slice(1).join('$') : '');
  const keyOk = !!edit && edit.key.length > 0 && edit.key !== '.' && edit.key !== '..' && !edit.key.includes('%') && !edit.key.includes('$');
  return (
    <Card title={L('Esplora configurazione', 'Configuration explorer')} actions={<Button size="sm" variant="primary" icon={Plus} onClick={() => setEdit({ key: '', label: '', value: '', contentType: '', isNew: true })}>{L('Nuovo valore', 'New value')}</Button>}>
      {store.properties?.disableLocalAuth && <Notice>{L('L\'accesso con chiavi è disattivato: le app leggono la configurazione con Microsoft Entra ID (ruolo App Configuration Data Reader).', 'Key access is disabled: apps read configuration with Microsoft Entra ID (App Configuration Data Reader role).')}</Notice>}
      {list.error ? <Notice tone="warn">{L('Questa directory non permette di elencare i valori tramite Azure Resource Manager: puoi comunque crearli e aggiornarli qui, oppure usare az appconfig kv list.', 'This directory does not allow listing values through Azure Resource Manager: you can still create and update them here, or use az appconfig kv list.')}</Notice>
        : !list.data ? <Skeleton rows={3} /> : list.data.length === 0 ? <Empty icon={Settings2} title={L('Nessun valore', 'No values')} text={L('Chiavi come App:Colore con etichette per ambiente (dev, prod) e riferimenti a Key Vault.', 'Keys like App:Color with labels per environment (dev, prod) and Key Vault references.')} /> : (
          <div className="table-wrap" style={{ border: 0, boxShadow: 'none' }}><table className="table">
            <thead><tr><th>{L('Chiave', 'Key')}</th><th>{L('Etichetta', 'Label')}</th><th>{L('Valore', 'Value')}</th><th>{L('Tipo di contenuto', 'Content type')}</th><th /></tr></thead>
            <tbody>{list.data.map((kv) => {
              const kvRef = String(kv.properties?.contentType ?? '').includes('keyvaultref');
              return (
                <tr key={kv.id}>
                  <td className="mono">{keyOf(kv)}</td>
                  <td>{labelOf(kv) ? <Badge>{labelOf(kv)}</Badge> : <span className="muted small">{L('(nessuna)', '(none)')}</span>}</td>
                  <td className="mono small" style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis' }}>{kvRef ? <Badge tone="info">Key Vault</Badge> : kv.properties?.value}</td>
                  <td className="small muted">{kv.properties?.contentType || '—'}</td>
                  <td><div className="row">
                    <Button size="sm" variant="ghost" icon={Pencil} aria-label={L('Modifica', 'Edit')} onClick={() => setEdit({ key: keyOf(kv), label: labelOf(kv), value: kv.properties?.value ?? '', contentType: kv.properties?.contentType ?? '', isNew: false })} />
                    <Button size="sm" variant="ghost" icon={Trash2} aria-label={L('Elimina', 'Delete')} onClick={async () => { if (!(await confirm({ title: L(`Eliminare ${keyOf(kv)}?`, `Delete ${keyOf(kv)}?`), danger: true, confirmLabel: L('Elimina', 'Delete') }))) return; try { await arm.del(`${id}/keyValues/${armName(keyOf(kv), labelOf(kv))}`, APPCFG_API); list.reload(); } catch (e) { toast.error(e); } }} />
                  </div></td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      <Panel open={!!edit} onClose={() => setEdit(null)} title={edit?.isNew ? L('Nuovo valore', 'New value') : L('Modifica valore', 'Edit value')}
        footer={<><Button onClick={() => setEdit(null)}>{L('Annulla', 'Cancel')}</Button><Button variant="primary" loading={busy} disabled={!keyOk} onClick={() => void save()}>{L('Salva', 'Save')}</Button></>}>
        {edit && (
          <>
            <Field label={L('Chiave', 'Key')} htmlFor="ck" hint={L('Usa : per i livelli, per esempio App:Database:Timeout.', 'Use : for levels, e.g. App:Database:Timeout.')}><Input id="ck" className="mono" disabled={!edit.isNew} value={edit.key} onChange={(e) => setEdit({ ...edit, key: e.target.value })} /></Field>
            <Field label={L('Etichetta (facoltativa)', 'Label (optional)')} htmlFor="cl"><Input id="cl" className="mono" disabled={!edit.isNew} placeholder="prod" value={edit.label} onChange={(e) => setEdit({ ...edit, label: e.target.value })} /></Field>
            <Field label={L('Valore', 'Value')} htmlFor="cv"><Textarea id="cv" code rows={4} value={edit.value} onChange={(e) => setEdit({ ...edit, value: e.target.value })} /></Field>
            <Field label={L('Tipo di contenuto (facoltativo)', 'Content type (optional)')} htmlFor="cc"><Input id="cc" className="mono" placeholder="application/json" value={edit.contentType} onChange={(e) => setEdit({ ...edit, contentType: e.target.value })} /></Field>
          </>
        )}
      </Panel>
    </Card>
  );
}

/** Chiavi di accesso (lettura/scrittura e sola lettura) con rigenerazione. */
export function AppConfigKeys({ id, store }: { id: string; store: any }) {
  const L = useL();
  const load = async () => {
    const keys = (await arm.post<{ value: any[] }>(`${id}/listKeys`, {}, APPCFG_API)).value;
    return keys.map((k) => ({ key: k.id, label: <span>{k.name} {k.readOnly && <Badge>{L('sola lettura', 'read-only')}</Badge>}</span>, value: k.connectionString, regen: () => arm.post(`${id}/regenerateKey`, { id: k.id }, APPCFG_API) }));
  };
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card title="Endpoint"><p className="mono" style={{ margin: 0 }}>{store.properties?.endpoint}</p></Card>
      <KeysCard title={L('Stringhe di connessione', 'Connection strings')} load={load}
        disabled={store.properties?.disableLocalAuth ? L('L\'accesso con chiavi è disattivato.', 'Key access is disabled.') : undefined}
        note={L('Alle app basta di solito una chiave di sola lettura.', 'Apps usually only need a read-only key.')} />
    </div>
  );
}
