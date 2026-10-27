import { Logo } from '@/components/logo';

export default function Offline() {
  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, textAlign: 'center' }}>
      <div>
        <Logo size={48} />
        <h1 style={{ marginTop: 16 }}>Sei offline · You are offline</h1>
        <p className="muted" style={{ marginTop: 8 }}>Azzurro tornerà disponibile non appena la connessione sarà ripristinata.</p>
        <p className="muted">Azzurro will be available again as soon as the connection is restored.</p>
      </div>
    </main>
  );
}
