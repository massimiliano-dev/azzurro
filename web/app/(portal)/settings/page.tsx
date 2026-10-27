'use client';

import { useState } from 'react';
import { Settings } from 'lucide-react';
import { graph, portal } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { useI18n, type Locale } from '@/i18n';
import { PageHeader } from '@/components/page';
import { Avatar, Button, Card, Field, Input, KV } from '@/components/ui';
import { useToast } from '@/components/overlay';
import { useTheme, type Theme } from '@/components/providers';
import { ServerConfig } from '@/components/serverconfig';

export default function SettingsPage() {
  const { t, locale, setLocale } = useI18n();
  const { theme, setTheme } = useTheme();
  const toast = useToast();
  const { session } = useSession();
  const cfg = useAsync(() => portal.get<any>('/config'), []);
  const [cur, setCur] = useState('');
  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const strong = pw1.length >= 8 && [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(pw1)).length >= 3;
  return (
    <>
      <PageHeader title={t('set.title')} subtitle={t('set.subtitle')} icon={Settings} />
      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <div className="stack" style={{ gap: 16 }}>
          <Card title={t('set.profile')}>
            <div className="row mb-16"><Avatar name={session?.user.displayName} size="lg" /><div><div style={{ fontWeight: 600, fontSize: 16 }}>{session?.user.displayName}</div><div className="muted">{session?.user.userPrincipalName}</div></div></div>
            <KV items={[[t('entra.tenantName'), session?.tenant.displayName], [t('users.roles'), session?.directoryRoles.map((r) => r.displayName).join(', ') || '—'], ...(session?.signIn?.provider === 'microsoft' ? [[t('login.roles'), session.signIn.appRoles.join(', ')] as [string, string]] : [])]} />
          </Card>
          <Card title={t('set.language')}>
            <div className="seg">
              {(['it', 'en'] as Locale[]).map((l) => <button key={l} className={locale === l ? 'on' : ''} onClick={() => { setLocale(l); void portal.put('/settings', { locale: l }); }}>{l === 'it' ? 'Italiano' : 'English'}</button>)}
            </div>
          </Card>
          <Card title={t('set.theme')}>
            <div className="seg">
              {(['system', 'light', 'dark'] as Theme[]).map((th) => <button key={th} className={theme === th ? 'on' : ''} onClick={() => { setTheme(th); void portal.put('/settings', { theme: th }); }}>{t(th === 'system' ? 'shell.themeSystem' : th === 'light' ? 'shell.themeLight' : 'shell.themeDark')}</button>)}
            </div>
          </Card>
        </div>
        <div className="stack" style={{ gap: 16 }}>
          {session?.signIn?.provider === 'microsoft' ? (
            <Card title={t('set.msAccount')}>
              <p className="muted" style={{ marginTop: 0 }}>{t('set.msAccountBody')}</p>
              <KV items={[[t('login.roles'), session.signIn.appRoles.join(', ')], [t('set.msTenant'), <span className="mono small" key="t">{session.signIn.tenantId}</span>], [t('set.msLast'), session.signIn.at ? new Date(session.signIn.at).toLocaleString() : '—']]} />
            </Card>
          ) : (
          <Card title={t('set.changePassword')}>
            <form onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await graph.post('/me/changePassword', { currentPassword: cur, newPassword: pw1 });
                toast.ok(t('set.passwordChanged'));
                setCur(''); setPw1(''); setPw2('');
              } catch (err) {
                toast.error(err);
              } finally {
                setBusy(false);
              }
            }}>
              <Field label={t('set.currentPassword')} htmlFor="cp"><Input id="cp" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} /></Field>
              <Field label={t('set.newPassword')} htmlFor="np" hint={t('login.weak')}><Input id="np" type="password" autoComplete="new-password" value={pw1} onChange={(e) => setPw1(e.target.value)} invalid={!!pw1 && !strong} /></Field>
              <Field label={t('login.confirmPassword')} htmlFor="np2" error={pw2 && pw1 !== pw2 ? t('login.mismatch') : undefined}><Input id="np2" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></Field>
              <Button type="submit" variant="primary" loading={busy} disabled={!cur || !strong || pw1 !== pw2}>{t('common.save')}</Button>
            </form>
          </Card>
          )}
          <Card title={t('set.about')}>
            <KV items={[
              ['Azzurro', '0.1.0'],
              ['API', cfg.data?.apiUrl],
              [t('set.authMode'), cfg.data ? t(cfg.data.authMode === 'lax' ? 'set.authMode.lax' : 'set.authMode.strict') : null],
              [t('set.rbac'), cfg.data ? (cfg.data.rbac ? t('common.yes') : t('common.no')) : null],
            ]} />
          </Card>
        </div>
      </div>
      {session?.isGlobalAdmin && <div className="mt-16"><ServerConfig /></div>}
    </>
  );
}
