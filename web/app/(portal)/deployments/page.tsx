'use client';

import Link from 'next/link';
import { FileCode2, Plus, RefreshCw } from 'lucide-react';
import { arm } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { parseId } from '@/lib/arm';
import { useI18n } from '@/i18n';
import { DataTable } from '@/components/table';
import { PageHeader, Toolbar } from '@/components/page';
import { Button } from '@/components/ui';
import { useSubscriptions } from '@/components/pickers';
import { StateBadge } from '@/components/resource';

export default function Deployments() {
  const { t, fmtDate } = useI18n();
  const subs = useSubscriptions();
  const deps = useAsync(async () => {
    const out: any[] = [];
    await Promise.all((subs.data ?? []).map(async (s) => {
      const subLevel = arm.get<{ value: any[] }>(`/subscriptions/${s.subscriptionId}/providers/Microsoft.Resources/deployments`, '2022-09-01').then((r) => out.push(...r.value)).catch(() => undefined);
      const rgs = (await arm.get<{ value: any[] }>(`/subscriptions/${s.subscriptionId}/resourcegroups`)).value;
      await Promise.all([subLevel, ...rgs.map((g) => arm.get<{ value: any[] }>(`${g.id}/providers/Microsoft.Resources/deployments`, '2022-09-01').then((r) => out.push(...r.value)).catch(() => undefined))]);
    }));
    return out;
  }, [subs.data], { interval: 8000 });
  return (
    <>
      <PageHeader title={t('dep.title')} subtitle={t('dep.subtitle')} icon={FileCode2} />
      <Toolbar>
        <Link className="btn" href="/deploy"><Plus size={16} />{t('dep.new')}</Link>
        <Button variant="ghost" icon={RefreshCw} onClick={deps.reload}>{t('common.refresh')}</Button>
      </Toolbar>
      <DataTable
        rows={deps.data} loading={deps.loading || subs.loading} error={deps.error} onRetry={deps.reload} rowKey={(d) => d.id}
        search={(d) => `${d.name} ${d.id}`} empty={t('dep.empty')} emptyIcon={FileCode2} initialSort={{ key: 'ts', desc: true }}
        columns={[
          { key: 'name', header: t('common.name'), sort: (d) => d.name, render: (d) => <div className="cell-main"><FileCode2 size={15} /><Link href={`/deployment?id=${encodeURIComponent(d.id)}`}>{d.name}</Link></div> },
          { key: 'scope', header: t('dep.scope'), sort: (d) => parseId(d.id).resourceGroup ?? '', render: (d) => { const p = parseId(d.id); return p.resourceGroup ? <Link href={`/resource-groups/${p.subscriptionId}/${encodeURIComponent(p.resourceGroup)}`}>{p.resourceGroup}</Link> : <span className="muted">{t('dep.scope.subscription')}</span>; } },
          { key: 'state', header: t('dep.state'), sort: (d) => d.properties.provisioningState, render: (d) => <StateBadge state={d.properties.provisioningState} /> },
          { key: 'ts', header: t('dep.timestamp'), sort: (d) => d.properties.timestamp, render: (d) => fmtDate(d.properties.timestamp) },
          { key: 'du', header: t('dep.duration'), render: (d) => <span className="mono small">{String(d.properties.duration).replace(/^PT/, '').replace(/(\.\d{2})\d*S$/, '$1s')}</span> },
          { key: 'mode', header: t('dep.mode'), render: (d) => d.properties.mode },
        ]}
      />
    </>
  );
}
