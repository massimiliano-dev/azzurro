import { HttpError } from '../errors.ts';

export type ArmPath =
  | { k: 'tenants' }
  | { k: 'subscriptions' }
  | { k: 'subscription'; sub: string }
  | { k: 'locations'; sub: string }
  | { k: 'resources'; sub: string; rg?: string }
  | { k: 'resourceGroups'; sub: string }
  | { k: 'resourceGroup'; sub: string; rg: string }
  | { k: 'rgAction'; sub: string; rg: string; action: string }
  | { k: 'tagNames'; sub: string; name?: string; value?: string }
  | { k: 'providers'; sub?: string }
  | { k: 'res'; sub?: string; rg?: string; scope: string; ns: string; types: string[]; names: string[] };

export const notFoundPath = (path: string) =>
  new HttpError(404, 'InvalidResourceType', `The resource type could not be found in the namespace for the requested path '${path}'.`);

export function buildId(scope: string, ns: string, types: string[], names: string[]): string {
  let id = `${scope}/providers/${ns}`;
  for (let i = 0; i < names.length; i++) id += `/${types[i]}/${names[i]}`;
  return id;
}

export function parseArmPath(pathname: string): ArmPath {
  const segs = pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
  const L = (i: number) => segs[i]?.toLowerCase();
  let i = 0;
  let scope = '';
  let sub: string | undefined;
  let rg: string | undefined;
  if (!segs.length) throw notFoundPath(pathname);
  if (L(0) === 'tenants' && segs.length === 1) return { k: 'tenants' };
  if (L(0) === 'subscriptions') {
    if (segs.length === 1) return { k: 'subscriptions' };
    sub = segs[1];
    scope = `/subscriptions/${sub}`;
    i = 2;
    if (segs.length === 2) return { k: 'subscription', sub };
    if (L(2) === 'locations' && segs.length === 3) return { k: 'locations', sub };
    if (L(2) === 'resources' && segs.length === 3) return { k: 'resources', sub };
    if (L(2) === 'tagnames') {
      if (segs.length > 6 || (segs.length >= 5 && L(4) !== 'tagvalues')) throw notFoundPath(pathname);
      return { k: 'tagNames', sub, name: segs[3], value: segs[5] };
    }
    if (L(2) === 'resourcegroups') {
      if (segs.length === 3) return { k: 'resourceGroups', sub };
      rg = segs[3];
      scope += `/resourceGroups/${rg}`;
      i = 4;
      if (segs.length === 4) return { k: 'resourceGroup', sub, rg };
      if (L(4) === 'resources' && segs.length === 5) return { k: 'resources', sub, rg };
      if (L(4) !== 'providers') {
        if (segs.length === 5) return { k: 'rgAction', sub, rg, action: segs[4] };
        throw notFoundPath(pathname);
      }
    }
  }
  if (L(i) !== 'providers') throw notFoundPath(pathname);
  if (segs.length === i + 1) return { k: 'providers', sub };
  for (;;) {
    const ns = segs[i + 1];
    i += 2;
    const types: string[] = [];
    const names: string[] = [];
    while (i < segs.length) {
      if (L(i) === 'providers' && types.length === names.length && types.length > 0 && i + 1 < segs.length) break;
      if (types.length === names.length) types.push(segs[i]);
      else names.push(segs[i]);
      i++;
    }
    if (i < segs.length) {
      scope = buildId(scope, ns, types, names);
      continue;
    }
    return { k: 'res', sub, rg, scope, ns, types, names };
  }
}

/** Scope gerarchici (minuscoli) di un id: "/", sottoscrizione, RG, risorse antenate, sé stesso. */
export function scopeChain(id: string): string[] {
  const out = ['/'];
  const lower = id.toLowerCase().replace(/\/+$/, '');
  if (!lower || lower === '/') return out;
  const segs = lower.split('/').filter(Boolean);
  let cur = '';
  for (let i = 0; i < segs.length; i++) {
    cur += '/' + segs[i];
    // punti di taglio: dopo subscriptions/x, resourcegroups/x, e dopo ogni coppia tipo/nome dei provider
    out.push(cur);
  }
  return [...new Set(out)];
}

export function isAncestorOrSelf(scope: string, target: string): boolean {
  const s = scope.toLowerCase().replace(/\/+$/, '');
  const t = target.toLowerCase().replace(/\/+$/, '');
  return s === '' || s === '/' || t === s || t.startsWith(s + '/');
}

export interface IdParts {
  subscriptionId?: string;
  resourceGroup?: string;
  provider?: string;
  type?: string;
  name?: string;
}

export function idParts(id: string): IdParts {
  const segs = id.split('/').filter(Boolean);
  const out: IdParts = {};
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i].toLowerCase();
    if (s === 'subscriptions' && !out.subscriptionId) out.subscriptionId = segs[i + 1];
    if (s === 'resourcegroups' && !out.resourceGroup) out.resourceGroup = segs[i + 1];
  }
  try {
    const p = parseArmPath(id);
    if (p.k === 'res' && p.names.length === p.types.length && p.names.length) {
      out.provider = p.ns;
      out.type = `${p.ns}/${p.types.join('/')}`;
      out.name = p.names[p.names.length - 1];
    } else if (p.k === 'resourceGroup') {
      out.type = 'Microsoft.Resources/resourceGroups';
      out.provider = 'Microsoft.Resources';
      out.name = p.rg;
    } else if (p.k === 'subscription') {
      out.type = 'Microsoft.Resources/subscriptions';
      out.provider = 'Microsoft.Resources';
      out.name = p.sub;
    }
  } catch {
    /* id non ARM */
  }
  return out;
}

export function rgId(sub: string, rg: string): string {
  return `/subscriptions/${sub}/resourceGroups/${rg}`;
}
