'use client';

/** POST con risposta Server-Sent Events: chiama onEvent per ogni evento ricevuto. */
export function postSSE(url: string, body: unknown, onEvent: (event: string, data: any) => void, signal?: AbortSignal): Promise<void> {
  return readSSE(url, 'POST', body, onEvent, signal);
}

/** GET in ascolto di uno stream già avviato (204 = niente in corso). */
export function getSSE(url: string, onEvent: (event: string, data: any) => void, signal?: AbortSignal): Promise<void> {
  return readSSE(url, 'GET', undefined, onEvent, signal);
}

async function readSSE(url: string, method: 'GET' | 'POST', body: unknown, onEvent: (event: string, data: any) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(url, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), 'X-Azzurro-Portal': '1', Accept: 'text/event-stream' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
    signal,
  });
  if (res.status === 204) return;
  if (!res.ok || !res.body) {
    let msg = res.statusText;
    let code = 'http_error';
    try {
      const j = await res.json();
      msg = j?.error?.message ?? j?.error_description ?? msg;
      code = j?.error?.code ?? code;
    } catch { /* corpo non JSON */ }
    throw Object.assign(new Error(msg), { status: res.status, code });
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (!data.length) continue;
      let parsed: any = data.join('\n');
      try { parsed = JSON.parse(parsed); } catch { /* testo */ }
      onEvent(event, parsed);
    }
  }
}
