'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, PanelBottomOpen, Trash2, X } from 'lucide-react';
import { traceClear, useTrace, type TraceEntry } from '@/lib/trace';
import { useI18n } from '@/i18n';
import { Button, CodeBlock, Notice } from './ui';

function shortPath(p: string): string {
  const [path] = p.split('?');
  const segs = path.split('/').filter(Boolean);
  if (segs.length <= 3) return path;
  return '…/' + segs.slice(-3).join('/');
}

function isErr(e: TraceEntry) {
  return e.status === undefined ? false : e.status === 0 || e.status >= 400;
}

let apiBase: string | null = null;

/** chiamate di servizio del portale (polling, sessione, configurazione) nascoste nella vista principale */
const NOISE = /^\/_portal\/(notifications|session|config|settings|search|push|catalog)/;

function curlFor(e: TraceEntry): string {
  const base = apiBase ?? 'http://localhost:4000';
  const lines = [`curl -X ${e.method} "${base}${e.path}"`, `  -H "Authorization: Bearer $TOKEN"`];
  if (e.reqBody !== undefined) {
    lines.push(`  -H "Content-Type: application/json"`);
    lines.push(`  -d '${JSON.stringify(e.reqBody).replace(/'/g, "'\\''")}'`);
  }
  return lines.join(' \\\n');
}

export function RequestStrip() {
  const { t, fmtDate } = useI18n();
  const all = useTrace();
  const [scope, setScope] = useState<'apis' | 'all'>('apis');
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const streamRef = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => (scope === 'all' ? all : all.filter((e) => !NOISE.test(e.path))), [all, scope]);
  useEffect(() => {
    if (apiBase) return;
    fetch('/api/portal/config').then((r) => r.json()).then((c) => { apiBase = c.httpsAvailable ? c.httpsUrl : c.apiUrl; }).catch(() => undefined);
  }, []);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
      if (e.key === '`' && !['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName)) setOpen((o) => !o);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  const sel = shown.find((e) => e.id === selected) ?? shown[shown.length - 1];
  const errors = shown.filter(isErr).length;
  return (
    <>
      <div className="trace" role="region" aria-label={t('trace.title')}>
        <button className="trace-label" onClick={() => setOpen(true)} title={`${t('trace.open')} ( \` )`}>
          <PanelBottomOpen size={15} aria-hidden />
          {t('trace.live')}
          <span className="num">{shown.length}{errors ? ` · ${errors} err` : ''}</span>
        </button>
        <div className="trace-stream" ref={streamRef}>
          {shown.slice(-14).map((e) => (
            <button key={e.id} className="trace-chip" style={{ ['--dur' as string]: e.ms !== undefined ? `${Math.min(220, Math.round(e.ms * 0.6))}px` : '0px' }} onClick={() => { setSelected(e.id); setOpen(true); }} title={`${e.method} ${e.path}`}>
              <span className={`m ${e.method} ${e.status === undefined ? 'pending' : ''}`}>{e.method}</span>
              <span className="p">{shortPath(e.path)}</span>
              <span className={`s ${isErr(e) ? 'err' : ''}`}>{e.status === undefined ? '···' : e.status || 'ERR'}</span>
              <span className="t">{e.ms !== undefined ? `${e.ms}ms` : ''}</span>
            </button>
          ))}
        </div>
        <div className="trace-tools">
          <div className="seg" role="group" aria-label={t('common.filter')}>
            <button className={scope === 'apis' ? 'on' : ''} onClick={() => setScope('apis')}>{t('trace.apis')}</button>
            <button className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>{t('trace.all')}</button>
          </div>
          <Button variant="ghost" size="sm" iconOnly icon={Trash2} aria-label={t('trace.clear')} title={t('trace.clear')} onClick={traceClear} />
        </div>
      </div>
      {open && typeof document !== 'undefined' && createPortal(
        <>
          <div className="overlay" onClick={() => setOpen(false)} />
          <div className="panel wide trace-panel" role="dialog" aria-modal="true" aria-label={t('trace.title')}>
            <div className="panel-head">
              <div style={{ flex: 1 }}>
                <h2>{t('trace.title')}</h2>
                <div className="sub" style={{ fontFamily: 'var(--font)' }}>{t('trace.hint')}</div>
              </div>
              <Button variant="ghost" iconOnly icon={X} aria-label={t('common.close')} onClick={() => setOpen(false)} />
            </div>
            <div className="panel-body">
              {!shown.length ? <div className="empty">{t('trace.empty')}</div> : (
                <div className="trace-drawer">
                  <div className="trace-list">
                    {[...shown].reverse().map((e) => (
                      <button key={e.id} className={`trace-row ${sel?.id === e.id ? 'on' : ''}`} onClick={() => setSelected(e.id)}>
                        <span className={`m ${e.method}`}>{e.method}</span>
                        <span className="p" title={e.path}>{shortPath(e.path)}</span>
                        <span className={`s ${isErr(e) ? 'err' : ''}`}>{e.status ?? '···'}</span>
                        <span className="d">{e.ms !== undefined ? `${e.ms}ms` : t('trace.pending')}</span>
                      </button>
                    ))}
                  </div>
                  {sel ? (
                    <div className="trace-detail stack" style={{ gap: 16 }}>
                      <div>
                        <div className="row wrap" style={{ gap: 10 }}>
                          <span className={`badge ${isErr(sel) ? 'bad' : sel.status ? 'ok' : 'info'}`}>{sel.method} · {sel.status ?? t('trace.pending')}</span>
                          <span className="small muted num">{sel.api} · {fmtDate(sel.start, 'time')}{sel.ms !== undefined ? ` · ${sel.ms} ms` : ''}</span>
                          <span style={{ flex: 1 }} />
                          <Button size="sm" icon={Copy} onClick={async () => { await navigator.clipboard.writeText(curlFor(sel)); setCopied(true); setTimeout(() => setCopied(false), 1400); }}>{copied ? t('common.copied') : t('trace.copyCurl')}</Button>
                        </div>
                        <div className="mono mt-8" style={{ overflowWrap: 'anywhere', fontSize: 13 }}>{sel.path}</div>
                      </div>
                      <section>
                        <h3 className="mb-16">{t('trace.request')}</h3>
                        {sel.reqBody !== undefined ? <CodeBlock value={sel.reqBody} maxHeight={260} /> : <p className="muted small">{t('trace.noBody')}</p>}
                      </section>
                      <section>
                        <h3 className="mb-16">{t('trace.response')}</h3>
                        {sel.error ? <Notice tone="bad">{sel.error}</Notice> : sel.resBody === undefined ? <span className="spinner" /> : sel.resBody === null || sel.resBody === '' ? <p className="muted small">{t('trace.noBody')}</p> : <CodeBlock value={sel.resBody} maxHeight={520} />}
                      </section>
                    </div>
                  ) : <div className="trace-detail muted">{t('trace.select')}</div>}
                </div>
              )}
            </div>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
