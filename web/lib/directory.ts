'use client';

import { useEffect, useState } from 'react';
import { portal } from './api';

export interface DirectoryEntry { tenantId: string; name: string; domain?: string; kind: 'local' | 'azure' }
export interface DirectoryState { active: string; status: { arm: boolean; graph: boolean; graphScopes: string } | null; microsoft: boolean; value: DirectoryEntry[] }

let promise: Promise<DirectoryState> | null = null;
export function loadDirectories(force = false): Promise<DirectoryState> {
  if (force) promise = null;
  promise ??= portal.get<DirectoryState>('/directories').catch((e) => { promise = null; throw e; });
  return promise;
}

export function useDirectory() {
  const [state, setState] = useState<DirectoryState | null>(null);
  useEffect(() => {
    let alive = true;
    loadDirectories().then((s) => alive && setState(s)).catch(() => undefined);
    return () => { alive = false; };
  }, []);
  const active = state?.value.find((d) => d.tenantId === state.active);
  return { state, active, real: !!state && state.active !== 'local' };
}

/** Cambia directory; se serve il consenso Microsoft, porta l'utente alla pagina di consenso. */
export async function switchDirectory(tenantId: string): Promise<void> {
  const r = await portal.post<any>('/directories/switch', { tenantId });
  if (r.status === 'app_not_multitenant') throw Object.assign(new Error('app_not_multitenant'), { code: 'app_not_multitenant' });
  if (r.status === 'consent_required' && r.redirect) {
    location.href = r.redirect;
    return;
  }
  promise = null;
  location.href = '/';
}
