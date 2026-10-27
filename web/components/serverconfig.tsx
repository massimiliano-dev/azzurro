'use client';

import { useEffect, useState } from 'react';
import { RotateCcw, Save, ServerCog } from 'lucide-react';
import { portal } from '@/lib/api';
import { invalidateAll } from '@/lib/cache';
import { useAsync } from '@/lib/hooks';
import { useI18n, type MessageKey } from '@/i18n';
import { Badge, Button, Card, Field, Input, Select, Skeleton, Switch } from './ui';
import { useToast } from './overlay';

interface CfgField { key: string; group: 'ai' | 'microsoft' | 'access'; kind: 'text' | 'secret' | 'url' | 'select' | 'bool'; options?: string[]; def?: string; set: boolean; value?: string; hint?: string; source: 'portal' | 'env' | 'default' }
interface CfgView { file: string; fields: CfgField[]; microsoft: { enabled: boolean; redirectUri: string; localLogin: boolean } }

const GROUPS: { id: CfgField['group']; title: MessageKey; body: MessageKey }[] = [
  { id: 'ai', title: 'cfg.ai', body: 'cfg.aiBody' },
  { id: 'microsoft', title: 'cfg.microsoft', body: 'cfg.microsoftBody' },
  { id: 'access', title: 'cfg.access', body: 'cfg.accessBody' },
];

/** Impostazioni del server (chiavi AI, app Microsoft, accesso): solo amministratori globali. */
export function ServerConfig() {
  const { t } = useI18n();
  const toast = useToast();
  const cfg = useAsync(() => portal.get<CfgView>('/admin/config'), []);
  const [draft, setDraft] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { setDraft({}); }, [cfg.data]);
  if (cfg.error) return null;
  const dirty = Object.keys(draft).length > 0;
  const edit = (k: string, v: string | null) => setDraft((d) => ({ ...d, [k]: v }));
  const save = async () => {
    setBusy(true);
    try {
      await portal.put('/admin/config', { values: draft });
      invalidateAll();
      cfg.reload();
      toast.ok(t('cfg.saved'));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const control = (f: CfgField) => {
    const v = f.key in draft ? draft[f.key] : null;
    const id = `cfg-${f.key}`;
    if (f.kind === 'bool') {
      const cur = v ?? f.value ?? '';
      return <Switch checked={cur ? cur === 'on' : cfg.data!.microsoft.localLogin} onChange={(on) => edit(f.key, on ? 'on' : 'off')} label={t(`cfg.${f.key}` as MessageKey)} />;
    }
    if (f.kind === 'select') {
      return (
        <Select id={id} value={v ?? f.value ?? ''} onChange={(e) => edit(f.key, e.target.value)}>
          {f.options!.map((o) => <option key={o} value={o}>{o ? t(`cfg.opt.${o}` as MessageKey) : t('cfg.auto')}</option>)}
        </Select>
      );
    }
    if (f.kind === 'secret') {
      return (
        <Input id={id} type="password" autoComplete="off" spellCheck={false} className="mono"
          placeholder={f.set ? t('cfg.secretSet', { hint: f.hint ?? '' }) : t('cfg.secretEmpty')}
          value={v ?? ''} onChange={(e) => (e.target.value ? edit(f.key, e.target.value) : setDraft(({ [f.key]: _, ...rest }) => rest))} />
      );
    }
    return <Input id={id} className="mono" spellCheck={false} placeholder={f.def} value={v ?? f.value ?? ''} onChange={(e) => edit(f.key, e.target.value)} />;
  };
  return (
    <Card title={<span className="row" style={{ gap: 8 }}><ServerCog size={18} aria-hidden />{t('cfg.title')}</span>}
      actions={<Button variant="primary" icon={Save} loading={busy} disabled={!dirty} onClick={save}>{t('common.save')}</Button>}>
      {!cfg.data ? <Skeleton rows={6} /> : (
        <div className="stack" style={{ gap: 22 }}>
          <p className="muted" style={{ margin: 0 }}>{t('cfg.body')} <span className="mono small">{cfg.data.file}</span></p>
          {GROUPS.map((g) => (
            <section key={g.id} className="cfg-group">
              <h3 className="cfg-title">{t(g.title)}</h3>
              <p className="muted small" style={{ marginTop: 0 }}>{t(g.body)}</p>
              {g.id === 'microsoft' && (
                <p className="small" style={{ marginTop: 0 }}>
                  <Badge tone={cfg.data!.microsoft.enabled ? 'ok' : 'warn'}>{t(cfg.data!.microsoft.enabled ? 'cfg.msOn' : 'cfg.msOff')}</Badge>{' '}
                  {t('cfg.redirect')} <span className="mono">{cfg.data!.microsoft.redirectUri}</span>
                </p>
              )}
              <div className="cfg-fields">
                {cfg.data!.fields.filter((f) => f.group === g.id).map((f) => (
                  <Field key={f.key} htmlFor={`cfg-${f.key}`}
                    label={f.kind === 'bool' ? undefined : <span className="cfg-label">{t(`cfg.${f.key}` as MessageKey)}<span className="mono small muted">{f.key}</span></span>}
                    hint={
                      <span className="row" style={{ gap: 8 }}>
                        <span>{t(`cfg.src.${f.source}`)}{f.key in draft ? ` · ${t('cfg.changed')}` : ''}</span>
                        {f.source === 'portal' && !(f.key in draft) && <button type="button" className="link-btn" onClick={() => edit(f.key, null)}><RotateCcw size={12} aria-hidden /> {t('cfg.reset')}</button>}
                        {f.key in draft && <button type="button" className="link-btn" onClick={() => setDraft(({ [f.key]: _, ...rest }) => rest)}>{t('common.cancel')}</button>}
                      </span>
                    }>
                    {control(f)}
                  </Field>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </Card>
  );
}
