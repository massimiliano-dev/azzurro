'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Ban, FileCode2, RefreshCw, Repeat, Trash2 } from 'lucide-react';
import { arm } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { parseId, resourceHref } from '@/lib/arm';
import { useI18n } from '@/i18n';
import { PageHeader, Tabs, Toolbar, useTab } from '@/components/page';
import { Card, CodeBlock, Empty, ErrorNotice, IdText, KV, Notice, Skeleton, Button } from '@/components/ui';
import { useConfirm, useToast } from '@/components/overlay';
import { DataTable } from '@/components/table';
import { ResourceIcon, StateBadge } from '@/components/resource';

export default function DeploymentPage() {
  const sp = useSearchParams();
  const id = sp.get('id') ?? '';
  const { t, fmtDate } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const router = useRouter();
  const [tab, setTab] = useTab('overview');
  const dep = useAsync(() => arm.get<any>(id, '2022-09-01'), [id]);
  const running = ['Running', 'Accepted'].includes(dep.data?.properties?.provisioningState);
  const live = useAsync(() => arm.get<any>(id, '2022-09-01').then((d) => { dep.setData(d); return d; }), [id], { enabled: running, interval: 1500 });
  void live;
  const ops = useAsync(async () => (await arm.get<{ value: any[] }>(`${id}/operations`, '2022-09-01')).value, [id, dep.data?.properties?.provisioningState]);
  const tpl = useAsync(() => arm.post<any>(`${id}/exportTemplate`, {}, '2022-09-01'), [id], { enabled: tab === 'template' });
  if (!id) return <Empty title={t('err.notFound')} />;
  if (dep.error) return <ErrorNotice error={dep.error} onRetry={dep.reload} />;
  const d = dep.data;
  const p = parseId(id);
  const err = d?.properties?.error;
  return (
    <>
      <PageHeader title={p.name ?? ''} subtitle="Microsoft.Resources/deployments" icon={FileCode2} crumbs={[{ label: t('nav.deployments'), href: '/deployments' }, ...(p.resourceGroup ? [{ label: p.resourceGroup, href: `/resource-groups/${p.subscriptionId}/${encodeURIComponent(p.resourceGroup)}` }] : []), { label: p.name ?? '' }]} />
      <Toolbar>
        <Button variant="ghost" icon={RefreshCw} onClick={dep.reload}>{t('common.refresh')}</Button>
        {running && <Button icon={Ban} onClick={async () => { try { await arm.post(`${id}/cancel`, {}, '2022-09-01'); await dep.reload(); } catch (e) { toast.error(e); } }}>{t('dep.cancel')}</Button>}
        <Button icon={Repeat} disabled={!d} onClick={async () => {
          try {
            const exp = await arm.post<any>(`${id}/exportTemplate`, {}, '2022-09-01');
            sessionStorage.setItem('azzurro:template', JSON.stringify(exp.template, null, 2));
            const params = Object.fromEntries(Object.entries<any>(d.properties.parameters ?? {}).filter(([, v]) => 'value' in v).map(([k, v]) => [k, { value: v.value }]));
            sessionStorage.setItem('azzurro:parameters', JSON.stringify(params, null, 2));
            sessionStorage.setItem('azzurro:scope', JSON.stringify({ sub: p.subscriptionId, rg: p.resourceGroup ?? '', name: p.name, location: d.location }));
            router.push('/deploy');
          } catch (e) { toast.error(e); }
        }}>{t('dep.redeploy')}</Button>
        <span className="spacer" />
        <Button variant="danger" icon={Trash2} disabled={running} onClick={async () => { if (await confirm({ title: t('common.delete'), text: p.name, danger: true })) { try { await arm.del(id, '2022-09-01'); router.push('/deployments'); } catch (e) { toast.error(e); } } }}>{t('common.delete')}</Button>
      </Toolbar>
      {!d ? <Skeleton rows={6} /> : (
        <>
          {err && (
            <Notice tone="bad" title={err.code}>
              <div>{err.message}</div>
              {err.details?.length ? <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{err.details.map((x: any, i: number) => <li key={i}><b>{x.code}</b>: {x.message}</li>)}</ul> : null}
            </Notice>
          )}
          {d.properties.provisioningState === 'Succeeded' && <Notice tone="ok">{t('dep.state.Succeeded')}</Notice>}
          <div className="mt-16" />
          <Tabs value={tab} onChange={setTab} tabs={[
            { key: 'overview', label: t('common.overview') },
            { key: 'outputs', label: t('dep.outputs') },
            { key: 'inputs', label: t('dep.inputs') },
            { key: 'template', label: t('dep.template') },
          ]} />
          {tab === 'overview' && (
            <div className="stack" style={{ gap: 16 }}>
              <Card title={t('res.essentials')}>
                <KV items={[
                  [t('dep.state'), <StateBadge key="s" state={d.properties.provisioningState} />],
                  [t('dep.mode'), d.properties.mode],
                  [t('dep.timestamp'), fmtDate(d.properties.timestamp)],
                  [t('dep.duration'), <span key="du" className="mono">{d.properties.duration}</span>],
                  [t('dep.correlation'), <IdText key="c" value={d.properties.correlationId} />],
                  [t('dep.scope'), p.resourceGroup ?? p.subscriptionId],
                  ...(d.location ? [[t('common.location'), d.location] as [string, string]] : []),
                ]} />
              </Card>
              <section>
                <h2 className="mb-16">{t('dep.operations')}</h2>
                <DataTable rows={ops.data} loading={ops.loading} error={ops.error} rowKey={(o) => o.id} empty={t('common.noResults')}
                  columns={[
                    { key: 'r', header: t('act.resource'), render: (o) => <div className="cell-main"><ResourceIcon type={o.properties.targetResource?.resourceType ?? ''} size="sm" />{o.properties.provisioningState === 'Succeeded' ? <Link href={resourceHref(o.properties.targetResource.id)}>{o.properties.targetResource.resourceName}</Link> : o.properties.targetResource?.resourceName}</div> },
                    { key: 't', header: t('common.type'), render: (o) => <span className="small mono">{o.properties.targetResource?.resourceType}</span> },
                    { key: 's', header: t('dep.state'), render: (o) => <StateBadge state={o.properties.provisioningState} /> },
                    { key: 'c', header: 'HTTP', render: (o) => <span className="mono small">{o.properties.statusCode}</span> },
                    { key: 'm', header: t('common.details'), render: (o) => <span className="small" style={{ color: 'var(--danger)' }}>{o.properties.statusMessage?.error?.message ?? ''}</span> },
                  ]} />
              </section>
            </div>
          )}
          {tab === 'outputs' && (Object.keys(d.properties.outputs ?? {}).length ? (
            <Card title={t('dep.outputs')}>
              <KV items={Object.entries<any>(d.properties.outputs).map(([k, v]) => [<span key={k} className="mono">{k}</span>, typeof v.value === 'object' ? <CodeBlock value={v.value} /> : v.value === undefined ? <i className="muted">{v.type}</i> : <IdText value={String(v.value)} />])} />
            </Card>
          ) : <Empty title={t('dep.noOutputs')} />)}
          {tab === 'inputs' && <CodeBlock value={d.properties.parameters ?? {}} />}
          {tab === 'template' && (tpl.data ? <CodeBlock value={tpl.data.template} maxHeight={1200} /> : <Skeleton />)}
        </>
      )}
    </>
  );
}
