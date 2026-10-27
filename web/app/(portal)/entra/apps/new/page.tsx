'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AppWindow } from 'lucide-react';
import { graph } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useI18n, type MessageKey } from '@/i18n';
import { PageHeader } from '@/components/page';
import { Button, Card, ErrorNotice, Field, Input, Select } from '@/components/ui';

const AUDIENCES = ['AzureADMyOrg', 'AzureADMultipleOrgs', 'AzureADandPersonalMicrosoftAccount', 'PersonalMicrosoftAccount'];

export default function NewApp() {
  const { t } = useI18n();
  const router = useRouter();
  const { session } = useSession();
  const [name, setName] = useState('');
  const [audience, setAudience] = useState('AzureADMyOrg');
  const [platform, setPlatform] = useState<'web' | 'spa' | 'public' | ''>('');
  const [uri, setUri] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body: any = { displayName: name, signInAudience: audience };
      if (platform && uri) {
        if (platform === 'web') body.web = { redirectUris: [uri] };
        if (platform === 'spa') body.spa = { redirectUris: [uri] };
        if (platform === 'public') body.publicClient = { redirectUris: [uri] };
      }
      const app = await graph.post<any>('/applications', body);
      await graph.post('/servicePrincipals', { appId: app.appId, tags: ['WindowsAzureActiveDirectoryIntegratedApp'] }).catch(() => undefined);
      router.push(`/entra/apps/${app.id}`);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeader title={t('apps.new')} icon={AppWindow} crumbs={[{ label: t('nav.apps'), href: '/entra/apps' }, { label: t('apps.new') }]} />
      <div style={{ maxWidth: 760 }} className="stack">
        <Card>
          <Field label={t('apps.name')} required htmlFor="an"><Input id="an" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
          <Field label={t('apps.audience')}>
            <div className="radio-cards">
              {AUDIENCES.map((a) => (
                <label key={a} className="radio-card">
                  <input type="radio" name="aud" checked={audience === a} onChange={() => setAudience(a)} />
                  <span>{t(`apps.audience.${a}` as MessageKey).replace('{tenant}', session?.tenant.displayName ?? '')}</span>
                </label>
              ))}
            </div>
          </Field>
          <Field label={`${t('apps.redirect')} (${t('common.optional')})`}>
            <div className="input-group">
              <Select value={platform} onChange={(e) => setPlatform(e.target.value as any)} style={{ maxWidth: 260 }} aria-label={t('apps.platform')}>
                <option value="">{t('apps.platform')}…</option>
                <option value="web">{t('apps.platform.web')}</option>
                <option value="spa">{t('apps.platform.spa')}</option>
                <option value="public">{t('apps.platform.public')}</option>
              </Select>
              <Input placeholder={t('apps.uriPlaceholder')} value={uri} onChange={(e) => setUri(e.target.value)} disabled={!platform} aria-label={t('apps.redirect')} />
            </div>
          </Field>
        </Card>
        {error ? <ErrorNotice error={error} /> : null}
        <div><Button variant="primary" loading={busy} disabled={!name.trim() || (!!platform && !!uri && !/^[a-z][a-z0-9+.-]*:/i.test(uri))} onClick={submit}>{t('apps.register')}</Button></div>
      </div>
    </>
  );
}
