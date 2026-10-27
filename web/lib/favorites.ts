'use client';

import { useEffect, useState } from 'react';

export interface Fav { id: string; name: string; type: string }
const KEY = 'azzurro:favorites';
const EVT = 'azzurro:favorites';

function read(): Fav[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]'); } catch { return []; }
}

/** Risorse preferite, salvate in questo browser. */
export function useFavorites() {
  const [favs, setFavs] = useState<Fav[]>([]);
  useEffect(() => {
    setFavs(read());
    const h = () => setFavs(read());
    window.addEventListener(EVT, h);
    window.addEventListener('storage', h);
    return () => { window.removeEventListener(EVT, h); window.removeEventListener('storage', h); };
  }, []);
  const toggle = (f: Fav) => {
    const cur = read();
    const next = cur.some((x) => x.id.toLowerCase() === f.id.toLowerCase()) ? cur.filter((x) => x.id.toLowerCase() !== f.id.toLowerCase()) : [...cur, f];
    try { localStorage.setItem(KEY, JSON.stringify(next.slice(-24))); } catch { /* archivio non disponibile */ }
    window.dispatchEvent(new Event(EVT));
  };
  const has = (id: string) => favs.some((x) => x.id.toLowerCase() === id.toLowerCase());
  return { favs, toggle, has };
}
