'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { LayoutList, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { arm } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { apiVersionFor, loadCatalog, typeLabel } from '@/lib/arm';
import { useI18n } from '@/i18n';
import { DataTable } from '@/components/table';
import { PageHeader, Toolbar } from '@/components/page';
import { Button, Select, Tags } from '@/components/ui';
import { useConfirm, useToast } from '@/components/overlay';
import { useSubscriptions } from '@/components/pickers';
import { ResourceIcon } from '@/components/resource';

export default function Resources() {
  const { t, locale, fmtRelative } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const subs = useSubscriptions();
  const cat = useAsync(() => loadCatalog(), []);
  const [type, setType] = useState('');
  const [loc, setLoc] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const res = useAsync(async () => {
    const all = await Promise.all((subs.data ?? []).map(async (s) => (await arm.get<{ value: any[] }>(`/subscriptions/${s.subscriptionId}/resources`, '2021-04-01', { $expand: 'changedTime' })).value.map((r) => ({ ...r, subName: s.displayName }))));
    return all.flat();
  }, [subs.data]);
  const types = useMemo(() => [...new Set((res.data ?? []).map((r) => r.type))].sort(), [res.data]);
  const locs = useMemo(() => [...new Set((res.data ?? []).map((r) => r.location).filter(Boolean))].sort(), [res.data]);
  const rows = (res.data ?? []).filter((r) => (!type || r.type === type) && (!loc || r.location === loc));
  const remove = async () => {
    if (!(await confirm({ title: t('res.deleteTitle'), text: [...selected].map((x) => x.split('/').pop()).join(', '), danger: true, confirmLabel: t('common.delete') }))) return;
    for (const id of selected) {
      const ty = rows.find((r) => r.id === id)?.type ?? '';
      try {
        await arm.del(id, await apiVersionFor(ty));
      } catch (e) {
        toast.error(e);
      }
    }
    setSelected(new Set());
    await res.reload();
  };
  return (
    <>
      <PageHeader title={t('res.title')} subtitle={t('res.subtitle')} icon={LayoutList} />
      <Toolbar>
        <Link className="btn" href="/create"><Plus size={16} />{t('common.create')}</Link>
        <Button variant="ghost" icon={RefreshCw} onClick={res.reload}>{t('common.refresh')}</Button>
        <Button variant="danger" icon={Trash2} disabled={!selected.size} onClick={remove}>{t('common.delete')}</Button>
      </Toolbar>
      <DataTable
        rows={res.data ? rows : undefined}
        loading={res.loading || subs.loading}
        error={res.error}
        onRetry={res.reload}
        rowKey={(r) => r.id}
        selectable
        selected={selected}
        onSelect={setSelected}
        search={(r) => `${r.name} ${r.type} ${r.id}`}
        emptyIcon={LayoutList}
        empty={t('res.empty')}
        initialSort={{ key: 'name' }}
        filters={
          <>
            <Select value={type} onChange={(e) => setType(e.target.value)} aria-label={t('common.type')}>
              <option value="">{t('res.filterType')}</option>
              {types.map((ty) => <option key={ty} value={ty}>{typeLabel(cat.data?.all, ty, locale)}</option>)}
            </Select>
            <Select value={loc} onChange={(e) => setLoc(e.target.value)} aria-label={t('common.location')}>
              <option value="">{t('common.location')}: {t('common.all')}</option>
              {locs.map((l) => <option key={l} value={l}>{l}</option>)}
            </Select>
          </>
        }
        columns={[
          { key: 'name', header: t('common.name'), sort: (r) => r.name, render: (r) => <div className="cell-main"><ResourceIcon type={r.type} size="sm" /><Link href={`/resource?id=${encodeURIComponent(r.id)}`}>{r.name}</Link></div> },
          { key: 'type', header: t('common.type'), sort: (r) => typeLabel(cat.data?.all, r.type, locale), render: (r) => typeLabel(cat.data?.all, r.type, locale) },
          { key: 'rg', header: t('common.resourceGroup'), sort: (r) => r.id.split('/')[4], render: (r) => <Link href={`/resource-groups/${r.id.split('/')[2]}/${encodeURIComponent(r.id.split('/')[4])}`}>{r.id.split('/')[4]}</Link> },
          { key: 'loc', header: t('common.location'), sort: (r) => r.location, render: (r) => r.location ?? '—' },
          { key: 'sub', header: t('common.subscription'), sort: (r) => r.subName, render: (r) => <span className="small">{r.subName}</span> },
          { key: 'tags', header: t('common.tags'), render: (r) => <Tags tags={r.tags} /> },
          { key: 'ch', header: t('common.updated'), sort: (r) => r.changedTime, render: (r) => <span className="small muted">{fmtRelative(r.changedTime)}</span> },
        ]}
      />
    </>
  );
}
