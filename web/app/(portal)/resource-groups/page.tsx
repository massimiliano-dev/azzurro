'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { FolderKanban, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { arm } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useT } from '@/i18n';
import { DataTable } from '@/components/table';
import { PageHeader, Toolbar } from '@/components/page';
import { Button, Tags } from '@/components/ui';
import { NewResourceGroupPanel } from '@/components/rg';
import { useConfirm, useToast } from '@/components/overlay';
import { useSubscriptions } from '@/components/pickers';
import { ResourceIcon } from '@/components/resource';

export default function ResourceGroups() {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const sp = useSearchParams();
  const router = useRouter();
  const subs = useSubscriptions();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (sp.get('new') === '1') setOpen(true);
  }, [sp]);
  const rgs = useAsync(async () => {
    const all = await Promise.all((subs.data ?? []).map(async (s) => (await arm.get<{ value: any[] }>(`/subscriptions/${s.subscriptionId}/resourcegroups`, '2021-04-01', { $expand: 'createdTime' })).value.map((r) => ({ ...r, sub: s }))));
    return all.flat();
  }, [subs.data]);
  const remove = async () => {
    const ids = [...selected];
    if (!(await confirm({ title: t('rg.deleteTitle'), text: `${ids.map((i) => i.split('/').pop()).join(', ')} — ${t('common.irreversible')}`, danger: true, confirmLabel: t('common.delete'), typeToConfirm: ids.length === 1 ? ids[0].split('/').pop() : undefined }))) return;
    for (const id of ids) {
      try {
        await arm.del(id);
      } catch (e) {
        toast.error(e);
      }
    }
    setSelected(new Set());
    await rgs.reload();
  };
  return (
    <>
      <PageHeader title={t('rg.title')} subtitle={t('rg.subtitle')} icon={FolderKanban} />
      <Toolbar>
        <Button icon={Plus} onClick={() => setOpen(true)}>{t('common.create')}</Button>
        <Button variant="ghost" icon={RefreshCw} onClick={rgs.reload}>{t('common.refresh')}</Button>
        <Button variant="danger" icon={Trash2} disabled={!selected.size} onClick={remove}>{t('common.delete')}</Button>
      </Toolbar>
      <DataTable
        rows={rgs.data}
        loading={rgs.loading || subs.loading}
        error={rgs.error ?? subs.error}
        onRetry={rgs.reload}
        rowKey={(r) => r.id}
        search={(r) => `${r.name} ${r.location} ${JSON.stringify(r.tags ?? {})}`}
        selectable
        selected={selected}
        onSelect={setSelected}
        emptyIcon={FolderKanban}
        empty={t('rg.empty')}
        initialSort={{ key: 'name' }}
        columns={[
          { key: 'name', header: t('common.name'), sort: (r) => r.name, render: (r) => <div className="cell-main"><ResourceIcon type="Microsoft.Resources/resourceGroups" size="sm" /><Link href={`/resource-groups/${r.sub.subscriptionId}/${encodeURIComponent(r.name)}`}>{r.name}</Link></div> },
          { key: 'sub', header: t('common.subscription'), sort: (r) => r.sub.displayName, render: (r) => r.sub.displayName },
          { key: 'loc', header: t('common.location'), sort: (r) => r.location, render: (r) => r.location },
          { key: 'tags', header: t('common.tags'), render: (r) => <Tags tags={r.tags} /> },
        ]}
      />
      <NewResourceGroupPanel open={open} initialSub={sp.get('sub') ?? undefined} onClose={() => { setOpen(false); if (sp.get('new')) router.replace('/resource-groups'); }} onCreated={() => rgs.reload()} />
    </>
  );
}
