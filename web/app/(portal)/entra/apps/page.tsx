'use client';

import Link from 'next/link';
import { AppWindow, Plus, RefreshCw } from 'lucide-react';
import { graph } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { useI18n } from '@/i18n';
import { PageHeader, Tabs, Toolbar, useTab } from '@/components/page';
import { Badge, Button, IdText } from '@/components/ui';
import { DataTable } from '@/components/table';

export default function AppsPage() {
  const { t, fmtDate } = useI18n();
  const { session } = useSession();
  const [tab, setTab] = useTab('all');
  const apps = useAsync(() => graph.list<any>('/applications?$top=999&$expand=owners'), []);
  const rows = tab === 'owned' ? apps.data?.filter((a) => a.owners?.some((o: any) => o.id === session?.user.id)) : apps.data;
  const expiry = (a: any) => {
    const ends = [...(a.passwordCredentials ?? []), ...(a.keyCredentials ?? [])].map((c: any) => Date.parse(c.endDateTime)).filter(Boolean);
    if (!ends.length) return null;
    const min = Math.min(...ends);
    if (min < Date.now()) return <Badge tone="bad">{t('apps.expires')}: {fmtDate(min, 'short')}</Badge>;
    if (min < Date.now() + 30 * 86400_000) return <Badge tone="warn">{t('apps.expires')}: {fmtDate(min, 'short')}</Badge>;
    return <Badge tone="ok">{t('apps.secretCount', { n: ends.length })}</Badge>;
  };
  return (
    <>
      <PageHeader title={t('apps.title')} subtitle={t('apps.subtitle')} icon={AppWindow} />
      <Toolbar>
        <Link className="btn" href="/entra/apps/new"><Plus size={16} />{t('apps.new')}</Link>
        <Button variant="ghost" icon={RefreshCw} onClick={apps.reload}>{t('common.refresh')}</Button>
      </Toolbar>
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'all', label: t('apps.all') }, { key: 'owned', label: t('apps.owned') }]} />
      <DataTable
        rows={rows} loading={apps.loading} error={apps.error} onRetry={apps.reload} rowKey={(a) => a.id} emptyIcon={AppWindow} empty={t('apps.empty')}
        search={(a) => `${a.displayName} ${a.appId}`} initialSort={{ key: 'n' }}
        columns={[
          { key: 'n', header: t('apps.name'), sort: (a) => a.displayName, render: (a) => <div className="cell-main"><span className="res-icon sm c-web"><AppWindow size={13} /></span><Link href={`/entra/apps/${a.id}`}>{a.displayName}</Link></div> },
          { key: 'id', header: t('apps.appId'), render: (a) => <IdText value={a.appId} /> },
          { key: 'c', header: t('common.created'), sort: (a) => a.createdDateTime, render: (a) => <span className="small muted">{fmtDate(a.createdDateTime, 'short')}</span> },
          { key: 'cred', header: t('apps.tab.credentials'), render: (a) => expiry(a) ?? <span className="muted small">—</span> },
        ]}
      />
    </>
  );
}
