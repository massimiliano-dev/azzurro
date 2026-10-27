'use client';

import { useState } from 'react';
import { Box, Database, FolderOpen, ListOrdered, Plus, Table2, Trash2 } from 'lucide-react';
import { arm } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { Badge, Button, Card, Empty, ErrorNotice, Field, Input, Select, Skeleton } from '../ui';
import { Panel, useConfirm, useToast } from '../overlay';
import { useL } from './common';

const COSMOS = '2024-05-15';
const STORAGE = '2023-05-01';

/** Database e contenitori di un account Cosmos DB (API NoSQL). */
export function CosmosExplorer({ accountId, account }: { accountId: string; account: any }) {
  const L = useL();
  const toast = useToast();
  const confirm = useConfirm();
  const serverless = (account.properties?.capabilities ?? []).some((c: any) => c.name === 'EnableServerless');
  const dbs = useAsync(async () => {
    const list = (await arm.get<{ value: any[] }>(`${accountId}/sqlDatabases`, COSMOS)).value;
    return Promise.all(list.map(async (d) => ({ db: d, containers: (await arm.get<{ value: any[] }>(`${d.id}/containers`, COSMOS)).value })));
  }, [accountId]);
  const [panel, setPanel] = useState<null | { kind: 'db' } | { kind: 'container'; db: string }>(null);
  const [name, setName] = useState('');
  const [pk, setPk] = useState('/id');
  const [mode, setMode] = useState<'none' | 'manual' | 'autoscale'>('none');
  const [ru, setRu] = useState(400);
  const [busy, setBusy] = useState(false);
  const options = () => (serverless || mode === 'none' ? {} : mode === 'manual' ? { throughput: ru } : { autoscaleSettings: { maxThroughput: Math.max(1000, ru) } });
  const create = async () => {
    if (!panel) return;
    setBusy(true);
    try {
      if (panel.kind === 'db') await arm.put(`${accountId}/sqlDatabases/${name}`, { properties: { resource: { id: name }, options: options() } }, COSMOS);
      else await arm.put(`${accountId}/sqlDatabases/${panel.db}/containers/${name}`, { properties: { resource: { id: name, partitionKey: { paths: [pk], kind: 'Hash', version: 2 } }, options: options() } }, COSMOS);
      toast.ok(L('Creato', 'Created'), name);
      setPanel(null); setName(''); dbs.reload();
    } catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  const del = async (id: string, n: string) => {
    if (!(await confirm({ title: L(`Eliminare ${n}?`, `Delete ${n}?`), text: L('Tutti i dati vengono persi.', 'All data is lost.'), danger: true, confirmLabel: L('Elimina', 'Delete'), typeToConfirm: n }))) return;
    try { await arm.del(id, COSMOS); dbs.reload(); } catch (e) { toast.error(e); }
  };
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row"><Button variant="primary" icon={Plus} onClick={() => { setPanel({ kind: 'db' }); setName(''); }}>{L('Nuovo database', 'New database')}</Button>{serverless && <Badge tone="info">serverless</Badge>}</div>
      {dbs.error ? <ErrorNotice error={dbs.error} onRetry={dbs.reload} /> : !dbs.data ? <Skeleton rows={3} /> : dbs.data.length === 0 ? (
        <Empty icon={Database} title={L('Nessun database', 'No databases')} text={L('Crea un database e poi i contenitori con la loro chiave di partizione.', 'Create a database, then containers with their partition key.')} />
      ) : dbs.data.map(({ db, containers }) => (
        <Card key={db.id} title={db.name} actions={<><Button size="sm" icon={Plus} onClick={() => { setPanel({ kind: 'container', db: db.name }); setName(''); setPk('/id'); }}>{L('Contenitore', 'Container')}</Button><Button size="sm" variant="ghost" icon={Trash2} aria-label={L('Elimina', 'Delete')} onClick={() => void del(db.id, db.name)} /></>}>
          {containers.length === 0 ? <p className="small muted">{L('Nessun contenitore.', 'No containers.')}</p> : (
            <table className="table compact"><thead><tr><th>{L('Contenitore', 'Container')}</th><th>{L('Chiave di partizione', 'Partition key')}</th><th /></tr></thead>
              <tbody>{containers.map((c) => (
                <tr key={c.id}><td><div className="cell-main"><Box size={15} aria-hidden />{c.name}</div></td><td className="mono">{(c.properties?.resource?.partitionKey?.paths ?? []).join(', ')}</td>
                  <td style={{ textAlign: 'right' }}><Button size="sm" variant="ghost" icon={Trash2} aria-label={L('Elimina', 'Delete')} onClick={() => void del(c.id, c.name)} /></td></tr>
              ))}</tbody></table>
          )}
        </Card>
      ))}
      <Panel open={!!panel} onClose={() => setPanel(null)} title={panel?.kind === 'container' ? L(`Nuovo contenitore in ${panel.db}`, `New container in ${panel.db}`) : L('Nuovo database', 'New database')}
        footer={<><Button variant="primary" loading={busy} disabled={!/^[^/\\#?]{1,255}$/.test(name) || (panel?.kind === 'container' && !/^\/[\w./-]+$/.test(pk))} onClick={() => void create()}>{L('Crea', 'Create')}</Button><Button onClick={() => setPanel(null)}>{L('Annulla', 'Cancel')}</Button></>}>
        <Field label={L('Nome', 'Name')} htmlFor="cn"><Input id="cn" value={name} autoFocus onChange={(e) => setName(e.target.value)} /></Field>
        {panel?.kind === 'container' && <Field label={L('Chiave di partizione', 'Partition key')} htmlFor="pk" hint={L('Scegli un campo con molti valori diversi, per esempio /tenantId o /userId.', 'Pick a field with many distinct values, for example /tenantId or /userId.')}><Input id="pk" value={pk} onChange={(e) => setPk(e.target.value)} /></Field>}
        {!serverless && (
          <div className="form-grid">
            <Field label={L('Velocità effettiva', 'Throughput')} htmlFor="tm"><Select id="tm" value={mode} onChange={(e) => setMode(e.target.value as any)}>
              <option value="none">{panel?.kind === 'db' ? L('Nessuna (per contenitore)', 'None (per container)') : L('Condivisa dal database', 'Shared from database')}</option>
              <option value="manual">{L('Manuale', 'Manual')}</option><option value="autoscale">{L('Scalabilità automatica', 'Autoscale')}</option>
            </Select></Field>
            {mode !== 'none' && <Field label={mode === 'manual' ? 'RU/s' : L('RU/s massime', 'Max RU/s')} htmlFor="ru"><Input id="ru" type="number" min={mode === 'manual' ? 400 : 1000} step={100} value={ru} onChange={(e) => setRu(Number(e.target.value))} /></Field>}
          </div>
        )}
      </Panel>
    </div>
  );
}

type Kind = 'containers' | 'queues' | 'tables' | 'shares';
const PATHS: Record<Kind, string> = { containers: 'blobServices/default/containers', queues: 'queueServices/default/queues', tables: 'tableServices/default/tables', shares: 'fileServices/default/shares' };

/** Contenitori BLOB, code, tabelle e condivisioni file di un account di archiviazione. */
export function StorageData({ accountId }: { accountId: string }) {
  const L = useL();
  const toast = useToast();
  const confirm = useConfirm();
  const [kind, setKind] = useState<Kind>('containers');
  const list = useAsync(async () => (await arm.get<{ value: any[] }>(`${accountId}/${PATHS[kind]}`, STORAGE)).value, [accountId, kind]);
  const [name, setName] = useState('');
  const [access, setAccess] = useState('None');
  const [quota, setQuota] = useState(100);
  const [busy, setBusy] = useState(false);
  const rule = kind === 'tables' ? /^[A-Za-z][A-Za-z0-9]{2,62}$/ : /^[a-z0-9](?!.*--)[a-z0-9-]{1,61}[a-z0-9]$/;
  const labels: Record<Kind, [string, string, typeof Box]> = { containers: [L('Contenitori BLOB', 'Blob containers'), L('contenitore', 'container'), FolderOpen], queues: [L('Code', 'Queues'), L('coda', 'queue'), ListOrdered], tables: [L('Tabelle', 'Tables'), L('tabella', 'table'), Table2], shares: [L('Condivisioni file', 'File shares'), L('condivisione', 'share'), Box] };
  const create = async () => {
    setBusy(true);
    try {
      const props = kind === 'containers' ? { publicAccess: access } : kind === 'shares' ? { shareQuota: quota, accessTier: 'TransactionOptimized' } : {};
      await arm.put(`${accountId}/${PATHS[kind]}/${name}`, { properties: props }, STORAGE);
      toast.ok(L('Creato', 'Created'), name); setName(''); list.reload();
    } catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  const Icon = labels[kind][2];
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="seg" role="tablist">{(Object.keys(PATHS) as Kind[]).map((k) => <button key={k} className={kind === k ? 'on' : ''} onClick={() => { setKind(k); setName(''); }}>{labels[k][0]}</button>)}</div>
      <div className="row wrap" style={{ alignItems: 'flex-end' }}>
        <Field label={L(`Nuova ${labels[kind][1]}`, `New ${labels[kind][1]}`)} htmlFor="sn" error={name && !rule.test(name) ? (kind === 'tables' ? L('Lettere e numeri, inizia con una lettera, 3-63 caratteri.', 'Letters and numbers, starting with a letter, 3-63 characters.') : L('Minuscole, numeri e trattini, 3-63 caratteri.', 'Lowercase letters, numbers and hyphens, 3-63 characters.')) : undefined}>
          <Input id="sn" value={name} onChange={(e) => setName(e.target.value)} style={{ minWidth: 260 }} />
        </Field>
        {kind === 'containers' && <Field label={L('Accesso anonimo', 'Anonymous access')} htmlFor="pa"><Select id="pa" value={access} onChange={(e) => setAccess(e.target.value)}><option value="None">{L('Privato', 'Private')}</option><option value="Blob">{L('Lettura dei BLOB', 'Blob read')}</option><option value="Container">{L('Lettura del contenitore', 'Container read')}</option></Select></Field>}
        {kind === 'shares' && <Field label={L('Quota (GiB)', 'Quota (GiB)')} htmlFor="qt"><Input id="qt" type="number" min={1} max={102400} value={quota} onChange={(e) => setQuota(Number(e.target.value))} /></Field>}
        <Button icon={Plus} variant="primary" loading={busy} disabled={!rule.test(name)} onClick={() => void create()} style={{ marginBottom: 16 }}>{L('Crea', 'Create')}</Button>
      </div>
      {list.error ? <ErrorNotice error={list.error} onRetry={list.reload} /> : !list.data ? <Skeleton rows={3} /> : list.data.length === 0 ? <Empty icon={Icon} title={L('Ancora vuoto', 'Still empty')} /> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>{L('Nome', 'Name')}</th>{kind === 'containers' && <th>{L('Accesso', 'Access')}</th>}{kind === 'shares' && <th>Quota</th>}<th /></tr></thead>
          <tbody>{list.data.map((x) => (
            <tr key={x.id}>
              <td><div className="cell-main"><Icon size={15} aria-hidden />{x.name}</div></td>
              {kind === 'containers' && <td>{x.properties?.publicAccess && x.properties.publicAccess !== 'None' ? <Badge tone="warn">{x.properties.publicAccess}</Badge> : <Badge tone="ok">{L('privato', 'private')}</Badge>}</td>}
              {kind === 'shares' && <td className="num">{x.properties?.shareQuota ?? '—'} GiB</td>}
              <td style={{ textAlign: 'right' }}><Button size="sm" variant="ghost" icon={Trash2} aria-label={L('Elimina', 'Delete')} onClick={async () => {
                if (!(await confirm({ title: L(`Eliminare ${x.name}?`, `Delete ${x.name}?`), text: L('Il contenuto viene perso.', 'The content is lost.'), danger: true, confirmLabel: L('Elimina', 'Delete') }))) return;
                try { await arm.del(x.id, STORAGE); list.reload(); } catch (e) { toast.error(e); }
              }} /></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  );
}
