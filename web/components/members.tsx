'use client';

import Link from 'next/link';
import { useState } from 'react';
import { AppWindow, Plus, Trash2, Users } from 'lucide-react';
import { graph } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useI18n } from '@/i18n';
import { Avatar, Button } from './ui';
import { Panel, useToast } from './overlay';
import { DataTable } from './table';
import { PrincipalPicker, type PrincipalRef } from './pickers';

const href = (o: any) => (o['@odata.type'] === '#microsoft.graph.user' ? `/entra/users/${o.id}` : o['@odata.type'] === '#microsoft.graph.group' ? `/entra/groups/${o.id}` : `/entra/enterprise-apps/${o.id}`);

/** Elenco membri/proprietari di un oggetto Graph con aggiunta e rimozione via $ref. */
export function RefList({ base, relation, types, title, empty }: { base: string; relation: 'members' | 'owners'; types: PrincipalRef['type'][]; title: string; empty: string }) {
  const { t } = useI18n();
  const toast = useToast();
  const list = useAsync(() => graph.list<any>(`${base}/${relation}`), [base, relation]);
  const [open, setOpen] = useState(false);
  return (
    <section>
      <div className="spread mb-16">
        <h2>{title}</h2>
        <Button size="sm" icon={Plus} onClick={() => setOpen(true)}>{t('common.add')}</Button>
      </div>
      <DataTable rows={list.data} loading={list.loading} error={list.error} rowKey={(o) => o.id} empty={empty} search={(o) => `${o.displayName} ${o.userPrincipalName ?? ''}`}
        columns={[
          { key: 'n', header: t('common.name'), sort: (o) => o.displayName, render: (o) => <div className="cell-main">{o['@odata.type'] === '#microsoft.graph.user' ? <Avatar name={o.displayName} size="sm" /> : <span className="res-icon sm">{o['@odata.type'] === '#microsoft.graph.group' ? <Users size={13} /> : <AppWindow size={13} />}</span>}<Link href={href(o)}>{o.displayName}</Link></div> },
          { key: 't', header: t('common.type'), render: (o) => t(o['@odata.type'] === '#microsoft.graph.user' ? 'iam.type.User' : o['@odata.type'] === '#microsoft.graph.group' ? 'iam.type.Group' : 'iam.type.ServicePrincipal') },
          { key: 'd', header: t('common.details'), render: (o) => <span className="small muted">{o.userPrincipalName ?? o.appId ?? o.mail ?? ''}</span> },
          { key: 'x', header: '', render: (o) => <Button size="sm" variant="ghost" icon={Trash2} aria-label={t('common.remove')} onClick={async () => { try { await graph.del(`${base}/${relation}/${o.id}/$ref`); await list.reload(); } catch (e) { toast.error(e); } }} /> },
        ]} />
      <Panel open={open} onClose={() => setOpen(false)} title={title}>
        <PrincipalPicker types={types} exclude={(list.data ?? []).map((o) => o.id)} onPick={async (p) => {
          try {
            await graph.post(`${base}/${relation}/$ref`, { '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${p.id}` });
            toast.ok(t('common.saved'), p.displayName);
            await list.reload();
          } catch (e) {
            toast.error(e);
          }
        }} />
      </Panel>
    </section>
  );
}
