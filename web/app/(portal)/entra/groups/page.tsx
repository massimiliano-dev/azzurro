'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Plus, RefreshCw, Trash2, UsersRound } from 'lucide-react';
import { graph } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { useI18n } from '@/i18n';
import { PageHeader, Toolbar } from '@/components/page';
import { Badge, Button, Checkbox, Field, Input, Select, Textarea } from '@/components/ui';
import { Panel, useConfirm, useToast } from '@/components/overlay';
import { DataTable } from '@/components/table';

export default function GroupsPage() {
  const { t, fmtDate } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const { session } = useSession();
  const groups = useAsync(() => graph.list<any>('/groups?$top=999&$expand=members'), []);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [f, setF] = useState({ displayName: '', description: '', type: 'security', mailNickname: '', isAssignableToRole: false });
  const create = async () => {
    try {
      const g = await graph.post<any>('/groups', {
        displayName: f.displayName, description: f.description || undefined,
        mailNickname: f.mailNickname || f.displayName.toLowerCase().replace(/[^a-z0-9]/g, '') || 'group',
        mailEnabled: f.type === 'm365', securityEnabled: true, groupTypes: f.type === 'm365' ? ['Unified'] : [],
        ...(f.isAssignableToRole ? { isAssignableToRole: true } : {}),
      });
      toast.ok(t('create.done', { name: g.displayName }));
      setOpen(false);
      setF({ displayName: '', description: '', type: 'security', mailNickname: '', isAssignableToRole: false });
      await groups.reload();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <>
      <PageHeader title={t('groups.title')} subtitle={t('groups.subtitle')} icon={UsersRound} />
      <Toolbar>
        <Button icon={Plus} onClick={() => setOpen(true)}>{t('groups.new')}</Button>
        <Button variant="ghost" icon={RefreshCw} onClick={groups.reload}>{t('common.refresh')}</Button>
        <Button variant="danger" icon={Trash2} disabled={!selected.size} onClick={async () => {
          if (!(await confirm({ title: t('common.delete'), text: [...selected].map((id) => groups.data?.find((g) => g.id === id)?.displayName).join(', '), danger: true, confirmLabel: t('common.delete') }))) return;
          for (const id of selected) { try { await graph.del(`/groups/${id}`); } catch (e) { toast.error(e); } }
          setSelected(new Set());
          await groups.reload();
        }}>{t('common.delete')}</Button>
      </Toolbar>
      <DataTable
        rows={groups.data} loading={groups.loading} error={groups.error} onRetry={groups.reload} rowKey={(g) => g.id} selectable selected={selected} onSelect={setSelected}
        search={(g) => `${g.displayName} ${g.description ?? ''}`} empty={t('groups.empty')} emptyIcon={UsersRound} initialSort={{ key: 'n' }}
        columns={[
          { key: 'n', header: t('groups.name'), sort: (g) => g.displayName, render: (g) => <div className="cell-main"><span className="res-icon sm c-identity"><UsersRound size={13} /></span><Link href={`/entra/groups/${g.id}`}>{g.displayName}</Link></div> },
          { key: 'd', header: t('common.description'), render: (g) => <span className="small">{g.description ?? '—'}</span> },
          { key: 't', header: t('groups.type'), sort: (g) => (g.groupTypes?.includes('Unified') ? 'm365' : 'security'), render: (g) => <Badge>{g.groupTypes?.includes('Unified') ? t('groups.m365') : t('groups.security')}</Badge> },
          { key: 'm', header: t('groups.memberCount'), sort: (g) => g.members?.length ?? 0, render: (g) => g.members?.length ?? 0 },
          { key: 'c', header: t('common.created'), sort: (g) => g.createdDateTime, render: (g) => <span className="small muted">{fmtDate(g.createdDateTime, 'short')}</span> },
        ]}
      />
      <Panel open={open} onClose={() => setOpen(false)} title={t('groups.new')} footer={<><Button variant="primary" disabled={!f.displayName} onClick={create}>{t('common.create')}</Button><Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button></>}>
        <Field label={t('groups.type')} htmlFor="g-t">
          <Select id="g-t" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
            <option value="security">{t('groups.security')}</option>
            <option value="m365">{t('groups.m365')}</option>
          </Select>
        </Field>
        <Field label={t('groups.name')} required htmlFor="g-n"><Input id="g-n" value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} /></Field>
        <Field label={t('groups.mailNickname')} htmlFor="g-m"><Input id="g-m" value={f.mailNickname} placeholder={f.displayName.toLowerCase().replace(/[^a-z0-9]/g, '')} onChange={(e) => setF({ ...f, mailNickname: e.target.value })} /></Field>
        <Field label={t('common.description')} htmlFor="g-d"><Textarea id="g-d" rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        {session?.isGlobalAdmin && <Checkbox checked={f.isAssignableToRole} onChange={(v) => setF({ ...f, isAssignableToRole: v })} label={t('groups.roleAssignable')} />}
      </Panel>
    </>
  );
}
