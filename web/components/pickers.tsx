'use client';

import { useEffect, useState } from 'react';
import { Search, Users, User, AppWindow } from 'lucide-react';
import { arm, graph } from '@/lib/api';
import { useAsync, useDebounced } from '@/lib/hooks';
import { useI18n, useT } from '@/i18n';
import { Avatar, Input, Select } from './ui';

export interface Sub { subscriptionId: string; displayName: string; state: string }

export function useSubscriptions() {
  return useAsync(async () => (await arm.get<{ value: Sub[] }>('/subscriptions', '2022-12-01')).value, []);
}

export function SubscriptionSelect({ value, onChange, id }: { value: string; onChange: (v: string) => void; id?: string }) {
  const subs = useSubscriptions();
  useEffect(() => {
    if (!value && subs.data?.length) onChange(subs.data[0].subscriptionId);
  }, [subs.data, value, onChange]);
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      {(subs.data ?? []).map((s) => <option key={s.subscriptionId} value={s.subscriptionId}>{s.displayName}</option>)}
    </Select>
  );
}

export function ResourceGroupSelect({ sub, value, onChange, id, allowEmpty }: { sub: string; value: string; onChange: (v: string, location?: string) => void; id?: string; allowEmpty?: boolean }) {
  const t = useT();
  const rgs = useAsync(async () => (sub ? (await arm.get<{ value: { name: string; location: string }[] }>(`/subscriptions/${sub}/resourcegroups`)).value : []), [sub]);
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value, rgs.data?.find((r) => r.name === e.target.value)?.location)}>
      <option value="">{allowEmpty ? t('common.all') : t('common.selectPlaceholder')}</option>
      {(rgs.data ?? []).map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}
    </Select>
  );
}

let locCache: { name: string; displayName: string; geography: string }[] | null = null;

export function LocationSelect({ value, onChange, id }: { value: string; onChange: (v: string) => void; id?: string }) {
  const [locs, setLocs] = useState(locCache ?? []);
  useEffect(() => {
    if (locCache) return;
    fetch('/api/portal/config').then((r) => r.json()).then((c) => { locCache = c.locations; setLocs(c.locations); });
  }, []);
  const groups = [...new Set(locs.map((l) => l.geography))];
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      {groups.map((g) => (
        <optgroup key={g} label={g}>
          {locs.filter((l) => l.geography === g).map((l) => <option key={l.name} value={l.name}>{l.displayName}</option>)}
        </optgroup>
      ))}
    </Select>
  );
}

export interface PrincipalRef { id: string; displayName: string; type: 'User' | 'Group' | 'ServicePrincipal'; detail?: string }

export function PrincipalPicker({ onPick, types = ['User', 'Group', 'ServicePrincipal'], exclude = [] }: { onPick: (p: PrincipalRef) => void; types?: PrincipalRef['type'][]; exclude?: string[] }) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 200);
  const res = useAsync(async () => {
    const term = dq.trim().replace(/'/g, "''");
    const filter = term ? `$filter=startswith(displayName,'${encodeURIComponent(term)}')` : '';
    const top = '$top=25';
    const out: PrincipalRef[] = [];
    let failed = 0;
    const tasks: Promise<void>[] = [];
    const soft = (p: Promise<void>) => p.catch(() => { failed++; });
    if (types.includes('User')) tasks.push(soft(graph.list<any>(`/users?${filter ? filter + '&' : ''}${top}&$select=id,displayName,userPrincipalName`).then((v) => { out.push(...v.map((u) => ({ id: u.id, displayName: u.displayName, type: 'User' as const, detail: u.userPrincipalName }))); })));
    if (types.includes('Group')) tasks.push(soft(graph.list<any>(`/groups?${filter ? filter + '&' : ''}${top}`).then((v) => { out.push(...v.map((g) => ({ id: g.id, displayName: g.displayName, type: 'Group' as const, detail: g.description ?? '' }))); })));
    if (types.includes('ServicePrincipal')) tasks.push(soft(graph.list<any>(`/servicePrincipals?${filter ? filter + '&' : ''}${top}`).then((v) => { out.push(...v.map((s) => ({ id: s.id, displayName: s.displayName, type: 'ServicePrincipal' as const, detail: s.servicePrincipalType === 'ManagedIdentity' ? `${t('ent.managedIdentity')} · ${s.appId}` : s.appId }))); })));
    await Promise.all(tasks);
    return { items: out.filter((p) => !exclude.includes(p.id)).sort((a, b) => a.displayName.localeCompare(b.displayName)), blind: failed === tasks.length };
  }, [dq, types.join(',')]);
  const [manualId, setManualId] = useState('');
  const [manualType, setManualType] = useState<PrincipalRef['type']>(types[0] ?? 'User');
  const Icon = (ty: string) => (ty === 'Group' ? Users : ty === 'User' ? User : AppWindow);
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div style={{ position: 'relative' }}>
        <Search size={15} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--muted)' }} aria-hidden />
        <Input style={{ paddingLeft: 32 }} placeholder={t('iam.searchPrincipals')} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="card" style={{ maxHeight: 300, overflow: 'auto' }}>
        {(res.data?.items ?? []).map((p) => {
          const I = Icon(p.type);
          return (
            <button key={p.id} type="button" className="dropdown-item" onClick={() => onPick(p)}>
              {p.type === 'User' ? <Avatar name={p.displayName} size="sm" /> : <span className="res-icon sm"><I size={13} /></span>}
              <span style={{ minWidth: 0 }}>
                <div>{p.displayName}</div>
                <div className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t(`iam.type.${p.type}`)} · {p.detail}</div>
              </span>
            </button>
          );
        })}
        {res.data && !res.data.items.length && !res.data.blind && <div className="empty" style={{ padding: 20 }}>{t('common.noResults')}</div>}
        {res.data?.blind && <div style={{ padding: 14 }} className="small">{t('iam.directoryBlind')}</div>}
        {!res.data && <div style={{ padding: 16 }}><span className="spinner" /></div>}
      </div>
      {res.data?.blind && (
        <div className="row wrap">
          <Input style={{ flex: 1, minWidth: 240 }} aria-label={t('iam.objectId')} placeholder={t('iam.objectId')} value={manualId} onChange={(e) => setManualId(e.target.value.trim())} />
          <select className="select" style={{ width: 'auto' }} value={manualType} onChange={(e) => setManualType(e.target.value as PrincipalRef['type'])} aria-label={t('common.type')}>
            {types.map((ty) => <option key={ty} value={ty}>{t(`iam.type.${ty}`)}</option>)}
          </select>
          <button type="button" className="btn" disabled={!/^[0-9a-f-]{36}$/i.test(manualId)} onClick={() => onPick({ id: manualId, displayName: manualId, type: manualType, detail: '' })}>{t('common.add')}</button>
        </div>
      )}
    </div>
  );
}
