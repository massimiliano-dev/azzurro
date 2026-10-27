'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { bypassCache, INVALIDATE_EVENT } from './cache';

export interface AsyncState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (fn: T | ((prev: T | undefined) => T)) => void;
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], opts: { enabled?: boolean; interval?: number } = {}): AsyncState<T> {
  const [data, setDataState] = useState<T>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const seq = useRef(0);
  const enabled = opts.enabled ?? true;

  const run = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true);
    try {
      const d = await fnRef.current();
      if (my === seq.current) {
        setDataState(d);
        setError(undefined);
      }
    } catch (e) {
      if (my === seq.current) setError(e as Error);
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, []);

  /** ricarica esplicita (es. pulsante «Aggiorna» o dopo una modifica): ignora la cache */
  const reload = useCallback(async () => {
    bypassCache();
    await run();
  }, [run]);

  useEffect(() => {
    if (!enabled) return;
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled]);

  // qualcosa è cambiato altrove: si rilegge, ciò che non è stato invalidato arriva dalla cache
  useEffect(() => {
    if (!enabled) return;
    const h = () => { void run(); };
    window.addEventListener(INVALIDATE_EVENT, h);
    return () => window.removeEventListener(INVALIDATE_EVENT, h);
  }, [enabled, run]);

  useEffect(() => {
    if (!opts.interval || !enabled) return;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void run();
    }, opts.interval);
    return () => clearInterval(id);
  }, [opts.interval, enabled, run]);

  const setData = useCallback((v: T | ((prev: T | undefined) => T)) => {
    setDataState((prev) => (typeof v === 'function' ? (v as (p: T | undefined) => T)(prev) : v));
  }, []);

  return { data, error, loading, reload, setData };
}

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}
