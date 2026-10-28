'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { ArrowRightLeft, FileCode2, FolderKanban, Lock, Pencil, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { arm } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { loadCatalog, rgId, typeLabel } from '@/lib/arm';
import { useI18n, type MessageKey } from '@/i18n';
import { PageHeader, Tabs, TagEditor, Toolbar, useTab } from '@/components/page';
import { Badge, Button, Card, CodeBlock, ErrorNotice, Field, IdText, Input, KV, Select, Skeleton, Tags } from '@/components/ui';
import { Panel, useConfirm, useToast } from '@/components/overlay';
import { DataTable } from '@/components/table';
import { ResourceIcon, StateBadge } from '@/components/resource';
import { MoveResourcesPanel } from '@/components/rgmove';
import { startOperation } from '@/lib/operations';

export default function ResourceGroup() {
  const { sub, name: rawName } = useParams<{ sub: string; name: string }>();
  const name = decodeURIComponent(rawName);
  const id = rgId(sub, name);
  const { t, locale, fmtDate, fmtRelative } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const router = useRouter();
  const [tab, setTab] = useTab('resources');
  const rg = useAsync(() => arm.get<any>(id, '2021-04-01', { $expand: 'createdTime' }), [id]);
  const res = useAsync(async () => (await arm.get<{ value: any[] }>(`${id}/resources`, '2021-04-01', { $expand: 'createdTime,changedTime' })).value, [id]);
  const deps = useAsync(async () => (await arm.get<{ value: any[] }>(`${id}/providers/Microsoft.Resources/deployments`, '2022-09-01')).value, [id], { enabled: tab === 'deployments' });
  const locks = useAsync(async () => (await arm.get<{ value: any[] }>(`${id}/providers/Microsoft.Authorization/locks`, '2020-05-01')).value, [id], { enabled: tab === 'locks' });
  const cat = useAsync(() => loadCatalog(), []);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tags, setTags] = useState<Record<string, string> | null>(null);
  const [exported, setExported] = useState<any>(null);
  const [lockOpen, setLockOpen] = useState(false);
  const [lock, setLock] = useState({ name: '', level: 'CanNotDelete', notes: '' });
  const [moveOpen, setMoveOpen] = useState(false);

  if (rg.error) return <ErrorNotice error={rg.error} onRetry={rg.reload} />;
  const g = rg.data;

  const deleteGroup = async () => {
    if (!(await confirm({ title: t('rg.deleteTitle'), text: <>{t('rg.deleteText', { n: res.data?.length ?? 0 })} {t('common.irreversible')}</>, danger: true, confirmLabel: t('common.delete'), typeToConfirm: name }))) return;
    try {
      // come su Azure l'eliminazione prosegue per conto suo: la si segue in Operazioni
      await startOperation({ kind: 'deleteResourceGroup', id });
      toast.ok(locale === 'it' ? 'Eliminazione avviata' : 'Deletion started', name);
      router.push('/resource-groups');
    } catch (e) {
      toast.error(e);
    }
  };
  const deleteSelected = async () => {
    if (!(await confirm({ title: t('res.deleteTitle'), text: [...selected].map((x) => x.split('/').pop()).join(', '), danger: true, confirmLabel: t('common.delete') }))) return;
    const resources = [...selected].map((rid) => {
      const type = rid.split('/providers/')[1]?.split('/').filter((_, i) => i % 2 === 0).join('/');
      return { id: rid, apiVersion: cat.data?.all.find((c) => c.type.toLowerCase() === type?.toLowerCase())?.apiVersion ?? '2021-04-01' };
    });
    try {
      await startOperation({ kind: 'deleteResources', resources });
      toast.ok(locale === 'it' ? 'Eliminazione avviata' : 'Deletion started', locale === 'it' ? `${resources.length} risorse · segui in Operazioni` : `${resources.length} resources · follow it in Operations`);
      setSelected(new Set());
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <>
      <PageHeader title={name} subtitle={t('common.resourceGroup')} icon={FolderKanban} crumbs={[{ label: t('nav.resourceGroups'), href: '/resource-groups' }, { label: name }]} />
      <Toolbar>
        <Link className="btn" href={`/create?sub=${sub}&rg=${encodeURIComponent(name)}`}><Plus size={16} />{t('common.create')}</Link>
        <Button variant="ghost" icon={RefreshCw} onClick={() => { void rg.reload(); void res.reload(); }}>{t('common.refresh')}</Button>
        <Button icon={FileCode2} onClick={async () => { try { setExported(await arm.post(`${id}/exportTemplate`, { resources: ['*'], options: 'IncludeParameterDefaultValue' })); } catch (e) { toast.error(e); } }}>{t('rg.export')}</Button>
        <Button icon={ArrowRightLeft} disabled={!res.data?.length} onClick={() => setMoveOpen(true)}>{t('rg.move')}</Button>
        <Link className="btn" href={`/iam?scope=${encodeURIComponent(id)}`}><ShieldCheck size={16} />{t('nav.iam')}</Link>
        <span className="spacer" />
        <Button variant="danger" icon={Trash2} disabled={!selected.size} onClick={deleteSelected}>{t('rg.deleteSelected')}</Button>
        <Button variant="danger" icon={Trash2} onClick={deleteGroup}>{t('rg.deleteGroup')}</Button>
      </Toolbar>

      {!g ? <Skeleton /> : (
        <Card title={t('res.essentials')} actions={<Button size="sm" variant="ghost" icon={Pencil} onClick={() => setTags(g.tags ?? {})}>{t('common.tags')}</Button>}>
          <KV items={[
            [t('common.subscription'), <Link key="s" href={`/subscriptions/${sub}`}><span className="mono">{sub}</span></Link>],
            [t('common.location'), g.location],
            [t('res.resourceId'), <IdText key="i" value={g.id} />],
            [t('common.created'), g.createdTime ? fmtDate(g.createdTime) : null],
            [t('rg.managedBy'), g.managedBy ? <Link key="m" href={`/resource?id=${encodeURIComponent(g.managedBy)}`}>{g.managedBy.split('/').pop()}</Link> : null],
            [t('common.tags'), <Tags key="t" tags={g.tags} />],
          ]} />
        </Card>
      )}

      <div className="mt-24">
        <Tabs value={tab} onChange={setTab} tabs={[{ key: 'resources', label: `${t('rg.resources')}${res.data ? ` (${res.data.length})` : ''}` }, { key: 'deployments', label: t('rg.deployments') }, { key: 'locks', label: t('rg.locks') }]} />
        {tab === 'resources' && (
          <DataTable
            rows={res.data} loading={res.loading} error={res.error} onRetry={res.reload} rowKey={(r) => r.id} selectable selected={selected} onSelect={setSelected}
            search={(r) => `${r.name} ${r.type}`} empty={t('rg.empty')} initialSort={{ key: 'name' }}
            columns={[
              { key: 'name', header: t('common.name'), sort: (r) => r.name, render: (r) => <div className="cell-main"><ResourceIcon type={r.type} size="sm" /><Link href={`/resource?id=${encodeURIComponent(r.id)}`}>{r.name}</Link></div> },
              { key: 'type', header: t('common.type'), sort: (r) => r.type, render: (r) => typeLabel(cat.data?.all, r.type, locale) },
              { key: 'loc', header: t('common.location'), sort: (r) => r.location, render: (r) => r.location ?? '—' },
              { key: 'changed', header: t('common.updated'), sort: (r) => r.changedTime, render: (r) => <span className="small muted">{fmtRelative(r.changedTime)}</span> },
            ]}
          />
        )}
        {tab === 'deployments' && (
          <DataTable
            rows={deps.data} loading={deps.loading} error={deps.error} rowKey={(d) => d.id} empty={t('dep.empty')}
            columns={[
              { key: 'n', header: t('common.name'), render: (d) => <Link href={`/deployment?id=${encodeURIComponent(d.id)}`}>{d.name}</Link> },
              { key: 's', header: t('dep.state'), render: (d) => <StateBadge state={d.properties.provisioningState} /> },
              { key: 'ts', header: t('dep.timestamp'), render: (d) => fmtDate(d.properties.timestamp) },
              { key: 'du', header: t('dep.duration'), render: (d) => <span className="mono">{d.properties.duration}</span> },
            ]}
          />
        )}
        {tab === 'locks' && (
          <>
            <div className="mb-16"><Button icon={Lock} onClick={() => setLockOpen(true)}>{t('rg.addLock')}</Button></div>
            <DataTable
              rows={locks.data} loading={locks.loading} error={locks.error} rowKey={(l) => l.id} empty={t('rg.noLocks')}
              columns={[
                { key: 'n', header: t('common.name'), render: (l) => <div className="cell-main"><Lock size={15} />{l.name}</div> },
                { key: 'lv', header: t('rg.lockLevel'), render: (l) => <Badge tone={l.properties.level === 'ReadOnly' ? 'warn' : 'info'}>{t(`rg.lock.${l.properties.level}` as MessageKey)}</Badge> },
                { key: 'sc', header: t('iam.scope'), render: (l) => <span className="small mono">{l.id.split('/providers/Microsoft.Authorization/locks/')[0].replace(id, '.') || '.'}</span> },
                { key: 'no', header: t('rg.lockNotes'), render: (l) => l.properties.notes ?? '—' },
                { key: 'a', header: '', render: (l) => <Button size="sm" variant="ghost" icon={Trash2} aria-label={t('common.delete')} onClick={async () => { try { await arm.del(l.id, '2020-05-01'); await locks.reload(); } catch (e) { toast.error(e); } }} /> },
              ]}
            />
          </>
        )}
      </div>

      <Panel open={tags !== null} onClose={() => setTags(null)} title={t('common.tags')} footer={<><Button variant="primary" onClick={async () => { try { await arm.patch(id, { tags }); setTags(null); await rg.reload(); toast.ok(t('common.saved')); } catch (e) { toast.error(e); } }}>{t('common.save')}</Button><Button onClick={() => setTags(null)}>{t('common.cancel')}</Button></>}>
        {tags && <TagEditor value={tags} onChange={setTags} />}
      </Panel>
      <Panel wide open={!!exported} onClose={() => setExported(null)} title={t('rg.exportTitle')} subtitle={name} footer={<><Link className="btn primary" href="/deploy" onClick={() => sessionStorage.setItem('azzurro:template', JSON.stringify(exported?.template, null, 2))}>{t('dep.redeploy')}</Link><Button onClick={() => setExported(null)}>{t('common.close')}</Button></>}>
        {exported && <CodeBlock value={exported.template} maxHeight={1000} />}
      </Panel>
      <Panel open={lockOpen} onClose={() => setLockOpen(false)} title={t('rg.addLock')} footer={<><Button variant="primary" disabled={!lock.name} onClick={async () => { try { await arm.put(`${id}/providers/Microsoft.Authorization/locks/${lock.name}`, { properties: { level: lock.level, notes: lock.notes || undefined } }, '2020-05-01'); setLockOpen(false); setLock({ name: '', level: 'CanNotDelete', notes: '' }); await locks.reload(); } catch (e) { toast.error(e); } }}>{t('common.create')}</Button><Button onClick={() => setLockOpen(false)}>{t('common.cancel')}</Button></>}>
        <Field label={t('common.name')} required htmlFor="ln"><Input id="ln" value={lock.name} onChange={(e) => setLock({ ...lock, name: e.target.value })} /></Field>
        <Field label={t('rg.lockLevel')} htmlFor="ll">
          <Select id="ll" value={lock.level} onChange={(e) => setLock({ ...lock, level: e.target.value })}>
            <option value="CanNotDelete">{t('rg.lock.CanNotDelete')}</option>
            <option value="ReadOnly">{t('rg.lock.ReadOnly')}</option>
          </Select>
        </Field>
        <Field label={t('rg.lockNotes')} htmlFor="lno"><Input id="lno" value={lock.notes} onChange={(e) => setLock({ ...lock, notes: e.target.value })} /></Field>
      </Panel>
      <MoveResourcesPanel open={moveOpen} onClose={() => setMoveOpen(false)} sub={sub} name={name} location={g?.location ?? 'westeurope'} all={(res.data ?? []).map((r) => r.id)} selected={[...selected]} onMoved={() => { setSelected(new Set()); void res.reload(); }} />
    </>
  );
}
