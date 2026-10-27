'use client';

import { useState } from 'react';
import { KeyRound, Plus, Trash2 } from 'lucide-react';
import { arm } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useI18n } from '@/i18n';
import { DataTable } from './table';
import { Panel, useConfirm, useToast } from './overlay';
import { Badge, Button, Field, Input, Notice, Switch } from './ui';

const API = '2023-07-01';

/** Segreti di un Key Vault tramite il piano di controllo ARM (Microsoft.KeyVault/vaults/secrets). */
export function VaultSecrets({ vaultId }: { vaultId: string }) {
  const { t, fmtDate } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const list = useAsync(async () => (await arm.get<{ value: any[] }>(`${vaultId}/secrets`, API)).value, [vaultId]);
  const [edit, setEdit] = useState<{ name: string; isNew: boolean } | null>(null);
  const [value, setValue] = useState('');
  const [contentType, setContentType] = useState('');
  const [exp, setExp] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);

  const openEdit = (s?: any) => {
    setEdit({ name: s?.name ?? '', isNew: !s });
    setValue('');
    setContentType(s?.properties?.contentType ?? '');
    const e = s?.properties?.attributes?.exp;
    setExp(e ? new Date(e * 1000).toISOString().slice(0, 10) : '');
    setEnabled(s?.properties?.attributes?.enabled ?? true);
  };

  const save = async () => {
    if (!edit) return;
    setBusy(true);
    try {
      const attributes: any = { enabled };
      if (exp) attributes.exp = Math.floor(Date.parse(`${exp}T23:59:59Z`) / 1000);
      const properties: any = { attributes, ...(contentType ? { contentType } : {}) };
      if (value) {
        properties.value = value;
        await arm.put(`${vaultId}/secrets/${encodeURIComponent(edit.name)}`, { properties }, API);
      } else {
        await arm.patch(`${vaultId}/secrets/${encodeURIComponent(edit.name)}`, { properties }, API);
      }
      toast.ok(value ? t('kv.versionSaved') : t('kv.attrsSaved'));
      setEdit(null);
      setValue('');
      list.reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (s: any) => {
    try {
      await arm.patch(`${s.id}`, { properties: { attributes: { enabled: !(s.properties?.attributes?.enabled ?? true) } } }, API);
      list.reload();
    } catch (e) { toast.error(e); }
  };

  const nameOk = /^[a-zA-Z0-9-]{1,127}$/.test(edit?.name ?? '');
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Notice>{t('kv.planeNote')}</Notice>
      <div className="row"><Button variant="primary" icon={Plus} onClick={() => openEdit()}>{t('kv.new')}</Button></div>
      <DataTable
        rows={list.data}
        loading={list.loading}
        error={list.error}
        onRetry={list.reload}
        rowKey={(s: any) => s.id}
        empty={t('kv.empty')}
        emptyIcon={KeyRound}
        columns={[
          { key: 'n', header: t('common.name'), sort: (s: any) => s.name, render: (s: any) => <button type="button" className="linkish mono" onClick={() => openEdit(s)}>{s.name}</button> },
          { key: 'st', header: t('kv.state'), render: (s: any) => (s.properties?.attributes?.enabled ?? true) ? <Badge tone="ok">{t('kv.enabled')}</Badge> : <Badge tone="warn">{t('kv.disabled')}</Badge> },
          { key: 'ct', header: t('kv.contentType'), render: (s: any) => <span className="small muted">{s.properties?.contentType || '—'}</span> },
          { key: 'ex', header: t('kv.expires'), render: (s: any) => {
            const e = s.properties?.attributes?.exp;
            if (!e) return <span className="muted">—</span>;
            const past = e * 1000 < Date.now();
            return <span className={past ? 'bad-text' : ''}>{fmtDate(new Date(e * 1000).toISOString())}</span>;
          } },
          { key: 'up', header: t('kv.updated'), render: (s: any) => { const u = s.properties?.attributes?.updated; return u ? fmtDate(new Date(u * 1000).toISOString()) : '—'; } },
          { key: 'a', header: '', render: (s: any) => (
            <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
              <Button size="sm" onClick={() => openEdit(s)}>{t('kv.newVersion')}</Button>
              <Button size="sm" onClick={() => toggle(s)}>{(s.properties?.attributes?.enabled ?? true) ? t('kv.disable') : t('kv.enable')}</Button>
              <Button size="sm" variant="ghost" icon={Trash2} aria-label={t('common.delete')} onClick={async () => {
                if (!(await confirm({ title: t('kv.deleteTitle', { name: s.name }), text: t('common.irreversible'), danger: true, confirmLabel: t('common.delete') }))) return;
                try { await arm.del(s.id, API); list.reload(); } catch (e) { toast.error(e); }
              }} />
            </div>
          ) },
        ] as any}
      />
      <Panel open={!!edit} onClose={() => setEdit(null)} title={edit?.isNew ? t('kv.new') : t('kv.editTitle', { name: edit?.name ?? '' })}
        footer={<><Button variant="primary" loading={busy} disabled={!nameOk || (edit?.isNew && !value)} onClick={save}>{t('common.save')}</Button><Button onClick={() => setEdit(null)}>{t('common.cancel')}</Button></>}>
        {edit && (
          <div className="stack" style={{ gap: 12 }}>
            {edit.isNew && (
              <Field label={t('common.name')} htmlFor="kvn" error={edit.name && !nameOk ? t('kv.nameRule') : undefined}>
                <Input id="kvn" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} autoComplete="off" />
              </Field>
            )}
            <Field label={edit.isNew ? t('kv.value') : t('kv.newValue')} htmlFor="kvv" hint={edit.isNew ? undefined : t('kv.keepValue')}>
              <Input id="kvv" type="password" autoComplete="new-password" value={value} onChange={(e) => setValue(e.target.value)} />
            </Field>
            <Field label={t('kv.contentType')} htmlFor="kvc"><Input id="kvc" value={contentType} onChange={(e) => setContentType(e.target.value)} placeholder="text/plain" /></Field>
            <Field label={t('kv.expires')} htmlFor="kve"><Input id="kve" type="date" value={exp} onChange={(e) => setExp(e.target.value)} /></Field>
            <Switch checked={enabled} onChange={setEnabled} label={t('kv.enabled')} />
          </div>
        )}
      </Panel>
    </div>
  );
}
