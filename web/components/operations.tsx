'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Loader2, ListChecks } from 'lucide-react';
import { invalidateAll } from '@/lib/cache';
import { listOperations, OPS_EVENT, type Operation } from '@/lib/operations';
import { useI18n } from '@/i18n';
import { useToast } from './overlay';

/**
 * Contatore delle operazioni in corso nella barra in alto. Interroga spesso solo mentre qualcosa
 * è in corso; quando un'operazione finisce mostra l'esito e aggiorna i dati in cache.
 */
export function OperationsIndicator() {
  const { locale } = useI18n();
  const toast = useToast();
  const [running, setRunning] = useState<Operation[]>([]);
  const known = useRef<Map<string, Operation['status']>>(new Map());
  const first = useRef(true);
  // letti da ref: l'effetto parte una volta sola e non si riavvia a ogni render
  const toastRef = useRef(toast);
  const localeRef = useRef(locale);
  toastRef.current = toast;
  localeRef.current = locale;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let alive = true;
    const tick = async () => {
      try {
        const { value } = await listOperations();
        if (!alive) return;
        const run = value.filter((o) => o.status === 'Running');
        setRunning(run);
        for (const o of value) {
          const before = known.current.get(o.id);
          if (!first.current && before === 'Running' && o.status !== 'Running') {
            invalidateAll();
            const loc = localeRef.current;
            const title = o.title[loc];
            if (o.status === 'Succeeded') toastRef.current.ok(loc === 'it' ? 'Operazione completata' : 'Operation completed', title);
            else if (o.status === 'Failed') toastRef.current.error(new Error(`${title}: ${o.error?.message ?? ''}`));
          }
          known.current.set(o.id, o.status);
        }
        first.current = false;
        timer = setTimeout(tick, run.length ? 3000 : 30_000);
      } catch {
        timer = setTimeout(tick, 30_000);
      }
    };
    const now = () => { clearTimeout(timer); void tick(); };
    void tick();
    window.addEventListener(OPS_EVENT, now);
    return () => { alive = false; clearTimeout(timer); window.removeEventListener(OPS_EVENT, now); };
  }, []);

  const label = locale === 'it' ? `Operazioni in corso: ${running.length}` : `Operations running: ${running.length}`;
  return (
    <Link href="/operations" className={`btn ghost ops-ind ${running.length ? 'busy' : ''}`} title={running.length ? `${label}\n${running.map((o) => o.title[locale]).join('\n')}` : locale === 'it' ? 'Operazioni' : 'Operations'} aria-label={running.length ? label : locale === 'it' ? 'Operazioni' : 'Operations'}>
      {running.length ? <Loader2 size={17} className="spin" aria-hidden /> : <ListChecks size={17} aria-hidden />}
      {running.length > 0 && <span className="ops-count">{running.length}</span>}
    </Link>
  );
}
