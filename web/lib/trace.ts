'use client';

import { useSyncExternalStore } from 'react';

export type TraceApi = 'ARM' | 'Graph' | 'Portal';

export interface TraceEntry {
  id: number;
  method: string;
  api: TraceApi;
  /** percorso come lo vede l'API emulata (es. /subscriptions/…?api-version=…) */
  path: string;
  start: number;
  ms?: number;
  status?: number;
  reqBody?: unknown;
  resBody?: unknown;
  error?: string;
}

const MAX = 200;
let entries: TraceEntry[] = [];
let seq = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function toApiPath(url: string): { api: TraceApi; path: string } {
  if (url.startsWith('/api/arm')) return { api: 'ARM', path: url.slice('/api/arm'.length) };
  if (url.startsWith('/api/graph')) return { api: 'Graph', path: '/v1.0' + url.slice('/api/graph'.length) };
  if (url.startsWith('/api/portal')) return { api: 'Portal', path: '/_portal' + url.slice('/api/portal'.length) };
  return { api: 'Portal', path: url };
}

export function traceBegin(method: string, url: string, body?: unknown): number {
  const id = ++seq;
  const { api, path } = toApiPath(url);
  entries = [...entries.slice(-(MAX - 1)), { id, method, api, path: decodeURIComponent(path), start: Date.now(), reqBody: body }];
  emit();
  return id;
}

export function traceEnd(id: number, status: number, resBody: unknown, error?: string) {
  entries = entries.map((e) => (e.id === id ? { ...e, status, resBody, error, ms: Date.now() - e.start } : e));
  emit();
}

export function traceClear() {
  entries = [];
  emit();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

const EMPTY: TraceEntry[] = [];

export function useTrace(): TraceEntry[] {
  return useSyncExternalStore(subscribe, () => entries, () => EMPTY);
}
