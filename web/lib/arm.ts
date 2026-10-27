'use client';

import { portal } from './api';

export interface CatalogType {
  type: string;
  label: { it: string; en: string };
  category: string;
  apiVersion: string;
  apiVersions?: string[];
  global?: boolean;
  icon?: string | null;
  fields?: { key: string; label: { it: string; en: string }; kind: 'text' | 'password' | 'number' | 'select' | 'bool'; options?: string[]; default?: unknown; required?: boolean }[];
  nameRule?: { pattern: string; message: string } | null;
  actions: string[];
  preset?: string;
  description?: { it: string; en: string } | null;
  presetBody?: any;
}

let catalogPromise: Promise<{ value: CatalogType[]; all: CatalogType[] }> | null = null;

export function loadCatalog() {
  catalogPromise ??= portal.get('/catalog').catch((e) => {
    catalogPromise = null;
    throw e;
  });
  return catalogPromise;
}

export async function apiVersionFor(type: string): Promise<string> {
  const c = await loadCatalog();
  const t = c.all.find((x) => x.type.toLowerCase() === type.toLowerCase());
  if (t) return t.apiVersion;
  const lower = type.toLowerCase();
  if (lower === 'microsoft.resources/resourcegroups') return '2021-04-01';
  if (lower.startsWith('microsoft.authorization/')) return '2022-04-01';
  try {
    const sub = /\/subscriptions\/([^/]+)/i.exec(location.pathname + location.search)?.[1] ?? '';
    return (await portal.get<{ apiVersion: string }>(`/apiversion?type=${encodeURIComponent(type)}&sub=${sub}`)).apiVersion;
  } catch {
    return '2021-04-01';
  }
}

export interface IdInfo {
  subscriptionId?: string;
  resourceGroup?: string;
  type?: string;
  name?: string;
  names: string[];
  parentId?: string;
}

export function parseId(id: string): IdInfo {
  const segs = id.split('/').filter(Boolean);
  const out: IdInfo = { names: [] };
  let i = 0;
  if (segs[0]?.toLowerCase() === 'subscriptions') {
    out.subscriptionId = segs[1];
    i = 2;
    if (segs[2]?.toLowerCase() === 'resourcegroups') {
      out.resourceGroup = segs[3];
      i = 4;
    }
  }
  let lastProviders = -1;
  for (let j = i; j < segs.length; j++) if (segs[j].toLowerCase() === 'providers') lastProviders = j;
  if (lastProviders >= 0) {
    const ns = segs[lastProviders + 1];
    const rest = segs.slice(lastProviders + 2);
    const types: string[] = [];
    for (let k = 0; k < rest.length; k += 2) {
      types.push(rest[k]);
      if (rest[k + 1] !== undefined) out.names.push(rest[k + 1]);
    }
    out.type = [ns, ...types].join('/');
    out.name = out.names[out.names.length - 1];
    if (out.names.length > 1) out.parentId = '/' + segs.slice(0, segs.length - 2).join('/');
  } else if (out.resourceGroup) {
    out.type = 'Microsoft.Resources/resourceGroups';
    out.name = out.resourceGroup;
  } else if (out.subscriptionId) {
    out.type = 'Microsoft.Resources/subscriptions';
    out.name = out.subscriptionId;
  }
  return out;
}

export function resourceHref(id: string, tab?: string): string {
  const base = resourceHrefBase(id);
  return tab ? `${base}${base.includes('?') ? '&' : '?'}tab=${encodeURIComponent(tab)}` : base;
}

function resourceHrefBase(id: string): string {
  const p = parseId(id);
  if (p.type === 'Microsoft.Resources/resourceGroups') return `/resource-groups/${p.subscriptionId}/${encodeURIComponent(p.resourceGroup!)}`;
  if (p.type === 'Microsoft.Resources/subscriptions') return `/subscriptions/${p.subscriptionId}`;
  if (p.type?.toLowerCase() === 'microsoft.resources/deployments') return `/deployment?id=${encodeURIComponent(id)}`;
  return `/resource?id=${encodeURIComponent(id)}`;
}

export function rgId(sub: string, rg: string) {
  return `/subscriptions/${sub}/resourceGroups/${rg}`;
}

export function typeLabel(catalog: CatalogType[] | undefined, type: string, locale: 'it' | 'en'): string {
  const t = catalog?.find((x) => x.type.toLowerCase() === type.toLowerCase());
  return t ? t.label[locale] : type.split('/').slice(1).join('/');
}

export function uuid(): string {
  return crypto.randomUUID();
}
