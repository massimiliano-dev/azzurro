'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { portal } from './api';

export interface Session {
  user: { id: string; displayName: string; userPrincipalName: string; mail?: string | null; jobTitle?: string | null; givenName?: string | null; surname?: string | null; preferredLanguage?: string | null; lastPasswordChangeDateTime?: string };
  tenant: { id: string; displayName: string; defaultDomain: string; domains: string[] };
  directoryRoles: { id: string; displayName: string }[];
  isGlobalAdmin: boolean;
  signIn?: { provider: 'microsoft' | 'local'; appRoles: string[]; tenantId?: string; at?: string };
  settings: { locale?: 'it' | 'en'; theme?: 'system' | 'light' | 'dark'; push?: Record<string, boolean>; notifyOwnActions?: boolean };
}

interface SessionCtx {
  session: Session | null;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<SessionCtx | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const refresh = useCallback(async () => {
    setSession(await portal.get<Session>('/session'));
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const signOut = useCallback(async () => {
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) await portal.post('/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => undefined);
    } catch {
      /* ignora */
    }
    await portal.post('/logout', {}, { noRedirect: true }).catch(() => undefined);
    location.href = '/login';
  }, []);
  return <Ctx.Provider value={{ session, refresh, signOut }}>{children}</Ctx.Provider>;
}

export function useSession(): SessionCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('SessionProvider mancante');
  return c;
}
