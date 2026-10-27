'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { Fingerprint, Plus, Trash2 } from 'lucide-react';
import { graph } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useI18n } from '@/i18n';
import { PageHeader, Tabs, Toolbar, useTab } from '@/components/page';
import { Badge, Button, Card, ErrorNotice, Field, IdText, KV, Select, Skeleton, Switch } from '@/components/ui';
import { Panel, useConfirm, useToast } from '@/components/overlay';
import { DataTable } from '@/components/table';
import { PrincipalPicker, type PrincipalRef } from '@/components/pickers';

const DEFAULT_ROLE = '00000000-0000-0000-0000-000000000000';

export default function EnterpriseApp() {
  const { id } = useParams<{ id: string }>();
  const { t, fmtDate } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const router = useRouter();
  const [tab, setTab] = useTab('overview');
  const sp = useAsync(() => graph.get<any>(`/servicePrincipals/${id}`), [id]);
  const assigned = useAsync(() => graph.list<any>(`/servicePrincipals/${id}/appRoleAssignedTo`), [id], { enabled: tab === 'users' });
  const grants = useAsync(async () => {
    const [delegated, app] = await Promise.all([graph.list<any>(`/servicePrincipals/${id}/oauth2PermissionGrants`), graph.list<any>(`/servicePrincipals/${id}/appRoleAssignments`)]);
    const resIds = [...new Set([...delegated.map((g) => g.resourceId), ...app.map((a) => a.resourceId)])];
    const res = await Promise.all(resIds.map((r) => graph.get<any>(`/servicePrincipals/${r}`).catch(() => null)));
    return { delegated, app, res: Object.fromEntries(res.filter(Boolean).map((r: any) => [r.id, r])) };
  }, [id], { enabled: tab === 'permissions' });
  const [open, setOpen] = useState(false);
  const [principal, setPrincipal] = useState<PrincipalRef | null>(null);
  const [role, setRole] = useState(DEFAULT_ROLE);
  if (sp.error) return <ErrorNotice error={sp.error} onRetry={sp.reload} />;
  const s = sp.data;
  const userRoles = (s?.appRoles ?? []).filter((r: any) => (r.allowedMemberTypes ?? []).includes('User'));
  const roleName = (rid: string, roles?: any[]) => (rid === DEFAULT_ROLE ? t('ent.defaultAccess') : (roles ?? s?.appRoles ?? []).find((r: any) => r.id === rid)?.value ?? rid);
  const patch = async (body: any) => {
    try { await graph.patch(`/servicePrincipals/${id}`, body); await sp.reload(); toast.ok(t('common.saved')); } catch (e) { toast.error(e); }
  };
  return (
    <>
      <PageHeader title={s?.displayName ?? '…'} subtitle={s?.servicePrincipalType === 'ManagedIdentity' ? t('ent.managedIdentity') : t('ent.application')} icon={Fingerprint} crumbs={[{ label: t('nav.enterpriseApps'), href: '/entra/enterprise-apps' }, { label: s?.displayName ?? '' }]} />
      <Toolbar>
        {s?.appOwnerOrganizationId && (
          <AppRegistrationLink appId={s.appId} label={t('nav.apps')} />
        )}
        <span className="spacer" />
        {s && s.servicePrincipalType !== 'ManagedIdentity' && (
          <Button variant="danger" icon={Trash2} onClick={async () => {
            if (!(await confirm({ title: t('common.delete'), text: s.displayName, danger: true }))) return;
            try { await graph.del(`/servicePrincipals/${id}`); router.push('/entra/enterprise-apps'); } catch (e) { toast.error(e); }
          }}>{t('common.delete')}</Button>
        )}
      </Toolbar>
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'overview', label: t('common.overview') }, { key: 'users', label: t('ent.assignments') }, { key: 'permissions', label: t('ent.permissionsGranted') }]} />
      {tab === 'overview' && (!s ? <Skeleton /> : (
        <div className="grid cols-2" style={{ alignItems: 'start' }}>
          <Card title={t('res.essentials')}>
            <KV items={[
              [t('common.name'), s.displayName],
              [t('ent.appId'), <IdText key="a" value={s.appId} />],
              [t('apps.objectId'), <IdText key="o" value={s.id} />],
              [t('ent.type'), s.servicePrincipalType],
              [t('common.created'), fmtDate(s.createdDateTime)],
              ...(s.alternativeNames?.length ? [[t('act.resource'), <span key="r" className="small mono">{s.alternativeNames.find((n: string) => n.startsWith('/')) ?? ''}</span>] as [string, React.ReactNode]] : []),
            ]} />
          </Card>
          <Card title={t('common.properties')}>
            <div className="stack">
              <Switch checked={!!s.accountEnabled} onChange={(v) => patch({ accountEnabled: v })} label={t('ent.enabled')} disabled={s.servicePrincipalType === 'ManagedIdentity'} />
              <Switch checked={!!s.appRoleAssignmentRequired} onChange={(v) => patch({ appRoleAssignmentRequired: v })} label={t('ent.assignmentRequired')} />
            </div>
          </Card>
        </div>
      ))}
      {tab === 'users' && (
        <>
          <div className="mb-16"><Button icon={Plus} onClick={() => setOpen(true)}>{t('ent.assignUser')}</Button></div>
          <DataTable rows={assigned.data} loading={assigned.loading} error={assigned.error} rowKey={(a) => a.id} empty={t('common.noResults')}
            columns={[
              { key: 'p', header: t('iam.principal'), render: (a) => a.principalDisplayName },
              { key: 't', header: t('common.type'), render: (a) => t(`iam.type.${a.principalType}` as any) },
              { key: 'r', header: t('ent.appRole'), render: (a) => <span className="mono small">{roleName(a.appRoleId)}</span> },
              { key: 'x', header: '', render: (a) => <Button size="sm" variant="ghost" icon={Trash2} aria-label={t('common.remove')} onClick={async () => { try { await graph.del(`/servicePrincipals/${id}/appRoleAssignedTo/${a.id}`); await assigned.reload(); } catch (e) { toast.error(e); } }} /> },
            ]} />
        </>
      )}
      {tab === 'permissions' && (!grants.data ? <Skeleton /> : (
        <div className="stack" style={{ gap: 18 }}>
          <section>
            <h2 className="mb-16">{t('ent.delegatedGrants')}</h2>
            <DataTable rows={grants.data.delegated.flatMap((g: any) => String(g.scope).split(' ').filter(Boolean).map((sc) => ({ ...g, sc })))} rowKey={(g) => `${g.id}-${g.sc}`} empty={t('common.noResults')}
              columns={[
                { key: 'r', header: t('ent.resource'), render: (g) => grants.data!.res[g.resourceId]?.displayName ?? g.resourceId },
                { key: 's', header: t('apps.permission'), render: (g) => <span className="mono">{g.sc}</span> },
                { key: 'c', header: t('apps.adminConsent'), render: (g) => <Badge tone={g.consentType === 'AllPrincipals' ? 'ok' : undefined}>{g.consentType === 'AllPrincipals' ? t('apps.consentGranted') : t('iam.type.User')}</Badge> },
              ]} />
          </section>
          <section>
            <h2 className="mb-16">{t('ent.appGrants')}</h2>
            <DataTable rows={grants.data.app} rowKey={(a) => a.id} empty={t('common.noResults')}
              columns={[
                { key: 'r', header: t('ent.resource'), render: (a) => a.resourceDisplayName },
                { key: 's', header: t('apps.permission'), render: (a) => <span className="mono">{roleName(a.appRoleId, grants.data!.res[a.resourceId]?.appRoles)}</span> },
                { key: 'c', header: t('common.created'), render: (a) => fmtDate(a.createdDateTime) },
              ]} />
          </section>
        </div>
      ))}
      <Panel open={open} onClose={() => { setOpen(false); setPrincipal(null); }} title={t('ent.assignUser')} footer={<><Button variant="primary" disabled={!principal} onClick={async () => {
        try {
          await graph.post(`/servicePrincipals/${id}/appRoleAssignedTo`, { principalId: principal!.id, resourceId: id, appRoleId: role });
          toast.ok(t('ent.roleAssigned'));
          setOpen(false);
          setPrincipal(null);
          await assigned.reload();
        } catch (e) { toast.error(e); }
      }}>{t('common.add')}</Button><Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button></>}>
        <Field label={t('ent.appRole')}>
          <Select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value={DEFAULT_ROLE}>{t('ent.defaultAccess')}</option>
            {userRoles.map((r: any) => <option key={r.id} value={r.id}>{r.displayName} ({r.value})</option>)}
          </Select>
        </Field>
        <Field label={t('iam.principal')}>
          {principal ? <div className="spread card" style={{ padding: '8px 12px' }}><span>{principal.displayName}</span><button className="link-btn" onClick={() => setPrincipal(null)}>{t('common.edit')}</button></div> : <PrincipalPicker types={['User', 'Group']} onPick={setPrincipal} />}
        </Field>
      </Panel>
    </>
  );
}

function AppRegistrationLink({ appId, label }: { appId: string; label: string }) {
  const app = useAsync(() => graph.get<any>(`/applications(appId='${appId}')`).catch(() => null), [appId]);
  if (!app.data) return null;
  return <Link className="btn" href={`/entra/apps/${app.data.id}`}>{label}</Link>;
}
