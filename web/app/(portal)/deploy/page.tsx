'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { CheckCircle2, Eye, FileCode2, Rocket } from 'lucide-react';
import { arm } from '@/lib/api';
import { rgId, resourceHref } from '@/lib/arm';
import { useI18n, type MessageKey } from '@/i18n';
import { JsonEditor, PageHeader } from '@/components/page';
import { Badge, Button, Card, ErrorNotice, Field, Input, Notice, Select } from '@/components/ui';
import { useToast } from '@/components/overlay';
import { LocationSelect, ResourceGroupSelect, SubscriptionSelect } from '@/components/pickers';
import { DataTable } from '@/components/table';

const SAMPLE = {
  $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
  contentVersion: '1.0.0.0',
  parameters: {
    prefix: { type: 'string', defaultValue: 'azz', maxLength: 8 },
    location: { type: 'string', defaultValue: '[resourceGroup().location]' },
  },
  variables: {
    storageName: "[format('{0}st{1}', parameters('prefix'), take(uniqueString(resourceGroup().id), 8))]",
  },
  resources: [
    { type: 'Microsoft.Storage/storageAccounts', apiVersion: '2023-01-01', name: "[variables('storageName')]", location: "[parameters('location')]", sku: { name: 'Standard_LRS' }, kind: 'StorageV2' },
    { type: 'Microsoft.Web/serverfarms', apiVersion: '2023-01-01', name: "[format('{0}-plan', parameters('prefix'))]", location: "[parameters('location')]", sku: { name: 'B1' }, properties: { reserved: true } },
    {
      type: 'Microsoft.Web/sites', apiVersion: '2023-01-01', name: "[format('{0}-web-{1}', parameters('prefix'), take(uniqueString(resourceGroup().id), 6))]", location: "[parameters('location')]",
      identity: { type: 'SystemAssigned' },
      dependsOn: ["[resourceId('Microsoft.Web/serverfarms', format('{0}-plan', parameters('prefix')))]"],
      properties: {
        serverFarmId: "[resourceId('Microsoft.Web/serverfarms', format('{0}-plan', parameters('prefix')))]",
        siteConfig: { linuxFxVersion: 'NODE|22-lts', appSettings: [{ name: 'STORAGE_ENDPOINT', value: "[reference(variables('storageName')).primaryEndpoints.blob]" }] },
      },
    },
  ],
  outputs: {
    storageEndpoint: { type: 'string', value: "[reference(variables('storageName')).primaryEndpoints.blob]" },
  },
};

export default function DeployPage() {
  const { t } = useI18n();
  const toast = useToast();
  const router = useRouter();
  const [scope, setScope] = useState<'resourceGroup' | 'subscription'>('resourceGroup');
  const [sub, setSub] = useState('');
  const [rg, setRg] = useState('');
  const [name, setName] = useState(`deployment-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`);
  const [location, setLocation] = useState('italynorth');
  const [mode, setMode] = useState('Incremental');
  const [template, setTemplate] = useState('');
  const [params, setParams] = useState('{}');
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ kind: 'valid' | 'whatif'; data: any } | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    const tpl = sessionStorage.getItem('azzurro:template');
    if (tpl) { setTemplate(tpl); sessionStorage.removeItem('azzurro:template'); }
    const pr = sessionStorage.getItem('azzurro:parameters');
    if (pr) { setParams(pr); sessionStorage.removeItem('azzurro:parameters'); }
    const sc = sessionStorage.getItem('azzurro:scope');
    if (sc) {
      const s = JSON.parse(sc);
      sessionStorage.removeItem('azzurro:scope');
      if (s.sub) setSub(s.sub);
      if (s.rg) setRg(s.rg); else setScope('subscription');
      if (s.name) setName(s.name);
      if (s.location) setLocation(s.location);
    }
  }, []);

  useEffect(() => {
    try {
      const schema = String(JSON.parse(template).$schema ?? '');
      if (/subscriptionDeploymentTemplate/i.test(schema)) setScope('subscription');
      else if (/deploymentTemplate/i.test(schema)) setScope('resourceGroup');
    } catch { /* */ }
  }, [template]);

  const base = scope === 'resourceGroup' ? rgId(sub, rg) : `/subscriptions/${sub}`;
  const path = `${base}/providers/Microsoft.Resources/deployments/${name}`;
  const body = () => {
    const p = JSON.parse(params || '{}');
    return { ...(scope === 'subscription' ? { location } : {}), properties: { mode, template: JSON.parse(template), parameters: p.$schema ? p.parameters : p } };
  };
  const run = async (kind: 'validate' | 'whatIf' | 'deploy') => {
    setBusy(kind);
    setError(null);
    setResult(null);
    try {
      if (kind === 'deploy') {
        await arm.put(path, body(), '2022-09-01');
        toast.ok(t('dep.started'), name);
        router.push(`/deployment?id=${encodeURIComponent(path)}`);
        return;
      }
      const r = await arm.post(`${path}/${kind}`, body(), '2022-09-01');
      if (kind === 'whatIf' && r.status === 'Failed') throw Object.assign(new Error(r.error?.message), r.error);
      setResult({ kind: kind === 'validate' ? 'valid' : 'whatif', data: r });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  let tplValid = true;
  try { JSON.parse(template); } catch { tplValid = false; }
  const ready = tplValid && !!sub && (scope === 'subscription' || !!rg) && !!name;
  return (
    <>
      <PageHeader title={t('dep.new')} subtitle={t('dep.template.hint')} icon={FileCode2} crumbs={[{ label: t('nav.deployments'), href: '/deployments' }, { label: t('dep.new') }]} />
      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <Card title={t('dep.target')}>
          <Field label={t('dep.scope')} htmlFor="d-scope">
            <Select id="d-scope" value={scope} onChange={(e) => setScope(e.target.value as any)}>
              <option value="resourceGroup">{t('dep.scope.resourceGroup')}</option>
              <option value="subscription">{t('dep.scope.subscription')}</option>
            </Select>
          </Field>
          <Field label={t('common.subscription')} required htmlFor="d-sub"><SubscriptionSelect id="d-sub" value={sub} onChange={setSub} /></Field>
          {scope === 'resourceGroup'
            ? <Field label={t('common.resourceGroup')} required htmlFor="d-rg"><ResourceGroupSelect id="d-rg" sub={sub} value={rg} onChange={setRg} /></Field>
            : <Field label={t('dep.location')} required htmlFor="d-loc"><LocationSelect id="d-loc" value={location} onChange={setLocation} /></Field>}
          <Field label={t('dep.name')} required htmlFor="d-name"><Input id="d-name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label={t('dep.mode')} htmlFor="d-mode">
            <Select id="d-mode" value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="Incremental">{t('dep.incremental')}</option>
              {scope === 'resourceGroup' && <option value="Complete">{t('dep.complete')}</option>}
            </Select>
          </Field>
        </Card>
        <Card title={t('dep.parameters')}>
          <p className="small muted mb-16">{t('dep.parameters.hint')}</p>
          <JsonEditor value={params} onChange={setParams} rows={14} />
        </Card>
      </div>
      <div className="mt-16">
        <Card title={t('dep.template')} actions={<Button size="sm" onClick={() => { setTemplate(JSON.stringify(SAMPLE, null, 2)); setScope('resourceGroup'); }}>{t('dep.loadSample')}</Button>}>
          <JsonEditor value={template} onChange={setTemplate} rows={22} />
        </Card>
      </div>
      <div className="row wrap mt-16">
        <Button icon={CheckCircle2} loading={busy === 'validate'} disabled={!ready || !!busy} onClick={() => run('validate')}>{t('dep.validate')}</Button>
        <Button icon={Eye} loading={busy === 'whatIf'} disabled={!ready || !!busy} onClick={() => run('whatIf')}>{t('dep.whatIf')}</Button>
        <Button variant="primary" icon={Rocket} loading={busy === 'deploy'} disabled={!ready || !!busy} onClick={() => run('deploy')}>{t('dep.deploy')}</Button>
      </div>
      <div className="mt-16">
        {error ? <ErrorNotice error={error} /> : null}
        {result?.kind === 'valid' && <Notice tone="ok" title={t('dep.valid')}>{(result.data.properties.validatedResources ?? []).length} · {result.data.properties.templateHash}</Notice>}
        {result?.kind === 'whatif' && (
          <section className="mt-16">
            <h2 className="mb-16">{t('dep.changes')}</h2>
            <DataTable rows={result.data.properties.changes} rowKey={(c: any) => c.resourceId}
              columns={[
                { key: 'c', header: t('common.status'), render: (c: any) => <Badge tone={c.changeType === 'Create' ? 'ok' : c.changeType === 'Modify' ? 'warn' : c.changeType === 'Delete' ? 'bad' : undefined}>{t(`dep.change.${c.changeType}` as MessageKey)}</Badge> },
                { key: 'r', header: t('act.resource'), render: (c: any) => <a href={resourceHref(c.resourceId)} className="mono small">{c.resourceId.split('/').slice(-3).join('/')}</a> },
                { key: 'd', header: t('dep.beforeAfter'), render: (c: any) => (c.delta ?? []).length ? (
                  <div className="delta-list">
                    {(c.delta ?? []).slice(0, 8).map((x: any) => (
                      <div className="delta" key={x.path}>
                        <span className="dp mono">{x.path || '·'}</span>
                        <span className="db mono">{x.before === undefined ? '—' : short(x.before)}</span>
                        <span className="da mono">{x.after === undefined ? '—' : short(x.after)}</span>
                      </div>
                    ))}
                  </div>
                ) : <span className="small muted">—</span> },
              ]} />
          </section>
        )}
      </div>
    </>
  );
}

/** valore compatto per il confronto prima/dopo */
function short(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}
