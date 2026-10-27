'use client';

import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { arm } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { Button, Card, CodeBlock, CopyButton, Field, Input, Notice, SecretValue, Select, Switch } from '../ui';
import { useToast } from '../overlay';
import { useL } from './common';
import { KeysCard } from './keys';

export const LAW_API = '2023-09-01';
export const AI_API = '2020-02-02';
const LAW_RETENTION = [30, 31, 60, 90, 120, 180, 270, 365, 550, 730];
const AI_RETENTION = [30, 60, 90, 120, 180, 270, 365, 550, 730];

/** Log Analytics: conservazione, limite giornaliero, ID e chiavi dell'area di lavoro. */
export function LawSettings({ id, ws, reload }: { id: string; ws: any; reload: () => void }) {
  const L = useL();
  const toast = useToast();
  const p = ws.properties ?? {};
  const capNow = Number(p.workspaceCapping?.dailyQuotaGb ?? -1);
  const [retention, setRetention] = useState(Number(p.retentionInDays ?? 30));
  const [capOn, setCapOn] = useState(capNow > 0);
  const [cap, setCap] = useState(capNow > 0 ? capNow : 1);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setRetention(Number(p.retentionInDays ?? 30)); setCapOn(capNow > 0); setCap(capNow > 0 ? capNow : 1); }, [ws]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = retention !== Number(p.retentionInDays ?? 30) || (capOn ? cap : -1) !== capNow;
  const save = async () => {
    setBusy(true);
    try { await arm.patch(id, { properties: { retentionInDays: retention, workspaceCapping: { dailyQuotaGb: capOn ? cap : -1 } } }, LAW_API); toast.ok(L('Impostazioni salvate', 'Settings saved')); reload(); }
    catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card title={L('Conservazione e costi', 'Retention and cost')} actions={<Button variant="primary" icon={Save} loading={busy} disabled={!dirty || (capOn && !(cap > 0))} onClick={() => void save()}>{L('Salva', 'Save')}</Button>}>
        <div className="stack" style={{ gap: 12 }}>
          <Field label={L('Conservazione dei dati (giorni)', 'Data retention (days)')} htmlFor="lr" hint={L('I primi 31 giorni sono inclusi nel prezzo di inserimento; oltre si paga per GB al mese.', 'The first 31 days are included in the ingestion price; beyond that you pay per GB per month.')}>
            <Select id="lr" value={retention} onChange={(e) => setRetention(Number(e.target.value))}>{LAW_RETENTION.map((d) => <option key={d} value={d}>{d}</option>)}</Select>
          </Field>
          <Switch checked={capOn} onChange={setCapOn} label={L('Limite giornaliero di inserimento', 'Daily ingestion cap')} />
          {capOn && <Field label={L('GB al giorno', 'GB per day')} htmlFor="lc" hint={L('Raggiunto il limite, i dati del giorno vengono scartati fino a mezzanotte UTC.', 'Once reached, the day\'s data is dropped until midnight UTC.')}><Input id="lc" type="number" min={0.023} step={0.5} value={cap} onChange={(e) => setCap(Number(e.target.value))} /></Field>}
          {capOn && <Notice tone="warn">{L('Con il limite attivo puoi perdere log importanti durante un picco: usalo come protezione dalla spesa, non come regolazione abituale.', 'With the cap on you can lose important logs during a spike: use it as a spending guard, not routine tuning.')}</Notice>}
        </div>
      </Card>
      <Card title={L('ID area di lavoro', 'Workspace ID')}><p style={{ margin: 0 }}><span className="mono">{p.customerId}</span> <CopyButton value={p.customerId ?? ''} /></p></Card>
      <KeysCard title={L('Chiavi dell\'agente', 'Agent keys')} load={async () => {
        const k = await arm.post<any>(`${id}/sharedKeys`, {}, '2020-08-01');
        return [{ key: 'p', label: L('Primaria', 'Primary'), value: k.primarySharedKey }, { key: 's', label: L('Secondaria', 'Secondary'), value: k.secondarySharedKey }];
      }} note={L('Servono solo agli agenti legacy: Azure Monitor Agent usa le regole di raccolta dati e un\'identità gestita.', 'Only legacy agents need them: Azure Monitor Agent uses data collection rules and a managed identity.')} />
    </div>
  );
}

/** Application Insights: stringa di connessione, conservazione, area di lavoro collegata. */
export function AppInsightsSettings({ id, ai, reload }: { id: string; ai: any; reload: () => void }) {
  const L = useL();
  const toast = useToast();
  const p = ai.properties ?? {};
  const sub = id.split('/')[2];
  const workspaces = useAsync(async () => (await arm.get<{ value: any[] }>(`/subscriptions/${sub}/providers/Microsoft.OperationalInsights/workspaces`, LAW_API)).value, [sub]);
  const [retention, setRetention] = useState(Number(p.RetentionInDays ?? 90));
  const [ws, setWs] = useState<string>(p.WorkspaceResourceId ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setRetention(Number(p.RetentionInDays ?? 90)); setWs(p.WorkspaceResourceId ?? ''); }, [ai]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = retention !== Number(p.RetentionInDays ?? 90) || (ws || '') !== (p.WorkspaceResourceId ?? '');
  const save = async () => {
    setBusy(true);
    try {
      // Application Insights accetta PATCH solo sui tag: si riscrive la risorsa intera
      const cur = await arm.get<any>(id, AI_API);
      await arm.put(id, { location: cur.location, kind: cur.kind, tags: cur.tags, properties: { ...cur.properties, RetentionInDays: retention, WorkspaceResourceId: ws || undefined, IngestionMode: ws ? 'LogAnalytics' : cur.properties?.IngestionMode } }, AI_API);
      toast.ok(L('Impostazioni salvate', 'Settings saved'));
      reload();
    } catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  const cs = p.ConnectionString ?? '';
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card title={L('Stringa di connessione', 'Connection string')}>
        <div className="stack" style={{ gap: 10 }}>
          <SecretValue value={cs} />
          <p className="small muted" style={{ margin: 0 }}>{L('Chiave di strumentazione', 'Instrumentation key')}: <span className="mono">{p.InstrumentationKey}</span> <CopyButton value={p.InstrumentationKey ?? ''} /></p>
        </div>
      </Card>
      <Card title={L('Impostazioni', 'Settings')} actions={<Button variant="primary" icon={Save} loading={busy} disabled={!dirty} onClick={() => void save()}>{L('Salva', 'Save')}</Button>}>
        <div className="stack" style={{ gap: 12 }}>
          <Field label={L('Area di lavoro Log Analytics', 'Log Analytics workspace')} htmlFor="aw" hint={L('Le risorse classiche vanno migrate a un\'area di lavoro; una volta collegata non si può scollegare.', 'Classic resources must be migrated to a workspace; once linked it cannot be unlinked.')}>
            <Select id="aw" value={ws} onChange={(e) => setWs(e.target.value)}>
              {!p.WorkspaceResourceId && <option value="">{L('(classica, nessuna)', '(classic, none)')}</option>}
              {(workspaces.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name} · {w.location}</option>)}
              {p.WorkspaceResourceId && !(workspaces.data ?? []).some((w) => w.id.toLowerCase() === String(p.WorkspaceResourceId).toLowerCase()) && <option value={p.WorkspaceResourceId}>{String(p.WorkspaceResourceId).split('/').pop()}</option>}
            </Select>
          </Field>
          <Field label={L('Conservazione (giorni)', 'Retention (days)')} htmlFor="ar"><Select id="ar" value={retention} onChange={(e) => setRetention(Number(e.target.value))}>{AI_RETENTION.map((d) => <option key={d} value={d}>{d}</option>)}</Select></Field>
        </div>
      </Card>
      <Card title={L('Configura l\'app', 'Configure your app')}>
        <CodeBlock value={`# App Service / Container Apps / Functions\nAPPLICATIONINSIGHTS_CONNECTION_STRING="<connection string>"\n\n# Node.js\nnpm install @azure/monitor-opentelemetry\nimport { useAzureMonitor } from '@azure/monitor-opentelemetry';\nuseAzureMonitor();\n\n# Python\npip install azure-monitor-opentelemetry\nfrom azure.monitor.opentelemetry import configure_azure_monitor\nconfigure_azure_monitor()\n\n# .NET\ndotnet add package Azure.Monitor.OpenTelemetry.AspNetCore\nbuilder.Services.AddOpenTelemetry().UseAzureMonitor();`} />
      </Card>
    </div>
  );
}
