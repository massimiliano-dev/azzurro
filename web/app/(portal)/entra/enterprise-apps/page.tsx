'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Fingerprint, RefreshCw } from 'lucide-react';
import { graph } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { useI18n } from '@/i18n';
import { PageHeader, Toolbar } from '@/components/page';
import { Badge, Button, IdText } from '@/components/ui';
import { DataTable } from '@/components/table';

export default function EnterpriseApps() {
  const { t, fmtDate } = useI18n();
  const { session } = useSession();
  const [filter, setFilter] = useState<'all' | 'app' | 'mi' | 'ms'>('app');
  const sps = useAsync(() => graph.list<any>('/servicePrincipals?$top=999'), []);
  const kind = (sp: any) => (sp.servicePrincipalType === 'ManagedIdentity' ? 'mi' : sp.appOwnerOrganizationId && sp.appOwnerOrganizationId !== session?.tenant.id ? 'ms' : 'app');
  const rows = sps.data?.filter((sp) => filter === 'all' || kind(sp) === filter);
  return (
    <>
      <PageHeader title={t('ent.title')} subtitle={t('ent.subtitle')} icon={Fingerprint} />
      <Toolbar><Button variant="ghost" icon={RefreshCw} onClick={sps.reload}>{t('common.refresh')}</Button></Toolbar>
      <div className="chips">
        {(['app', 'mi', 'ms', 'all'] as const).map((f) => <button key={f} className={`chip ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>{t(`ent.filter.${f}`)}</button>)}
      </div>
      <DataTable
        rows={rows} loading={sps.loading} error={sps.error} onRetry={sps.reload} rowKey={(s) => s.id} empty={t('ent.empty')} emptyIcon={Fingerprint}
        search={(s) => `${s.displayName} ${s.appId}`} initialSort={{ key: 'n' }}
        columns={[
          { key: 'n', header: t('common.name'), sort: (s) => s.displayName, render: (s) => <div className="cell-main"><span className={`res-icon sm ${kind(s) === 'mi' ? 'c-identity' : 'c-web'}`}><Fingerprint size={13} /></span><Link href={`/entra/enterprise-apps/${s.id}`}>{s.displayName}</Link></div> },
          { key: 'a', header: t('ent.appId'), render: (s) => <IdText value={s.appId} short /> },
          { key: 't', header: t('ent.type'), sort: (s) => kind(s), render: (s) => <Badge tone={kind(s) === 'mi' ? 'warn' : kind(s) === 'ms' ? 'info' : undefined}>{kind(s) === 'mi' ? t('ent.managedIdentity') : kind(s) === 'ms' ? t('ent.microsoft') : t('ent.application')}</Badge> },
          { key: 'e', header: t('common.status'), render: (s) => <Badge tone={s.accountEnabled ? 'ok' : 'warn'}>{s.accountEnabled ? t('common.enabled') : t('common.disabled')}</Badge> },
          { key: 'c', header: t('common.created'), sort: (s) => s.createdDateTime, render: (s) => <span className="small muted">{fmtDate(s.createdDateTime, 'short')}</span> },
        ]}
      />
    </>
  );
}
