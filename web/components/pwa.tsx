'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

interface PwaCtx {
  canInstall: boolean;
  install: () => Promise<void>;
  online: boolean;
  standalone: boolean;
}

const Ctx = createContext<PwaCtx>({ canInstall: false, install: async () => undefined, online: true, standalone: false });

/** Azzurro risponde? (endpoint pubblico, senza cache) */
export async function reachable(): Promise<boolean> {
  try {
    const r = await fetch('/api/portal/config', { cache: 'no-store' });
    return r.status < 500;
  } catch {
    return false;
  }
}

export function PwaProvider({ children }: { children: ReactNode }) {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [online, setOnline] = useState(true);
  const [standalone, setStandalone] = useState(false);

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((e) => console.warn('[pwa] registrazione service worker non riuscita', e));
    }
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setDeferred(null);
    // navigator.onLine dice solo se il Mac ha una rete e sbaglia spesso (VPN, adattatori virtuali):
    // «offline» solo se Azzurro davvero non risponde, e si ricontrolla finché non torna
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      clearTimeout(timer);
      const ok = await reachable();
      setOnline(ok);
      if (!ok) timer = setTimeout(check, 10_000);
    };
    const onOnline = () => void check();
    const onOffline = () => void check();
    if (!navigator.onLine) void check();
    setStandalone(window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      clearTimeout(timer);
    };
  }, []);

  const install = useCallback(async () => {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice;
    setDeferred(null);
  }, [deferred]);

  return <Ctx.Provider value={{ canInstall: !!deferred && !standalone, install, online, standalone }}>{children}</Ctx.Provider>;
}

export function usePwa() {
  return useContext(Ctx);
}
