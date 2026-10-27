'use client';

import { useState, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { AlertTriangle, Check, CheckCircle2, Copy, Info, XCircle, type LucideIcon } from 'lucide-react';
import { useT } from '@/i18n';

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'danger' | 'ghost' | 'default' | 'danger-solid'; size?: 'sm' | 'md'; icon?: LucideIcon; loading?: boolean; iconOnly?: boolean };

export function Button({ variant = 'default', size = 'md', icon: Icon, loading, iconOnly, className = '', children, disabled, ...rest }: BtnProps) {
  const v = variant === 'danger-solid' ? 'danger solid' : variant === 'default' ? '' : variant;
  return (
    <button className={`btn ${v} ${size === 'sm' ? 'sm' : ''} ${iconOnly ? 'icon' : ''} ${className}`} disabled={disabled || loading} {...rest}>
      {loading ? <span className="spinner" aria-hidden /> : Icon ? <Icon size={size === 'sm' ? 14 : 16} aria-hidden /> : null}
      {children}
    </button>
  );
}

export function Field({ label, hint, error, required, children, htmlFor }: { label?: ReactNode; hint?: ReactNode; error?: ReactNode; required?: boolean; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="field">
      {label && <label htmlFor={htmlFor} className={required ? 'req' : ''}>{label}</label>}
      {children}
      {error ? <div className="err" role="alert">{error}</div> : hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

export function Input({ invalid, className = '', ...rest }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return <input className={`input ${invalid ? 'invalid' : ''} ${className}`} aria-invalid={invalid || undefined} {...rest} />;
}

export function Select({ className = '', children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`select ${className}`} {...rest}>{children}</select>;
}

export function Textarea({ code, invalid, className = '', ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { code?: boolean; invalid?: boolean }) {
  return <textarea className={`textarea ${code ? 'code' : ''} ${invalid ? 'invalid' : ''} ${className}`} spellCheck={code ? false : undefined} {...rest} />;
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" aria-hidden />
      {label && <span>{label}</span>}
    </label>
  );
}

export function Checkbox({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function Badge({ tone, children, pulse }: { tone?: 'ok' | 'warn' | 'bad' | 'info'; children: ReactNode; pulse?: boolean }) {
  return <span className={`badge ${tone ?? ''}`}>{pulse && <span className="pulse" aria-hidden />}{children}</span>;
}

export function Spinner({ label }: { label?: string }) {
  return <span className="row muted"><span className="spinner" aria-hidden />{label}</span>;
}

export function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="stack" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => <div key={i} className="skeleton" style={{ width: `${90 - (i % 3) * 18}%` }} />)}
    </div>
  );
}

export function Notice({ tone = 'info', children, title }: { tone?: 'info' | 'warn' | 'bad' | 'ok'; children?: ReactNode; title?: ReactNode }) {
  const Icon = tone === 'warn' ? AlertTriangle : tone === 'bad' ? XCircle : tone === 'ok' ? CheckCircle2 : Info;
  return (
    <div className={`notice ${tone === 'info' ? '' : tone}`} role={tone === 'bad' ? 'alert' : 'status'}>
      <Icon size={16} aria-hidden />
      <div>{title && <div style={{ fontWeight: 600 }}>{title}</div>}{children}</div>
    </div>
  );
}

export function ErrorNotice({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const t = useT();
  const e = error as { status?: number; code?: string; message?: string; details?: { message: string }[] };
  const msg = e?.status === 403 ? t('err.forbidden') : e?.status === 0 ? t('err.network') : e?.message ?? t('common.error');
  return (
    <Notice tone="bad" title={e?.code && e.status !== 403 ? e.code : undefined}>
      <div>{msg}</div>
      {e?.details?.length ? <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{e.details.slice(0, 5).map((d, i) => <li key={i}>{d.message}</li>)}</ul> : null}
      {onRetry && <button className="link-btn mt-8" onClick={onRetry}>{t('common.retry')}</button>}
    </Notice>
  );
}

export function Empty({ icon: Icon, title, text, action }: { icon?: LucideIcon; title: ReactNode; text?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {Icon && <Icon size={36} strokeWidth={1.5} aria-hidden />}
      <h3>{title}</h3>
      {text && <p>{text}</p>}
      {action}
    </div>
  );
}

export function CopyButton({ value, label }: { value: string; label?: string }) {
  const t = useT();
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn ghost sm icon"
      title={done ? t('common.copied') : label ?? t('common.copy')}
      aria-label={label ?? t('common.copy')}
      onClick={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await navigator.clipboard.writeText(value);
        setDone(true);
        setTimeout(() => setDone(false), 1400);
      }}
    >
      {done ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

export function IdText({ value, short }: { value: string | null | undefined; short?: boolean }) {
  if (!value) return <span className="muted">—</span>;
  return (
    <span className="idline">
      <span className="mono" title={value}>{short && value.length > 24 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value}</span>
      <CopyButton value={value} />
    </span>
  );
}

export function KV({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <div className="kv">
      {items.map(([k, v], i) => (
        <div className="row" key={i}>
          <div className="k">{k}</div>
          <div className="v">{v === null || v === undefined || v === '' ? <span className="muted">—</span> : v}</div>
        </div>
      ))}
    </div>
  );
}

export function Card({ title, actions, children, padded = true }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; padded?: boolean }) {
  return (
    <section className="card">
      {(title || actions) && <div className="card-head"><h2>{title}</h2>{actions}</div>}
      {padded ? <div className="card-body">{children}</div> : children}
    </section>
  );
}

export function Avatar({ name, size }: { name?: string | null; size?: 'sm' | 'lg' }) {
  const initials = (name ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('') || '?';
  return <span className={`avatar ${size ?? ''}`} aria-hidden>{initials}</span>;
}

export function Tags({ tags }: { tags?: Record<string, string> | null }) {
  const entries = Object.entries(tags ?? {});
  if (!entries.length) return <span className="muted">—</span>;
  return <span>{entries.map(([k, v]) => <span className="tag" key={k}><b>{k}:</b>{v}</span>)}</span>;
}

export function CodeBlock({ value, maxHeight }: { value: unknown; maxHeight?: number }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return (
    <div className="codeblock">
      <pre className="code" style={maxHeight ? { maxHeight } : undefined}>{text}</pre>
      <CopyButton value={text} />
    </div>
  );
}

export function SecretValue({ value }: { value: string }) {
  const [shown, setShown] = useState(false);
  const t = useT();
  return (
    <span className="secret">
      <span>{shown ? value : '•'.repeat(Math.min(value.length, 32))}</span>
      <button type="button" className="link-btn small" onClick={() => setShown((s) => !s)}>{shown ? t('res.hide') : t('res.show')}</button>
      <CopyButton value={value} />
    </span>
  );
}
