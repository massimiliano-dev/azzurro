'use client';

import { useEffect } from 'react';
import { Logo } from '@/components/logo';
import { reachable } from '@/components/pwa';

/** Mostrata dal service worker quando una pagina non si carica: appena Azzurro risponde si riprova da sola. */
export default function Offline() {
  useEffect(() => {
    const t = setInterval(async () => { if (await reachable()) { if (location.pathname === '/offline') location.href = '/'; else location.reload(); } }, 5000);
    return () => clearInterval(t);
  }, []);
  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, textAlign: 'center' }}>
      <div>
        <Logo size={48} />
        <h1 style={{ marginTop: 16 }}>Sei offline · You are offline</h1>
        <p className="muted" style={{ marginTop: 8 }}>Azzurro tornerà disponibile non appena la connessione sarà ripristinata: la pagina si ricarica da sola.</p>
        <p className="muted">Azzurro will be available again as soon as the connection is restored: the page reloads by itself.</p>
      </div>
    </main>
  );
}
