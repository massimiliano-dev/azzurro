'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Check, KeyRound, Plus, ShieldCheck, Trash2, Upload, X } from 'lucide-react';
import { graph, portal } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { useI18n, type MessageKey } from '@/i18n';
import { JsonEditor } from './page';
import { Badge, Button, Card, Checkbox, CodeBlock, Empty, ErrorNotice, Field, IdText, Input, KV, Notice, SecretValue, Select, Skeleton, Switch, Textarea } from './ui';
import { Panel, useConfirm, useToast } from './overlay';
import { DataTable } from './table';

export interface AppCtx {
  app: any;
  sp: any | null;
  reload: () => Promise<void>;
  reloadSp: () => Promise<void>;
}

const GRAPH = '00000003-0000-0000-c000-000000000000';
const ARM = '797f4846-ba00-4fd7-ba43-dac1f8f63013';

function usePatch(ctx: AppCtx) {
  const toast = useToast();
  const { t } = useI18n();
  return async (body: any, msg?: string) => {
    try {
      await graph.patch(`/applications/${ctx.app.id}`, body);
      toast.ok(msg ?? t('common.saved'));
      await ctx.reload();
      return true;
    } catch (e) {
      toast.error(e);
      return false;
    }
  };
}

// ---------------- Panoramica ----------------

export function OverviewTab({ ctx }: { ctx: AppCtx }) {
  const { t, fmtDate } = useI18n();
  const toast = useToast();
  const cfg = useAsync(() => portal.get<any>('/config'), []);
  const a = ctx.app;
  const base = cfg.data?.httpsAvailable ? cfg.data.httpsUrl : cfg.data?.apiUrl;
  const tid = cfg.data?.tenantId;
  const endpoints: [string, string][] = base ? [
    ['OAuth 2.0 authorization endpoint (v2)', `${base}/${tid}/oauth2/v2.0/authorize`],
    ['OAuth 2.0 token endpoint (v2)', `${base}/${tid}/oauth2/v2.0/token`],
    ['OAuth 2.0 device code (v2)', `${base}/${tid}/oauth2/v2.0/devicecode`],
    ['OAuth 2.0 authorization endpoint (v1)', `${base}/${tid}/oauth2/authorize`],
    ['OAuth 2.0 token endpoint (v1)', `${base}/${tid}/oauth2/token`],
    ['OpenID Connect metadata', `${base}/${tid}/v2.0/.well-known/openid-configuration`],
    ['Microsoft Graph API', `${base}/v1.0`],
    ['Azure Resource Manager', `${base}/`],
  ] : [];
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card title={t('res.essentials')}>
        <KV items={[
          [t('apps.name'), a.displayName],
          [t('apps.appId'), <IdText key="a" value={a.appId} />],
          [t('apps.objectId'), <IdText key="o" value={a.id} />],
          [t('apps.tenantId'), <IdText key="t" value={tid} />],
          [t('apps.audience'), t(`apps.audience.${a.signInAudience}` as MessageKey)],
          [t('common.created'), fmtDate(a.createdDateTime)],
          [t('apps.tab.credentials'), `${a.keyCredentials?.length ?? 0} cert · ${a.passwordCredentials?.length ?? 0} secret`],
          [t('apps.redirectUris'), `${a.web?.redirectUris?.length ?? 0} web · ${a.spa?.redirectUris?.length ?? 0} spa · ${a.publicClient?.redirectUris?.length ?? 0} public`],
          [t('apps.identifierUri'), a.identifierUris?.[0] ? <IdText key="u" value={a.identifierUris[0]} /> : null],
          [t('apps.enterpriseLink'), ctx.sp ? <Link key="sp" href={`/entra/enterprise-apps/${ctx.sp.id}`}>{ctx.sp.displayName}</Link> : (
            <Button key="c" size="sm" onClick={async () => { try { await graph.post('/servicePrincipals', { appId: a.appId }); await ctx.reloadSp(); } catch (e) { toast.error(e); } }}>{t('apps.createSp')}</Button>
          )],
        ]} />
      </Card>
      {!ctx.sp && <Notice tone="warn">{t('apps.spMissing')}</Notice>}
      <Card title={t('apps.endpoints')}>
        {!cfg.data ? <Skeleton /> : <KV items={endpoints.map(([k, v]) => [k, <IdText key={k} value={v} />])} />}
      </Card>
      {cfg.data && (
        <Card title="curl">
          <CodeBlock value={`curl -s -X POST ${base}/${tid}/oauth2/v2.0/token \\\n  -d grant_type=client_credentials \\\n  -d client_id=${a.appId} \\\n  -d client_secret=<SECRET> \\\n  -d scope=https://management.azure.com/.default`} />
        </Card>
      )}
    </div>
  );
}

// ---------------- Autenticazione ----------------

function UriList({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState('');
  const valid = /^[a-z][a-z0-9+.-]*:/i.test(draft);
  return (
    <div className="stack" style={{ gap: 6 }}>
      {value.map((u, i) => (
        <div className="input-group" key={i}>
          <Input value={u} onChange={(e) => onChange(value.map((x, j) => (j === i ? e.target.value : x)))} aria-label={t('apps.redirect')} />
          <Button variant="ghost" size="sm" iconOnly icon={Trash2} aria-label={t('common.remove')} onClick={() => onChange(value.filter((_, j) => j !== i))} />
        </div>
      ))}
      <div className="input-group">
        <Input placeholder={placeholder} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={t('apps.addUri')} onKeyDown={(e) => { if (e.key === 'Enter' && valid) { e.preventDefault(); onChange([...value, draft]); setDraft(''); } }} />
        <Button size="sm" icon={Plus} disabled={!valid} onClick={() => { onChange([...value, draft]); setDraft(''); }}>{t('apps.addUri')}</Button>
      </div>
    </div>
  );
}

export function AuthTab({ ctx }: { ctx: AppCtx }) {
  const { t } = useI18n();
  const patch = usePatch(ctx);
  const a = ctx.app;
  const [web, setWeb] = useState<string[]>(a.web?.redirectUris ?? []);
  const [spa, setSpa] = useState<string[]>(a.spa?.redirectUris ?? []);
  const [pub, setPub] = useState<string[]>(a.publicClient?.redirectUris ?? []);
  const [logout, setLogout] = useState<string>(a.web?.logoutUrl ?? '');
  const [access, setAccess] = useState<boolean>(!!a.web?.implicitGrantSettings?.enableAccessTokenIssuance);
  const [idt, setIdt] = useState<boolean>(!!a.web?.implicitGrantSettings?.enableIdTokenIssuance);
  const [fallback, setFallback] = useState<boolean>(!!a.isFallbackPublicClient);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    await patch({
      web: { redirectUris: web, logoutUrl: logout || null, implicitGrantSettings: { enableAccessTokenIssuance: access, enableIdTokenIssuance: idt } },
      spa: { redirectUris: spa },
      publicClient: { redirectUris: pub },
      isFallbackPublicClient: fallback,
    });
    setBusy(false);
  };
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card title={t('apps.platform.web')}>
        <Field label={t('apps.redirectUris')}><UriList value={web} onChange={setWeb} placeholder="https://localhost:5001/signin-oidc" /></Field>
        <Field label={t('apps.logoutUrl')}><Input value={logout} onChange={(e) => setLogout(e.target.value)} placeholder="https://localhost:5001/signout-oidc" /></Field>
        <Field label={t('apps.implicit')}>
          <Checkbox checked={access} onChange={setAccess} label={t('apps.accessTokens')} />
          <Checkbox checked={idt} onChange={setIdt} label={t('apps.idTokens')} />
        </Field>
      </Card>
      <Card title={t('apps.platform.spa')}><UriList value={spa} onChange={setSpa} placeholder="http://localhost:5173" /></Card>
      <Card title={t('apps.platform.public')}><UriList value={pub} onChange={setPub} placeholder="http://localhost" /></Card>
      <Card title={t('apps.publicFlows')}>
        <Switch checked={fallback} onChange={setFallback} label={t('apps.publicFlowsHint')} />
      </Card>
      <div><Button variant="primary" loading={busy} onClick={save}>{t('common.save')}</Button></div>
    </div>
  );
}

// ---------------- Certificati e segreti ----------------

export function CredentialsTab({ ctx }: { ctx: AppCtx }) {
  const { t, fmtDate } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const patch = usePatch(ctx);
  const a = ctx.app;
  const [secretOpen, setSecretOpen] = useState(false);
  const [desc, setDesc] = useState('');
  const [months, setMonths] = useState('6');
  const [created, setCreated] = useState<{ value: string; keyId: string; name: string }[]>([]);
  const [ficOpen, setFicOpen] = useState(false);
  const [fic, setFic] = useState({ scenario: 'github', name: '', org: '', repo: '', entity: 'branch', value: 'main', issuer: '', subject: '', ns: 'default', sa: '', description: '', audience: 'api://AzureADTokenExchange' });
  const fics = useAsync(() => graph.list<any>(`/applications/${a.id}/federatedIdentityCredentials`), [a.id]);
  const addSecret = async () => {
    try {
      const end = new Date();
      end.setMonth(end.getMonth() + Number(months));
      const r = await graph.post<any>(`/applications/${a.id}/addPassword`, { passwordCredential: { displayName: desc || undefined, endDateTime: end.toISOString() } });
      setCreated((c) => [{ value: r.secretText, keyId: r.keyId, name: r.displayName ?? '' }, ...c]);
      setSecretOpen(false);
      setDesc('');
      await ctx.reload();
    } catch (e) {
      toast.error(e);
    }
  };
  const upload = async (file: File) => {
    const text = await file.text();
    let key: string;
    const m = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(text);
    if (m) key = m[1].replace(/\s+/g, '');
    else key = btoa(String.fromCharCode(...new Uint8Array(await file.arrayBuffer())));
    await patch({ keyCredentials: [...(a.keyCredentials ?? []).map((k: any) => ({ keyId: k.keyId })), { type: 'AsymmetricX509Cert', usage: 'Verify', key, displayName: file.name }] });
  };
  const ficSubject = fic.scenario === 'github'
    ? `repo:${fic.org}/${fic.repo}:${fic.entity === 'branch' ? `ref:refs/heads/${fic.value}` : fic.entity === 'tag' ? `ref:refs/tags/${fic.value}` : fic.entity === 'environment' ? `environment:${fic.value}` : 'pull_request'}`
    : fic.scenario === 'k8s' ? `system:serviceaccount:${fic.ns}:${fic.sa}` : fic.subject;
  const ficIssuer = fic.scenario === 'github' ? 'https://token.actions.githubusercontent.com' : fic.issuer;
  return (
    <div className="stack" style={{ gap: 18 }}>
      {created.map((c) => (
        <Notice key={c.keyId} tone="warn" title={`${t('apps.newSecret')}${c.name ? ` · ${c.name}` : ''}`}>
          <div className="mt-8"><SecretValue value={c.value} /></div>
          <div className="small mt-8">{t('apps.secretCopyWarning')} · {t('apps.secretId')}: <span className="mono">{c.keyId}</span></div>
        </Notice>
      ))}
      <section>
        <div className="spread mb-16"><h2>{t('apps.secrets')}</h2><Button size="sm" icon={Plus} onClick={() => setSecretOpen(true)}>{t('apps.newSecret')}</Button></div>
        <DataTable rows={(a.passwordCredentials ?? []) as any[]} rowKey={(s) => s.keyId} empty={t('apps.noSecrets')}
          columns={[
            { key: 'd', header: t('apps.secretDesc'), render: (s) => s.displayName ?? '—' },
            { key: 'e', header: t('apps.expires'), render: (s) => <Badge tone={Date.parse(s.endDateTime) < Date.now() ? 'bad' : Date.parse(s.endDateTime) < Date.now() + 30 * 86400e3 ? 'warn' : undefined}>{fmtDate(s.endDateTime, 'short')}</Badge> },
            { key: 'v', header: t('apps.secretValue'), render: (s) => <span className="mono">{s.hint}{'*'.repeat(10)}</span> },
            { key: 'id', header: t('apps.secretId'), render: (s) => <IdText value={s.keyId} short /> },
            { key: 'x', header: '', render: (s) => <Button size="sm" variant="ghost" icon={Trash2} aria-label={t('common.delete')} onClick={async () => {
              if (!(await confirm({ title: t('common.delete'), text: s.displayName ?? s.keyId, danger: true }))) return;
              try { await graph.post(`/applications/${a.id}/removePassword`, { keyId: s.keyId }); await ctx.reload(); } catch (e) { toast.error(e); }
            }} /> },
          ]} />
      </section>
      <section>
        <div className="spread mb-16">
          <h2>{t('apps.certs')}</h2>
          <label className="btn sm"><Upload size={14} />{t('apps.uploadCert')}<input type="file" accept=".cer,.crt,.pem" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} /></label>
        </div>
        <p className="small muted mb-16">{t('apps.certHint')}</p>
        <DataTable rows={(a.keyCredentials ?? []) as any[]} rowKey={(k) => k.keyId} empty={t('apps.noCerts')}
          columns={[
            { key: 'th', header: t('apps.thumbprint'), render: (k) => <span className="mono small">{k.customKeyIdentifier}</span> },
            { key: 'd', header: t('apps.secretDesc'), render: (k) => <span className="small">{k.displayName}</span> },
            { key: 'e', header: t('apps.expires'), render: (k) => fmtDate(k.endDateTime, 'short') },
            { key: 'x', header: '', render: (k) => <Button size="sm" variant="ghost" icon={Trash2} aria-label={t('common.delete')} onClick={() => patch({ keyCredentials: (a.keyCredentials ?? []).filter((x: any) => x.keyId !== k.keyId).map((x: any) => ({ keyId: x.keyId })) })} /> },
          ]} />
      </section>
      <section>
        <div className="spread mb-16"><h2>{t('apps.fic')}</h2><Button size="sm" icon={Plus} onClick={() => setFicOpen(true)}>{t('apps.newFic')}</Button></div>
        <DataTable rows={fics.data} loading={fics.loading} error={fics.error} rowKey={(f) => f.id} empty={t('apps.noFic')}
          columns={[
            { key: 'n', header: t('common.name'), render: (f) => f.name },
            { key: 'i', header: t('apps.issuer'), render: (f) => <span className="small mono">{f.issuer}</span> },
            { key: 's', header: t('apps.subject'), render: (f) => <span className="small mono">{f.subject}</span> },
            { key: 'x', header: '', render: (f) => <Button size="sm" variant="ghost" icon={Trash2} aria-label={t('common.delete')} onClick={async () => { try { await graph.del(`/applications/${a.id}/federatedIdentityCredentials/${f.id}`); await fics.reload(); } catch (e) { toast.error(e); } }} /> },
          ]} />
      </section>
      <Panel open={secretOpen} onClose={() => setSecretOpen(false)} title={t('apps.newSecret')} footer={<><Button variant="primary" onClick={addSecret}>{t('common.add')}</Button><Button onClick={() => setSecretOpen(false)}>{t('common.cancel')}</Button></>}>
        <Field label={t('apps.secretDesc')} htmlFor="sd"><Input id="sd" value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
        <Field label={t('apps.expires')} htmlFor="se">
          <Select id="se" value={months} onChange={(e) => setMonths(e.target.value)}>
            {['6', '12', '24'].map((m) => <option key={m} value={m}>{t(`apps.expiry.${m}` as MessageKey)}</option>)}
          </Select>
        </Field>
      </Panel>
      <Panel open={ficOpen} onClose={() => setFicOpen(false)} title={t('apps.newFic')} footer={<><Button variant="primary" disabled={!fic.name || !ficIssuer || !ficSubject} onClick={async () => {
        try {
          await graph.post(`/applications/${a.id}/federatedIdentityCredentials`, { name: fic.name, issuer: ficIssuer, subject: ficSubject, audiences: [fic.audience], description: fic.description || undefined });
          setFicOpen(false);
          await fics.reload();
        } catch (e) { toast.error(e); }
      }}>{t('common.add')}</Button><Button onClick={() => setFicOpen(false)}>{t('common.cancel')}</Button></>}>
        <Field label={t('apps.ficScenario')} htmlFor="fs">
          <Select id="fs" value={fic.scenario} onChange={(e) => setFic({ ...fic, scenario: e.target.value })}>
            <option value="github">{t('apps.ficScenario.github')}</option>
            <option value="k8s">{t('apps.ficScenario.k8s')}</option>
            <option value="other">{t('apps.ficScenario.other')}</option>
          </Select>
        </Field>
        {fic.scenario === 'github' && (
          <div className="form-grid">
            <Field label={t('apps.ficOrg')}><Input value={fic.org} onChange={(e) => setFic({ ...fic, org: e.target.value })} /></Field>
            <Field label={t('apps.ficRepo')}><Input value={fic.repo} onChange={(e) => setFic({ ...fic, repo: e.target.value })} /></Field>
            <Field label={t('apps.ficEntity')}>
              <Select value={fic.entity} onChange={(e) => setFic({ ...fic, entity: e.target.value })}>
                {['branch', 'environment', 'pull_request', 'tag'].map((x) => <option key={x} value={x}>{t(`apps.ficEntity.${x}` as MessageKey)}</option>)}
              </Select>
            </Field>
            {fic.entity !== 'pull_request' && <Field label={t('apps.ficValue')}><Input value={fic.value} onChange={(e) => setFic({ ...fic, value: e.target.value })} /></Field>}
          </div>
        )}
        {fic.scenario === 'k8s' && (
          <>
            <Field label={t('apps.issuer')}><Input value={fic.issuer} onChange={(e) => setFic({ ...fic, issuer: e.target.value })} placeholder="https://oidc.example/issuer" /></Field>
            <div className="form-grid">
              <Field label={t('apps.ficNs')}><Input value={fic.ns} onChange={(e) => setFic({ ...fic, ns: e.target.value })} /></Field>
              <Field label={t('apps.ficSa')}><Input value={fic.sa} onChange={(e) => setFic({ ...fic, sa: e.target.value })} /></Field>
            </div>
          </>
        )}
        {fic.scenario === 'other' && (
          <>
            <Field label={t('apps.issuer')}><Input value={fic.issuer} onChange={(e) => setFic({ ...fic, issuer: e.target.value })} /></Field>
            <Field label={t('apps.subject')}><Input value={fic.subject} onChange={(e) => setFic({ ...fic, subject: e.target.value })} /></Field>
          </>
        )}
        <Field label={t('common.name')} required><Input value={fic.name} onChange={(e) => setFic({ ...fic, name: e.target.value })} /></Field>
        <Field label={t('apps.audiences')}><Input value={fic.audience} onChange={(e) => setFic({ ...fic, audience: e.target.value })} /></Field>
        <Field label={t('common.description')}><Input value={fic.description} onChange={(e) => setFic({ ...fic, description: e.target.value })} /></Field>
        <Notice><div className="small mono">{ficIssuer}<br />{ficSubject}</div></Notice>
      </Panel>
    </div>
  );
}

// ---------------- Autorizzazioni API ----------------

interface ApiInfo { sp: any; scopes: any[]; roles: any[] }

export function PermissionsTab({ ctx }: { ctx: AppCtx }) {
  const { t } = useI18n();
  const toast = useToast();
  const { session } = useSession();
  const patch = usePatch(ctx);
  const a = ctx.app;
  const rra: any[] = a.requiredResourceAccess ?? [];
  const apis = useAsync(async () => {
    const out: Record<string, ApiInfo> = {};
    for (const appId of new Set([GRAPH, ARM, ...rra.map((r) => r.resourceAppId)])) {
      try {
        const sp = await graph.get<any>(`/servicePrincipals(appId='${appId}')`);
        out[appId] = { sp, scopes: sp.oauth2PermissionScopes ?? [], roles: (sp.appRoles ?? []).filter((r: any) => (r.allowedMemberTypes ?? []).includes('Application')) };
      } catch { /* API non presente */ }
    }
    return out;
  }, [JSON.stringify(rra.map((r) => r.resourceAppId))]);
  const grants = useAsync(async () => {
    if (!ctx.sp) return { delegated: [] as any[], app: [] as any[] };
    const [delegated, app] = await Promise.all([graph.list<any>(`/servicePrincipals/${ctx.sp.id}/oauth2PermissionGrants`), graph.list<any>(`/servicePrincipals/${ctx.sp.id}/appRoleAssignments`)]);
    return { delegated, app };
  }, [ctx.sp?.id]);
  const rows = rra.flatMap((r) => (r.resourceAccess ?? []).map((ra: any) => {
    const api = apis.data?.[r.resourceAppId];
    const scope = ra.type === 'Scope' ? api?.scopes.find((s) => s.id === ra.id) : undefined;
    const role = ra.type === 'Role' ? (api?.sp.appRoles ?? []).find((x: any) => x.id === ra.id) : undefined;
    const granted = ra.type === 'Scope'
      ? (grants.data?.delegated ?? []).some((g) => g.resourceId === api?.sp.id && g.consentType === 'AllPrincipals' && String(g.scope).split(' ').includes(scope?.value))
      : (grants.data?.app ?? []).some((x) => x.resourceId === api?.sp.id && x.appRoleId === ra.id);
    return { key: `${r.resourceAppId}:${ra.id}:${ra.type}`, resourceAppId: r.resourceAppId, ra, api, value: scope?.value ?? role?.value ?? ra.id, desc: scope?.adminConsentDisplayName ?? role?.displayName ?? '', granted };
  }));
  const [addOpen, setAddOpen] = useState(false);
  const [pickApi, setPickApi] = useState<string | null>(null);
  const [kind, setKind] = useState<'Scope' | 'Role'>('Scope');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const orgApis = useAsync(async () => (await graph.list<any>('/servicePrincipals?$top=999')).filter((sp) => sp.appOwnerOrganizationId === session?.tenant.id && sp.appId !== a.appId && ((sp.oauth2PermissionScopes ?? []).length || (sp.appRoles ?? []).some((r: any) => (r.allowedMemberTypes ?? []).includes('Application')))), [addOpen], { enabled: addOpen });
  const removePerm = async (resourceAppId: string, id: string, type: string) => {
    const next = rra.map((r) => (r.resourceAppId === resourceAppId ? { ...r, resourceAccess: r.resourceAccess.filter((x: any) => !(x.id === id && x.type === type)) } : r)).filter((r) => r.resourceAccess.length);
    await patch({ requiredResourceAccess: next });
  };
  const addPerms = async () => {
    const next = [...rra.map((r) => ({ ...r, resourceAccess: [...r.resourceAccess] }))];
    let entry = next.find((r) => r.resourceAppId === pickApi);
    if (!entry) { entry = { resourceAppId: pickApi, resourceAccess: [] }; next.push(entry); }
    for (const id of chosen) if (!entry.resourceAccess.some((x: any) => x.id === id && x.type === kind)) entry.resourceAccess.push({ id, type: kind });
    if (await patch({ requiredResourceAccess: next }, t('apps.added'))) { setAddOpen(false); setPickApi(null); setChosen(new Set()); }
  };
  const grantConsent = async () => {
    try {
      let sp = ctx.sp;
      if (!sp) { sp = await graph.post('/servicePrincipals', { appId: a.appId }); await ctx.reloadSp(); }
      for (const r of rra) {
        const api = apis.data?.[r.resourceAppId];
        if (!api) continue;
        const scopes = r.resourceAccess.filter((x: any) => x.type === 'Scope').map((x: any) => api.scopes.find((s) => s.id === x.id)?.value).filter(Boolean);
        if (scopes.length) {
          const existing = (grants.data?.delegated ?? []).find((g) => g.resourceId === api.sp.id && g.consentType === 'AllPrincipals');
          if (existing) await graph.patch(`/oauth2PermissionGrants/${existing.id}`, { scope: [...new Set([...String(existing.scope).split(' ').filter(Boolean), ...scopes])].join(' ') });
          else await graph.post('/oauth2PermissionGrants', { clientId: sp.id, consentType: 'AllPrincipals', resourceId: api.sp.id, scope: scopes.join(' ') });
        }
        for (const x of r.resourceAccess.filter((y: any) => y.type === 'Role')) {
          if ((grants.data?.app ?? []).some((g) => g.resourceId === api.sp.id && g.appRoleId === x.id)) continue;
          await graph.post(`/servicePrincipals/${sp.id}/appRoleAssignments`, { principalId: sp.id, resourceId: api.sp.id, appRoleId: x.id });
        }
      }
      toast.ok(t('apps.consentDone'));
      await grants.reload();
    } catch (e) {
      toast.error(e);
    }
  };
  const revoke = async () => {
    try {
      for (const g of grants.data?.delegated ?? []) if (g.consentType === 'AllPrincipals') await graph.del(`/oauth2PermissionGrants/${g.id}`);
      for (const x of grants.data?.app ?? []) await graph.del(`/servicePrincipals/${ctx.sp.id}/appRoleAssignments/${x.id}`);
      await grants.reload();
    } catch (e) {
      toast.error(e);
    }
  };
  const api = pickApi ? (apis.data?.[pickApi] ?? (orgApis.data ?? []).map((sp) => ({ sp, scopes: sp.oauth2PermissionScopes ?? [], roles: (sp.appRoles ?? []).filter((r: any) => (r.allowedMemberTypes ?? []).includes('Application')) })).find((x) => x.sp.appId === pickApi)) : null;
  const options = (api ? (kind === 'Scope' ? api.scopes : api.roles) : []).filter((o: any) => `${o.value} ${o.adminConsentDisplayName ?? o.displayName}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row wrap">
        <Button icon={Plus} onClick={() => setAddOpen(true)}>{t('apps.addPermission')}</Button>
        <Button icon={ShieldCheck} disabled={!rra.length} onClick={grantConsent}>{t('apps.grantConsent', { tenant: session?.tenant.displayName ?? '' })}</Button>
        {(grants.data?.delegated.length || grants.data?.app.length) ? <Button variant="ghost" icon={X} onClick={revoke}>{t('apps.revokeConsent')}</Button> : null}
      </div>
      <DataTable rows={apis.data ? rows : undefined} loading={apis.loading} error={apis.error} rowKey={(r) => r.key} empty={t('apps.noPermissions')}
        columns={[
          { key: 'api', header: t('apps.api'), render: (r) => r.api?.sp.displayName ?? <span className="mono small">{r.resourceAppId}</span> },
          { key: 'p', header: t('apps.permission'), render: (r) => <span className="mono">{r.value}</span> },
          { key: 't', header: t('apps.permType'), render: (r) => <Badge>{r.ra.type === 'Scope' ? t('apps.delegated') : t('apps.application')}</Badge> },
          { key: 'd', header: t('common.description'), render: (r) => <span className="small">{r.desc}</span> },
          { key: 'c', header: t('apps.adminConsent'), render: (r) => r.granted ? <Badge tone="ok"><Check size={12} />{t('apps.consentGranted')}</Badge> : <Badge tone="warn">{t('apps.consentNotGranted')}</Badge> },
          { key: 'x', header: '', render: (r) => <Button size="sm" variant="ghost" icon={Trash2} aria-label={t('common.remove')} onClick={() => removePerm(r.resourceAppId, r.ra.id, r.ra.type)} /> },
        ]} />
      <Panel wide open={addOpen} onClose={() => { setAddOpen(false); setPickApi(null); }} title={t('apps.addPermission')} subtitle={api?.sp.displayName} footer={pickApi ? <><Button variant="primary" disabled={!chosen.size} onClick={addPerms}>{t('common.add')}</Button><Button onClick={() => { setPickApi(null); setChosen(new Set()); }}>{t('common.back')}</Button></> : undefined}>
        {!pickApi ? (
          <div className="stack">
            <h3>{t('apps.selectApi')}</h3>
            <div className="catalog">
              {[GRAPH, ARM].filter((x) => apis.data?.[x]).map((x) => (
                <a key={x} href="#" onClick={(e) => { e.preventDefault(); setPickApi(x); setKind('Scope'); }}><span className="res-icon c-identity"><KeyRound size={18} /></span><span><div className="t">{apis.data![x].sp.displayName}</div><div className="s">{x}</div></span></a>
              ))}
            </div>
            <h3 className="mt-16">{t('apps.myApis')}</h3>
            {orgApis.data?.length ? (
              <div className="catalog">
                {orgApis.data.map((sp) => <a key={sp.appId} href="#" onClick={(e) => { e.preventDefault(); setPickApi(sp.appId); setKind((sp.oauth2PermissionScopes ?? []).length ? 'Scope' : 'Role'); }}><span className="res-icon c-web"><KeyRound size={18} /></span><span><div className="t">{sp.displayName}</div><div className="s">{sp.appId}</div></span></a>)}
              </div>
            ) : <p className="muted">{t('common.noResults')}</p>}
          </div>
        ) : (
          <div className="stack">
            <div className="seg">
              <button className={kind === 'Scope' ? 'on' : ''} onClick={() => { setKind('Scope'); setChosen(new Set()); }}>{t('apps.delegated')}</button>
              <button className={kind === 'Role' ? 'on' : ''} onClick={() => { setKind('Role'); setChosen(new Set()); }}>{t('apps.application')}</button>
            </div>
            <Input placeholder={t('common.search')} value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="card" style={{ maxHeight: 460, overflow: 'auto' }}>
              {options.length ? options.map((o: any) => (
                <label key={o.id} className="dropdown-item" style={{ alignItems: 'flex-start' }}>
                  <input type="checkbox" checked={chosen.has(o.id)} onChange={(e) => { const s = new Set(chosen); if (e.target.checked) s.add(o.id); else s.delete(o.id); setChosen(s); }} style={{ marginTop: 4, accentColor: 'var(--primary)' }} />
                  <span><div className="mono">{o.value}</div><div className="small muted">{o.adminConsentDisplayName ?? o.displayName}{o.type === 'Admin' ? ' · Admin' : ''}</div></span>
                </label>
              )) : <Empty title={t('common.noResults')} />}
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}

// ---------------- Esponi un'API ----------------

export function ExposeTab({ ctx }: { ctx: AppCtx }) {
  const { t } = useI18n();
  const patch = usePatch(ctx);
  const a = ctx.app;
  const [uri, setUri] = useState<string>(a.identifierUris?.[0] ?? `api://${a.appId}`);
  const [open, setOpen] = useState(false);
  const blank = { value: '', type: 'User', adminConsentDisplayName: '', adminConsentDescription: '', userConsentDisplayName: '', userConsentDescription: '', isEnabled: true };
  const [s, setS] = useState(blank);
  const scopes: any[] = a.api?.oauth2PermissionScopes ?? [];
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card title={t('apps.identifierUri')}>
        <div className="input-group">
          <Input value={uri} onChange={(e) => setUri(e.target.value)} aria-label={t('apps.identifierUri')} />
          <Button onClick={() => patch({ identifierUris: uri ? [uri] : [] })}>{t('apps.setUri')}</Button>
        </div>
      </Card>
      <Card title={t('apps.tokenVersion')}>
        <Select value={String(a.api?.requestedAccessTokenVersion ?? '')} onChange={(e) => patch({ api: { requestedAccessTokenVersion: e.target.value ? Number(e.target.value) : null } })} style={{ maxWidth: 240 }} aria-label={t('apps.tokenVersion')}>
          <option value="">v1 ({t('common.default')})</option>
          <option value="2">v2</option>
        </Select>
      </Card>
      <section>
        <div className="spread mb-16"><h2>{t('apps.scopes')}</h2><Button size="sm" icon={Plus} disabled={!a.identifierUris?.length} onClick={() => { setS(blank); setOpen(true); }}>{t('apps.addScope')}</Button></div>
        <DataTable rows={scopes} rowKey={(x) => x.id} empty={t('apps.noScopes')}
          columns={[
            { key: 'v', header: t('apps.scopeName'), render: (x) => <span className="mono">{`${a.identifierUris?.[0] ?? ''}/${x.value}`}</span> },
            { key: 'w', header: t('apps.whoCanConsent'), render: (x) => (x.type === 'Admin' ? t('apps.adminsOnly') : t('apps.adminsAndUsers')) },
            { key: 'd', header: t('apps.consentDisplayName'), render: (x) => x.adminConsentDisplayName },
            { key: 'e', header: t('common.status'), render: (x) => <Switch checked={x.isEnabled} onChange={(v) => patch({ api: { oauth2PermissionScopes: scopes.map((y) => (y.id === x.id ? { ...y, isEnabled: v } : y)) } })} /> },
            { key: 'x', header: '', render: (x) => <Button size="sm" variant="ghost" icon={Trash2} aria-label={t('common.delete')} onClick={() => patch({ api: { oauth2PermissionScopes: scopes.filter((y) => y.id !== x.id) } })} /> },
          ]} />
      </section>
      <Panel open={open} onClose={() => setOpen(false)} title={t('apps.addScope')} footer={<><Button variant="primary" disabled={!s.value || !s.adminConsentDisplayName} onClick={async () => { if (await patch({ api: { oauth2PermissionScopes: [...scopes, { ...s, id: crypto.randomUUID() }] } })) setOpen(false); }}>{t('common.add')}</Button><Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button></>}>
        <Field label={t('apps.scopeName')} required hint={`${a.identifierUris?.[0] ?? ''}/${s.value || '…'}`}><Input value={s.value} onChange={(e) => setS({ ...s, value: e.target.value.replace(/\s/g, '') })} placeholder="access_as_user" /></Field>
        <Field label={t('apps.whoCanConsent')}>
          <Select value={s.type} onChange={(e) => setS({ ...s, type: e.target.value })}>
            <option value="User">{t('apps.adminsAndUsers')}</option>
            <option value="Admin">{t('apps.adminsOnly')}</option>
          </Select>
        </Field>
        <Field label={t('apps.consentDisplayName')} required><Input value={s.adminConsentDisplayName} onChange={(e) => setS({ ...s, adminConsentDisplayName: e.target.value, userConsentDisplayName: s.userConsentDisplayName || e.target.value })} /></Field>
        <Field label={t('apps.consentDescription')}><Textarea rows={2} value={s.adminConsentDescription} onChange={(e) => setS({ ...s, adminConsentDescription: e.target.value, userConsentDescription: e.target.value })} /></Field>
      </Panel>
    </div>
  );
}

// ---------------- Ruoli app ----------------

export function RolesTab({ ctx }: { ctx: AppCtx }) {
  const { t } = useI18n();
  const patch = usePatch(ctx);
  const roles: any[] = ctx.app.appRoles ?? [];
  const blank = { displayName: '', value: '', description: '', members: 'User', isEnabled: true };
  const [r, setR] = useState(blank);
  const [open, setOpen] = useState(false);
  const types = (m: string) => (m === 'both' ? ['User', 'Application'] : [m]);
  return (
    <section>
      <div className="spread mb-16"><h2>{t('apps.appRoles')}</h2><Button size="sm" icon={Plus} onClick={() => { setR(blank); setOpen(true); }}>{t('apps.addRole')}</Button></div>
      <DataTable rows={roles} rowKey={(x) => x.id} empty={t('apps.noRoles')}
        columns={[
          { key: 'n', header: t('apps.roleDisplayName'), render: (x) => x.displayName },
          { key: 'v', header: t('apps.roleValue'), render: (x) => <span className="mono">{x.value}</span> },
          { key: 'm', header: t('apps.allowedMembers'), render: (x) => (x.allowedMemberTypes ?? []).map((m: string) => <Badge key={m}>{m === 'User' ? t('apps.users') : t('apps.apps')}</Badge>) },
          { key: 'd', header: t('common.description'), render: (x) => <span className="small">{x.description}</span> },
          { key: 'e', header: t('common.status'), render: (x) => <Switch checked={x.isEnabled} onChange={(v) => patch({ appRoles: roles.map((y) => (y.id === x.id ? { ...y, isEnabled: v } : y)) })} /> },
          { key: 'x', header: '', render: (x) => <Button size="sm" variant="ghost" icon={Trash2} aria-label={t('common.delete')} onClick={() => patch({ appRoles: roles.filter((y) => y.id !== x.id) })} /> },
        ]} />
      <Panel open={open} onClose={() => setOpen(false)} title={t('apps.addRole')} footer={<><Button variant="primary" disabled={!r.displayName || !r.value} onClick={async () => { if (await patch({ appRoles: [...roles, { id: crypto.randomUUID(), displayName: r.displayName, value: r.value, description: r.description || r.displayName, allowedMemberTypes: types(r.members), isEnabled: r.isEnabled, origin: 'Application' }] })) setOpen(false); }}>{t('common.create')}</Button><Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button></>}>
        <Field label={t('apps.roleDisplayName')} required><Input value={r.displayName} onChange={(e) => setR({ ...r, displayName: e.target.value })} /></Field>
        <Field label={t('apps.allowedMembers')}>
          <Select value={r.members} onChange={(e) => setR({ ...r, members: e.target.value })}>
            <option value="User">{t('apps.users')}</option>
            <option value="Application">{t('apps.apps')}</option>
            <option value="both">{t('apps.both')}</option>
          </Select>
        </Field>
        <Field label={t('apps.roleValue')} required><Input value={r.value} onChange={(e) => setR({ ...r, value: e.target.value.replace(/\s/g, '') })} placeholder="Tasks.ReadWrite" /></Field>
        <Field label={t('common.description')}><Textarea rows={2} value={r.description} onChange={(e) => setR({ ...r, description: e.target.value })} /></Field>
        <Checkbox checked={r.isEnabled} onChange={(v) => setR({ ...r, isEnabled: v })} label={t('apps.enabledRole')} />
      </Panel>
    </section>
  );
}

// ---------------- Manifesto ----------------

const WRITABLE = ['displayName', 'description', 'notes', 'signInAudience', 'identifierUris', 'web', 'spa', 'publicClient', 'isFallbackPublicClient', 'api', 'appRoles', 'requiredResourceAccess', 'tags', 'info', 'optionalClaims', 'groupMembershipClaims', 'serviceManagementReference', 'tokenEncryptionKeyId', 'isDeviceOnlyAuthSupported', 'defaultRedirectUri', 'parentalControlSettings'];

export function ManifestTab({ ctx }: { ctx: AppCtx }) {
  const { t } = useI18n();
  const patch = usePatch(ctx);
  const initial = useMemo(() => JSON.stringify(ctx.app, null, 2), [ctx.app]);
  const [text, setText] = useState(initial);
  const [valid, setValid] = useState(true);
  return (
    <div className="stack">
      <Notice>{t('apps.manifestHint')}</Notice>
      <JsonEditor value={text} onChange={setText} onValid={setValid} rows={32} />
      <div className="row">
        <Button variant="primary" disabled={!valid || text === initial} onClick={() => {
          const next = JSON.parse(text);
          const body: any = {};
          for (const k of WRITABLE) if (JSON.stringify(next[k]) !== JSON.stringify(ctx.app[k])) body[k] = next[k];
          if (Object.keys(body).length) void patch(body);
        }}>{t('common.save')}</Button>
        <Button onClick={() => setText(initial)}>{t('common.reset')}</Button>
      </div>
    </div>
  );
}

export { ErrorNotice };
