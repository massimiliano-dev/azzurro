'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Plus, RefreshCw, RotateCcw, Trash2, Users } from 'lucide-react';
import { graph } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useI18n } from '@/i18n';
import { PageHeader, Tabs, Toolbar, useTab } from '@/components/page';
import { Avatar, Badge, Button } from '@/components/ui';
import { useConfirm, useToast } from '@/components/overlay';
import { DataTable } from '@/components/table';
import { NewUserPanel } from '@/components/users';

const SELECT = 'id,displayName,userPrincipalName,jobTitle,department,accountEnabled,createdDateTime,userType,signInActivity,mail';

export default function UsersPage() {
  const { t, fmtDate, fmtRelative } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const sp = useSearchParams();
  const router = useRouter();
  const [tab, setTab] = useTab('all');
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => { if (sp.get('new') === '1') setOpen(true); }, [sp]);
  const users = useAsync(() => graph.list<any>(`/users?$select=${SELECT}&$top=999`), []);
  const deleted = useAsync(() => graph.list<any>('/directory/deletedItems/microsoft.graph.user'), [], { enabled: tab === 'deleted' });
  return (
    <>
      <PageHeader title={t('users.title')} subtitle={t('users.subtitle')} icon={Users} />
      <Toolbar>
        <Button icon={Plus} onClick={() => setOpen(true)}>{t('users.new')}</Button>
        <Button variant="ghost" icon={RefreshCw} onClick={() => { void users.reload(); void deleted.reload(); }}>{t('common.refresh')}</Button>
        {tab === 'all' && <Button variant="danger" icon={Trash2} disabled={!selected.size} onClick={async () => {
          if (!(await confirm({ title: t('users.deleteTitle'), text: [...selected].map((id) => users.data?.find((u) => u.id === id)?.displayName).join(', '), danger: true, confirmLabel: t('common.delete') }))) return;
          for (const id of selected) { try { await graph.del(`/users/${id}`); } catch (e) { toast.error(e); } }
          setSelected(new Set());
          await users.reload();
        }}>{t('common.delete')}</Button>}
      </Toolbar>
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'all', label: t('users.title') }, { key: 'deleted', label: t('users.deleted') }]} />
      {tab === 'all' ? (
        <DataTable
          rows={users.data} loading={users.loading} error={users.error} onRetry={users.reload} rowKey={(u) => u.id} selectable selected={selected} onSelect={setSelected}
          search={(u) => `${u.displayName} ${u.userPrincipalName} ${u.jobTitle ?? ''} ${u.department ?? ''}`} empty={t('users.empty')} emptyIcon={Users} initialSort={{ key: 'n' }}
          columns={[
            { key: 'n', header: t('users.displayName'), sort: (u) => u.displayName, render: (u) => <div className="cell-main"><Avatar name={u.displayName} size="sm" /><Link href={`/entra/users/${u.id}`}>{u.displayName}</Link></div> },
            { key: 'upn', header: t('users.upn'), sort: (u) => u.userPrincipalName, render: (u) => <span className="small">{u.userPrincipalName}</span> },
            { key: 'jt', header: t('users.jobTitle'), sort: (u) => u.jobTitle, render: (u) => u.jobTitle ?? '—' },
            { key: 'en', header: t('users.accountEnabled'), sort: (u) => (u.accountEnabled ? 1 : 0), render: (u) => <Badge tone={u.accountEnabled ? 'ok' : 'warn'}>{u.accountEnabled ? t('common.yes') : t('common.no')}</Badge> },
            { key: 'si', header: t('users.lastSignIn'), sort: (u) => u.signInActivity?.lastSignInDateTime ?? '', render: (u) => <span className="small muted">{u.signInActivity?.lastSignInDateTime ? fmtRelative(u.signInActivity.lastSignInDateTime) : t('common.never')}</span> },
            { key: 'c', header: t('common.created'), sort: (u) => u.createdDateTime, render: (u) => <span className="small muted">{fmtDate(u.createdDateTime, 'short')}</span> },
          ]}
        />
      ) : (
        <DataTable rows={deleted.data} loading={deleted.loading} error={deleted.error} rowKey={(u) => u.id} empty={t('common.noResults')}
          columns={[
            { key: 'n', header: t('users.displayName'), render: (u) => <div className="cell-main"><Avatar name={u.displayName} size="sm" />{u.displayName}</div> },
            { key: 'upn', header: t('users.upn'), render: (u) => u.userPrincipalName },
            { key: 'd', header: t('common.deleted'), render: (u) => fmtDate(u.deletedDateTime) },
            { key: 'a', header: '', render: (u) => <Button size="sm" icon={RotateCcw} onClick={async () => { try { await graph.post(`/directory/deletedItems/${u.id}/restore`); await deleted.reload(); await users.reload(); } catch (e) { toast.error(e); } }}>{t('users.restore')}</Button> },
          ]} />
      )}
      <NewUserPanel open={open} onClose={() => { setOpen(false); if (sp.get('new')) router.replace('/entra/users'); }} onCreated={() => users.reload()} />
    </>
  );
}
