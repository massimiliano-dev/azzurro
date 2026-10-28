'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Check, CircleAlert, ListChecks, Loader2, Trash2, X } from 'lucide-react';
import { portal } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { listOperations, OPS_EVENT, type Operation, type OpStep } from '@/lib/operations';
import { useI18n } from '@/i18n';
import { PageHeader, Toolbar } from '@/components/page';
import { Badge, Button, ErrorNotice, Notice, Skeleton } from '@/components/ui';
import { useToast } from '@/components/overlay';

function duration(o: Operation): string {
  const ms = (o.endedAt ? Date.parse(o.endedAt) : Date.now()) - Date.parse(o.startedAt);
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const stepIcon = (s: OpStep['status']) => s === 'run' ? <Loader2 size={15} className="spin" aria-hidden /> : s === 'ok' ? <Check size={15} aria-hidden /> : s === 'error' ? <CircleAlert size={15} aria-hidden /> : s === 'skip' ? <span className="dash" aria-hidden>–</span> : <span className="dot" aria-hidden />;

/** Sezione Operazioni: tutte le operazioni lunghe avviate dal portale, in corso e concluse. */
export default function OperationsPage() {
  const { locale, fmtDate } = useI18n();
  const L = (it: string, en: string) => (locale === 'it' ? it : en);
  const toast = useToast();
  const focus = useSearchParams().get('id');
  const ops = useAsync(() => listOperations(), []);
  const [open, setOpen] = useState<Set<string>>(new Set(focus ? [focus] : []));
  const [, tick] = useState(0);
  const running = ops.data?.running ?? 0;

  const reload = useRef(ops.reload);
  reload.current = ops.reload;
  useEffect(() => {
    const t = setInterval(() => { if (running) { void reload.current(); tick((n) => n + 1); } }, 2500);
    const now = () => void reload.current();
    window.addEventListener(OPS_EVENT, now);
    return () => { clearInterval(t); window.removeEventListener(OPS_EVENT, now); };
  }, [running]);

  const STATUS: Record<Operation['status'], { tone: 'ok' | 'warn' | 'bad' | 'info'; label: string }> = {
    Running: { tone: 'info', label: L('In corso', 'Running') },
    Succeeded: { tone: 'ok', label: L('Completata', 'Succeeded') },
    Failed: { tone: 'bad', label: L('Non riuscita', 'Failed') },
    Canceled: { tone: 'warn', label: L('Annullata', 'Canceled') },
  };
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <>
      <PageHeader title={L('Operazioni', 'Operations')} subtitle={L('Spostamenti ed eliminazioni avviati dal portale: proseguono da soli, anche chiudendo la pagina.', 'Moves and deletions started from the portal: they run on their own, even if you close the page.')} icon={ListChecks} />
      <Toolbar>
        <Button variant="ghost" icon={Trash2} disabled={!ops.data?.value.some((o) => o.status !== 'Running')} onClick={async () => { await portal.del('/operations'); await ops.reload(); }}>{L('Togli le concluse', 'Clear finished')}</Button>
      </Toolbar>
      {ops.error ? <ErrorNotice error={ops.error} onRetry={ops.reload} /> : !ops.data ? <Skeleton rows={5} /> : !ops.data.value.length ? (
        <Notice>{L('Nessuna operazione. Qui compaiono spostamenti di risorse ed eliminazioni avviate dal portale.', 'No operations yet. Resource moves and deletions started from the portal appear here.')}</Notice>
      ) : (
        <div className="ops-list">
          {ops.data.value.map((o) => (
            <article key={o.id} className={`op ${o.status.toLowerCase()} ${o.id === focus ? 'focus' : ''}`}>
              <button type="button" className="op-head" aria-expanded={open.has(o.id)} onClick={() => toggle(o.id)}>
                <span className="op-title">{o.title[locale]}</span>
                <Badge tone={STATUS[o.status].tone} pulse={o.status === 'Running'}>{o.cancelRequested && o.status === 'Running' ? L('Annullamento…', 'Canceling…') : STATUS[o.status].label}</Badge>
                <span className="small muted mono">{fmtDate(o.startedAt)} · {duration(o)}</span>
              </button>
              {open.has(o.id) && (
                <div className="op-body">
                  <ol className="move-steps">
                    {o.steps.filter((s) => s.status !== 'skip' || o.status !== 'Succeeded').map((s) => (
                      <li key={s.key} className={s.status}>{stepIcon(s.status)}<span>{s.label[locale]}</span>{s.startedAt && <span className="mono small muted">{Math.round(((s.endedAt ? Date.parse(s.endedAt) : Date.now()) - Date.parse(s.startedAt)) / 1000)}s</span>}</li>
                    ))}
                  </ol>
                  {o.error && (
                    <Notice tone="bad">
                      <strong>{o.error.message}</strong>
                      {o.error.details?.length ? <ul className="small">{o.error.details.map((d, i) => <li key={i}><span className="mono">{d.code}</span> {d.message}{d.target ? ` (${d.target.split('/').pop()})` : ''}</li>)}</ul> : null}
                    </Notice>
                  )}
                  {o.note && <Notice tone={o.status === 'Succeeded' ? 'ok' : 'warn'}>{o.note[locale]}</Notice>}
                  <div className="row" style={{ gap: 8 }}>
                    {o.href && o.status === 'Succeeded' && <Link className="btn primary" href={o.href}>{L('Apri', 'Open')}</Link>}
                    {o.target && o.status !== 'Succeeded' && <Link className="btn" href={`/resource-groups/${o.target.split('/')[2]}/${encodeURIComponent(o.target.split('/')[4])}`}>{L('Apri il gruppo di origine', 'Open the source group')}</Link>}
                    {o.status === 'Running' && !o.cancelRequested && (
                      <Button icon={X} onClick={async () => { try { await portal.post(`/operations/${o.id}/cancel`, {}); toast.ok(L('Annullamento richiesto: si ferma al termine del passo in corso.', 'Cancel requested: it stops when the current step ends.')); await ops.reload(); } catch (e) { toast.error(e); } }}>{L('Annulla', 'Cancel')}</Button>
                    )}
                  </div>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </>
  );
}
