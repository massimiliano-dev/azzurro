'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Plus, RefreshCw, Wallet } from 'lucide-react';
import { arm } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { uuid } from '@/lib/arm';
import { useT, type MessageKey } from '@/i18n';
import { DataTable } from '@/components/table';
import { PageHeader, Toolbar } from '@/components/page';
import { Badge, Button, Field, IdText, Input, Notice, Select } from '@/components/ui';
import { Panel, useToast } from '@/components/overlay';

export default function Subscriptions() {
  const t = useT();
  const toast = useToast();
  const { session } = useSession();
  const subs = useAsync(async () => (await arm.get<{ value: any[] }>('/subscriptions', '2022-12-01')).value, []);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [workload, setWorkload] = useState('Production');
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const alias = `azzurro-${uuid().slice(0, 8)}`;
      await arm.put(`/providers/Microsoft.Subscription/aliases/${alias}`, { properties: { displayName: name, workload, billingScope: '/providers/Microsoft.Billing/billingAccounts/azzurro' } }, '2021-10-01');
      toast.ok(t('create.done', { name }));
      setOpen(false);
      setName('');
      await subs.reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeader title={t('subs.title')} subtitle={t('subs.subtitle')} icon={Wallet} />
      <Toolbar>
        <Button icon={Plus} onClick={() => setOpen(true)} disabled={!session?.isGlobalAdmin} title={session?.isGlobalAdmin ? undefined : t('subs.onlyAdmins')}>{t('subs.new')}</Button>
        <Button variant="ghost" icon={RefreshCw} onClick={subs.reload}>{t('common.refresh')}</Button>
      </Toolbar>
      <DataTable
        rows={subs.data}
        loading={subs.loading}
        error={subs.error}
        onRetry={subs.reload}
        rowKey={(s) => s.subscriptionId}
        search={(s) => `${s.displayName} ${s.subscriptionId}`}
        emptyIcon={Wallet}
        initialSort={{ key: 'name' }}
        columns={[
          { key: 'name', header: t('common.name'), sort: (s) => s.displayName, render: (s) => <div className="cell-main"><Wallet size={16} color="var(--warning)" /><Link href={`/subscriptions/${s.subscriptionId}`}>{s.displayName}</Link></div> },
          { key: 'id', header: t('subs.id'), render: (s) => <IdText value={s.subscriptionId} /> },
          { key: 'state', header: t('subs.state'), sort: (s) => s.state, render: (s) => <Badge tone={s.state === 'Enabled' ? 'ok' : 'warn'}>{t(`subs.state.${s.state}` as MessageKey) ?? s.state}</Badge> },
          { key: 'quota', header: t('subs.quota'), render: (s) => <span className="muted small">{s.subscriptionPolicies?.quotaId}</span> },
        ]}
      />
      <Panel open={open} onClose={() => setOpen(false)} title={t('subs.new')} footer={<><Button variant="primary" loading={busy} disabled={!name.trim()} onClick={create}>{t('common.create')}</Button><Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button></>}>
        {!session?.isGlobalAdmin && <Notice tone="warn">{t('subs.onlyAdmins')}</Notice>}
        <Field label={t('subs.newName')} required htmlFor="sn"><Input id="sn" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label={t('subs.workload')} htmlFor="sw">
          <Select id="sw" value={workload} onChange={(e) => setWorkload(e.target.value)}>
            <option value="Production">{t('subs.workload.Production')}</option>
            <option value="DevTest">{t('subs.workload.DevTest')}</option>
          </Select>
        </Field>
      </Panel>
    </>
  );
}
