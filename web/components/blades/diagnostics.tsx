'use client';

import { useState } from 'react';
import Link from 'next/link';
import { BellRing, FileText, Pencil, Plus, Trash2 } from 'lucide-react';
import { arm } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { resourceHref } from '@/lib/arm';
import { Badge, Button, Card, Checkbox, Empty, ErrorNotice, Field, Input, Notice, Select, Skeleton, Switch } from '../ui';
import { Panel, useConfirm, useToast } from '../overlay';
import { useL } from './common';

const DIAG_API = '2021-05-01-preview';
const METRICDEF_API = '2018-01-01';
const ALERT_API = '2018-03-01';
const AG_API = '2023-01-01';
const nameOf = (id?: string) => id?.split('/').pop() ?? '';
const subOf = (id: string) => id.split('/')[2];
const rgOf = (id: string) => id.split('/providers/')[0];

/** Tipi con impostazioni di diagnostica (e metriche per gli avvisi), come in Azure Monitor. */
const DIAG_TYPES = new Set([
  'microsoft.web/sites', 'microsoft.web/serverfarms', 'microsoft.storage/storageaccounts', 'microsoft.keyvault/vaults', 'microsoft.sql/servers/databases',
  'microsoft.dbforpostgresql/flexibleservers', 'microsoft.dbformysql/flexibleservers', 'microsoft.documentdb/databaseaccounts', 'microsoft.cache/redis',
  'microsoft.compute/virtualmachines', 'microsoft.containerservice/managedclusters', 'microsoft.app/containerapps', 'microsoft.app/managedenvironments',
  'microsoft.containerregistry/registries', 'microsoft.servicebus/namespaces', 'microsoft.eventhub/namespaces', 'microsoft.appconfiguration/configurationstores',
  'microsoft.network/networksecuritygroups', 'microsoft.network/publicipaddresses', 'microsoft.network/loadbalancers', 'microsoft.network/virtualnetworks',
  'microsoft.network/natgateways', 'microsoft.network/applicationgateways', 'microsoft.network/dnszones', 'microsoft.cognitiveservices/accounts',
  'microsoft.insights/components', 'microsoft.operationalinsights/workspaces', 'microsoft.search/searchservices', 'microsoft.signalrservice/signalr',
  'microsoft.apimanagement/service', 'microsoft.logic/workflows',
]);
export const supportsDiagnostics = (type?: string) => !!type && DIAG_TYPES.has(type.toLowerCase());
export const supportsMetricAlerts = (type?: string) => supportsDiagnostics(type) && type!.toLowerCase() !== 'microsoft.network/networksecuritygroups';

const listInSub = async (sub: string, type: string, v: string) => (await arm.get<{ value: any[] }>(`/subscriptions/${sub}/providers/${type}`, v)).value;

// ---------------- impostazioni di diagnostica ----------------

/** Dove mandare log e metriche della risorsa: area di lavoro Log Analytics e/o account di archiviazione. */
export function DiagnosticSettings({ id, r }: { id: string; r: any }) {
  const L = useL();
  const toast = useToast();
  const confirm = useConfirm();
  const base = `${id}/providers/Microsoft.Insights`;
  const cats = useAsync(async () => (await arm.get<{ value: any[] }>(`${base}/diagnosticSettingsCategories`, DIAG_API)).value, [id]);
  const settings = useAsync(async () => (await arm.get<{ value: any[] }>(`${base}/diagnosticSettings`, DIAG_API)).value, [id]);
  const [editing, setEditing] = useState<any | null | undefined>(undefined);
  const dest = useAsync(async () => {
    if (editing === undefined) return null;
    const sub = subOf(id);
    const [ws, sa] = await Promise.all([listInSub(sub, 'Microsoft.OperationalInsights/workspaces', '2023-09-01').catch(() => []), listInSub(sub, 'Microsoft.Storage/storageAccounts', '2023-05-01').catch(() => [])]);
    return { ws, sa: sa.filter((a) => !r.location || r.location === 'global' || a.location === r.location) };
  }, [editing === undefined, id]);
  const blank = { name: '', allLogs: true, audit: false, logs: [] as string[], metrics: [] as string[], ws: '', dedicated: true, sa: '' };
  const [form, setForm] = useState(blank);
  const [busy, setBusy] = useState(false);
  const logCats = (cats.data ?? []).filter((c) => c.properties?.categoryType === 'Logs');
  const metricCats = (cats.data ?? []).filter((c) => c.properties?.categoryType === 'Metrics');
  const hasAudit = logCats.some((c) => (c.properties?.categoryGroups ?? []).includes('audit'));
  const open = (s: any | null) => {
    setEditing(s);
    if (!s) { setForm({ ...blank, name: `send-to-${(settings.data?.length ?? 0) === 0 ? 'logs' : `logs-${settings.data!.length + 1}`}`, allLogs: logCats.length > 0, metrics: metricCats.map((c) => c.name) }); return; }
    const p = s.properties ?? {};
    const groups = (p.logs ?? []).filter((l: any) => l.enabled && l.categoryGroup).map((l: any) => l.categoryGroup);
    setForm({
      name: s.name, allLogs: groups.includes('allLogs'), audit: groups.includes('audit'), logs: (p.logs ?? []).filter((l: any) => l.enabled && l.category).map((l: any) => l.category),
      metrics: (p.metrics ?? []).filter((m: any) => m.enabled).map((m: any) => m.category), ws: p.workspaceId ?? '', dedicated: p.logAnalyticsDestinationType === 'Dedicated', sa: p.storageAccountId ?? '',
    });
  };
  const anyCat = form.allLogs || form.audit || form.logs.length > 0 || form.metrics.length > 0;
  const nameErr = form.name && !/^[^<>*%&:\\?/+]{1,260}$/.test(form.name) ? L('Caratteri non ammessi', 'Characters not allowed') : !editing && settings.data?.some((s) => s.name.toLowerCase() === form.name.toLowerCase()) ? L('Nome già usato', 'Name already used') : undefined;
  const save = async () => {
    setBusy(true);
    const logs = form.allLogs ? [{ categoryGroup: 'allLogs', enabled: true }] : [...(form.audit ? [{ categoryGroup: 'audit', enabled: true }] : []), ...form.logs.map((category) => ({ category, enabled: true }))];
    try {
      await arm.put(`${base}/diagnosticSettings/${encodeURIComponent(form.name)}`, {
        properties: {
          logs, metrics: metricCats.map((c) => ({ category: c.name, enabled: form.metrics.includes(c.name) })),
          ...(form.ws ? { workspaceId: form.ws, ...(form.dedicated && logs.length ? { logAnalyticsDestinationType: 'Dedicated' } : {}) } : {}),
          ...(form.sa ? { storageAccountId: form.sa } : {}),
        },
      }, DIAG_API);
      toast.ok(L('Impostazione di diagnostica salvata', 'Diagnostic setting saved'), form.name);
      setEditing(undefined);
      settings.reload();
    } catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  const remove = async (s: any) => {
    if (!(await confirm({ title: L(`Eliminare ${s.name}?`, `Delete ${s.name}?`), text: L('Log e metriche smettono di arrivare alle destinazioni; quelli già inviati restano.', 'Logs and metrics stop flowing to the destinations; data already sent stays.'), danger: true, confirmLabel: L('Elimina', 'Delete') }))) return;
    try { await arm.del(`${base}/diagnosticSettings/${encodeURIComponent(s.name)}`, DIAG_API); settings.reload(); } catch (e) { toast.error(e); }
  };
  const describe = (s: any) => {
    const p = s.properties ?? {};
    const logs = (p.logs ?? []).filter((l: any) => l.enabled).map((l: any) => l.categoryGroup === 'allLogs' ? L('tutti i log', 'all logs') : l.categoryGroup === 'audit' ? 'audit' : l.category);
    const metrics = (p.metrics ?? []).filter((m: any) => m.enabled).map((m: any) => m.category === 'AllMetrics' ? L('tutte le metriche', 'all metrics') : m.category);
    return [...logs, ...metrics].join(', ');
  };
  if (cats.error) return <Notice tone="info">{L('Questa risorsa non ha impostazioni di diagnostica.', 'This resource has no diagnostic settings.')} <span className="small muted">{(cats.error as any)?.message}</span></Notice>;
  return (
    <Card title={L('Impostazioni di diagnostica', 'Diagnostic settings')} actions={<Button size="sm" icon={Plus} disabled={!cats.data || (settings.data?.length ?? 0) >= 5} title={(settings.data?.length ?? 0) >= 5 ? L('Massimo 5 impostazioni per risorsa', 'At most 5 settings per resource') : undefined} onClick={() => open(null)}>{L('Impostazione', 'Setting')}</Button>}>
      {settings.error ? <ErrorNotice error={settings.error} onRetry={settings.reload} /> : !settings.data || !cats.data ? <Skeleton rows={3} /> : settings.data.length === 0 ? (
        <Empty icon={FileText} title={L('Log e metriche non vengono raccolti', 'Logs and metrics are not collected')} text={L('Invia log e metriche della piattaforma a un\'area di lavoro Log Analytics per interrogarli e creare avvisi.', 'Send platform logs and metrics to a Log Analytics workspace to query them and build alerts.')} action={<Button variant="primary" icon={Plus} onClick={() => open(null)}>{L('Aggiungi impostazione', 'Add setting')}</Button>} />
      ) : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>{L('Nome', 'Name')}</th><th>{L('Dati', 'Data')}</th><th>Log Analytics</th><th>{L('Archiviazione', 'Storage')}</th><th /></tr></thead>
          <tbody>{settings.data.map((s) => (
            <tr key={s.id ?? s.name}>
              <td className="mono">{s.name}</td>
              <td className="small">{describe(s)}</td>
              <td>{s.properties?.workspaceId ? <Link className="mono small" href={resourceHref(s.properties.workspaceId)}>{nameOf(s.properties.workspaceId)}</Link> : '—'}</td>
              <td>{s.properties?.storageAccountId ? <Link className="mono small" href={resourceHref(s.properties.storageAccountId)}>{nameOf(s.properties.storageAccountId)}</Link> : '—'}</td>
              <td><div className="row" style={{ gap: 2, justifyContent: 'flex-end' }}>
                <Button size="sm" variant="ghost" icon={Pencil} aria-label={L('Modifica', 'Edit')} onClick={() => open(s)} />
                <Button size="sm" variant="ghost" icon={Trash2} aria-label={L('Elimina', 'Delete')} onClick={() => void remove(s)} />
              </div></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      <Panel open={editing !== undefined} onClose={() => setEditing(undefined)} wide title={editing ? editing.name : L('Nuova impostazione di diagnostica', 'New diagnostic setting')}
        footer={<><Button onClick={() => setEditing(undefined)}>{L('Annulla', 'Cancel')}</Button><Button variant="primary" loading={busy} disabled={!form.name || !!nameErr || !anyCat || (!form.ws && !form.sa)} onClick={() => void save()}>{L('Salva', 'Save')}</Button></>}>
        <Field label={L('Nome', 'Name')} htmlFor="dg-n" error={nameErr}><Input id="dg-n" className="mono" disabled={!!editing} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <div className="grid cols-2" style={{ gap: 16, alignItems: 'start' }}>
          <div>
            <h4 className="cfg-title" style={{ fontSize: 16 }}>Log</h4>
            {logCats.length === 0 ? <p className="small muted">{L('Questa risorsa non produce log di piattaforma.', 'This resource emits no platform logs.')}</p> : (
              <div className="stack" style={{ gap: 6 }}>
                <Checkbox checked={form.allLogs} onChange={(v) => setForm({ ...form, allLogs: v })} label={<strong>{L('Tutti i log (anche le categorie future)', 'All logs (including future categories)')}</strong>} />
                {hasAudit && <Checkbox checked={form.allLogs || form.audit} disabled={form.allLogs} onChange={(v) => setForm({ ...form, audit: v })} label={L('Solo audit', 'Audit only')} />}
                {logCats.map((c) => <Checkbox key={c.name} checked={form.allLogs || form.logs.includes(c.name)} disabled={form.allLogs} onChange={(v) => setForm({ ...form, logs: v ? [...form.logs, c.name] : form.logs.filter((x) => x !== c.name) })} label={<span className="mono small">{c.name}</span>} />)}
              </div>
            )}
            <h4 className="cfg-title" style={{ fontSize: 16, marginTop: 14 }}>{L('Metriche', 'Metrics')}</h4>
            {metricCats.length === 0 ? <p className="small muted">—</p> : metricCats.map((c) => <Checkbox key={c.name} checked={form.metrics.includes(c.name)} onChange={(v) => setForm({ ...form, metrics: v ? [...form.metrics, c.name] : form.metrics.filter((x) => x !== c.name) })} label={<span className="mono small">{c.name}</span>} />)}
          </div>
          <div>
            <h4 className="cfg-title" style={{ fontSize: 16 }}>{L('Destinazioni', 'Destinations')}</h4>
            {dest.error ? <ErrorNotice error={dest.error} onRetry={dest.reload} /> : !dest.data ? <Skeleton rows={2} /> : (
              <>
                <Field label={L('Area di lavoro Log Analytics', 'Log Analytics workspace')} htmlFor="dg-ws" hint={dest.data.ws.length ? undefined : L('Nessuna area di lavoro nella sottoscrizione: creane una.', 'No workspace in the subscription: create one.')}>
                  <Select id="dg-ws" value={form.ws} onChange={(e) => setForm({ ...form, ws: e.target.value })}><option value="">{L('Nessuna', 'None')}</option>{dest.data.ws.map((w) => <option key={w.id} value={w.id}>{w.name} · {w.location}</option>)}</Select>
                </Field>
                {form.ws && logCats.length > 0 && <Switch checked={form.dedicated} onChange={(v) => setForm({ ...form, dedicated: v })} label={L('Tabelle specifiche della risorsa (consigliato)', 'Resource-specific tables (recommended)')} />}
                <Field label={L(`Account di archiviazione (${r.location})`, `Storage account (${r.location})`)} htmlFor="dg-sa" hint={L('Per conservare i log a lungo a basso costo; deve stare nella stessa area della risorsa.', 'To keep logs long-term at low cost; must be in the resource\'s region.')}>
                  <Select id="dg-sa" value={form.sa} onChange={(e) => setForm({ ...form, sa: e.target.value })}><option value="">{L('Nessuno', 'None')}</option>{dest.data.sa.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>
                </Field>
              </>
            )}
            {!form.ws && !form.sa && <Notice tone="warn">{L('Scegli almeno una destinazione.', 'Choose at least one destination.')}</Notice>}
          </div>
        </div>
      </Panel>
    </Card>
  );
}

// ---------------- avvisi metrica ----------------

const OPS: [string, string][] = [['GreaterThan', '>'], ['GreaterThanOrEqual', '≥'], ['LessThan', '<'], ['LessThanOrEqual', '≤'], ['Equals', '=']];
const SEVERITIES: [number, string, string][] = [[0, 'Critico', 'Critical'], [1, 'Errore', 'Error'], [2, 'Avviso', 'Warning'], [3, 'Informativo', 'Informational'], [4, 'Dettagliato', 'Verbose']];
const WINDOWS: [string, string, string][] = [['PT1M', '1 minuto', '1 minute'], ['PT5M', '5 minuti', '5 minutes'], ['PT15M', '15 minuti', '15 minutes'], ['PT30M', '30 minuti', '30 minutes'], ['PT1H', '1 ora', '1 hour'], ['PT6H', '6 ore', '6 hours'], ['PT12H', '12 ore', '12 hours'], ['P1D', '1 giorno', '1 day']];
const FREQS = WINDOWS.slice(0, 5);
const mins = (d: string) => (d === 'P1D' ? 1440 : Number(/(\d+)H/.exec(d)?.[1] ?? 0) * 60 + Number(/(\d+)M/.exec(d)?.[1] ?? 0));
const sevTone = (s: number) => (s <= 1 ? 'bad' : s === 2 ? 'warn' : 'info');

/** Regole di avviso sulle metriche della risorsa, con i gruppi di azioni che ricevono le notifiche via email. */
export function MetricAlerts({ id, r }: { id: string; r: any }) {
  const L = useL();
  const toast = useToast();
  const confirm = useConfirm();
  const sub = subOf(id);
  const defs = useAsync(async () => (await arm.get<{ value: any[] }>(`${id}/providers/Microsoft.Insights/metricDefinitions`, METRICDEF_API)).value, [id]);
  const rules = useAsync(async () => (await listInSub(sub, 'Microsoft.Insights/metricAlerts', ALERT_API)).filter((a) => (a.properties?.scopes ?? []).some((s: string) => s.toLowerCase() === id.toLowerCase())), [id]);
  const groups = useAsync(async () => listInSub(sub, 'Microsoft.Insights/actionGroups', AG_API), [sub]);
  const [editing, setEditing] = useState<any | null | undefined>(undefined);
  const [form, setForm] = useState({ name: '', metric: '', agg: 'Average', op: 'GreaterThan', threshold: '80', window: 'PT5M', freq: 'PT1M', severity: 2, group: '', description: '', newGroup: false, agName: 'ops-team', agShort: 'ops', agEmail: '' });
  const [busy, setBusy] = useState(false);
  const def = defs.data?.find((d) => d.name.value === form.metric);
  const open = (a: any | null) => {
    setEditing(a);
    const first = defs.data?.[0];
    if (!a) {
      setForm({ ...form, name: `${r.name}-${(first?.name.value ?? 'metric').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, metric: first?.name.value ?? '', agg: first?.primaryAggregationType ?? 'Average', op: 'GreaterThan', threshold: first?.unit === 'Percent' ? '80' : '0', window: 'PT5M', freq: 'PT1M', severity: 2, group: groups.data?.[0]?.id ?? '', description: '', newGroup: !groups.data?.length });
      return;
    }
    const c = a.properties?.criteria?.allOf?.[0] ?? {};
    setForm({ ...form, name: a.name, metric: c.metricName ?? '', agg: c.timeAggregation ?? 'Average', op: c.operator ?? 'GreaterThan', threshold: String(c.threshold ?? 0), window: a.properties.windowSize, freq: a.properties.evaluationFrequency, severity: a.properties.severity, group: a.properties.actions?.[0]?.actionGroupId ?? '', description: a.properties.description ?? '', newGroup: false });
  };
  const errs = {
    name: form.name && !/^[^<>*%&:\\?+/#|]{1,260}$/.test(form.name) ? L('Caratteri non ammessi', 'Characters not allowed') : undefined,
    threshold: form.threshold === '' || !Number.isFinite(Number(form.threshold)) ? L('Numero', 'Number') : undefined,
    window: mins(form.window) < mins(form.freq) ? L('La finestra deve essere almeno pari alla frequenza', 'The window must be at least the frequency') : undefined,
    ag: form.newGroup && (!form.agName || !form.agShort || form.agShort.length > 12 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.agEmail)) ? L('Nome, nome breve (max 12) ed email validi', 'Valid name, short name (max 12) and email') : undefined,
  };
  const save = async () => {
    setBusy(true);
    try {
      let groupId = form.group;
      if (form.newGroup) {
        groupId = `${rgOf(id)}/providers/Microsoft.Insights/actionGroups/${form.agName}`;
        await arm.put(groupId, { location: 'Global', properties: { groupShortName: form.agShort, enabled: true, emailReceivers: [{ name: form.agEmail.split('@')[0], emailAddress: form.agEmail, useCommonAlertSchema: true }] } }, AG_API);
        groups.reload();
      }
      await arm.put(editing?.id ?? `${rgOf(id)}/providers/Microsoft.Insights/metricAlerts/${form.name}`, {
        location: 'global', tags: editing?.tags ?? {},
        properties: {
          description: form.description, severity: form.severity, enabled: editing?.properties?.enabled ?? true, scopes: [id], evaluationFrequency: form.freq, windowSize: form.window, autoMitigate: true,
          criteria: { 'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria', allOf: [{ criterionType: 'StaticThresholdCriterion', name: 'Metric1', metricName: form.metric, metricNamespace: r.type, operator: form.op, threshold: Number(form.threshold), timeAggregation: form.agg }] },
          actions: groupId ? [{ actionGroupId: groupId }] : [],
        },
      }, ALERT_API);
      toast.ok(editing ? L('Regola aggiornata', 'Rule updated') : L('Regola di avviso creata', 'Alert rule created'), form.name);
      setEditing(undefined);
      rules.reload();
    } catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  const toggle = async (a: any, on: boolean) => {
    try { await arm.put(a.id, { location: a.location, tags: a.tags, properties: { ...a.properties, enabled: on } }, ALERT_API); rules.reload(); }
    catch (e) { toast.error(e); }
  };
  const remove = async (a: any) => {
    if (!(await confirm({ title: L(`Eliminare la regola ${a.name}?`, `Delete rule ${a.name}?`), danger: true, confirmLabel: L('Elimina', 'Delete') }))) return;
    try { await arm.del(a.id, ALERT_API); rules.reload(); } catch (e) { toast.error(e); }
  };
  const condition = (a: any) => {
    const c = a.properties?.criteria?.allOf?.[0];
    if (!c) return '—';
    const d = defs.data?.find((x) => x.name.value === c.metricName);
    return `${d?.name.localizedValue ?? c.metricName} (${c.timeAggregation}) ${OPS.find((o) => o[0] === c.operator)?.[1] ?? c.operator} ${c.threshold}${d?.unit === 'Percent' ? '%' : ''} · ${L('su', 'over')} ${L(...(WINDOWS.find((w) => w[0] === a.properties.windowSize)?.slice(1) as [string, string] ?? [a.properties.windowSize, a.properties.windowSize]))}`;
  };
  if (defs.error) return <ErrorNotice error={defs.error} onRetry={defs.reload} />;
  return (
    <Card title={L('Regole di avviso', 'Alert rules')} actions={<Button size="sm" icon={Plus} disabled={!defs.data?.length || !groups.data} onClick={() => open(null)}>{L('Regola', 'Rule')}</Button>}>
      {rules.error ? <ErrorNotice error={rules.error} onRetry={rules.reload} /> : !rules.data || !defs.data ? <Skeleton rows={3} /> : defs.data.length === 0 ? <Notice>{L('Questa risorsa non espone metriche per gli avvisi.', 'This resource exposes no metrics for alerts.')}</Notice> : rules.data.length === 0 ? (
        <Empty icon={BellRing} title={L('Nessuna regola di avviso', 'No alert rules')} text={L('Ricevi un\'email quando una metrica supera una soglia, per esempio CPU sopra l\'80% per 5 minuti.', 'Get an email when a metric crosses a threshold, for example CPU above 80% for 5 minutes.')} action={<Button variant="primary" icon={Plus} disabled={!groups.data} onClick={() => open(null)}>{L('Crea regola', 'Create rule')}</Button>} />
      ) : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>{L('Nome', 'Name')}</th><th>{L('Condizione', 'Condition')}</th><th>{L('Gravità', 'Severity')}</th><th>{L('Gruppo di azioni', 'Action group')}</th><th>{L('Attiva', 'Enabled')}</th><th /></tr></thead>
          <tbody>{rules.data.map((a) => (
            <tr key={a.id}>
              <td className="mono">{a.name}</td>
              <td className="small">{condition(a)}</td>
              <td><Badge tone={sevTone(a.properties.severity)}>Sev{a.properties.severity} · {L(...(SEVERITIES[a.properties.severity]?.slice(1) as [string, string] ?? ['', '']))}</Badge></td>
              <td className="small">{(a.properties.actions ?? []).map((x: any) => nameOf(x.actionGroupId)).join(', ') || <span className="muted">{L('nessuno: nessuna notifica', 'none: no notifications')}</span>}</td>
              <td><Switch checked={!!a.properties.enabled} onChange={(v) => void toggle(a, v)} /></td>
              <td><div className="row" style={{ gap: 2, justifyContent: 'flex-end' }}>
                <Button size="sm" variant="ghost" icon={Pencil} aria-label={L('Modifica', 'Edit')} onClick={() => open(a)} />
                <Button size="sm" variant="ghost" icon={Trash2} aria-label={L('Elimina', 'Delete')} onClick={() => void remove(a)} />
              </div></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      <Panel open={editing !== undefined} onClose={() => setEditing(undefined)} wide title={editing ? editing.name : L('Nuova regola di avviso', 'New alert rule')}
        footer={<><Button onClick={() => setEditing(undefined)}>{L('Annulla', 'Cancel')}</Button><Button variant="primary" loading={busy} disabled={!form.name || !form.metric || Object.values(errs).some(Boolean)} onClick={() => void save()}>{editing ? L('Salva', 'Save') : L('Crea', 'Create')}</Button></>}>
        <div className="grid cols-2" style={{ gap: '0 16px', alignItems: 'start' }}>
          <Field label={L('Nome della regola', 'Rule name')} htmlFor="al-n" error={errs.name}><Input id="al-n" className="mono" disabled={!!editing} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label={L('Gravità', 'Severity')} htmlFor="al-s"><Select id="al-s" value={form.severity} onChange={(e) => setForm({ ...form, severity: Number(e.target.value) })}>{SEVERITIES.map(([v, it, en]) => <option key={v} value={v}>Sev{v} · {L(it, en)}</option>)}</Select></Field>
          <Field label={L('Metrica', 'Metric')} htmlFor="al-m">
            <Select id="al-m" value={form.metric} onChange={(e) => { const d = defs.data?.find((x) => x.name.value === e.target.value); setForm({ ...form, metric: e.target.value, agg: d?.primaryAggregationType ?? form.agg }); }}>{defs.data?.map((d) => <option key={d.name.value} value={d.name.value}>{d.name.localizedValue} · {d.unit}</option>)}</Select>
          </Field>
          <Field label={L('Aggregazione', 'Aggregation')} htmlFor="al-a"><Select id="al-a" value={form.agg} onChange={(e) => setForm({ ...form, agg: e.target.value })}>{(def?.supportedAggregationTypes ?? ['Average', 'Minimum', 'Maximum', 'Total', 'Count']).filter((x: string) => x !== 'None').map((x: string) => <option key={x}>{x}</option>)}</Select></Field>
          <Field label={L('Operatore', 'Operator')} htmlFor="al-o"><Select id="al-o" value={form.op} onChange={(e) => setForm({ ...form, op: e.target.value })}>{OPS.map(([v, s]) => <option key={v} value={v}>{s} {v}</option>)}</Select></Field>
          <Field label={L(`Soglia${def?.unit ? ` (${def.unit})` : ''}`, `Threshold${def?.unit ? ` (${def.unit})` : ''}`)} htmlFor="al-t" error={errs.threshold}><Input id="al-t" type="number" value={form.threshold} onChange={(e) => setForm({ ...form, threshold: e.target.value })} /></Field>
          <Field label={L('Finestra di osservazione', 'Lookback window')} htmlFor="al-w" error={errs.window}><Select id="al-w" value={form.window} onChange={(e) => setForm({ ...form, window: e.target.value })}>{WINDOWS.map(([v, it, en]) => <option key={v} value={v}>{L(it, en)}</option>)}</Select></Field>
          <Field label={L('Controlla ogni', 'Check every')} htmlFor="al-f"><Select id="al-f" value={form.freq} onChange={(e) => setForm({ ...form, freq: e.target.value })}>{FREQS.map(([v, it, en]) => <option key={v} value={v}>{L(it, en)}</option>)}</Select></Field>
        </div>
        <Field label={L('Descrizione', 'Description')} htmlFor="al-d"><Input id="al-d" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
        <h4 className="cfg-title" style={{ fontSize: 16 }}>{L('Chi avvisare', 'Who to notify')}</h4>
        <div className="seg mb-16">
          <button type="button" className={!form.newGroup ? 'on' : ''} disabled={!groups.data?.length} onClick={() => setForm({ ...form, newGroup: false })}>{L('Gruppo esistente', 'Existing group')}</button>
          <button type="button" className={form.newGroup ? 'on' : ''} onClick={() => setForm({ ...form, newGroup: true })}>{L('Nuovo gruppo', 'New group')}</button>
        </div>
        {!form.newGroup ? (
          <Field label={L('Gruppo di azioni', 'Action group')} htmlFor="al-g"><Select id="al-g" value={form.group} onChange={(e) => setForm({ ...form, group: e.target.value })}><option value="">{L('Nessuno (la regola scatta senza notifiche)', 'None (the rule fires without notifications)')}</option>{groups.data?.map((g) => <option key={g.id} value={g.id}>{g.name} · {(g.properties?.emailReceivers ?? []).map((x: any) => x.emailAddress).join(', ') || L('nessuna email', 'no email')}</option>)}</Select></Field>
        ) : (
          <div className="grid cols-3" style={{ gap: '0 12px', alignItems: 'start' }}>
            <Field label={L('Nome', 'Name')} htmlFor="ag-n"><Input id="ag-n" className="mono" value={form.agName} onChange={(e) => setForm({ ...form, agName: e.target.value })} /></Field>
            <Field label={L('Nome breve (max 12)', 'Short name (max 12)')} htmlFor="ag-s" hint={L('Appare negli SMS e nelle email.', 'Shown in SMS and email.')}><Input id="ag-s" maxLength={12} value={form.agShort} onChange={(e) => setForm({ ...form, agShort: e.target.value })} /></Field>
            <Field label="Email" htmlFor="ag-e" error={form.agEmail ? errs.ag : undefined}><Input id="ag-e" type="email" value={form.agEmail} onChange={(e) => setForm({ ...form, agEmail: e.target.value })} /></Field>
          </div>
        )}
      </Panel>
    </Card>
  );
}
