'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ChevronRight, Plus, Trash2, type LucideIcon } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useT } from '@/i18n';
import { Button, Input, Textarea } from './ui';

export function PageHeader({ title, subtitle, icon: Icon, crumbs, actions }: { title: ReactNode; subtitle?: ReactNode; icon?: LucideIcon; crumbs?: { label: ReactNode; href?: string }[]; actions?: ReactNode }) {
  useEffect(() => {
    if (typeof title === 'string') document.title = `${title} · Azzurro`;
  }, [title]);
  return (
    <>
      {crumbs?.length ? (
        <nav className="crumbs" aria-label="breadcrumb">
          {crumbs.map((c, i) => (
            <span key={i} className="row" style={{ gap: 6 }}>
              {c.href ? <Link href={c.href}>{c.label}</Link> : <span>{c.label}</span>}
              {i < crumbs.length - 1 && <ChevronRight size={12} aria-hidden />}
            </span>
          ))}
        </nav>
      ) : null}
      <header className="page-head">
        {Icon && <div className="icon"><Icon size={20} aria-hidden /></div>}
        <div className="titles">
          <h1>{title}</h1>
          {subtitle && <div className="sub">{subtitle}</div>}
        </div>
        {actions && <div className="row wrap">{actions}</div>}
      </header>
    </>
  );
}

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="toolbar" role="toolbar">{children}</div>;
}

/** Tab sincronizzate con il parametro ?tab= dell'URL. */
export function useTab(defaultTab: string): [string, (t: string) => void] {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const tab = sp.get('tab') ?? defaultTab;
  const set = (t: string) => {
    const q = new URLSearchParams(sp.toString());
    if (t === defaultTab) q.delete('tab');
    else q.set('tab', t);
    router.replace(`${pathname}${q.toString() ? `?${q}` : ''}`, { scroll: false });
  };
  return [tab, set];
}

export function Tabs({ tabs, value, onChange }: { tabs: { key: string; label: ReactNode }[]; value: string; onChange: (k: string) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.key} role="tab" aria-selected={value === t.key} className={value === t.key ? 'on' : ''} onClick={() => onChange(t.key)}>{t.label}</button>
      ))}
    </div>
  );
}

export function TagEditor({ value, onChange }: { value: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const t = useT();
  const [rows, setRows] = useState<[string, string][]>(() => (Object.entries(value).length ? Object.entries(value) : [['', '']]));
  const emit = (r: [string, string][]) => {
    setRows(r);
    onChange(Object.fromEntries(r.filter(([k]) => k.trim())));
  };
  return (
    <div className="stack" style={{ gap: 8 }}>
      {rows.map(([k, v], i) => (
        <div className="input-group" key={i}>
          <Input placeholder={t('common.key')} value={k} aria-label={t('common.key')} onChange={(e) => emit(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))} />
          <span className="muted">:</span>
          <Input placeholder={t('common.value')} value={v} aria-label={t('common.value')} onChange={(e) => emit(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))} />
          <Button variant="ghost" size="sm" iconOnly icon={Trash2} aria-label={t('common.remove')} onClick={() => emit(rows.length > 1 ? rows.filter((_, j) => j !== i) : [['', '']])} />
        </div>
      ))}
      <div><Button size="sm" icon={Plus} onClick={() => setRows([...rows, ['', '']])}>{t('common.add')}</Button></div>
    </div>
  );
}

export function JsonEditor({ value, onChange, rows = 14, onValid }: { value: string; onChange: (v: string) => void; rows?: number; onValid?: (ok: boolean) => void }) {
  const t = useT();
  let error: string | null = null;
  if (value.trim()) {
    try {
      JSON.parse(value);
    } catch (e) {
      error = (e as Error).message;
    }
  }
  useEffect(() => onValid?.(!error), [error, onValid]);
  return (
    <div className="stack" style={{ gap: 6 }}>
      <Textarea code rows={rows} value={value} invalid={!!error} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => {
        if (e.key === 'Tab') {
          e.preventDefault();
          const el = e.currentTarget;
          const s = el.selectionStart;
          const v = el.value.slice(0, s) + '  ' + el.value.slice(el.selectionEnd);
          onChange(v);
          requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
        }
      }} />
      <div className="spread small">
        <span className={error ? '' : 'muted'} style={error ? { color: 'var(--danger)' } : undefined}>{error ? `${t('res.invalidJson')}: ${error}` : 'JSON'}</span>
        <button type="button" className="link-btn small" disabled={!!error} onClick={() => { try { onChange(JSON.stringify(JSON.parse(value || '{}'), null, 2)); } catch { /* */ } }}>Format</button>
      </div>
    </div>
  );
}
