'use client';

import { useEffect, useState } from 'react';

export interface Visit { url: string; title: string; at: number }
const KEY = 'azzurro:history';
const EVT = 'azzurro:history';
const MAX = 50;

function read(): Visit[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]'); } catch { return []; }
}

/** Registra una pagina visitata (le ripetizioni consecutive si fondono). */
export function recordVisit(url: string, title: string): void {
  if (url.startsWith('/login')) return;
  const list = read();
  const clean = title.replace(/ · Azzurro$/, '').trim() || url;
  if (list[0]?.url === url) list[0] = { url, title: clean, at: Date.now() };
  else list.unshift({ url, title: clean, at: Date.now() });
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX))); } catch { /* archivio non disponibile */ }
  window.dispatchEvent(new Event(EVT));
}

export function clearHistory(): void {
  try { localStorage.removeItem(KEY); } catch { /* niente */ }
  window.dispatchEvent(new Event(EVT));
}

export function useHistoryList(): Visit[] {
  const [list, setList] = useState<Visit[]>([]);
  useEffect(() => {
    setList(read());
    const h = () => setList(read());
    window.addEventListener(EVT, h);
    window.addEventListener('storage', h);
    return () => { window.removeEventListener(EVT, h); window.removeEventListener('storage', h); };
  }, []);
  return list;
}
