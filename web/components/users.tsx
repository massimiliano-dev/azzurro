'use client';

import { useState } from 'react';
import { graph } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useT } from '@/i18n';
import { Button, Checkbox, Field, Input, Notice, Select, SecretValue } from './ui';
import { Panel, useToast } from './overlay';

export function generatePassword(): string {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!#$%&*?'];
  const pick = (s: string, n: number) => Array.from(crypto.getRandomValues(new Uint32Array(n)), (x) => s[x % s.length]).join('');
  return (pick(sets[0], 3) + pick(sets[1], 5) + pick(sets[2], 3) + pick(sets[3], 1)).split('').sort(() => Math.random() - 0.5).join('');
}

export function NewUserPanel({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const t = useT();
  const toast = useToast();
  const { session } = useSession();
  const [f, setF] = useState({ displayName: '', alias: '', domain: '', givenName: '', surname: '', jobTitle: '', department: '', usageLocation: 'IT', accountEnabled: true });
  const [auto, setAuto] = useState(true);
  const [password, setPassword] = useState('');
  const [force, setForce] = useState(true);
  const [created, setCreated] = useState<{ upn: string; password: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const domain = f.domain || session?.tenant.defaultDomain || '';
  const close = () => {
    setCreated(null);
    setF({ ...f, displayName: '', alias: '', givenName: '', surname: '', jobTitle: '', department: '' });
    onClose();
  };
  const submit = async () => {
    setBusy(true);
    const pw = auto ? generatePassword() : password;
    try {
      const upn = `${f.alias}@${domain}`;
      await graph.post('/users', {
        accountEnabled: f.accountEnabled, displayName: f.displayName, mailNickname: f.alias, userPrincipalName: upn, mail: upn,
        givenName: f.givenName || undefined, surname: f.surname || undefined, jobTitle: f.jobTitle || undefined, department: f.department || undefined, usageLocation: f.usageLocation || undefined,
        passwordProfile: { password: pw, forceChangePasswordNextSignIn: force },
      });
      setCreated({ upn, password: pw });
      onCreated();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel open={open} onClose={close} title={t('users.new')} footer={created ? <Button variant="primary" onClick={close}>{t('common.done')}</Button> : <><Button variant="primary" loading={busy} disabled={!f.displayName || !/^[A-Za-z0-9._-]+$/.test(f.alias) || (!auto && password.length < 8)} onClick={submit}>{t('common.create')}</Button><Button onClick={close}>{t('common.cancel')}</Button></>}>
      {created ? (
        <div className="stack">
          <Notice tone="ok" title={created.upn}>{t('users.createdPassword')}</Notice>
          <SecretValue value={created.password} />
          <Notice tone="warn">{t('users.createdPasswordHint')}</Notice>
        </div>
      ) : (
        <>
          <Field label={t('users.displayName')} required htmlFor="u-dn">
            <Input id="u-dn" value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} onBlur={() => {
              if (!f.displayName.trim()) return;
              const parts = f.displayName.trim().split(/\s+/);
              setF((x) => ({
                ...x,
                alias: x.alias || x.displayName.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '.').replace(/[^a-z0-9._-]/g, ''),
                givenName: x.givenName || parts[0],
                surname: x.surname || parts.slice(1).join(' '),
              }));
            }} />
          </Field>
          <Field label={t('users.upn')} required htmlFor="u-al">
            <div className="input-group">
              <Input id="u-al" value={f.alias} onChange={(e) => setF({ ...f, alias: e.target.value })} />
              <span className="muted">@</span>
              <Select value={domain} onChange={(e) => setF({ ...f, domain: e.target.value })} aria-label="domain">
                {(session?.tenant.domains ?? []).map((d) => <option key={d} value={d}>{d}</option>)}
              </Select>
            </div>
          </Field>
          <div className="form-grid">
            <Field label={t('users.givenName')} htmlFor="u-gn"><Input id="u-gn" value={f.givenName} onChange={(e) => setF({ ...f, givenName: e.target.value })} /></Field>
            <Field label={t('users.surname')} htmlFor="u-sn"><Input id="u-sn" value={f.surname} onChange={(e) => setF({ ...f, surname: e.target.value })} /></Field>
            <Field label={t('users.jobTitle')} htmlFor="u-jt"><Input id="u-jt" value={f.jobTitle} onChange={(e) => setF({ ...f, jobTitle: e.target.value })} /></Field>
            <Field label={t('users.department')} htmlFor="u-dep"><Input id="u-dep" value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })} /></Field>
          </div>
          <Field label={t('users.password')}>
            <Checkbox checked={auto} onChange={setAuto} label={t('users.autoPassword')} />
            {!auto && <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
          </Field>
          <Checkbox checked={force} onChange={setForce} label={t('users.forceChange')} />
          <div className="mt-8"><Checkbox checked={f.accountEnabled} onChange={(v) => setF({ ...f, accountEnabled: v })} label={t('users.accountEnabled')} /></div>
        </>
      )}
    </Panel>
  );
}
