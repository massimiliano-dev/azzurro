'use client';

import { useDirectory } from '@/lib/directory';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Plus, RefreshCw, ShieldCheck, Trash2, Users, User, AppWindow } from 'lucide-react';
import { arm, graph } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { parseId, uuid } from '@/lib/arm';
import { useI18n, type MessageKey } from '@/i18n';
import { PageHeader, Tabs, Toolbar, useTab } from '@/components/page';
import { Avatar, Badge, Button, Card, CodeBlock, Field, Input, KV, Notice, Select, Textarea } from '@/components/ui';
import { Panel, useConfirm, useToast } from '@/components/overlay';
import { DataTable } from '@/components/table';
import { PrincipalPicker, ResourceGroupSelect, useSubscriptions, type PrincipalRef } from '@/components/pickers';

export default function IamPage() {
  const { t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const sp = useSearchParams();
  const router = useRouter();
  const subs = useSubscriptions();
  const [tab, setTab] = useTab('assignments');
  const scope = sp.get('scope') ?? (subs.data?.[0] ? `/subscriptions/${subs.data[0].subscriptionId}` : '');
  const info = parseId(scope);
  const dir = useDirectory();
  const setScope = (s: string) => router.replace(`/iam?scope=${encodeURIComponent(s)}`);

  const roles = useAsync(async () => (scope ? (await arm.get<{ value: any[] }>(`${scope}/providers/Microsoft.Authorization/roleDefinitions`, '2022-04-01')).value : []), [scope]);
  const ras = useAsync(async () => {
    if (!scope) return [];
    const list = (await arm.get<{ value: any[] }>(`${scope}/providers/Microsoft.Authorization/roleAssignments`, '2022-04-01')).value;
    const ids = [...new Set(list.map((a) => a.properties.principalId))];
    // senza permesso di lettura della directory (Azure reale) si mostrano gli ID: le assegnazioni restano gestibili
    const objs = ids.length ? await graph.post<{ value: any[] }>('/directoryObjects/getByIds', { ids }).then((r) => r.value).catch(() => [] as any[]) : [];
    return list.map((a) => ({ ...a, principal: objs.find((o) => o.id === a.properties.principalId) }));
  }, [scope]);
  const perms = useAsync(async () => (scope ? (await arm.get<{ value: any[] }>(`${scope}/providers/Microsoft.Authorization/permissions`, '2022-04-01')).value : []), [scope], { enabled: tab === 'access' });

  const roleName = (rid: string) => roles.data?.find((r) => r.name === rid.split('/').pop())?.properties.roleName ?? rid.split('/').pop();
  const [open, setOpen] = useState(false);
  const [roleId, setRoleId] = useState('');
  const [roleQ, setRoleQ] = useState('');
  const [principal, setPrincipal] = useState<PrincipalRef | null>(null);
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);
  const [roleDetail, setRoleDetail] = useState<any>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [custom, setCustom] = useState({ name: '', description: '', actions: 'Microsoft.Storage/storageAccounts/read\nMicrosoft.Storage/storageAccounts/listKeys/action', notActions: '' });

  useEffect(() => {
    if (!sp.get('scope') && scope) setScope(scope);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  const assign = async () => {
    setBusy(true);
    try {
      await arm.put(`${scope}/providers/Microsoft.Authorization/roleAssignments/${uuid()}`, { properties: { roleDefinitionId: `${info.subscriptionId ? `/subscriptions/${info.subscriptionId}` : ''}/providers/Microsoft.Authorization/roleDefinitions/${roleId}`, principalId: principal!.id, principalType: principal!.type, description: desc || undefined } }, '2022-04-01');
      toast.ok(t('iam.assigned'), `${roleName(roleId)} · ${principal!.displayName}`);
      setOpen(false);
      setPrincipal(null);
      setRoleId('');
      setDesc('');
      await ras.reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const filteredRoles = useMemo(() => (roles.data ?? []).filter((r) => r.properties.roleName.toLowerCase().includes(roleQ.toLowerCase())).sort((a, b) => {
    const pri = ['Owner', 'Contributor', 'Reader', 'User Access Administrator'];
    const ia = pri.indexOf(a.properties.roleName);
    const ib = pri.indexOf(b.properties.roleName);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.properties.roleName.localeCompare(b.properties.roleName);
  }), [roles.data, roleQ]);
  const scopeLabel = info.type === 'Microsoft.Resources/subscriptions' ? `${t('common.subscription')}: ${subs.data?.find((s) => s.subscriptionId === info.subscriptionId)?.displayName ?? info.subscriptionId}` : info.type === 'Microsoft.Resources/resourceGroups' ? `${t('common.resourceGroup')}: ${info.resourceGroup}` : `${info.type}: ${info.name}`;

  const PIcon = (ty?: string) => (ty === 'Group' ? Users : ty === 'ServicePrincipal' ? AppWindow : User);

  return (
    <>
      <PageHeader title={t('iam.title')} subtitle={scope ? scopeLabel : t('iam.subtitle')} icon={ShieldCheck} />
      {dir.real && dir.state?.status && !dir.state.status.graph && (
        <Notice tone="warn" title={t('iam.graphTitle')}>
          {t('iam.graphText')}{' '}
          <a className="btn sm" href={`/api/portal/auth/connect?tenant=${dir.state.active}&resource=graph&returnTo=${encodeURIComponent('/iam' + (scope ? `?scope=${encodeURIComponent(scope)}` : ''))}`}>{t('dir.connectGraph')}</a>
        </Notice>
      )}
      <div className="card card-body mb-16">
        <div className="form-grid">
          <Field label={t('common.subscription')} htmlFor="iam-sub">
            <Select id="iam-sub" value={info.subscriptionId ?? ''} onChange={(e) => setScope(`/subscriptions/${e.target.value}`)}>
              {(subs.data ?? []).map((s) => <option key={s.subscriptionId} value={s.subscriptionId}>{s.displayName}</option>)}
            </Select>
          </Field>
          <Field label={t('common.resourceGroup')} htmlFor="iam-rg">
            <ResourceGroupSelect id="iam-rg" allowEmpty sub={info.subscriptionId ?? ''} value={info.resourceGroup ?? ''} onChange={(v) => setScope(v ? `/subscriptions/${info.subscriptionId}/resourceGroups/${v}` : `/subscriptions/${info.subscriptionId}`)} />
          </Field>
        </div>
        <div className="small muted mono" style={{ overflowWrap: 'anywhere' }}>{t('iam.scope')}: {scope}</div>
      </div>
      <Toolbar>
        <Button icon={Plus} onClick={() => setOpen(true)}>{t('iam.add')}</Button>
        <Button icon={Plus} variant="ghost" onClick={() => setCustomOpen(true)}>{t('iam.newCustomRole')}</Button>
        <Button variant="ghost" icon={RefreshCw} onClick={() => { void ras.reload(); void roles.reload(); }}>{t('common.refresh')}</Button>
      </Toolbar>
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'assignments', label: t('iam.assignments') }, { key: 'roles', label: t('iam.roles') }, { key: 'access', label: t('iam.checkAccess') }]} />
      {tab === 'assignments' && (
        <DataTable
          rows={ras.data} loading={ras.loading} error={ras.error} onRetry={ras.reload} rowKey={(a) => a.id}
          search={(a) => `${a.principal?.displayName ?? ''} ${roleName(a.properties.roleDefinitionId)}`} empty={t('iam.empty')} initialSort={{ key: 'role' }}
          columns={[
            { key: 'p', header: t('iam.principal'), sort: (a) => a.principal?.displayName ?? '', render: (a) => {
              const ty = a.properties.principalType;
              const I = PIcon(ty);
              return <div className="cell-main">{ty === 'User' ? <Avatar name={a.principal?.displayName} size="sm" /> : <span className="res-icon sm"><I size={13} /></span>}<span>{a.principal?.displayName ?? <span className="muted">{t('iam.unknownPrincipal')}</span>}<div className="small muted">{a.principal?.userPrincipalName ?? a.principal?.appId ?? a.properties.principalId}</div></span></div>;
            } },
            { key: 'ty', header: t('iam.principalType'), sort: (a) => a.properties.principalType, render: (a) => t(`iam.type.${a.properties.principalType}` as MessageKey) },
            { key: 'role', header: t('iam.role'), sort: (a) => roleName(a.properties.roleDefinitionId), render: (a) => <button className="link-btn" onClick={() => setRoleDetail(roles.data?.find((r) => r.name === a.properties.roleDefinitionId.split('/').pop()))}>{roleName(a.properties.roleDefinitionId)}</button> },
            { key: 'sc', header: t('iam.scope'), render: (a) => a.properties.scope.toLowerCase() === scope.toLowerCase() ? <Badge tone="info">{t('iam.thisScope')}</Badge> : <span className="small mono" title={a.properties.scope}>{a.properties.scope.length > scope.length ? a.properties.scope.slice(scope.length) || '/' : `${t('iam.inherited')} · ${a.properties.scope.split('/').slice(-2).join('/') || '/'}`}</span> },
            { key: 'x', header: '', render: (a) => (
              <Button size="sm" variant="ghost" icon={Trash2} aria-label={t('common.remove')} onClick={async () => {
                if (!(await confirm({ title: t('iam.removeTitle'), text: t('iam.removeText', { principal: a.principal?.displayName ?? a.properties.principalId, role: roleName(a.properties.roleDefinitionId) }), danger: true, confirmLabel: t('common.remove') }))) return;
                try { await arm.del(a.id, '2022-04-01'); await ras.reload(); } catch (e) { toast.error(e); }
              }} />
            ) },
          ]}
        />
      )}
      {tab === 'roles' && (
        <DataTable rows={roles.data} loading={roles.loading} error={roles.error} rowKey={(r) => r.id} search={(r) => `${r.properties.roleName} ${r.properties.description}`} initialSort={{ key: 'n' }}
          columns={[
            { key: 'n', header: t('common.name'), sort: (r) => r.properties.roleName, render: (r) => <button className="link-btn" onClick={() => setRoleDetail(r)}>{r.properties.roleName}</button> },
            { key: 'd', header: t('common.description'), render: (r) => <span className="small">{r.properties.description}</span> },
            { key: 't', header: t('common.type'), sort: (r) => r.properties.type, render: (r) => <Badge tone={r.properties.type === 'CustomRole' ? 'info' : undefined}>{r.properties.type === 'CustomRole' ? t('iam.custom') : t('iam.builtIn')}</Badge> },
          ]} />
      )}
      {tab === 'access' && (
        <Card title={t('iam.checkAccess')}>
          {perms.data ? (perms.data.length ? perms.data.map((p, i) => (
            <div key={i} className="mb-16"><KV items={[[t('iam.actions'), <span key="a" className="mono small">{p.actions.join(', ') || '—'}</span>], [t('iam.notActions'), <span key="n" className="mono small">{p.notActions.join(', ') || '—'}</span>]]} /></div>
          )) : <Notice tone="warn">{t('err.forbidden')}</Notice>) : <span className="spinner" />}
        </Card>
      )}

      <Panel open={open} onClose={() => setOpen(false)} title={t('iam.add')} subtitle={scope} footer={<><Button variant="primary" loading={busy} disabled={!roleId || !principal} onClick={assign}>{t('common.create')}</Button><Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button></>}>
        <Field label={t('iam.role')} required>
          <Input placeholder={t('common.search')} value={roleQ} onChange={(e) => setRoleQ(e.target.value)} />
          <div className="card mt-8" style={{ maxHeight: 220, overflow: 'auto' }}>
            {filteredRoles.map((r) => (
              <label key={r.name} className="dropdown-item" style={{ alignItems: 'flex-start', background: roleId === r.name ? 'var(--primary-soft)' : undefined }}>
                <input type="radio" name="role" checked={roleId === r.name} onChange={() => setRoleId(r.name)} style={{ marginTop: 4, accentColor: 'var(--primary)' }} />
                <span><div style={{ fontWeight: 500 }}>{r.properties.roleName}</div><div className="small muted">{r.properties.description}</div></span>
              </label>
            ))}
          </div>
        </Field>
        <Field label={t('iam.principal')} required>
          {principal ? (
            <div className="spread card" style={{ padding: '8px 12px' }}>
              <span>{principal.displayName} <span className="small muted">· {t(`iam.type.${principal.type}` as MessageKey)}</span></span>
              <button className="link-btn" onClick={() => setPrincipal(null)}>{t('common.edit')}</button>
            </div>
          ) : <PrincipalPicker onPick={setPrincipal} />}
        </Field>
        <Field label={t('common.description')}><Textarea rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
      </Panel>

      <Panel wide open={!!roleDetail} onClose={() => setRoleDetail(null)} title={roleDetail?.properties.roleName ?? ''} subtitle={roleDetail?.properties.description}>
        {roleDetail && <CodeBlock value={roleDetail.properties} />}
      </Panel>

      <Panel open={customOpen} onClose={() => setCustomOpen(false)} title={t('iam.newCustomRole')} subtitle={scope} footer={<><Button variant="primary" disabled={!custom.name} onClick={async () => {
        try {
          await arm.put(`${scope}/providers/Microsoft.Authorization/roleDefinitions/${uuid()}`, { properties: { roleName: custom.name, description: custom.description, type: 'CustomRole', assignableScopes: [scope], permissions: [{ actions: custom.actions.split('\n').map((s) => s.trim()).filter(Boolean), notActions: custom.notActions.split('\n').map((s) => s.trim()).filter(Boolean), dataActions: [], notDataActions: [] }] } }, '2022-04-01');
          toast.ok(t('create.done', { name: custom.name }));
          setCustomOpen(false);
          await roles.reload();
        } catch (e) { toast.error(e); }
      }}>{t('common.create')}</Button><Button onClick={() => setCustomOpen(false)}>{t('common.cancel')}</Button></>}>
        <Field label={t('iam.roleName')} required><Input value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} /></Field>
        <Field label={t('common.description')}><Input value={custom.description} onChange={(e) => setCustom({ ...custom, description: e.target.value })} /></Field>
        <Field label={t('iam.actions')} hint="Una per riga · one per line"><Textarea code rows={6} value={custom.actions} onChange={(e) => setCustom({ ...custom, actions: e.target.value })} /></Field>
        <Field label={t('iam.notActions')}><Textarea code rows={3} value={custom.notActions} onChange={(e) => setCustom({ ...custom, notActions: e.target.value })} /></Field>
      </Panel>
    </>
  );
}
