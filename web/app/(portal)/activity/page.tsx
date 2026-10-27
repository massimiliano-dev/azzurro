'use client';

import { useState } from 'react';
import { Activity, RefreshCw } from 'lucide-react';
import { arm } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { resourceHref } from '@/lib/arm';
import { useI18n, type MessageKey } from '@/i18n';
import { PageHeader, Toolbar } from '@/components/page';
import { Badge, Button, CodeBlock, Field, Select } from '@/components/ui';
import { Panel } from '@/components/overlay';
import { DataTable } from '@/components/table';
import { ResourceGroupSelect, SubscriptionSelect } from '@/components/pickers';

const RANGES: Record<string, number> = { '1h': 3600e3, '24h': 86400e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3 };

export default function ActivityPage() {
  const { t, fmtDate } = useI18n();
  const [sub, setSub] = useState('');
  const [rg, setRg] = useState('');
  const [range, setRange] = useState('24h');
  const [status, setStatus] = useState('');
  const [detail, setDetail] = useState<any>(null);
  const events = useAsync(async () => {
    if (!sub) return [];
    const since = new Date(Date.now() - RANGES[range]).toISOString();
    let filter = `eventTimestamp ge '${since}'`;
    if (rg) filter += ` and resourceGroupName eq '${rg}'`;
    if (status) filter += ` and status eq '${status}'`;
    return (await arm.get<{ value: any[] }>(`/subscriptions/${sub}/providers/Microsoft.Insights/eventtypes/management/values`, '2015-04-01', { $filter: filter })).value;
  }, [sub, rg, range, status]);
  return (
    <>
      <PageHeader title={t('act.title')} subtitle={t('act.subtitle')} icon={Activity} />
      <div className="card card-body mb-16">
        <div className="grid cols-4">
          <Field label={t('common.subscription')} htmlFor="a-sub"><SubscriptionSelect id="a-sub" value={sub} onChange={(v) => { setSub(v); setRg(''); }} /></Field>
          <Field label={t('common.resourceGroup')} htmlFor="a-rg"><ResourceGroupSelect id="a-rg" allowEmpty sub={sub} value={rg} onChange={(v) => setRg(v)} /></Field>
          <Field label={t('act.range')} htmlFor="a-range">
            <Select id="a-range" value={range} onChange={(e) => setRange(e.target.value)}>
              {Object.keys(RANGES).map((k) => <option key={k} value={k}>{t(`act.range.${k}` as MessageKey)}</option>)}
            </Select>
          </Field>
          <Field label={t('act.status')} htmlFor="a-status">
            <Select id="a-status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">{t('common.all')}</option>
              {['Succeeded', 'Failed', 'Accepted'].map((s) => <option key={s} value={s}>{t(`act.status.${s}` as MessageKey)}</option>)}
            </Select>
          </Field>
        </div>
      </div>
      <Toolbar><Button variant="ghost" icon={RefreshCw} onClick={events.reload}>{t('common.refresh')}</Button></Toolbar>
      <DataTable
        rows={events.data} loading={events.loading} error={events.error} onRetry={events.reload} rowKey={(e) => e.eventDataId} empty={t('act.empty')} emptyIcon={Activity}
        search={(e) => `${e.operationName.value} ${e.caller} ${e.resourceId}`} initialSort={{ key: 'ts', desc: true }}
        columns={[
          { key: 'op', header: t('act.operation'), sort: (e) => e.operationName.value, render: (e) => <button className="link-btn mono small" style={{ textAlign: 'left' }} onClick={() => setDetail(e)}>{e.operationName.value}</button> },
          { key: 'st', header: t('act.status'), sort: (e) => e.status.value, render: (e) => <Badge tone={e.status.value === 'Failed' ? 'bad' : e.status.value === 'Accepted' ? 'info' : 'ok'}>{t(`act.status.${e.status.value}` as MessageKey)}</Badge> },
          { key: 'ts', header: t('act.time'), sort: (e) => e.eventTimestamp, render: (e) => <span className="small">{fmtDate(e.eventTimestamp)}</span> },
          { key: 'res', header: t('act.resource'), render: (e) => <a className="small" href={resourceHref(e.resourceId)}>{e.resourceId.split('/').pop()}</a> },
          { key: 'ca', header: t('act.caller'), sort: (e) => e.caller, render: (e) => <span className="small">{e.caller}</span> },
        ]}
      />
      <Panel wide open={!!detail} onClose={() => setDetail(null)} title={detail?.operationName.value ?? ''} subtitle={detail ? fmtDate(detail.eventTimestamp) : ''}>
        {detail && <CodeBlock value={detail} maxHeight={1200} />}
      </Panel>
    </>
  );
}
