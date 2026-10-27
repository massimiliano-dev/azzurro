'use client';

import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { Pencil, Trash2, UsersRound } from 'lucide-react';
import { graph } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useI18n } from '@/i18n';
import { PageHeader, Tabs, Toolbar, useTab } from '@/components/page';
import { Badge, Button, Card, ErrorNotice, Field, IdText, Input, KV, Skeleton, Textarea } from '@/components/ui';
import { Panel, useConfirm, useToast } from '@/components/overlay';
import { RefList } from '@/components/members';

export default function GroupPage() {
  const { id } = useParams<{ id: string }>();
  const { t, fmtDate } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const router = useRouter();
  const [tab, setTab] = useTab('members');
  const group = useAsync(() => graph.get<any>(`/groups/${id}`), [id]);
  const [edit, setEdit] = useState<{ displayName: string; description: string } | null>(null);
  if (group.error) return <ErrorNotice error={group.error} onRetry={group.reload} />;
  const g = group.data;
  return (
    <>
      <PageHeader title={g?.displayName ?? '…'} subtitle={g?.description} icon={UsersRound} crumbs={[{ label: t('nav.groups'), href: '/entra/groups' }, { label: g?.displayName ?? '' }]} />
      <Toolbar>
        <Button icon={Pencil} disabled={!g} onClick={() => setEdit({ displayName: g.displayName, description: g.description ?? '' })}>{t('common.edit')}</Button>
        <span className="spacer" />
        <Button variant="danger" icon={Trash2} onClick={async () => {
          if (!(await confirm({ title: t('common.delete'), text: t('groups.deleteText', { name: g?.displayName }), danger: true, confirmLabel: t('common.delete') }))) return;
          try { await graph.del(`/groups/${id}`); router.push('/entra/groups'); } catch (e) { toast.error(e); }
        }}>{t('common.delete')}</Button>
      </Toolbar>
      {!g ? <Skeleton /> : (
        <Card title={t('res.essentials')}>
          <KV items={[
            [t('common.id'), <IdText key="i" value={g.id} />],
            [t('groups.type'), <Badge key="t">{g.groupTypes?.includes('Unified') ? t('groups.m365') : t('groups.security')}</Badge>],
            [t('groups.mailNickname'), g.mailNickname],
            [t('users.mail'), g.mail],
            [t('groups.roleAssignable'), g.isAssignableToRole ? t('common.yes') : t('common.no')],
            [t('common.created'), fmtDate(g.createdDateTime)],
          ]} />
        </Card>
      )}
      <div className="mt-24">
        <Tabs value={tab} onChange={setTab} tabs={[{ key: 'members', label: t('groups.members') }, { key: 'owners', label: t('groups.owners') }]} />
        {tab === 'members' && <RefList base={`/groups/${id}`} relation="members" types={['User', 'Group', 'ServicePrincipal']} title={t('groups.members')} empty={t('groups.noMembers')} />}
        {tab === 'owners' && <RefList base={`/groups/${id}`} relation="owners" types={['User', 'ServicePrincipal']} title={t('groups.owners')} empty={t('apps.noOwners')} />}
      </div>
      <Panel open={!!edit} onClose={() => setEdit(null)} title={t('common.edit')} footer={<><Button variant="primary" onClick={async () => { try { await graph.patch(`/groups/${id}`, { displayName: edit!.displayName, description: edit!.description || null }); setEdit(null); await group.reload(); toast.ok(t('common.saved')); } catch (e) { toast.error(e); } }}>{t('common.save')}</Button><Button onClick={() => setEdit(null)}>{t('common.cancel')}</Button></>}>
        {edit && (
          <>
            <Field label={t('groups.name')} htmlFor="gn"><Input id="gn" value={edit.displayName} onChange={(e) => setEdit({ ...edit, displayName: e.target.value })} /></Field>
            <Field label={t('common.description')} htmlFor="gd"><Textarea id="gd" rows={3} value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
          </>
        )}
      </Panel>
    </>
  );
}
