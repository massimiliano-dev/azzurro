/**
 * Proxy in streaming per l'assistente. Le rewrites di Next accumulano la risposta e la
 * chiudono dopo 30 secondi: qui lo stream SSE (ragionamento, testo, strumenti) passa
 * così com'è, per tutto il tempo che serve al modello.
 */
import type { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const API = (process.env.AZZURRO_API_URL ?? 'http://localhost:4000').replace(/\/+$/, '');
const FORWARD = ['cookie', 'content-type', 'accept', 'accept-language', 'user-agent', 'x-azzurro-portal', 'x-forwarded-for'];

async function proxy(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await params;
  const headers = new Headers();
  for (const h of FORWARD) { const v = req.headers.get(h); if (v) headers.set(h, v); }
  const upstream = await fetch(`${API}/_portal/assistant/${path.map(encodeURIComponent).join('/')}${req.nextUrl.search}`, {
    method: req.method,
    headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer(),
    signal: req.signal,
    redirect: 'manual',
  });
  const out = new Headers();
  for (const [k, v] of upstream.headers) if (!['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(k)) out.append(k, v);
  if (out.get('content-type')?.startsWith('text/event-stream')) {
    out.set('Cache-Control', 'no-cache, no-transform');
    out.set('X-Accel-Buffering', 'no');
  }
  out.set('X-Azzurro-Proxy', 'stream');
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as DELETE };
