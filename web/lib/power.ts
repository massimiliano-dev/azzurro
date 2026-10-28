'use client';

import { arm } from './api';

/** Stato di alimentazione: in Azure sta nell'instance view delle VM e in proprietà diverse per gli altri tipi. */
export type Power = 'running' | 'starting' | 'stopping' | 'stopped' | 'deallocating' | 'deallocated' | 'updating';

const VM = 'microsoft.compute/virtualmachines';

export function powerOf(type: string | undefined, r: any): Power | null {
  const t = (type ?? r?.type ?? '').toLowerCase();
  const p = r?.properties ?? {};
  if (t === VM) {
    const code = (p.instanceView?.statuses ?? []).find((s: any) => String(s.code).startsWith('PowerState/'))?.code;
    const v = String(code ?? '').split('/')[1]?.toLowerCase();
    return (['running', 'starting', 'stopping', 'stopped', 'deallocating', 'deallocated'] as Power[]).find((x) => x === v) ?? null;
  }
  const state = String(p.state ?? p.powerState?.code ?? '').toLowerCase();
  if (!state) return null;
  if (['running', 'ready'].includes(state)) return 'running';
  if (state === 'stopped' || state === 'disabled') return 'stopped';
  if (state === 'starting') return 'starting';
  if (state === 'stopping') return 'stopping';
  if (state === 'updating') return 'updating';
  return null;
}

/** Stato atteso dopo un'azione, per mostrarlo subito mentre Azure la esegue. */
export const AFTER: Record<string, Power> = { start: 'starting', restart: 'starting', stop: 'stopping', powerOff: 'stopping', deallocate: 'deallocating' };
export const transitional = (p: Power | null) => p === 'starting' || p === 'stopping' || p === 'deallocating' || p === 'updating';

/**
 * Stato delle VM e delle app web di più sottoscrizioni con una richiesta per tipo e sottoscrizione
 * (statusOnly=true per le VM, come fa il portale Azure), invece di una per risorsa.
 */
export async function loadPowerStates(subscriptionIds: string[]): Promise<Map<string, Power>> {
  const out = new Map<string, Power>();
  await Promise.all(subscriptionIds.map(async (sub) => {
    const [vms, sites] = await Promise.all([
      arm.get<{ value: any[] }>(`/subscriptions/${sub}/providers/Microsoft.Compute/virtualMachines`, '2024-07-01', { statusOnly: 'true' }).catch(() => ({ value: [] })),
      arm.get<{ value: any[] }>(`/subscriptions/${sub}/providers/Microsoft.Web/sites`, '2023-12-01').catch(() => ({ value: [] })),
    ]);
    for (const r of [...vms.value, ...sites.value]) {
      const p = powerOf(r.type, r);
      if (p) out.set(String(r.id).toLowerCase(), p);
    }
  }));
  return out;
}
