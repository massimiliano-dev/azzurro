'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Sparkles } from 'lucide-react';
import { useI18n } from '@/i18n';
import { AssistantChat } from './assistant-chat';

/** Contesto della pagina corrente, inviato all'assistente con ogni messaggio. */
function pageContext(): Record<string, unknown> {
  const url = location.pathname + location.search;
  const sp = new URLSearchParams(location.search);
  let resourceId = sp.get('id') ?? sp.get('scope') ?? undefined;
  const rg = /^\/resource-groups\/([^/]+)\/([^/]+)/.exec(location.pathname);
  if (!resourceId && rg) resourceId = `/subscriptions/${rg[1]}/resourceGroups/${decodeURIComponent(rg[2])}`;
  const sub = /^\/subscriptions\/([0-9a-f-]{36})/i.exec(location.pathname);
  if (!resourceId && sub) resourceId = `/subscriptions/${sub[1]}`;
  const app = /^\/entra\/apps\/([0-9a-f-]{36})/i.exec(location.pathname);
  const tab = sp.get('tab') ?? undefined;
  return { url, title: document.title.replace(/ · Azzurro$/, ''), resourceId: resourceId?.split('?')[0], appObjectId: app?.[1], tab };
}

export function AssistantDock() {
  const { t } = useI18n();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') { e.preventDefault(); setOpen((o) => !o); }
      if (e.key === 'Escape' && document.querySelector('.ai-dock')?.contains(document.activeElement)) setOpen(false);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  if (pathname.startsWith('/assistant')) return null;
  return (
    <>
      {!open && (
        <button type="button" className="ai-fab" onClick={() => setOpen(true)} aria-label={t('ai.dock')} title={`${t('ai.dock')} (⌘J)`}>
          <Sparkles size={20} aria-hidden /><span>{t('ai.dockShort')}</span>
        </button>
      )}
      {open && (
        <aside className="ai-dock" aria-label={t('ai.title')}>
          <AssistantChat mode="dock" context={pageContext} onClose={() => setOpen(false)} />
        </aside>
      )}
    </>
  );
}
