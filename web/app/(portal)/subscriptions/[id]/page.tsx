'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Ban, FolderPlus, Pencil, Play, ShieldCheck, Wallet } from 'lucide-react';
import { arm } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useT, type MessageKey } from '@/i18n';
import { PageHeader, Tabs, TagEditor, Toolbar, useTab } from '@/components/page';
import { Badge, Button, Card, ErrorNotice, Field, IdText, Input, KV, Skeleton, Tags } from '@/components/ui';
import { Panel, useConfirm, useToast } from '@/components/overlay';
import { DataTable } from '@/components/table';
import { ResourceIcon } from '@/components/resource';

export default function Subscription() {
  const { id } = useParams<{ id: string }>();
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const [tab, setTab] = useTab('overview');
  const sub = useAsync(() => arm.get<any>(`/subscriptions/${id}`, '2022-12-01'), [id]);
  const rgs = useAsync(async () => (await arm.get<{ value: any[] }>(`/subscriptions/${id}/resourcegroups`)).value, [id]);
  const res = useAsync(async () => (await arm.get<{ value: any[] }>(`/subscriptions/${id}/resources`)).value, [id]);
  const [rename, setRename] = useState<string | null>(null);
  const [tags, setTags] = useState<Record<string, string> | null>(null);
  const action = async (a: 'rename' | 'cancel' | 'enable', body: unknown = {}) => {
    try {
      await arm.post(`/subscriptions/${id}/providers/Microsoft.Subscription/${a}`, body, '2021-10-01');
      await sub.reload();
      toast.ok(t('common.saved'));
    } catch (e) {
      toast.error(e);
    }
  };
  if (sub.error) return <ErrorNotice error={sub.error} onRetry={sub.reload} />;
  const s = sub.data;
  return (
    <>
      <PageHeader title={s?.displayName ?? '…'} subtitle={t('common.subscription')} icon={Wallet} crumbs={[{ label: t('nav.subscriptions'), href: '/subscriptions' }, { label: s?.displayName ?? id }]} />
      <Toolbar>
        <Link className="btn" href={`/resource-groups?new=1&sub=${id}`}><FolderPlus size={16} />{t('subs.newRgHere')}</Link>
        <Button icon={Pencil} onClick={() => setRename(s?.displayName ?? '')}>{t('subs.rename')}</Button>
        <Link className="btn" href={`/iam?scope=${encodeURIComponent(`/subscriptions/${id}`)}`}><ShieldCheck size={16} />{t('nav.iam')}</Link>
        {s?.state === 'Enabled'
          ? <Button variant="danger" icon={Ban} onClick={async () => { if (await confirm({ title: t('subs.cancelSub'), text: t('subs.cancelText'), danger: true, confirmLabel: t('subs.cancelSub') })) await action('cancel'); }}>{t('subs.cancelSub')}</Button>
          : <Button icon={Play} onClick={() => action('enable')}>{t('subs.enableSub')}</Button>}
      </Toolbar>
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'overview', label: t('common.overview') }, { key: 'groups', label: t('nav.resourceGroups') }, { key: 'resources', label: t('rg.resources') }]} />
      {tab === 'overview' && (!s ? <Skeleton /> : (
        <Card title={t('res.essentials')} actions={<Button size="sm" variant="ghost" icon={Pencil} onClick={() => setTags(s.tags ?? {})}>{t('common.tags')}</Button>}>
          <KV items={[
            [t('subs.id'), <IdText key="i" value={s.subscriptionId} />],
            [t('subs.state'), <Badge key="s" tone={s.state === 'Enabled' ? 'ok' : 'warn'}>{t(`subs.state.${s.state}` as MessageKey)}</Badge>],
            [t('entra.tenantId'), <IdText key="tn" value={s.tenantId} />],
            [t('subs.quota'), s.subscriptionPolicies?.quotaId],
            [t('nav.resourceGroups'), rgs.data?.length],
            [t('rg.resources'), res.data?.length],
            [t('common.tags'), <Tags key="tg" tags={s.tags} />],
          ]} />
        </Card>
      ))}
      {tab === 'groups' && (
        <DataTable rows={rgs.data} loading={rgs.loading} error={rgs.error} rowKey={(r) => r.id} search={(r) => r.name}
          columns={[
            { key: 'n', header: t('common.name'), sort: (r) => r.name, render: (r) => <div className="cell-main"><ResourceIcon type="Microsoft.Resources/resourceGroups" size="sm" /><Link href={`/resource-groups/${id}/${encodeURIComponent(r.name)}`}>{r.name}</Link></div> },
            { key: 'l', header: t('common.location'), sort: (r) => r.location, render: (r) => r.location },
          ]} />
      )}
      {tab === 'resources' && (
        <DataTable rows={res.data} loading={res.loading} error={res.error} rowKey={(r) => r.id} search={(r) => `${r.name} ${r.type}`}
          columns={[
            { key: 'n', header: t('common.name'), sort: (r) => r.name, render: (r) => <div className="cell-main"><ResourceIcon type={r.type} size="sm" /><Link href={`/resource?id=${encodeURIComponent(r.id)}`}>{r.name}</Link></div> },
            { key: 't', header: t('common.type'), sort: (r) => r.type, render: (r) => <span className="small muted">{r.type}</span> },
            { key: 'g', header: t('common.resourceGroup'), render: (r) => r.id.split('/')[4] },
          ]} />
      )}
      <Panel open={rename !== null} onClose={() => setRename(null)} title={t('subs.rename')} footer={<><Button variant="primary" disabled={!rename?.trim()} onClick={async () => { await action('rename', { subscriptionName: rename }); setRename(null); }}>{t('common.save')}</Button><Button onClick={() => setRename(null)}>{t('common.cancel')}</Button></>}>
        <Field label={t('subs.newName')} htmlFor="rn"><Input id="rn" value={rename ?? ''} onChange={(e) => setRename(e.target.value)} /></Field>
      </Panel>
      <Panel open={tags !== null} onClose={() => setTags(null)} title={t('common.tags')} footer={<><Button variant="primary" onClick={async () => { try { await arm.put(`/subscriptions/${id}/providers/Microsoft.Resources/tags/default`, { properties: { tags } }); setTags(null); await sub.reload(); toast.ok(t('common.saved')); } catch (e) { toast.error(e); } }}>{t('common.save')}</Button><Button onClick={() => setTags(null)}>{t('common.cancel')}</Button></>}>
        {tags && <TagEditor value={tags} onChange={setTags} />}
      </Panel>
    </>
  );
}
