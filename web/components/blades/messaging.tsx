'use client';

import { useState } from 'react';
import { Inbox, KeyRound, Plus, Trash2 } from 'lucide-react';
import { arm } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { Badge, Button, Card, Checkbox, Empty, ErrorNotice, Field, Input, Notice, Select, Skeleton, Switch } from '../ui';
import { Panel, useConfirm, useToast } from '../overlay';
import { useL } from './common';
import { KeysCard } from './keys';

export type MsgKind = 'servicebus' | 'eventhub';
export const msgKind = (type: string): MsgKind | null => {
  const t = type.toLowerCase();
  if (t === 'microsoft.servicebus/namespaces') return 'servicebus';
  if (t === 'microsoft.eventhub/namespaces') return 'eventhub';
  return null;
};
export const MSG_API: Record<MsgKind, string> = { servicebus: '2022-10-01-preview', eventhub: '2024-01-01' };
const NAME_RE = /^[a-zA-Z0-9]([\w.-]{0,258}[a-zA-Z0-9])?$/;
const TTL: [string, string, string][] = [['PT1H', '1 ora', '1 hour'], ['P1D', '1 giorno', '1 day'], ['P7D', '7 giorni', '7 days'], ['P14D', '14 giorni', '14 days']];

function useDel() {
  const L = useL();
  const toast = useToast();
  const confirm = useConfirm();
  return async (id: string, api: string, after: () => void, what: string) => {
    if (!(await confirm({ title: L(`Eliminare ${what}?`, `Delete ${what}?`), text: L('I messaggi non ancora letti vanno persi.', 'Messages not yet read are lost.'), danger: true, confirmLabel: L('Elimina', 'Delete'), typeToConfirm: what }))) return;
    try { await arm.del(id, api); toast.ok(L('Eliminato', 'Deleted'), what); after(); } catch (e) { toast.error(e); }
  };
}

/** Code, argomenti e sottoscrizioni del bus di servizio. */
export function SbEntities({ id, ns }: { id: string; ns: any }) {
  const L = useL();
  const toast = useToast();
  const del = useDel();
  const api = MSG_API.servicebus;
  const queues = useAsync(async () => (await arm.get<{ value: any[] }>(`${id}/queues`, api)).value, [id]);
  const topics = useAsync(async () => {
    const list = (await arm.get<{ value: any[] }>(`${id}/topics`, api)).value;
    return Promise.all(list.map(async (t) => ({ ...t, subs: (await arm.get<{ value: any[] }>(`${t.id}/subscriptions`, api)).value })));
  }, [id]);
  const basic = ns.sku?.name === 'Basic';
  const [open, setOpen] = useState<null | { kind: 'queue' | 'topic' | 'sub'; topic?: string }>(null);
  const [f, setF] = useState({ name: '', size: 1024, ttl: 'P14D', lock: 'PT1M', maxDelivery: 10, session: false, dlq: false, dup: false });
  const [busy, setBusy] = useState(false);
  const create = async () => {
    if (!open) return;
    setBusy(true);
    try {
      if (open.kind === 'queue') await arm.put(`${id}/queues/${f.name}`, { properties: { maxSizeInMegabytes: f.size, defaultMessageTimeToLive: f.ttl, lockDuration: f.lock, maxDeliveryCount: f.maxDelivery, requiresSession: f.session, deadLetteringOnMessageExpiration: f.dlq, requiresDuplicateDetection: f.dup } }, api);
      else if (open.kind === 'topic') await arm.put(`${id}/topics/${f.name}`, { properties: { maxSizeInMegabytes: f.size, defaultMessageTimeToLive: f.ttl, requiresDuplicateDetection: f.dup } }, api);
      else await arm.put(`${id}/topics/${open.topic}/subscriptions/${f.name}`, { properties: { lockDuration: f.lock, maxDeliveryCount: f.maxDelivery, requiresSession: f.session, deadLetteringOnMessageExpiration: f.dlq, defaultMessageTimeToLive: f.ttl } }, api);
      toast.ok(L('Creato', 'Created'), f.name);
      setOpen(null); setF({ ...f, name: '' });
      if (open.kind === 'queue') queues.reload(); else topics.reload();
    } catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  const nameOk = NAME_RE.test(f.name);
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card title={L('Code', 'Queues')} actions={<Button size="sm" icon={Plus} onClick={() => setOpen({ kind: 'queue' })}>{L('Nuova coda', 'New queue')}</Button>}>
        {queues.error ? <ErrorNotice error={queues.error} onRetry={queues.reload} /> : !queues.data ? <Skeleton rows={2} /> : queues.data.length === 0 ? <Empty icon={Inbox} title={L('Nessuna coda', 'No queues')} text={L('Una coda consegna ogni messaggio a un solo destinatario.', 'A queue delivers each message to a single receiver.')} /> : (
          <div className="table-wrap" style={{ border: 0, boxShadow: 'none' }}><table className="table">
            <thead><tr><th>{L('Nome', 'Name')}</th><th>{L('Messaggi', 'Messages')}</th><th>{L('Dead-letter', 'Dead-letter')}</th><th>{L('Dimensione massima', 'Max size')}</th><th>{L('Opzioni', 'Options')}</th><th /></tr></thead>
            <tbody>{queues.data.map((q) => (
              <tr key={q.id}>
                <td className="mono">{q.name}</td>
                <td className="mono">{q.properties?.countDetails?.activeMessageCount ?? q.properties?.messageCount ?? 0}</td>
                <td className="mono">{q.properties?.countDetails?.deadLetterMessageCount ?? 0}</td>
                <td className="mono">{q.properties?.maxSizeInMegabytes} MB</td>
                <td>{q.properties?.requiresSession && <Badge>{L('sessioni', 'sessions')}</Badge>} {q.properties?.requiresDuplicateDetection && <Badge>{L('deduplica', 'dedup')}</Badge>}</td>
                <td><Button size="sm" variant="ghost" icon={Trash2} aria-label={L('Elimina', 'Delete')} onClick={() => void del(q.id, api, queues.reload, q.name)} /></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      <Card title={L('Argomenti', 'Topics')} actions={<Button size="sm" icon={Plus} disabled={basic} title={basic ? L('Serve il piano Standard o Premium', 'Requires the Standard or Premium tier') : undefined} onClick={() => setOpen({ kind: 'topic' })}>{L('Nuovo argomento', 'New topic')}</Button>}>
        {basic ? <Notice>{L('Il piano Basic non supporta argomenti e sottoscrizioni: passa a Standard.', 'The Basic tier does not support topics and subscriptions: move to Standard.')}</Notice> : topics.error ? <ErrorNotice error={topics.error} onRetry={topics.reload} /> : !topics.data ? <Skeleton rows={2} /> : topics.data.length === 0 ? <Empty icon={Inbox} title={L('Nessun argomento', 'No topics')} text={L('Un argomento consegna ogni messaggio a tutte le sue sottoscrizioni.', 'A topic delivers each message to all its subscriptions.')} /> : (
          <div className="stack" style={{ gap: 12 }}>
            {topics.data.map((t) => (
              <div key={t.id} className="stack" style={{ gap: 6 }}>
                <div className="row"><strong className="mono">{t.name}</strong><Badge>{t.subs.length} {L('sottoscrizioni', 'subscriptions')}</Badge><span style={{ flex: 1 }} />
                  <Button size="sm" icon={Plus} onClick={() => setOpen({ kind: 'sub', topic: t.name })}>{L('Sottoscrizione', 'Subscription')}</Button>
                  <Button size="sm" variant="ghost" icon={Trash2} aria-label={L('Elimina', 'Delete')} onClick={() => void del(t.id, api, topics.reload, t.name)} />
                </div>
                {t.subs.map((s: any) => (
                  <div className="row" key={s.id} style={{ paddingLeft: 20 }}>
                    <span className="mono small">↳ {s.name}</span><span className="small muted">{s.properties?.messageCount ?? 0} {L('messaggi', 'messages')} · {L('max consegne', 'max deliveries')} {s.properties?.maxDeliveryCount}</span><span style={{ flex: 1 }} />
                    <Button size="sm" variant="ghost" icon={Trash2} aria-label={L('Elimina', 'Delete')} onClick={() => void del(s.id, api, topics.reload, s.name)} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </Card>
      <Panel open={!!open} onClose={() => setOpen(null)} title={open?.kind === 'queue' ? L('Nuova coda', 'New queue') : open?.kind === 'topic' ? L('Nuovo argomento', 'New topic') : L(`Nuova sottoscrizione a ${open?.topic}`, `New subscription to ${open?.topic}`)}
        footer={<><Button onClick={() => setOpen(null)}>{L('Annulla', 'Cancel')}</Button><Button variant="primary" loading={busy} disabled={!nameOk} onClick={() => void create()}>{L('Crea', 'Create')}</Button></>}>
        <Field label={L('Nome', 'Name')} htmlFor="en"><Input id="en" className="mono" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        {open?.kind !== 'sub' && <Field label={L('Dimensione massima', 'Max size')} htmlFor="es"><Select id="es" value={f.size} onChange={(e) => setF({ ...f, size: Number(e.target.value) })}>{[1024, 2048, 3072, 4096, 5120].map((n) => <option key={n} value={n}>{n / 1024} GB</option>)}</Select></Field>}
        <Field label={L('Durata dei messaggi', 'Message time to live')} htmlFor="et"><Select id="et" value={f.ttl} onChange={(e) => setF({ ...f, ttl: e.target.value })}>{TTL.map(([v, it, en]) => <option key={v} value={v}>{L(it, en)}</option>)}</Select></Field>
        {open?.kind !== 'topic' && (
          <>
            <Field label={L('Durata del blocco', 'Lock duration')} htmlFor="el"><Select id="el" value={f.lock} onChange={(e) => setF({ ...f, lock: e.target.value })}>{['PT30S', 'PT1M', 'PT2M', 'PT5M'].map((v) => <option key={v}>{v}</option>)}</Select></Field>
            <Field label={L('Consegne massime prima del dead-letter', 'Max deliveries before dead-letter')} htmlFor="ed"><Input id="ed" type="number" min={1} max={2000} value={f.maxDelivery} onChange={(e) => setF({ ...f, maxDelivery: Number(e.target.value) })} /></Field>
            <Switch checked={f.session} onChange={(v) => setF({ ...f, session: v })} label={L('Sessioni (ordine garantito per chiave)', 'Sessions (ordered per key)')} />
            <Switch checked={f.dlq} onChange={(v) => setF({ ...f, dlq: v })} label={L('Sposta nel dead-letter i messaggi scaduti', 'Dead-letter expired messages')} />
          </>
        )}
        {open?.kind !== 'sub' && <Switch checked={f.dup} onChange={(v) => setF({ ...f, dup: v })} label={L('Rilevamento dei duplicati', 'Duplicate detection')} />}
      </Panel>
    </div>
  );
}

/** Hub eventi e gruppi di consumer. */
export function EhEntities({ id, ns }: { id: string; ns: any }) {
  const L = useL();
  const toast = useToast();
  const del = useDel();
  const api = MSG_API.eventhub;
  const hubs = useAsync(async () => {
    const list = (await arm.get<{ value: any[] }>(`${id}/eventhubs`, api)).value;
    return Promise.all(list.map(async (h) => ({ ...h, groups: (await arm.get<{ value: any[] }>(`${h.id}/consumergroups`, api)).value })));
  }, [id]);
  const basic = ns.sku?.name === 'Basic';
  const [open, setOpen] = useState<null | { kind: 'hub' | 'group'; hub?: string }>(null);
  const [f, setF] = useState({ name: '', partitions: 2, retention: 1 });
  const [busy, setBusy] = useState(false);
  const create = async () => {
    if (!open) return;
    setBusy(true);
    try {
      if (open.kind === 'hub') await arm.put(`${id}/eventhubs/${f.name}`, { properties: { partitionCount: f.partitions, messageRetentionInDays: f.retention } }, api);
      else await arm.put(`${id}/eventhubs/${open.hub}/consumergroups/${f.name}`, { properties: {} }, api);
      toast.ok(L('Creato', 'Created'), f.name);
      setOpen(null); setF({ ...f, name: '' }); hubs.reload();
    } catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  return (
    <Card title={L('Hub eventi', 'Event hubs')} actions={<Button size="sm" icon={Plus} onClick={() => setOpen({ kind: 'hub' })}>{L('Nuovo hub eventi', 'New event hub')}</Button>}>
      {hubs.error ? <ErrorNotice error={hubs.error} onRetry={hubs.reload} /> : !hubs.data ? <Skeleton rows={2} /> : hubs.data.length === 0 ? <Empty icon={Inbox} title={L('Nessun hub eventi', 'No event hubs')} text={L('Un hub eventi raccoglie flussi di eventi divisi in partizioni, letti da più gruppi di consumer.', 'An event hub collects event streams split into partitions, read by several consumer groups.')} /> : (
        <div className="stack" style={{ gap: 12 }}>
          {hubs.data.map((h) => (
            <div key={h.id} className="stack" style={{ gap: 6 }}>
              <div className="row wrap"><strong className="mono">{h.name}</strong><Badge>{h.properties?.partitionCount} {L('partizioni', 'partitions')}</Badge><Badge>{L('conservazione', 'retention')} {h.properties?.messageRetentionInDays ?? h.properties?.retentionDescription?.retentionTimeInHours / 24} {L('g', 'd')}</Badge><span style={{ flex: 1 }} />
                <Button size="sm" icon={Plus} disabled={basic && h.groups.length >= 1} title={basic ? L('Il piano Basic ha un solo gruppo di consumer', 'The Basic tier has a single consumer group') : undefined} onClick={() => setOpen({ kind: 'group', hub: h.name })}>{L('Gruppo di consumer', 'Consumer group')}</Button>
                <Button size="sm" variant="ghost" icon={Trash2} aria-label={L('Elimina', 'Delete')} onClick={() => void del(h.id, api, hubs.reload, h.name)} />
              </div>
              {h.groups.map((g: any) => (
                <div className="row" key={g.id} style={{ paddingLeft: 20 }}>
                  <span className="mono small">↳ {g.name}</span><span style={{ flex: 1 }} />
                  {g.name !== '$Default' && <Button size="sm" variant="ghost" icon={Trash2} aria-label={L('Elimina', 'Delete')} onClick={() => void del(g.id, api, hubs.reload, g.name)} />}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      <Panel open={!!open} onClose={() => setOpen(null)} title={open?.kind === 'hub' ? L('Nuovo hub eventi', 'New event hub') : L(`Nuovo gruppo di consumer in ${open?.hub}`, `New consumer group in ${open?.hub}`)}
        footer={<><Button onClick={() => setOpen(null)}>{L('Annulla', 'Cancel')}</Button><Button variant="primary" loading={busy} disabled={!NAME_RE.test(f.name)} onClick={() => void create()}>{L('Crea', 'Create')}</Button></>}>
        <Field label={L('Nome', 'Name')} htmlFor="hn"><Input id="hn" className="mono" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        {open?.kind === 'hub' && (
          <>
            <Field label={L('Partizioni', 'Partitions')} htmlFor="hp" hint={L('Non si possono cambiare dopo (salvo piano Premium): decidono quanti lettori lavorano in parallelo.', 'Cannot be changed later (except Premium): they set how many readers work in parallel.')}><Select id="hp" value={f.partitions} onChange={(e) => setF({ ...f, partitions: Number(e.target.value) })}>{[1, 2, 4, 8, 16, 32].map((n) => <option key={n}>{n}</option>)}</Select></Field>
            <Field label={L('Conservazione (giorni)', 'Retention (days)')} htmlFor="hr"><Select id="hr" value={f.retention} onChange={(e) => setF({ ...f, retention: Number(e.target.value) })}>{(basic ? [1] : [1, 2, 3, 4, 5, 6, 7]).map((n) => <option key={n}>{n}</option>)}</Select></Field>
          </>
        )}
      </Panel>
    </Card>
  );
}

const RIGHTS = ['Listen', 'Send', 'Manage'];

/** Criteri di accesso condiviso del namespace: chiavi e stringhe di connessione. */
export function MsgPolicies({ id, ns, kind }: { id: string; ns: any; kind: MsgKind }) {
  const L = useL();
  const toast = useToast();
  const confirm = useConfirm();
  const api = MSG_API[kind];
  const rules = useAsync(async () => (await arm.get<{ value: any[] }>(`${id}/authorizationRules`, api)).value, [id]);
  const [f, setF] = useState({ name: '', rights: ['Listen'] });
  const [busy, setBusy] = useState(false);
  const local = !ns.properties?.disableLocalAuth;
  const keysOf = (ruleId: string) => async () => {
    const k = await arm.post<any>(`${ruleId}/listKeys`, {}, api);
    const regen = (keyType: string) => () => arm.post(`${ruleId}/regenerateKeys`, { keyType }, api);
    return [
      { key: 'pcs', label: L('Stringa di connessione primaria', 'Primary connection string'), value: k.primaryConnectionString, regen: regen('PrimaryKey') },
      { key: 'scs', label: L('Stringa di connessione secondaria', 'Secondary connection string'), value: k.secondaryConnectionString, regen: regen('SecondaryKey') },
    ];
  };
  const rights = (r: any) => (r.properties?.rights ?? []) as string[];
  return (
    <div className="stack" style={{ gap: 16 }}>
      {!local && <Notice tone="warn">{L('L\'autenticazione locale (chiavi SAS) è disattivata: le app usano Microsoft Entra ID con i ruoli Data Sender e Data Receiver.', 'Local authentication (SAS keys) is disabled: apps use Microsoft Entra ID with the Data Sender and Data Receiver roles.')}</Notice>}
      {rules.error ? <ErrorNotice error={rules.error} onRetry={rules.reload} /> : !rules.data ? <Skeleton rows={2} /> : rules.data.map((r) => (
        <div key={r.id} className="stack" style={{ gap: 6 }}>
          <KeysCard title={<span className="row" style={{ gap: 8 }}><KeyRound size={16} aria-hidden /><span className="mono">{r.name}</span>{rights(r).map((x) => <Badge key={x}>{x}</Badge>)}</span>} load={keysOf(r.id)} disabled={!local ? L('Chiavi non utilizzabili finché l\'autenticazione locale è spenta.', 'Keys are unusable while local authentication is off.') : undefined}
            note={r.name !== 'RootManageSharedAccessKey' ? <button type="button" className="link-btn" onClick={async () => { if (!(await confirm({ title: L(`Eliminare il criterio ${r.name}?`, `Delete policy ${r.name}?`), text: L('Le app che usano queste chiavi smettono di connettersi.', 'Apps using these keys stop connecting.'), danger: true, confirmLabel: L('Elimina', 'Delete') }))) return; try { await arm.del(r.id, api); rules.reload(); } catch (e) { toast.error(e); } }}>{L('Elimina criterio', 'Delete policy')}</button> : L('Criterio con tutti i diritti: per le app crea criteri con solo i diritti necessari.', 'Policy with all rights: for apps create policies with only the rights they need.')} />
        </div>
      ))}
      <Card title={L('Nuovo criterio di accesso', 'New access policy')}>
        <div className="row wrap" style={{ alignItems: 'end' }}>
          <Field label={L('Nome', 'Name')} htmlFor="pn"><Input id="pn" className="mono" placeholder="app-sender" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          {RIGHTS.map((x) => <Checkbox key={x} checked={f.rights.includes(x)} onChange={(v) => { const next = v ? [...new Set([...f.rights, x, ...(x === 'Manage' ? ['Listen', 'Send'] : [])])] : f.rights.filter((y) => y !== x && !(y === 'Manage' && x !== 'Manage')); setF({ ...f, rights: next }); }} label={x} />)}
          <Button icon={Plus} loading={busy} disabled={!NAME_RE.test(f.name) || !f.rights.length}
            onClick={async () => { setBusy(true); try { await arm.put(`${id}/authorizationRules/${f.name}`, { properties: { rights: f.rights } }, api); toast.ok(L('Criterio creato', 'Policy created'), f.name); setF({ name: '', rights: ['Listen'] }); rules.reload(); } catch (e) { toast.error(e); } finally { setBusy(false); } }}>{L('Crea', 'Create')}</Button>
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>{L('Manage include Listen e Send.', 'Manage includes Listen and Send.')}</p>
      </Card>
    </div>
  );
}
