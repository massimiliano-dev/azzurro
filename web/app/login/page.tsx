'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { portal, ApiError } from '@/lib/api';
import { useI18n, type Locale } from '@/i18n';
import { Logo } from '@/components/logo';
import { Button, Field, Input, Notice } from '@/components/ui';
import { useTheme } from '@/components/providers';

function strong(pw: string) {
  return pw.length >= 8 && [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length >= 3;
}

function LoginForm() {
  const { t, locale, setLocale } = useI18n();
  useTheme();
  const sp = useSearchParams();
  const next = sp.get('next');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [ticket, setTicket] = useState<string | null>(null);
  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [modes, setModes] = useState<{ microsoft: boolean; local: boolean } | null>(null);
  const [leaving, setLeaving] = useState(false);
  const urlError = sp.get('error');
  const urlDetail = sp.get('detail');

  useEffect(() => {
    portal.get<any>('/config', { noRedirect: true })
      .then((c) => setModes(c.login ?? { microsoft: false, local: true }))
      .catch(() => setModes({ microsoft: false, local: true }));
  }, []);

  const microsoft = () => {
    setLeaving(true);
    const back = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
    location.href = `/api/portal/auth/microsoft?returnTo=${encodeURIComponent(back)}`;
  };
  const msError = urlError
    ? (['no_role', 'cancelled', 'state_expired'].includes(urlError) ? t(`login.err.${urlError}` as any) : t('login.err.generic'))
    : null;

  const done = (data: any) => {
    const l = data?.settings?.locale ?? (data?.user?.preferredLanguage?.startsWith('en') ? 'en' : data?.user?.preferredLanguage?.startsWith('it') ? 'it' : null);
    if (l && l !== locale) setLocale(l);
    location.href = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (ticket) {
        if (pw1 !== pw2) throw new Error(t('login.mismatch'));
        if (!strong(pw1)) throw new Error(t('login.weak'));
        done(await portal.post('/change-password', { ticket, newPassword: pw1 }, { noRedirect: true }));
        return;
      }
      const r = await portal.post<any>('/login', { username, password }, { noRedirect: true });
      if (r.status === 'password_change_required') {
        setTicket(r.ticket);
        setBusy(false);
        return;
      }
      done(r);
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError) setError(err.code === 'account_disabled' ? t('login.disabled') : err.code === 'weak_password' ? t('login.weak') : err.status === 0 ? t('err.network') : t('login.invalid'));
      else setError((err as Error).message);
    }
  };

  return (
    <div className="login">
      <aside className="login-art">
        <span className="shape" aria-hidden />
        <span className="shape b" aria-hidden />
        <span className="shape c" aria-hidden />
        <div className="brand"><Logo size={32} inverse /><span className="logotype">azzurro</span></div>
        <h1>{t('login.tagline')}</h1>
        <div>
          <div className="login-ribbon" aria-hidden>
            {[
              ['GET', '/subscriptions?api-version=2022-12-01', '200', '12ms'],
              ['PUT', '/subscriptions/…/resourceGroups/demo-rg', '201', '31ms'],
              ['POST', '/v1.0/applications/…/addPassword', '200', '18ms'],
              ['DELETE', '/…/providers/Microsoft.Storage/storageAccounts/old', '200', '24ms'],
            ].map(([m, p, s2, ms]) => (
              <div key={p}><span className={`m ${m}`}>{m}</span><span className="p">{p}</span><span className="s">{s2}</span><span className="t">{ms}</span></div>
            ))}
          </div>
          <div className="foot">
            {(['login.pitch1', 'login.pitch2', 'login.pitch3'] as const).map((k) => <span key={k}>{t(k)}</span>)}
          </div>
        </div>
      </aside>
      <section className="login-form">
        <form onSubmit={submit} noValidate>
          <div className="lang">
            <div className="seg">
              {(['it', 'en'] as Locale[]).map((l) => <button type="button" key={l} className={locale === l ? 'on' : ''} onClick={() => setLocale(l)}>{l === 'it' ? 'Italiano' : 'English'}</button>)}
            </div>
          </div>
          
          <h2>{ticket ? t('login.update') : t('login.title')}</h2>
          <p className="sub">{ticket ? '' : t('login.subtitle')}</p>
          {ticket && <Notice>{t('login.mustChange')}</Notice>}
          {error && <div className="mb-16"><Notice tone="bad">{error}</Notice></div>}
          {msError && !ticket && (
            <div className="mb-16"><Notice tone="bad">{msError}{urlDetail && urlError !== 'no_role' && urlError !== 'cancelled' ? <span className="mono small" style={{ display: 'block', marginTop: 6, wordBreak: 'break-word' }}>{urlDetail}</span> : null}</Notice></div>
          )}
          {modes?.microsoft && !ticket && (
            <div className="ms-login">
              <button type="button" className="btn-ms" onClick={microsoft} disabled={leaving}>
                <svg width="20" height="20" viewBox="0 0 21 21" aria-hidden><rect x="1" y="1" width="9" height="9" fill="#f25022" /><rect x="11" y="1" width="9" height="9" fill="#7fba00" /><rect x="1" y="11" width="9" height="9" fill="#00a4ef" /><rect x="11" y="11" width="9" height="9" fill="#ffb900" /></svg>
                <span>{leaving ? t('login.redirecting') : t('login.microsoft')}</span>
              </button>
              <p className="small muted">{t('login.msHint')}</p>
            </div>
          )}
          {modes?.microsoft && modes.local && !ticket && <div className="login-or"><span>{t('login.or')}</span></div>}
          {(modes?.local || ticket) && (
            <>
            {!ticket ? (
              <>
                <Field label={t('login.username')} htmlFor="u">
                  <Input id="u" type="email" autoComplete="username" required autoFocus value={username} onChange={(e) => setUsername(e.target.value)} placeholder="nome@azzurro.local" />
                </Field>
                <Field label={t('login.password')} htmlFor="p">
                  <Input id="p" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
                </Field>
              </>
            ) : (
              <div className="mt-16">
                <Field label={t('login.newPassword')} htmlFor="n1" hint={t('login.weak')}>
                  <Input id="n1" type="password" autoComplete="new-password" autoFocus value={pw1} onChange={(e) => setPw1(e.target.value)} />
                </Field>
                <Field label={t('login.confirmPassword')} htmlFor="n2">
                  <Input id="n2" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
                </Field>
              </div>
            )}
            <Button type="submit" variant="primary" loading={busy} disabled={!ticket ? !username || !password : !pw1 || !pw2}>
              {busy ? t('login.signingIn') : ticket ? t('login.update') : t('login.submit')}
            </Button>
            </>
          )}
        </form>
      </section>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
