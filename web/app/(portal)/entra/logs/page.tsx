'use client';

import { useState } from 'react';
import { RefreshCw, ScrollText } from 'lucide-react';
import { graph } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useI18n } from '@/i18n';
import { PageHeader, Tabs, Toolbar, useTab } from '@/components/page';
import { Badge, Button, CodeBlock, Notice } from '@/components/ui';
import { Panel } from '@/components/overlay';
import { DataTable } from '@/components/table';

export default function LogsPage() {
  const { t, fmtDate } = useI18n();
  const [tab, setTab] = useTab('signins');
  const [kind, setKind] = useState<'interactiveUser' | 'nonInteractiveUser' | 'servicePrincipal'>('interactiveUser');
  const [detail, setDetail] = useState<any>(null);
  const signins = useAsync(() => graph.listBeta<any>(`/auditLogs/signIns?$top=500&$filter=${encodeURIComponent(`signInEventTypes/any(t: t eq '${kind}')`)}`), [kind], { enabled: tab === 'signins' });
  const audits = useAsync(() => graph.list<any>('/auditLogs/directoryAudits?$top=500'), [], { enabled: tab === 'audits' });
  const forbidden = (signins.error as any)?.status === 403 || (audits.error as any)?.status === 403;
  return (
    <>
      <PageHeader title={t('logs.title')} subtitle={t('logs.subtitle')} icon={ScrollText} />
      <Toolbar><Button variant="ghost" icon={RefreshCw} onClick={() => { void signins.reload(); void audits.reload(); }}>{t('common.refresh')}</Button></Toolbar>
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'signins', label: t('logs.signins') }, { key: 'audits', label: t('logs.audits') }]} />
      {forbidden ? <Notice tone="warn">{t('logs.forbidden')}</Notice> : tab === 'signins' ? (
        <>
          <div className="chips">
            {(['interactiveUser', 'nonInteractiveUser', 'servicePrincipal'] as const).map((k) => <button key={k} className={`chip ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}>{t(k === 'interactiveUser' ? 'logs.interactive' : k === 'nonInteractiveUser' ? 'logs.nonInteractive' : 'logs.servicePrincipal')}</button>)}
          </div>
          <DataTable rows={signins.data} loading={signins.loading} error={signins.error} rowKey={(s) => s.id} empty={t('logs.empty')} search={(s) => `${s.userPrincipalName ?? ''} ${s.servicePrincipalName ?? ''} ${s.appDisplayName ?? ''} ${s.ipAddress}`} initialSort={{ key: 'd', desc: true }}
            columns={[
              { key: 'd', header: t('logs.date'), sort: (s) => s.createdDateTime, render: (s) => <button className="link-btn small" onClick={() => setDetail(s)}>{fmtDate(s.createdDateTime)}</button> },
              { key: 'u', header: kind === 'servicePrincipal' ? t('logs.servicePrincipal') : t('logs.user'), sort: (s) => s.userPrincipalName ?? s.servicePrincipalName, render: (s) => s.userPrincipalName ?? s.servicePrincipalName ?? '—' },
              { key: 'a', header: t('logs.app'), render: (s) => s.appDisplayName ?? '—' },
              { key: 'r', header: t('ent.resource'), render: (s) => <span className="small">{s.resourceDisplayName ?? '—'}</span> },
              { key: 'ip', header: t('logs.ip'), render: (s) => <span className="mono small">{s.ipAddress}</span> },
              { key: 's', header: t('logs.result'), sort: (s) => s.status.errorCode, render: (s) => s.status.errorCode ? <Badge tone="bad">{t('logs.failure')} · {s.status.errorCode}</Badge> : <Badge tone="ok">{t('logs.success')}</Badge> },
            ]} />
        </>
      ) : (
        <DataTable rows={audits.data} loading={audits.loading} error={audits.error} rowKey={(a) => a.id} empty={t('logs.empty')} search={(a) => `${a.activityDisplayName} ${a.category} ${a.targetResources?.[0]?.displayName ?? ''}`} initialSort={{ key: 'd', desc: true }}
          columns={[
            { key: 'd', header: t('logs.date'), sort: (a) => a.activityDateTime, render: (a) => <button className="link-btn small" onClick={() => setDetail(a)}>{fmtDate(a.activityDateTime)}</button> },
            { key: 'c', header: t('logs.category'), sort: (a) => a.category, render: (a) => <Badge>{a.category}</Badge> },
            { key: 'a', header: t('logs.activity'), sort: (a) => a.activityDisplayName, render: (a) => a.activityDisplayName },
            { key: 'i', header: t('logs.initiatedBy'), render: (a) => <span className="small">{a.initiatedBy?.user?.userPrincipalName ?? a.initiatedBy?.app?.displayName ?? '—'}</span> },
            { key: 't', header: t('logs.target'), render: (a) => <span className="small">{a.targetResources?.map((x: any) => x.displayName ?? x.id).join(', ')}</span> },
            { key: 'r', header: t('logs.result'), render: (a) => <Badge tone={a.result === 'success' ? 'ok' : 'bad'}>{a.result}</Badge> },
          ]} />
      )}
      <Panel wide open={!!detail} onClose={() => setDetail(null)} title={detail?.activityDisplayName ?? detail?.userPrincipalName ?? detail?.servicePrincipalName ?? ''}>
        {detail && <CodeBlock value={detail} maxHeight={1200} />}
      </Panel>
    </>
  );
}
