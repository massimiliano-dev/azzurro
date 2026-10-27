'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import it, { type MessageKey } from './it';
import en from './en';

export type Locale = 'it' | 'en';
const DICTS = { it, en };

type T = (key: MessageKey, params?: Record<string, string | number | null | undefined>) => string;

interface LocaleCtx {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: T;
  fmtDate: (v: string | number | Date | null | undefined, style?: 'short' | 'medium' | 'long' | 'time') => string;
  fmtRelative: (v: string | number | Date | null | undefined) => string;
  fmtNumber: (n: number) => string;
}

const Ctx = createContext<LocaleCtx | null>(null);

export function translate(locale: Locale, key: MessageKey, params?: Record<string, string | number | null | undefined>): string {
  const s = DICTS[locale][key] ?? it[key] ?? key;
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (_, p) => (params[p] === undefined || params[p] === null ? '' : String(params[p])));
}

export function LocaleProvider({ initial, children }: { initial: Locale; children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initial);
  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    document.cookie = `azzurro_locale=${l}; path=/; max-age=31536000; samesite=lax`;
    document.documentElement.lang = l;
  }, []);
  const value = useMemo<LocaleCtx>(() => {
    const tag = locale === 'it' ? 'it-IT' : 'en-GB';
    const toDate = (v: string | number | Date) => (v instanceof Date ? v : new Date(v));
    return {
      locale,
      setLocale,
      t: (key, params) => translate(locale, key, params),
      fmtDate: (v, style = 'medium') => {
        if (v === null || v === undefined || v === '') return '—';
        const d = toDate(v);
        if (Number.isNaN(d.getTime())) return String(v);
        if (style === 'time') return new Intl.DateTimeFormat(tag, { timeStyle: 'medium' }).format(d);
        return new Intl.DateTimeFormat(tag, style === 'short' ? { dateStyle: 'short' } : style === 'long' ? { dateStyle: 'long', timeStyle: 'medium' } : { dateStyle: 'medium', timeStyle: 'short' }).format(d);
      },
      fmtRelative: (v) => {
        if (!v) return '—';
        const diff = (toDate(v).getTime() - Date.now()) / 1000;
        const rtf = new Intl.RelativeTimeFormat(tag, { numeric: 'auto' });
        const abs = Math.abs(diff);
        if (abs < 60) return rtf.format(Math.round(diff), 'second');
        if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
        if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
        if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
        return new Intl.DateTimeFormat(tag, { dateStyle: 'medium' }).format(toDate(v));
      },
      fmtNumber: (n) => new Intl.NumberFormat(tag).format(n),
    };
  }, [locale, setLocale]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): LocaleCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('LocaleProvider mancante');
  return c;
}

export function useT(): T {
  return useI18n().t;
}

export type { MessageKey };
