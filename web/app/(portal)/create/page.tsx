'use client';

import { DraftEstimate } from '@/components/pricing';
import { useDirectory } from '@/lib/directory';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { FileCode2, Plus, Search } from 'lucide-react';
import { portal, arm } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { loadCatalog, rgId, type CatalogType } from '@/lib/arm';
import { useI18n, type MessageKey } from '@/i18n';
import { JsonEditor, PageHeader, TagEditor } from '@/components/page';
import { Button, Card, CodeBlock, Checkbox, ErrorNotice, Field, Input, Select, Skeleton, Switch } from '@/components/ui';
import { useToast } from '@/components/overlay';
import { LocationSelect, ResourceGroupSelect, SubscriptionSelect } from '@/components/pickers';
import { NewResourceGroupPanel } from '@/components/rg';
import { iconFor } from '@/components/resource';

const CATEGORIES = ['compute', 'containers', 'web', 'storage', 'databases', 'networking', 'identity', 'security', 'integration', 'monitor', 'ai', 'management'];
const IDENTITY_TYPES = /web\/sites|sql\/servers|containerservice|app\/containerapps|keyvault|cognitiveservices|documentdb|servicebus|eventhub|apimanagement|appconfiguration|signalr|logic|search|machinelearning|compute\/virtualmachines|dbforpostgresql|dbformysql|containerregistry|automation|recoveryservices|cache\/redis|eventgrid|containerinstance/i;

function setPath(obj: any, path: string, value: unknown) {
  const parts = path.split('.');
  let cur = obj;
  parts.forEach((p, i) => {
    const last = i === parts.length - 1;
    const nextIsIndex = /^\d+$/.test(parts[i + 1] ?? '');
    const key: string | number = /^\d+$/.test(p) ? Number(p) : p;
    if (last) cur[key] = value;
    else {
      if (cur[key] == null || typeof cur[key] !== 'object') cur[key] = nextIsIndex ? [] : {};
      cur = cur[key];
    }
  });
}

function deepMerge(a: any, b: any): any {
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = deepMerge(a[k], v);
    return out;
  }
  return b === undefined ? a : b;
}

function Catalog() {
  const { t, locale } = useI18n();
  const sp = useSearchParams();
  const cat = useAsync(() => loadCatalog(), []);
  const [q, setQ] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const qs = sp.toString() ? `&${sp.toString()}` : '';
  const items = (cat.data?.value ?? []).filter((c) => (!category || c.category === category) && (!q || `${c.label[locale]} ${c.type} ${c.description?.[locale] ?? ''}`.toLowerCase().includes(q.toLowerCase())));
  return (
    <>
      <PageHeader title={t('create.title')} subtitle={t('create.subtitle')} icon={Plus} />
      <div style={{ position: 'relative', maxWidth: 520 }} className="mb-16">
        <Search size={16} style={{ position: 'absolute', left: 11, top: 10, color: 'var(--muted)' }} aria-hidden />
        <Input style={{ paddingLeft: 34 }} placeholder={t('create.searchTypes')} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      </div>
      <div className="chips" role="tablist">
        <button className={`chip ${!category ? 'on' : ''}`} onClick={() => setCategory(null)}>{t('common.all')}</button>
        {CATEGORIES.filter((c) => cat.data?.value.some((x) => x.category === c)).map((c) => (
          <button key={c} className={`chip ${category === c ? 'on' : ''}`} onClick={() => setCategory(c)}>{t(`create.category.${c}` as MessageKey)}</button>
        ))}
      </div>
      {cat.error ? <ErrorNotice error={cat.error} /> : !cat.data ? <Skeleton rows={6} /> : (
        <div className="catalog">
          {(!category || category === 'management') && !q && (
            <Link href="/deploy"><span className="res-icon c-management"><FileCode2 size={18} /></span><span style={{ minWidth: 0 }}><div className="t">{t('create.customTemplate')}</div><div className="s">Microsoft.Resources/deployments</div></span></Link>
          )}
          {items.map((c) => {
            const Icon = iconFor(c.type, c.category);
            return (
              <Link key={`${c.type}|${c.preset ?? ''}`} href={`/create?type=${encodeURIComponent(c.type)}${c.preset ? `&preset=${c.preset}` : ''}${qs.replace(/&?(type|preset)=[^&]*/g, '')}`}>
                <span className={`res-icon c-${c.category}`}><Icon size={18} /></span>
                <span style={{ minWidth: 0 }}>
                  <div className="t">{c.label[locale]}</div>
                  <div className="s">{c.preset && c.presetBody?.kind ? `${c.type} · kind ${c.presetBody.kind}` : c.type}</div>
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}

function CreateForm({ def }: { def: CatalogType }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const router = useRouter();
  const sp = useSearchParams();
  const [sub, setSub] = useState(sp.get('sub') ?? '');
  const [rg, setRg] = useState(sp.get('rg') ?? '');
  const [rgOpen, setRgOpen] = useState(false);
  const [rgKey, setRgKey] = useState(0);
  const [name, setName] = useState('');
  const [location, setLocation] = useState('italynorth');
  const [values, setValues] = useState<Record<string, unknown>>(() => Object.fromEntries((def.fields ?? []).filter((f) => f.default !== undefined).map((f) => [f.key, f.default])));
  const [tags, setTags] = useState<Record<string, string>>({});
  const [identity, setIdentity] = useState(false);
  const [advanced, setAdvanced] = useState('{\n  "properties": {}\n}');
  const [advValid, setAdvValid] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const rule = def.nameRule ? new RegExp(def.nameRule.pattern) : null;
  const nameValid = !!name && (!rule || rule.test(name));
  const body = useMemo(() => {
    let b: any = def.global ? { location: 'global' } : { location };
    if (def.presetBody) b = deepMerge(b, structuredClone(def.presetBody));
    for (const f of def.fields ?? []) {
      const v = values[f.key];
      if (v === undefined || v === '') continue;
      setPath(b, f.key, f.kind === 'number' ? Number(v) : v);
    }
    if (Object.keys(tags).length) b.tags = tags;
    if (identity) b.identity = { type: 'SystemAssigned' };
    try {
      b = deepMerge(b, JSON.parse(advanced || '{}'));
    } catch { /* gestito dall'editor */ }
    return b;
  }, [def, values, location, tags, identity, advanced]);
  const missing = (def.fields ?? []).some((f) => f.required && (values[f.key] === undefined || values[f.key] === ''));
  const { real: isReal } = useDirectory();
  const submit = async () => {
    setBusy(true);
    setError(null);
    const path = `${rgId(sub, rg)}/providers/${def.type}/${name}`;
    try {
      // in Azure reale nessuno applica i valori predefiniti del catalogo: li aggiunge il portale
      const final = isReal ? (await portal.post<any>('/prepare', { type: def.type, name, sub, rg, id: path, resource: body })).resource : body;
      await arm.put(path, final, def.apiVersion);
      toast.ok(t('create.done', { name }));
      router.push(`/resource?id=${encodeURIComponent(path)}`);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeader title={def.label[locale]} subtitle={def.description?.[locale] ? `${def.description[locale]} · ${def.type}` : def.type} crumbs={[{ label: t('nav.create'), href: '/create' }, { label: def.label[locale] }]} />
      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <div className="stack" style={{ gap: 16 }}>
          <Card title={t('create.project')}>
            <Field label={t('common.subscription')} required htmlFor="c-sub"><SubscriptionSelect id="c-sub" value={sub} onChange={(v) => { setSub(v); setRg(''); }} /></Field>
            <Field label={t('common.resourceGroup')} required htmlFor="c-rg">
              <div className="input-group">
                <ResourceGroupSelect key={rgKey} id="c-rg" sub={sub} value={rg} onChange={(v, loc) => { setRg(v); if (loc) setLocation(loc); }} />
                <Button onClick={() => setRgOpen(true)}>{t('create.newRg')}</Button>
              </div>
            </Field>
          </Card>
          <Card title={t('create.instance')}>
            <Field label={t('common.name')} required htmlFor="c-name" error={name && !nameValid ? def.nameRule?.message ?? t('create.nameInvalid') : undefined}>
              <Input id="c-name" value={name} onChange={(e) => setName(e.target.value)} invalid={!!name && !nameValid} autoComplete="off" />
            </Field>
            {!def.global && <Field label={t('common.location')} required htmlFor="c-loc"><LocationSelect id="c-loc" value={location} onChange={setLocation} /></Field>}
            {(def.fields ?? []).map((f) => (
              <Field key={f.key} label={f.label[locale]} required={f.required} htmlFor={`f-${f.key}`}>
                {f.kind === 'select' ? (
                  <Select id={`f-${f.key}`} value={String(values[f.key] ?? '')} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}>
                    {!f.default && <option value="">{t('common.selectPlaceholder')}</option>}
                    {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                  </Select>
                ) : f.kind === 'bool' ? (
                  <Switch checked={!!values[f.key]} onChange={(v) => setValues({ ...values, [f.key]: v })} />
                ) : (
                  <Input id={`f-${f.key}`} type={f.kind === 'password' ? 'password' : f.kind === 'number' ? 'number' : 'text'} autoComplete={f.kind === 'password' ? 'new-password' : 'off'} value={String(values[f.key] ?? '')} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
                )}
              </Field>
            ))}
            {IDENTITY_TYPES.test(def.type) && <Checkbox checked={identity} onChange={setIdentity} label={t('create.identity')} />}
          </Card>
          <Card title={t('common.tags')}><TagEditor value={tags} onChange={setTags} /></Card>
          <Card title={t('create.advanced')}>
            <p className="small muted mb-16">{t('create.advancedHint')}</p>
            <JsonEditor value={advanced} onChange={setAdvanced} onValid={setAdvValid} rows={8} />
          </Card>
        </div>
        <div className="stack" style={{ gap: 16, position: 'sticky', top: 76 }}>
          <DraftEstimate type={def.type} resource={body} />
          <Card title={t('create.review')}>
            <p className="small muted mb-16 mono">PUT …/providers/{def.type}/{name || '{name}'}?api-version={def.apiVersion}</p>
            <CodeBlock value={body} maxHeight={480} />
          </Card>
          {error ? <ErrorNotice error={error} /> : null}
          <div className="row">
            <Button variant="primary" loading={busy} disabled={!sub || !rg || !nameValid || missing || !advValid} onClick={submit}>{t('common.create')}</Button>
            <Link className="btn" href="/create">{t('common.back')}</Link>
          </div>
        </div>
      </div>
      <NewResourceGroupPanel open={rgOpen} initialSub={sub} onClose={() => setRgOpen(false)} onCreated={(s, n, loc) => { setSub(s); setRg(n); setLocation(loc); setRgKey((k) => k + 1); }} />
    </>
  );
}

export default function CreatePage() {
  const sp = useSearchParams();
  const type = sp.get('type');
  const cat = useAsync(() => loadCatalog(), []);
  const preset = sp.get('preset');
  const def = type ? cat.data?.all.find((c) => c.type.toLowerCase() === type.toLowerCase()) : undefined;
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [type]);
  if (!type) return <Catalog />;
  if (!cat.data) return <Skeleton rows={8} />;
  if (!def) return <Catalog />;
  const entry = cat.data.value.find((v) => v.type === def.type && (v.preset ?? null) === (preset ?? null)) ?? cat.data.value.find((v) => v.type === def.type && !v.preset);
  return <CreateForm key={`${def.type}|${preset ?? ''}`} def={{ ...def, ...(entry ?? {}) }} />;
}
