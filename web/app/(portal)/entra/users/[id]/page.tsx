'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { Ban, CheckCircle2, KeyRound, LogOut, Pencil, Trash2, User } from 'lucide-react';
import { arm, graph } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { useI18n, type MessageKey } from '@/i18n';
import { PageHeader, Tabs, Toolbar, useTab } from '@/components/page';
import { Avatar, Badge, Button, Card, ErrorNotice, Field, IdText, Input, KV, Notice, SecretValue, Skeleton } from '@/components/ui';
import { Panel, useConfirm, useToast } from '@/components/overlay';
import { DataTable } from '@/components/table';
import { generatePassword } from '@/components/users';
import { useSubscriptions } from '@/components/pickers';

const EDITABLE = ['displayName', 'givenName', 'surname', 'jobTitle', 'department', 'officeLocation', 'mobilePhone', 'usageLocation'] as const;
const LABELS: Record<(typeof EDITABLE)[number], MessageKey> = {
  displayName: 'users.displayName', givenName: 'users.givenName', surname: 'users.surname', jobTitle: 'users.jobTitle', department: 'users.department',
  officeLocation: 'users.office', mobilePhone: 'users.mobile', usageLocation: 'users.usageLocation',
};

export default function UserPage() {
  const { id } = useParams<{ id: string }>();
  const { t, fmtDate } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const router = useRouter();
  const { session } = useSession();
  const [tab, setTab] = useTab('overview');
  const user = useAsync(() => graph.get<any>(`/users/${id}?$select=id,displayName,givenName,surname,userPrincipalName,mail,jobTitle,department,officeLocation,mobilePhone,usageLocation,companyName,employeeId,accountEnabled,createdDateTime,userType,lastPasswordChangeDateTime,signInActivity,preferredLanguage`), [id]);
  const memberOf = useAsync(() => graph.list<any>(`/users/${id}/memberOf`), [id]);
  const appRoles = useAsync(() => graph.list<any>(`/users/${id}/appRoleAssignments`), [id], { enabled: tab === 'apps' });
  const subs = useSubscriptions();
  const azure = useAsync(async () => {
    const out: any[] = [];
    for (const s of subs.data ?? []) {
      const r = await arm.get<{ value: any[] }>(`/subscriptions/${s.subscriptionId}/providers/Microsoft.Authorization/roleAssignments`, '2022-04-01', { $filter: `assignedTo('${id}')` });
      out.push(...r.value);
    }
    const roles = subs.data?.[0] ? (await arm.get<{ value: any[] }>(`/subscriptions/${subs.data[0].subscriptionId}/providers/Microsoft.Authorization/roleDefinitions`, '2022-04-01')).value : [];
    return out.map((a) => ({ ...a, roleName: roles.find((r) => r.name === a.properties.roleDefinitionId.split('/').pop())?.properties.roleName }));
  }, [id, subs.data], { enabled: tab === 'azure' && !!subs.data });
  const [edit, setEdit] = useState<Record<string, string> | null>(null);
  const [newPw, setNewPw] = useState<string | null>(null);
  if (user.error) return <ErrorNotice error={user.error} onRetry={user.reload} />;
  const u = user.data;
  const self = session?.user.id === id;
  const patch = async (body: any, msg = t('common.saved')) => {
    try {
      await graph.patch(`/users/${id}`, body);
      toast.ok(msg);
      await user.reload();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <>
      <PageHeader title={u?.displayName ?? '…'} subtitle={u?.userPrincipalName} icon={User} crumbs={[{ label: t('nav.users'), href: '/entra/users' }, { label: u?.displayName ?? '' }]} />
      <Toolbar>
        <Button icon={Pencil} disabled={!u} onClick={() => setEdit(Object.fromEntries(EDITABLE.map((k) => [k, u?.[k] ?? ''])))}>{t('common.edit')}</Button>
        {!self && <Button icon={KeyRound} onClick={async () => {
          if (!(await confirm({ title: t('users.resetPassword'), text: u?.userPrincipalName, confirmLabel: t('users.resetPassword') }))) return;
          const pw = generatePassword();
          try { await graph.patch(`/users/${id}`, { passwordProfile: { password: pw, forceChangePasswordNextSignIn: true } }); setNewPw(pw); } catch (e) { toast.error(e); }
        }}>{t('users.resetPassword')}</Button>}
        {!self && (u?.accountEnabled
          ? <Button icon={Ban} onClick={() => patch({ accountEnabled: false })}>{t('users.block')}</Button>
          : <Button icon={CheckCircle2} onClick={() => patch({ accountEnabled: true })}>{t('users.unblock')}</Button>)}
        <Button icon={LogOut} onClick={async () => { try { await graph.post(`/users/${id}/revokeSignInSessions`); toast.ok(t('users.revoked')); } catch (e) { toast.error(e); } }}>{t('users.revoke')}</Button>
        <span className="spacer" />
        {!self && <Button variant="danger" icon={Trash2} onClick={async () => {
          if (!(await confirm({ title: t('users.deleteTitle'), text: t('users.deleteText', { name: u?.displayName }), danger: true, confirmLabel: t('common.delete') }))) return;
          try { await graph.del(`/users/${id}`); router.push('/entra/users'); } catch (e) { toast.error(e); }
        }}>{t('common.delete')}</Button>}
      </Toolbar>
      {newPw && <div className="mb-16"><Notice tone="ok" title={t('users.resetDone')}><div className="mt-8"><SecretValue value={newPw} /></div></Notice></div>}
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'overview', label: t('common.overview') }, { key: 'groups', label: t('users.groups') }, { key: 'azure', label: t('users.azureRoles') }, { key: 'apps', label: t('users.appRoles') }]} />
      {tab === 'overview' && (!u ? <Skeleton rows={6} /> : (
        <div className="grid cols-2" style={{ alignItems: 'start' }}>
          <Card title={t('users.profile')}>
            <div className="row mb-16"><Avatar name={u.displayName} size="lg" /><div><div style={{ fontWeight: 600, fontSize: 16 }}>{u.displayName}</div><div className="muted">{u.jobTitle ?? ''}{u.department ? ` · ${u.department}` : ''}</div></div></div>
            <KV items={[
              [t('users.upn'), u.userPrincipalName],
              [t('common.id'), <IdText key="i" value={u.id} />],
              [t('users.mail'), u.mail],
              [t('users.type'), u.userType],
              [t('users.office'), u.officeLocation],
              [t('users.mobile'), u.mobilePhone],
              [t('users.usageLocation'), u.usageLocation],
            ]} />
          </Card>
          <Card title={t('common.status')}>
            <KV items={[
              [t('users.accountEnabled'), <Badge key="e" tone={u.accountEnabled ? 'ok' : 'warn'}>{u.accountEnabled ? t('common.yes') : t('common.no')}</Badge>],
              [t('common.created'), fmtDate(u.createdDateTime)],
              [t('users.lastSignIn'), u.signInActivity?.lastSignInDateTime ? fmtDate(u.signInActivity.lastSignInDateTime) : t('common.never')],
              [t('set.changePassword'), fmtDate(u.lastPasswordChangeDateTime)],
              [t('users.roles'), (memberOf.data ?? []).filter((m) => m['@odata.type'] === '#microsoft.graph.directoryRole').map((r) => <Badge key={r.id} tone="info">{r.displayName}</Badge>)],
            ]} />
          </Card>
        </div>
      ))}
      {tab === 'groups' && (
        <DataTable rows={memberOf.data} loading={memberOf.loading} error={memberOf.error} rowKey={(g) => g.id} empty={t('common.noResults')}
          columns={[
            { key: 'n', header: t('common.name'), render: (g) => g['@odata.type'] === '#microsoft.graph.group' ? <Link href={`/entra/groups/${g.id}`}>{g.displayName}</Link> : <Link href="/entra/roles">{g.displayName}</Link> },
            { key: 't', header: t('common.type'), render: (g) => g['@odata.type'] === '#microsoft.graph.group' ? t('groups.security') : t('nav.roles') },
          ]} />
      )}
      {tab === 'azure' && (
        <DataTable rows={azure.data} loading={azure.loading || subs.loading} error={azure.error} rowKey={(a) => a.id} empty={t('iam.empty')}
          columns={[
            { key: 'r', header: t('iam.role'), render: (a) => a.roleName ?? a.properties.roleDefinitionId.split('/').pop() },
            { key: 's', header: t('iam.scope'), render: (a) => <Link className="mono small" href={`/iam?scope=${encodeURIComponent(a.properties.scope)}`}>{a.properties.scope}</Link> },
            { key: 'v', header: t('iam.principal'), render: (a) => a.properties.principalId === id ? u?.displayName : <span className="small muted">{t('iam.type.Group')}</span> },
          ]} />
      )}
      {tab === 'apps' && (
        <DataTable rows={appRoles.data} loading={appRoles.loading} error={appRoles.error} rowKey={(a) => a.id} empty={t('common.noResults')}
          columns={[
            { key: 'r', header: t('ent.resource'), render: (a) => <Link href={`/entra/enterprise-apps/${a.resourceId}`}>{a.resourceDisplayName}</Link> },
            { key: 'role', header: t('ent.appRole'), render: (a) => <span className="mono small">{a.appRoleId === '00000000-0000-0000-0000-000000000000' ? t('ent.defaultAccess') : a.appRoleId}</span> },
            { key: 'c', header: t('common.created'), render: (a) => fmtDate(a.createdDateTime) },
          ]} />
      )}
      <Panel open={!!edit} onClose={() => setEdit(null)} title={t('common.edit')} subtitle={u?.userPrincipalName} footer={<><Button variant="primary" onClick={async () => {
        const body: any = {};
        for (const k of EDITABLE) if ((edit?.[k] ?? '') !== (u?.[k] ?? '')) body[k] = edit?.[k] || null;
        if (Object.keys(body).length) await patch(body);
        setEdit(null);
      }}>{t('common.save')}</Button><Button onClick={() => setEdit(null)}>{t('common.cancel')}</Button></>}>
        {edit && (
          <div className="form-grid">
            {EDITABLE.map((k) => (
              <Field key={k} label={t(LABELS[k])} htmlFor={`e-${k}`}><Input id={`e-${k}`} value={edit[k]} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} /></Field>
            ))}
          </div>
        )}
      </Panel>
    </>
  );
}
