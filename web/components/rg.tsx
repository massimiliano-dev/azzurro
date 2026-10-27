'use client';

import { useState } from 'react';
import { arm } from '@/lib/api';
import { useT } from '@/i18n';
import { TagEditor } from './page';
import { Button, Field, Input } from './ui';
import { Panel, useToast } from './overlay';
import { LocationSelect, SubscriptionSelect } from './pickers';

const RG_NAME = /^[-\w._()]{1,90}$/;

export function NewResourceGroupPanel({ open, onClose, onCreated, initialSub }: { open: boolean; onClose: () => void; onCreated?: (sub: string, name: string, location: string) => void; initialSub?: string }) {
  const t = useT();
  const toast = useToast();
  const [sub, setSub] = useState(initialSub ?? '');
  const [name, setName] = useState('');
  const [location, setLocation] = useState('italynorth');
  const [tags, setTags] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const valid = RG_NAME.test(name) && !name.endsWith('.');
  const submit = async () => {
    setBusy(true);
    try {
      await arm.put(`/subscriptions/${sub}/resourcegroups/${name}`, { location, tags });
      toast.ok(t('create.done', { name }));
      onCreated?.(sub, name, location);
      setName('');
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel open={open} onClose={onClose} title={t('rg.new')} footer={<><Button variant="primary" loading={busy} disabled={!valid || !sub} onClick={submit}>{t('common.create')}</Button><Button onClick={onClose}>{t('common.cancel')}</Button></>}>
      <Field label={t('common.subscription')} required htmlFor="rg-sub"><SubscriptionSelect id="rg-sub" value={sub} onChange={setSub} /></Field>
      <Field label={t('rg.name')} required htmlFor="rg-name" hint={t('rg.nameHint')} error={name && !valid ? t('create.nameInvalid') : undefined}>
        <Input id="rg-name" value={name} onChange={(e) => setName(e.target.value)} invalid={!!name && !valid} autoComplete="off" />
      </Field>
      <Field label={t('common.location')} required htmlFor="rg-loc"><LocationSelect id="rg-loc" value={location} onChange={setLocation} /></Field>
      <Field label={t('common.tags')}><TagEditor value={tags} onChange={setTags} /></Field>
    </Panel>
  );
}

