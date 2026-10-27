'use client';

/**
 * Cache delle letture in memoria (per scheda del browser), con deduplica delle chiamate in corso
 * e invalidazione dopo le modifiche. Le viste aperte si ricaricano da sole quando qualcosa cambia:
 * ciò che non è stato invalidato torna subito dalla cache, senza rete.
 */
type Entry = { data?: unknown; at: number; inflight?: Promise<unknown> };
const entries = new Map<string, Entry>();
let bypassUntil = 0;
export const INVALIDATE_EVENT = 'azzurro:invalidate';

/** Le letture dei prossimi istanti ignorano la cache (pulsante «Aggiorna»). */
export function bypassCache(ms = 1200): void {
  bypassUntil = Date.now() + ms;
}

export function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const e = entries.get(key);
  if (e?.inflight) return e.inflight as Promise<T>;
  if (e && e.data !== undefined && Date.now() - e.at < ttl && Date.now() > bypassUntil) return Promise.resolve(e.data as T);
  const p = load().then(
    (d) => { entries.set(key, { data: d, at: Date.now() }); return d; },
    (err) => { entries.delete(key); throw err; },
  );
  entries.set(key, { ...(e ?? { at: 0 }), inflight: p });
  return p;
}

/** Invalida le chiavi che corrispondono e avvisa le viste aperte. */
export function invalidate(match: (key: string) => boolean): void {
  let n = 0;
  for (const k of [...entries.keys()]) if (match(k)) { entries.delete(k); n++; }
  if (n && typeof window !== 'undefined') window.dispatchEvent(new Event(INVALIDATE_EVENT));
}

export function invalidateAll(): void {
  invalidate(() => true);
}
