'use client';

import { useState } from 'react';
import { Trash2, UserCog } from 'lucide-react';
import { graph } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useI18n } from '@/i18n';
import { PageHeader } from '@/components/page';
import { Button } from '@/components/ui';
import { Panel, useConfirm, useToast } from '@/components/overlay';
import { DataTable } from '@/components/table';
import { PrincipalPicker } from '@/components/pickers';

export default function RolesPage() {
  const { t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const roles = useAsync(async () => {
    const list = await graph.list<any>('/directoryRoles');
    const assignments = await graph.list<any>('/roleManagement/directory/roleAssignments');
    return list.map((r) => ({ ...r, count: assignments.filter((a) => a.roleDefinitionId === r.roleTemplateId).length }));
  }, []);
  const [role, setRole] = useState<any>(null);
  const members = useAsync<any[]>(async () => (role ? graph.list<any>(`/directoryRoles/${role.id}/members`) : []), [role?.id]);
  return (
    <>
      <PageHeader title={t('roles.title')} subtitle={t('roles.subtitle')} icon={UserCog} />
      <DataTable rows={roles.data} loading={roles.loading} error={roles.error} rowKey={(r) => r.id} search={(r) => `${r.displayName} ${r.description}`} initialSort={{ key: 'n' }}
        columns={[
          { key: 'n', header: t('common.name'), sort: (r) => r.displayName, render: (r) => <button className="link-btn" onClick={() => setRole(r)}>{r.displayName}</button> },
          { key: 'd', header: t('common.description'), render: (r) => <span className="small">{r.description}</span> },
          { key: 'c', header: t('roles.members'), sort: (r) => r.count, render: (r) => r.count },
        ]} />
      <Panel wide open={!!role} onClose={() => setRole(null)} title={role?.displayName ?? ''} subtitle={role?.description}>
        <div className="stack" style={{ gap: 18 }}>
          <DataTable rows={members.data} loading={members.loading} error={members.error} rowKey={(m) => m.id} empty={t('roles.empty')}
            columns={[
              { key: 'n', header: t('common.name'), render: (m) => m.displayName },
              { key: 'u', header: t('common.details'), render: (m) => <span className="small muted">{m.userPrincipalName ?? m.appId ?? ''}</span> },
              { key: 'x', header: '', render: (m) => <Button size="sm" variant="ghost" icon={Trash2} aria-label={t('common.remove')} onClick={async () => {
                if (!(await confirm({ title: t('common.remove'), text: t('roles.removeText', { principal: m.displayName, role: role.displayName }), danger: true }))) return;
                try { await graph.del(`/directoryRoles/${role.id}/members/${m.id}/$ref`); await members.reload(); await roles.reload(); } catch (e) { toast.error(e); }
              }} /> },
            ]} />
          <div>
            <h3 className="mb-16">{t('roles.assign')}</h3>
            <PrincipalPicker exclude={(members.data ?? []).map((m) => m.id)} onPick={async (p) => {
              try { await graph.post(`/directoryRoles/${role.id}/members/$ref`, { '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${p.id}` }); await members.reload(); await roles.reload(); toast.ok(t('iam.assigned'), p.displayName); } catch (e) { toast.error(e); }
            }} />
          </div>
        </div>
      </Panel>
    </>
  );
}
