'use client';

import { portal } from './api';

export type Lang = { it: string; en: string };
export interface OpStep { key: string; label: Lang; status: 'todo' | 'run' | 'ok' | 'error' | 'skip'; startedAt?: string; endedAt?: string; detail?: string }
export interface Operation {
  id: string; kind: string; title: Lang; target?: string; href?: string;
  status: 'Running' | 'Succeeded' | 'Failed' | 'Canceled';
  startedAt: string; endedAt?: string; steps: OpStep[];
  error?: { code: string; message: string; details?: { code?: string; message?: string; target?: string }[] };
  note?: Lang; cancelRequested?: boolean;
}

/** Evento: un'operazione è partita, la sezione e il contatore si aggiornano subito. */
export const OPS_EVENT = 'azzurro:operations';

/** Avvia un'operazione in background sul server (prosegue anche chiudendo la pagina). */
export async function startOperation(body: Record<string, unknown>): Promise<Operation> {
  const op = await portal.post<Operation>('/operations', body);
  window.dispatchEvent(new CustomEvent(OPS_EVENT));
  return op;
}

export const listOperations = () => portal.get<{ value: Operation[]; running: number }>('/operations');
