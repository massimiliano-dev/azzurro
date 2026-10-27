'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Star, KeyRound, Pencil, Sparkles, Play, Plus, Power, RefreshCw, RotateCw, ShieldCheck, Square, Trash2 } from 'lucide-react';
import { portal, arm, graph } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { loadCatalog, parseId, resourceHref, typeLabel, type CatalogType } from '@/lib/arm';
import { useI18n } from '@/i18n';
import { useDirectory } from '@/lib/directory';
import { useFavorites } from '@/lib/favorites';
import { ResourceCosts } from '@/components/pricing';
import { VaultSecrets } from '@/components/vault';
import { useServiceTabs } from '@/components/blades';
import { JsonEditor, PageHeader, Tabs, TagEditor, Toolbar, useTab } from '@/components/page';
import { Badge, Button, Card, CodeBlock, Empty, ErrorNotice, Field, IdText, Input, KV, Notice, SecretValue, Skeleton, Tags } from '@/components/ui';
import { Panel, useConfirm, useToast } from '@/components/overlay';
import { DataTable } from '@/components/table';
import { ResourceIcon, StateBadge } from '@/components/resource';

const LIST_ACTIONS = ['listKeys', 'listConnectionStrings', 'listCredentials', 'listAdminKeys', 'listQueryKeys', 'sharedKeys', 'listSecrets', 'listClusterUserCredential', 'readonlykeys'];
const POWER_ACTIONS = ['start', 'stop', 'restart', 'powerOff', 'deallocate'];
const HIDDEN_PROPS = new Set(['provisioningState']);

function flatten(obj: any, prefix = '', out: [string, unknown][] = [], depth = 0): [string, unknown][] {
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (HIDDEN_PROPS.has(k)) continue;
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && depth < 1 && Object.keys(v).length <= 8) flatten(v, key, out, depth + 1);
    else if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out.push([key, v]);
  }
  return out;
}

function SecretsView({ data }: { data: any }) {
  const rows: [string, string][] = [];
  const walk = (v: any, path: string) => {
    if (typeof v === 'string') rows.push([path, v]);
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${x?.keyName ?? x?.name ?? x?.description ?? i}]`));
    else if (v && typeof v === 'object') {
      if (typeof v.value === 'string' && (v.keyName || v.name)) rows.push([v.keyName ?? v.name, v.value]);
      else for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
    }
  };
  walk(data, '');
  return <KV items={rows.map(([k, v]) => [k.replace(/^\./, ''), v.length > 20 && !/^https?:/.test(v) ? <SecretValue key={k} value={v} /> : <IdText key={k} value={v} />])} />;
}

export default function ResourcePage() {
  const sp = useSearchParams();
  // un ID non contiene mai '?': i link vecchi con '?tab=' attaccato vengono ripuliti
  const id = (sp.get('id') ?? '').split('?')[0];
  const router = useRouter();
  const { t, locale, fmtDate } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const [tab, setTab] = useTab('overview');
  const info = useMemo(() => parseId(id), [id]);
  const cat = useAsync(() => loadCatalog(), []);
  const def: CatalogType | undefined = cat.data?.all.find((c) => c.type.toLowerCase() === info.type?.toLowerCase());
  // tipi fuori dal catalogo (directory Azure reale): versione API dai metadati del provider
  const apiV = useAsync(async () => (await portal.get<{ apiVersion: string }>(`/apiversion?type=${encodeURIComponent(info.type ?? '')}&sub=${info.subscriptionId ?? ''}`)).apiVersion, [info.type, info.subscriptionId], { enabled: !!cat.data && !def });
  const apiVersion = def?.apiVersion ?? apiV.data ?? '2021-04-01';
  const res = useAsync(() => arm.get<any>(id, apiVersion, info.type === 'Microsoft.Compute/virtualMachines' ? { $expand: 'instanceView' } : undefined), [id, apiVersion], { enabled: !!cat.data && (!!def || apiV.data !== undefined || !!apiV.error) });
  const childTypes = useMemo(() => (cat.data?.all ?? []).filter((c) => info.type && c.type.toLowerCase().startsWith(info.type.toLowerCase() + '/') && c.type.split('/').length === info.type.split('/').length + 1), [cat.data, info.type]);
  const listActions = (def?.actions ?? []).filter((a) => LIST_ACTIONS.some((l) => l.toLowerCase() === a.toLowerCase()));
  const powerActions = (def?.actions ?? []).filter((a) => POWER_ACTIONS.includes(a));
  const [secrets, setSecrets] = useState<Record<string, any>>({});
  const [json, setJson] = useState<string | null>(null);
  const [tags, setTags] = useState<Record<string, string> | null>(null);
  const [childOpen, setChildOpen] = useState<CatalogType | null>(null);
  const [childName, setChildName] = useState('');
  const [childProps, setChildProps] = useState('{\n  "properties": {}\n}');
  const [busy, setBusy] = useState(false);
  const activity = useAsync(async () => {
    if (!info.subscriptionId) return [];
    const since = new Date(Date.now() - 30 * 86400_000).toISOString();
    return (await arm.get<{ value: any[] }>(`/subscriptions/${info.subscriptionId}/providers/Microsoft.Insights/eventtypes/management/values`, '2015-04-01', { $filter: `eventTimestamp ge '${since}' and resourceUri eq '${id}'` })).value;
  }, [id], { enabled: tab === 'activity' });
  const identitySp = useAsync(async () => (res.data?.identity?.principalId ? graph.get(`/servicePrincipals/${res.data.identity.principalId}`) : null), [res.data?.identity?.principalId]);

  useEffect(() => {
    if (tab !== 'keys' || !res.data) return;
    for (const a of listActions) {
      if (secrets[a]) continue;
      arm.post(`${id}/${a}`, {}, apiVersion).then((v) => setSecrets((s) => ({ ...s, [a]: v }))).catch((e) => setSecrets((s) => ({ ...s, [a]: { __error: e } })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, res.data]);

  if (!id) return <Empty title={t('res.notFound')} />;
  if (res.error) return <><PageHeader title={info.name ?? id} crumbs={[{ label: t('nav.allResources'), href: '/resources' }]} /><ErrorNotice error={res.error} onRetry={res.reload} /></>;
  const r = res.data;
  // Azure AI Foundry: risorse AI Services / OpenAI, progetti Foundry, hub e progetti classici
  const { real, state: dirState } = useDirectory();
  const fav = useFavorites();
  const svcTabs = useServiceTabs(info.type, id, res.data, res.reload, apiVersion);
  const foundryKind = String(r?.kind ?? '').toLowerCase();
  const isFoundry = (/^microsoft\.cognitiveservices\/accounts$/i.test(info.type ?? '') && ['aiservices', 'openai'].includes(foundryKind))
    || /^microsoft\.cognitiveservices\/accounts\/projects$/i.test(info.type ?? '')
    || (/^microsoft\.machinelearningservices\/workspaces$/i.test(info.type ?? '') && ['hub', 'project'].includes(foundryKind));
  const foundryUrl: string | null | undefined = !isFoundry ? undefined : !real ? null
    : `https://ai.azure.com/${foundryKind === 'hub' ? 'managementCenter/hub/overview' : 'resource/overview'}?wsid=${encodeURIComponent(id)}&tid=${dirState?.active ?? ''}`;
  const label = info.type ? typeLabel(cat.data?.all, info.type, locale) : '';
  const crumbs = [
    { label: t('nav.resourceGroups'), href: '/resource-groups' },
    ...(info.resourceGroup ? [{ label: info.resourceGroup, href: `/resource-groups/${info.subscriptionId}/${encodeURIComponent(info.resourceGroup)}` }] : []),
    ...(info.parentId ? [{ label: parseId(info.parentId).name ?? '', href: resourceHref(info.parentId) }] : []),
    { label: info.name ?? '' },
  ];

  const runAction = async (a: string) => {
    setBusy(true);
    try {
      await arm.post(`${id}/${a}`, {}, apiVersion);
      toast.ok(t('res.actionDone', { action: a }));
      await res.reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!(await confirm({ title: t('res.deleteTitle'), text: <>{t('res.deleteText', { name: info.name })} {t('common.irreversible')}</>, danger: true, confirmLabel: t('common.delete'), typeToConfirm: info.name }))) return;
    try {
      await arm.del(id, apiVersion);
      toast.ok(t('common.deleted'), info.name);
      router.push(info.parentId ? resourceHref(info.parentId) : info.resourceGroup ? `/resource-groups/${info.subscriptionId}/${encodeURIComponent(info.resourceGroup)}` : '/resources');
    } catch (e) {
      toast.error(e);
    }
  };
  const saveJson = async () => {
    try {
      const body = JSON.parse(json ?? '{}');
      delete body.id; delete body.name; delete body.type; delete body.systemData; delete body.etag;
      await arm.put(id, body, apiVersion);
      toast.ok(t('common.saved'));
      setJson(null);
      await res.reload();
    } catch (e) {
      toast.error(e);
    }
  };
  const props = r ? flatten(r.properties) : [];
  const power = r?.properties?.instanceView?.statuses?.find((s: any) => s.code?.startsWith('PowerState/'))?.displayStatus ?? r?.properties?.state ?? r?.properties?.powerState?.code;

  return (
    <>
      <PageHeader title={info.name ?? ''} subtitle={label} crumbs={crumbs} icon={undefined} actions={info.type ? <ResourceIcon type={info.type} /> : undefined} />
      <Toolbar>
        <Button variant="ghost" icon={RefreshCw} onClick={res.reload}>{t('common.refresh')}</Button>
        {powerActions.includes('start') && <Button icon={Play} loading={busy} onClick={() => runAction('start')}>{t('common.start')}</Button>}
        {powerActions.includes('restart') && <Button icon={RotateCw} loading={busy} onClick={() => runAction('restart')}>{t('common.restart')}</Button>}
        {powerActions.includes('stop') && <Button icon={Square} loading={busy} onClick={() => runAction('stop')}>{t('common.stop')}</Button>}
        {powerActions.includes('powerOff') && <Button icon={Power} loading={busy} onClick={() => runAction('powerOff')}>{t('common.stop')}</Button>}
        {powerActions.includes('deallocate') && <Button icon={Power} loading={busy} onClick={() => runAction('deallocate')}>deallocate</Button>}
        <Button icon={Pencil} disabled={!r} onClick={() => setJson(JSON.stringify(r, null, 2))}>{t('res.editJson')}</Button>
        <Link className="btn" href={`/iam?scope=${encodeURIComponent(id)}`}><ShieldCheck size={16} />{t('nav.iam')}</Link>
        <Button className={`fav-toggle ${fav.has(id) ? 'on' : ''}`} icon={Star} aria-pressed={fav.has(id)} onClick={() => fav.toggle({ id, name: info.name ?? id, type: info.type ?? '' })}>{fav.has(id) ? t('res.unfavorite') : t('res.favorite')}</Button>
        {foundryUrl !== undefined && (foundryUrl
          ? <a className="btn" href={foundryUrl} target="_blank" rel="noreferrer noopener"><Sparkles size={16} />{t('res.openFoundry')}<ExternalLink size={13} aria-hidden /></a>
          : <Button icon={Sparkles} disabled title={t('res.foundryLocal')}>{t('res.openFoundry')}</Button>)}
        <span className="spacer" />
        <Button variant="danger" icon={Trash2} onClick={remove}>{t('common.delete')}</Button>
      </Toolbar>
      <Tabs value={tab} onChange={setTab} tabs={[
        { key: 'overview', label: t('common.overview') },
        ...svcTabs.map((s) => ({ key: s.key, label: s.label })),
        ...(listActions.length ? [{ key: 'keys', label: t('res.keys') }] : []),
        ...(childTypes.length ? [{ key: 'children', label: t('res.children') }] : []),
        ...(info.type?.toLowerCase() === 'microsoft.keyvault/vaults' ? [{ key: 'secrets', label: t('kv.tab') }] : []),
        { key: 'costs', label: t('pricing.tab') },
        { key: 'json', label: t('common.json') },
        { key: 'activity', label: t('nav.activity') },
      ]} />
      {tab === 'overview' && (!r ? <Skeleton rows={6} /> : (
        <div className="stack" style={{ gap: 16 }}>
          <Card title={t('res.essentials')} actions={<Button size="sm" variant="ghost" icon={Pencil} onClick={() => setTags(r.tags ?? {})}>{t('common.tags')}</Button>}>
            <KV items={[
              [t('common.resourceGroup'), info.resourceGroup ? <Link key="g" href={`/resource-groups/${info.subscriptionId}/${encodeURIComponent(info.resourceGroup)}`}>{info.resourceGroup}</Link> : null],
              [t('common.location'), r.location],
              [t('common.subscription'), info.subscriptionId ? <Link key="s" href={`/subscriptions/${info.subscriptionId}`}><span className="mono">{info.subscriptionId}</span></Link> : null],
              [t('common.type'), <span key="t" className="mono">{r.type}</span>],
              [t('res.provisioning'), <StateBadge key="p" state={r.properties?.provisioningState} />],
              ...(power ? [[t('res.power'), <Badge key="pw" tone={/running|ready/i.test(String(power)) ? 'ok' : 'warn'}>{String(power)}</Badge>] as [string, React.ReactNode]] : []),
              ...(r.sku ? [[t('res.sku'), <span key="sku" className="mono">{r.sku.name}{r.sku.tier && r.sku.tier !== r.sku.name ? ` · ${r.sku.tier}` : ''}</span>] as [string, React.ReactNode]] : []),
              ...(r.kind ? [[t('res.kind'), r.kind] as [string, React.ReactNode]] : []),
              [t('res.resourceId'), <IdText key="i" value={r.id} />],
              [t('common.created'), r.systemData?.createdAt ? `${fmtDate(r.systemData.createdAt)} · ${r.systemData.createdBy ?? ''}` : null],
              [t('common.tags'), <Tags key="tg" tags={r.tags} />],
            ]} />
          </Card>
          {props.length > 0 && (
            <Card title={t('common.properties')}>
              <KV items={props.slice(0, 40).map(([k, v]) => [k, typeof v === 'string' && /^https?:\/\//.test(v) ? <IdText key={k} value={v} /> : typeof v === 'boolean' ? (v ? t('common.yes') : t('common.no')) : String(v ?? '—')])} />
            </Card>
          )}
          {r.identity && r.identity.type !== 'None' && (
            <Card title={t('res.identity')}>
              <KV items={[
                [t('common.type'), r.identity.type],
                ...(r.identity.principalId ? [[t('res.principalId'), <span key="p" className="row"><IdText value={r.identity.principalId} />{identitySp.data && <Link href={`/entra/enterprise-apps/${r.identity.principalId}`} className="small">{t('nav.enterpriseApps')}</Link>}</span>] as [string, React.ReactNode]] : []),
                ...(identitySp.data ? [[t('res.clientId'), <IdText key="c" value={identitySp.data.appId} />] as [string, React.ReactNode]] : []),
                ...Object.entries(r.identity.userAssignedIdentities ?? {}).map(([k, v]: [string, any]) => [k.split('/').pop(), <span key={k} className="small mono">{v.clientId}</span>] as [string, React.ReactNode]),
              ]} />
            </Card>
          )}
          {r.type === 'Microsoft.ManagedIdentity/userAssignedIdentities' && (
            <Notice>{t('conn.imds')}: <code>curl -H "Metadata: true" &quot;/metadata/identity/oauth2/token?api-version=2018-02-01&amp;resource=https://management.azure.com/&amp;client_id={r.properties.clientId}&quot;</code></Notice>
          )}
        </div>
      ))}
      {tab === 'keys' && (
        <div className="stack" style={{ gap: 16 }}>
          <Notice tone="warn">{t('res.keysHint')}</Notice>
          {listActions.map((a) => (
            <Card key={a} title={<span className="mono">{a}</span>} actions={def?.actions.some((x) => /^regenerate/i.test(x)) ? (
              <Button size="sm" icon={KeyRound} onClick={async () => {
                const action = def!.actions.find((x) => /^regenerate/i.test(x))!;
                if (!(await confirm({ title: t('res.regenerate'), text: action, danger: true }))) return;
                try { await arm.post(`${id}/${action}`, { keyName: 'key1', keyType: 'PrimaryKey', keyKind: 'primary', name: 'password' }, apiVersion); setSecrets({}); setTab('overview'); setTimeout(() => setTab('keys'), 0); } catch (e) { toast.error(e); }
              }}>{t('res.regenerate')}</Button>
            ) : undefined}>
              {!secrets[a] ? <Skeleton rows={2} /> : secrets[a].__error ? <ErrorNotice error={secrets[a].__error} /> : <SecretsView data={secrets[a]} />}
            </Card>
          ))}
        </div>
      )}
      {tab === 'children' && (
        <div className="stack" style={{ gap: 18 }}>
          {childTypes.map((ct) => <ChildList key={ct.type} parentId={id} def={ct} onAdd={() => { setChildOpen(ct); setChildName(''); }} />)}
        </div>
      )}
      {svcTabs.find((s) => s.key === tab)?.render()}
      {tab === 'secrets' && <VaultSecrets vaultId={id} />}
      {tab === 'costs' && <ResourceCosts id={id} type={info.type} apiVersion={apiVersion} />}
      {tab === 'json' && (r ? <CodeBlock value={r} maxHeight={1200} /> : <Skeleton />)}
      {tab === 'activity' && (
        <DataTable rows={activity.data} loading={activity.loading} error={activity.error} rowKey={(e) => e.eventDataId} empty={t('act.empty')}
          columns={[
            { key: 'op', header: t('act.operation'), render: (e) => <span className="mono small">{e.operationName.value}</span> },
            { key: 'st', header: t('act.status'), render: (e) => <Badge tone={e.status.value === 'Failed' ? 'bad' : 'ok'}>{e.status.value}</Badge> },
            { key: 'ts', header: t('act.time'), render: (e) => fmtDate(e.eventTimestamp) },
            { key: 'ca', header: t('act.caller'), render: (e) => e.caller },
          ]} />
      )}
      <Panel wide open={json !== null} onClose={() => setJson(null)} title={t('res.editJson')} subtitle={`PUT ${apiVersion}`} footer={<><Button variant="primary" onClick={saveJson}>{t('common.save')}</Button><Button onClick={() => setJson(null)}>{t('common.cancel')}</Button></>}>
        {json !== null && <JsonEditor value={json} onChange={setJson} rows={30} />}
      </Panel>
      <Panel open={tags !== null} onClose={() => setTags(null)} title={t('common.tags')} footer={<><Button variant="primary" onClick={async () => { try { await arm.put(`${id}/providers/Microsoft.Resources/tags/default`, { properties: { tags } }); setTags(null); await res.reload(); toast.ok(t('common.saved')); } catch (e) { toast.error(e); } }}>{t('common.save')}</Button><Button onClick={() => setTags(null)}>{t('common.cancel')}</Button></>}>
        {tags && <TagEditor value={tags} onChange={setTags} />}
      </Panel>
      <Panel open={!!childOpen} onClose={() => setChildOpen(null)} title={childOpen ? t('res.addChild', { type: childOpen.label[locale] }) : ''} footer={<><Button variant="primary" disabled={!childName} onClick={async () => {
        try {
          const body = JSON.parse(childProps || '{}');
          await arm.put(`${id}/${childOpen!.type.split('/').pop()}/${childName}`, body, childOpen!.apiVersion);
          toast.ok(t('create.done', { name: childName }));
          setChildOpen(null);
          setTab('overview');
          setTimeout(() => setTab('children'), 0);
        } catch (e) { toast.error(e); }
      }}>{t('common.create')}</Button><Button onClick={() => setChildOpen(null)}>{t('common.cancel')}</Button></>}>
        <Field label={t('res.childName')} required htmlFor="cn"><Input id="cn" value={childName} onChange={(e) => setChildName(e.target.value)} /></Field>
        <Field label={t('create.advanced')}><JsonEditor value={childProps} onChange={setChildProps} rows={10} /></Field>
      </Panel>
    </>
  );
}

function ChildList({ parentId, def, onAdd }: { parentId: string; def: CatalogType; onAdd: () => void }) {
  const { t, locale } = useI18n();
  const seg = def.type.split('/').pop()!;
  const list = useAsync(async () => (await arm.get<{ value: any[] }>(`${parentId}/${seg}`, def.apiVersion)).value, [parentId, seg]);
  return (
    <section>
      <div className="spread mb-16">
        <h2>{def.label[locale]}</h2>
        <Button size="sm" icon={Plus} onClick={onAdd}>{t('common.add')}</Button>
      </div>
      <DataTable rows={list.data} loading={list.loading} error={list.error} rowKey={(c) => c.id} empty={t('res.noChildren')}
        columns={[
          { key: 'n', header: t('common.name'), render: (c) => <div className="cell-main"><ResourceIcon type={def.type} size="sm" /><Link href={`/resource?id=${encodeURIComponent(c.id)}`}>{c.name}</Link></div> },
          { key: 's', header: t('res.provisioning'), render: (c) => <StateBadge state={c.properties?.provisioningState ?? 'Succeeded'} /> },
        ]} />
    </section>
  );
}

