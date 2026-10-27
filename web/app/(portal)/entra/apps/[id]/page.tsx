'use client';

import { useParams, useRouter } from 'next/navigation';
import { AppWindow, Trash2 } from 'lucide-react';
import { graph } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useI18n } from '@/i18n';
import { PageHeader, Tabs, Toolbar, useTab } from '@/components/page';
import { Button, ErrorNotice, Skeleton } from '@/components/ui';
import { useConfirm, useToast } from '@/components/overlay';
import { RefList } from '@/components/members';
import { AuthTab, CredentialsTab, ExposeTab, ManifestTab, OverviewTab, PermissionsTab, RolesTab, type AppCtx } from '@/components/app-tabs';

export default function AppPage() {
  const { id } = useParams<{ id: string }>();
  const { t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const router = useRouter();
  const [tab, setTab] = useTab('overview');
  const app = useAsync(() => graph.get<any>(`/applications/${id}`), [id]);
  const sp = useAsync(async () => (app.data ? graph.get<any>(`/servicePrincipals(appId='${app.data.appId}')`).catch(() => null) : null), [app.data?.appId]);
  if (app.error) return <ErrorNotice error={app.error} onRetry={app.reload} />;
  const a = app.data;
  const ctx: AppCtx | null = a ? { app: a, sp: sp.data ?? null, reload: app.reload, reloadSp: sp.reload } : null;
  return (
    <>
      <PageHeader title={a?.displayName ?? '…'} subtitle={t('nav.apps')} icon={AppWindow} crumbs={[{ label: t('nav.apps'), href: '/entra/apps' }, { label: a?.displayName ?? '' }]} />
      <Toolbar>
        <span className="spacer" />
        <Button variant="danger" icon={Trash2} disabled={!a} onClick={async () => {
          if (!(await confirm({ title: t('common.delete'), text: t('apps.deleteText', { name: a.displayName }), danger: true, confirmLabel: t('common.delete'), typeToConfirm: a.displayName }))) return;
          try { await graph.del(`/applications/${id}`); router.push('/entra/apps'); } catch (e) { toast.error(e); }
        }}>{t('common.delete')}</Button>
      </Toolbar>
      <Tabs value={tab} onChange={setTab} tabs={(['overview', 'auth', 'credentials', 'permissions', 'expose', 'roles', 'owners', 'manifest'] as const).map((k) => ({ key: k, label: t(`apps.tab.${k}`) }))} />
      {!ctx ? <Skeleton rows={8} /> : (
        <div key={`${tab}-${a.id}`}>
          {tab === 'overview' && <OverviewTab ctx={ctx} />}
          {tab === 'auth' && <AuthTab ctx={ctx} />}
          {tab === 'credentials' && <CredentialsTab ctx={ctx} />}
          {tab === 'permissions' && <PermissionsTab ctx={ctx} />}
          {tab === 'expose' && <ExposeTab ctx={ctx} />}
          {tab === 'roles' && <RolesTab ctx={ctx} />}
          {tab === 'owners' && <RefList base={`/applications/${id}`} relation="owners" types={['User', 'ServicePrincipal']} title={t('apps.tab.owners')} empty={t('apps.noOwners')} />}
          {tab === 'manifest' && <ManifestTab ctx={ctx} />}
        </div>
      )}
    </>
  );
}
