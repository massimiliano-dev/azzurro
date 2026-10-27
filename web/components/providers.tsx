'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { LocaleProvider, type Locale } from '@/i18n';
import { ConfirmProvider, ToastProvider } from './overlay';
import { PwaProvider } from './pwa';

export type Theme = 'system' | 'light' | 'dark';

const ThemeCtx = createContext<{ theme: Theme; setTheme: (t: Theme) => void }>({ theme: 'system', setTheme: () => undefined });

function applyTheme(theme: Theme) {
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]:not([media])')?.setAttribute('content', dark ? '#0d2a78' : '#0b3fbf');
}

function ThemeProvider({ initial, children }: { initial: Theme; children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(initial);
  useEffect(() => {
    applyTheme(theme);
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const h = () => applyTheme('system');
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, [theme]);
  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    document.cookie = `azzurro_theme=${t}; path=/; max-age=31536000; samesite=lax`;
  }, []);
  return <ThemeCtx.Provider value={{ theme, setTheme }}>{children}</ThemeCtx.Provider>;
}

export function useTheme() {
  return useContext(ThemeCtx);
}

export function Providers({ locale, theme, children }: { locale: Locale; theme: Theme; children: ReactNode }) {
  return (
    <LocaleProvider initial={locale}>
      <ThemeProvider initial={theme}>
        <PwaProvider>
          <ToastProvider>
            <ConfirmProvider>{children}</ConfirmProvider>
          </ToastProvider>
        </PwaProvider>
      </ThemeProvider>
    </LocaleProvider>
  );
}
