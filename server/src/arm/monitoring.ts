/**
 * Azure Monitor per risorsa: categorie delle impostazioni di diagnostica, definizioni delle metriche,
 * validazione di impostazioni di diagnostica, regole di avviso metrica e gruppi di azioni come in Azure.
 */
import * as store from '../db/store.ts';
import { armError, type ArmCtx } from './context.ts';
import { loadResource, type ResInfo } from './generic.ts';

const DIAG_SETTING = 'microsoft.insights/diagnosticsettings';
const METRIC_ALERT = 'microsoft.insights/metricalerts';
const ACTION_GROUP = 'microsoft.insights/actiongroups';
export const MONITOR_TYPES = new Set([DIAG_SETTING, METRIC_ALERT, ACTION_GROUP]);

type Unit = 'Count' | 'Percent' | 'Bytes' | 'BytesPerSecond' | 'Milliseconds' | 'Seconds' | 'CountPerSecond';
type Agg = 'Average' | 'Total' | 'Maximum' | 'Minimum' | 'Count';
/** [nome, unità, aggregazione primaria, descrizione] */
type Metric = [string, Unit, Agg, string];
interface Monitor { logs: [string, ('audit' | 'allLogs')[]][]; metrics: string[]; defs: Metric[] }

const L = (...names: string[]): [string, ('audit' | 'allLogs')[]][] => names.map((n) => [n, /audit/i.test(n) ? ['audit', 'allLogs'] : ['allLogs']]);
const M = (defs: Metric[], logs: [string, ('audit' | 'allLogs')[]][] = [], metrics = ['AllMetrics']): Monitor => ({ logs, metrics, defs });

/** Categorie e metriche principali dei tipi più usati (nomi reali di Azure Monitor). */
const MONITOR: Record<string, Monitor> = {
  'microsoft.web/sites': M([
    ['Requests', 'Count', 'Total', 'Requests'], ['Http5xx', 'Count', 'Total', 'Http Server Errors'], ['Http4xx', 'Count', 'Total', 'Http 4xx'],
    ['HttpResponseTime', 'Seconds', 'Average', 'Response Time'], ['CpuTime', 'Seconds', 'Total', 'CPU Time'], ['MemoryWorkingSet', 'Bytes', 'Average', 'Memory working set'], ['HealthCheckStatus', 'Percent', 'Average', 'Health check status'],
  ], L('AppServiceHTTPLogs', 'AppServiceConsoleLogs', 'AppServiceAppLogs', 'AppServiceAuditLogs', 'AppServiceIPSecAuditLogs', 'AppServicePlatformLogs', 'AppServiceAuthenticationLogs')),
  'microsoft.web/serverfarms': M([['CpuPercentage', 'Percent', 'Average', 'CPU Percentage'], ['MemoryPercentage', 'Percent', 'Average', 'Memory Percentage'], ['HttpQueueLength', 'Count', 'Average', 'Http Queue Length'], ['BytesReceived', 'Bytes', 'Total', 'Data In']]),
  'microsoft.storage/storageaccounts': M([
    ['UsedCapacity', 'Bytes', 'Average', 'Used capacity'], ['Transactions', 'Count', 'Total', 'Transactions'], ['Ingress', 'Bytes', 'Total', 'Ingress'], ['Egress', 'Bytes', 'Total', 'Egress'],
    ['Availability', 'Percent', 'Average', 'Availability'], ['SuccessE2ELatency', 'Milliseconds', 'Average', 'Success E2E Latency'],
  ], [], ['Transaction', 'Capacity']),
  'microsoft.keyvault/vaults': M([['ServiceApiHit', 'Count', 'Count', 'Total Service Api Hits'], ['ServiceApiLatency', 'Milliseconds', 'Average', 'Overall Service Api Latency'], ['Availability', 'Percent', 'Average', 'Overall Vault Availability'], ['SaturationShoebox', 'Percent', 'Average', 'Overall Vault Saturation']], L('AuditEvent', 'AzurePolicyEvaluationDetails')),
  'microsoft.sql/servers/databases': M([
    ['cpu_percent', 'Percent', 'Average', 'CPU percentage'], ['dtu_consumption_percent', 'Percent', 'Average', 'DTU percentage'], ['storage_percent', 'Percent', 'Maximum', 'Data space used percent'],
    ['connection_successful', 'Count', 'Total', 'Successful Connections'], ['connection_failed', 'Count', 'Total', 'Failed Connections: System Errors'], ['deadlock', 'Count', 'Total', 'Deadlocks'],
  ], L('SQLInsights', 'AutomaticTuning', 'QueryStoreRuntimeStatistics', 'QueryStoreWaitStatistics', 'Errors', 'DatabaseWaitStatistics', 'Timeouts', 'Blocks', 'Deadlocks', 'DevOpsOperationsAudit', 'SQLSecurityAuditEvents'), ['Basic', 'InstanceAndAppAdvanced', 'WorkloadManagement']),
  'microsoft.dbforpostgresql/flexibleservers': M([['cpu_percent', 'Percent', 'Average', 'CPU percent'], ['memory_percent', 'Percent', 'Average', 'Memory percent'], ['storage_percent', 'Percent', 'Average', 'Storage percent'], ['active_connections', 'Count', 'Average', 'Active Connections'], ['connections_failed', 'Count', 'Total', 'Failed Connections']], L('PostgreSQLLogs', 'PostgreSQLFlexSessions', 'PostgreSQLFlexQueryStoreRuntime', 'PostgreSQLFlexQueryStoreWaitStats', 'PostgreSQLFlexTableStats', 'PostgreSQLFlexDatabaseXacts')),
  'microsoft.dbformysql/flexibleservers': M([['cpu_percent', 'Percent', 'Average', 'Host CPU Percent'], ['memory_percent', 'Percent', 'Average', 'Host Memory Percent'], ['storage_percent', 'Percent', 'Average', 'Storage Percent'], ['active_connections', 'Count', 'Maximum', 'Active Connections'], ['aborted_connections', 'Count', 'Total', 'Aborted Connections']], L('MySqlSlowLogs', 'MySqlAuditLogs')),
  'microsoft.documentdb/databaseaccounts': M([['TotalRequests', 'Count', 'Count', 'Total Requests'], ['TotalRequestUnits', 'Count', 'Total', 'Total Request Units'], ['NormalizedRUConsumption', 'Percent', 'Maximum', 'Normalized RU Consumption'], ['ServerSideLatency', 'Milliseconds', 'Average', 'Server Side Latency'], ['DataUsage', 'Bytes', 'Total', 'Data Usage']], L('DataPlaneRequests', 'QueryRuntimeStatistics', 'PartitionKeyStatistics', 'PartitionKeyRUConsumption', 'ControlPlaneRequests'), ['Requests']),
  'microsoft.cache/redis': M([['percentProcessorTime', 'Percent', 'Maximum', 'CPU'], ['usedmemorypercentage', 'Percent', 'Maximum', 'Used Memory Percentage'], ['connectedclients', 'Count', 'Maximum', 'Connected Clients'], ['cachehits', 'Count', 'Total', 'Cache Hits'], ['cachemisses', 'Count', 'Total', 'Cache Misses'], ['serverLoad', 'Percent', 'Maximum', 'Server Load'], ['errors', 'Count', 'Maximum', 'Errors']], L('ConnectedClientList', 'MSEntraAuthenticationAuditLog')),
  'microsoft.compute/virtualmachines': M([['Percentage CPU', 'Percent', 'Average', 'Percentage CPU'], ['Available Memory Bytes', 'Bytes', 'Average', 'Available Memory Bytes'], ['Network In Total', 'Bytes', 'Total', 'Network In Total'], ['Network Out Total', 'Bytes', 'Total', 'Network Out Total'], ['Disk Read Bytes', 'Bytes', 'Total', 'Disk Read Bytes'], ['Disk Write Bytes', 'Bytes', 'Total', 'Disk Write Bytes'], ['VmAvailabilityMetric', 'Count', 'Average', 'VM Availability Metric']]),
  'microsoft.containerservice/managedclusters': M([['node_cpu_usage_percentage', 'Percent', 'Average', 'CPU Usage Percentage'], ['node_memory_working_set_percentage', 'Percent', 'Average', 'Memory Working Set Percentage'], ['kube_pod_status_ready', 'Count', 'Average', 'Number of pods in Ready state'], ['kube_node_status_condition', 'Count', 'Average', 'Statuses for various node conditions']], L('kube-apiserver', 'kube-audit', 'kube-audit-admin', 'kube-controller-manager', 'kube-scheduler', 'cluster-autoscaler', 'cloud-controller-manager', 'guard')),
  'microsoft.app/containerapps': M([['Requests', 'Count', 'Total', 'Requests'], ['Replicas', 'Count', 'Maximum', 'Replica Count'], ['RestartCount', 'Count', 'Maximum', 'Replica Restart Count'], ['UsageNanoCores', 'Count', 'Average', 'CPU Usage'], ['WorkingSetBytes', 'Bytes', 'Average', 'Memory Working Set Bytes']]),
  'microsoft.app/managedenvironments': M([['EnvCoresQuotaUtilization', 'Percent', 'Maximum', 'Percentage Cores Used']], L('ContainerAppConsoleLogs', 'ContainerAppSystemLogs')),
  'microsoft.containerregistry/registries': M([['TotalPullCount', 'Count', 'Total', 'Total Pull Count'], ['TotalPushCount', 'Count', 'Total', 'Total Push Count'], ['SuccessfulPullCount', 'Count', 'Total', 'Successful Pull Count'], ['StorageUsed', 'Bytes', 'Average', 'Storage used']], L('ContainerRegistryRepositoryEvents', 'ContainerRegistryLoginEvents')),
  'microsoft.servicebus/namespaces': M([['IncomingMessages', 'Count', 'Total', 'Incoming Messages'], ['OutgoingMessages', 'Count', 'Total', 'Outgoing Messages'], ['ActiveMessages', 'Count', 'Average', 'Count of active messages'], ['DeadletteredMessages', 'Count', 'Average', 'Count of dead-lettered messages'], ['ServerErrors', 'Count', 'Total', 'Server Errors'], ['ThrottledRequests', 'Count', 'Total', 'Throttled Requests']], L('OperationalLogs', 'VNetAndIPFilteringLogs', 'RuntimeAuditLogs', 'ApplicationMetricsLogs')),
  'microsoft.eventhub/namespaces': M([['IncomingMessages', 'Count', 'Total', 'Incoming Messages'], ['OutgoingMessages', 'Count', 'Total', 'Outgoing Messages'], ['IncomingBytes', 'Bytes', 'Total', 'Incoming Bytes'], ['ThrottledRequests', 'Count', 'Total', 'Throttled Requests'], ['ServerErrors', 'Count', 'Total', 'Server Errors']], L('ArchiveLogs', 'OperationalLogs', 'AutoScaleLogs', 'KafkaCoordinatorLogs', 'KafkaUserErrorLogs', 'EventHubVNetConnectionEvent', 'RuntimeAuditLogs', 'ApplicationMetricsLogs')),
  'microsoft.appconfiguration/configurationstores': M([['HttpIncomingRequestCount', 'Count', 'Count', 'HttpIncomingRequestCount'], ['HttpIncomingRequestDuration', 'Milliseconds', 'Average', 'HttpIncomingRequestDuration'], ['ThrottledHttpRequestCount', 'Count', 'Count', 'ThrottledHttpRequestCount']], L('HttpRequest', 'Audit')),
  'microsoft.network/networksecuritygroups': M([], L('NetworkSecurityGroupEvent', 'NetworkSecurityGroupRuleCounter'), []),
  'microsoft.network/publicipaddresses': M([['PacketCount', 'CountPerSecond', 'Total', 'Packet Count'], ['ByteCount', 'Bytes', 'Total', 'Byte Count'], ['VipAvailability', 'Percent', 'Average', 'Data Path Availability'], ['IfUnderDDoSAttack', 'Count', 'Maximum', 'Under DDoS attack or not']], L('DDoSProtectionNotifications', 'DDoSMitigationFlowLogs', 'DDoSMitigationReports')),
  'microsoft.network/loadbalancers': M([['VipAvailability', 'Count', 'Average', 'Data Path Availability'], ['DipAvailability', 'Count', 'Average', 'Health Probe Status'], ['ByteCount', 'Bytes', 'Total', 'Byte Count'], ['PacketCount', 'Count', 'Total', 'Packet Count'], ['SnatConnectionCount', 'Count', 'Total', 'SNAT Connection Count']], L('LoadBalancerHealthEvent')),
  'microsoft.network/virtualnetworks': M([['IfUnderDDoSAttack', 'Count', 'Maximum', 'Under DDoS attack or not'], ['PingMeshAverageRoundtripMs', 'Milliseconds', 'Average', 'Round trip time for Pings to a VM']], L('VMProtectionAlerts')),
  'microsoft.network/natgateways': M([['ByteCount', 'Bytes', 'Total', 'Bytes'], ['SNATConnectionCount', 'Count', 'Total', 'SNAT Connection Count'], ['PacketCount', 'Count', 'Total', 'Packets']]),
  'microsoft.network/applicationgateways': M([['Throughput', 'BytesPerSecond', 'Average', 'Throughput'], ['TotalRequests', 'Count', 'Total', 'Total Requests'], ['FailedRequests', 'Count', 'Total', 'Failed Requests'], ['UnhealthyHostCount', 'Count', 'Average', 'Unhealthy Host Count']], L('ApplicationGatewayAccessLog', 'ApplicationGatewayPerformanceLog', 'ApplicationGatewayFirewallLog')),
  'microsoft.network/dnszones': M([['QueryVolume', 'Count', 'Total', 'Query Volume'], ['RecordSetCount', 'Count', 'Maximum', 'Record Set Count']]),
  'microsoft.cognitiveservices/accounts': M([['TotalCalls', 'Count', 'Total', 'Total Calls'], ['SuccessfulCalls', 'Count', 'Total', 'Successful Calls'], ['TotalErrors', 'Count', 'Total', 'Total Errors'], ['Latency', 'Milliseconds', 'Average', 'Latency'], ['ProcessedPromptTokens', 'Count', 'Total', 'Processed Prompt Tokens'], ['GeneratedTokens', 'Count', 'Total', 'Generated Completion Tokens']], L('Audit', 'RequestResponse', 'Trace', 'AzureOpenAIRequestUsage')),
  'microsoft.insights/components': M([['requests/count', 'Count', 'Count', 'Server requests'], ['requests/failed', 'Count', 'Count', 'Failed requests'], ['requests/duration', 'Milliseconds', 'Average', 'Server response time'], ['exceptions/count', 'Count', 'Count', 'Exceptions'], ['dependencies/failed', 'Count', 'Count', 'Dependency failures'], ['availabilityResults/availabilityPercentage', 'Percent', 'Average', 'Availability']], L('AppAvailabilityResults', 'AppBrowserTimings', 'AppEvents', 'AppMetrics', 'AppDependencies', 'AppExceptions', 'AppPageViews', 'AppPerformanceCounters', 'AppRequests', 'AppSystemEvents', 'AppTraces')),
  'microsoft.operationalinsights/workspaces': M([['Average_% Processor Time', 'Percent', 'Average', '% Processor Time']], L('Audit', 'SummaryLogs')),
  'microsoft.search/searchservices': M([['SearchLatency', 'Seconds', 'Average', 'Search Latency'], ['SearchQueriesPerSecond', 'CountPerSecond', 'Average', 'Search queries per second'], ['ThrottledSearchQueriesPercentage', 'Percent', 'Average', 'Throttled search queries percentage']], L('OperationLogs')),
  'microsoft.signalrservice/signalr': M([['ConnectionCount', 'Count', 'Maximum', 'Connection Count'], ['MessageCount', 'Count', 'Total', 'Message Count']], L('AllLogs')),
  'microsoft.apimanagement/service': M([['Requests', 'Count', 'Total', 'Requests'], ['Capacity', 'Percent', 'Average', 'Capacity'], ['Duration', 'Milliseconds', 'Average', 'Overall Duration of Gateway Requests']], L('GatewayLogs', 'WebSocketConnectionLogs', 'DeveloperPortalAuditLogs')),
  'microsoft.logic/workflows': M([['RunsStarted', 'Count', 'Total', 'Runs Started'], ['RunsSucceeded', 'Count', 'Total', 'Runs Succeeded'], ['RunsFailed', 'Count', 'Total', 'Runs Failed']], L('WorkflowRuntime')),
};
const AGGS: Agg[] = ['Average', 'Minimum', 'Maximum', 'Total', 'Count'];

export const monitorOf = (type: string): Monitor | undefined => MONITOR[type.toLowerCase()];

const notSupported = (type: string) => armError(400, 'ResourceTypeNotSupported', `The resource type '${type}' does not support diagnostic settings.`);

/** GET {risorsa}/providers/Microsoft.Insights/diagnosticSettingsCategories[/{nome}] */
export function diagnosticCategories(res: any, name?: string) {
  const m = monitorOf(res.type);
  if (!m) throw notSupported(res.type);
  const all = [
    ...m.logs.map(([n, groups]) => ({ n, kind: 'Logs', groups })),
    ...m.metrics.map((n) => ({ n, kind: 'Metrics', groups: [] as string[] })),
  ].map((c) => ({ id: `${res.id}/providers/microsoft.insights/diagnosticSettingsCategories/${c.n}`, type: 'Microsoft.Insights/diagnosticSettingsCategories', name: c.n, properties: { categoryType: c.kind, categoryGroups: c.groups } }));
  if (name === undefined) return { value: all };
  const one = all.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (!one) throw armError(404, 'ResourceNotFound', `Diagnostic settings category '${name}' does not exist for resource type '${res.type}'.`);
  return one;
}

/** GET {risorsa}/providers/Microsoft.Insights/metricDefinitions */
export function metricDefinitions(res: any) {
  const m = monitorOf(res.type);
  return {
    value: (m?.defs ?? []).map(([name, unit, agg, desc]) => ({
      id: `${res.id}/providers/microsoft.insights/metricdefinitions/${name}`, resourceId: res.id, namespace: res.type,
      name: { value: name, localizedValue: desc }, displayDescription: desc, category: 'Platform', isDimensionRequired: false,
      unit, primaryAggregationType: agg, supportedAggregationTypes: ['None', ...AGGS],
      metricAvailabilities: [{ timeGrain: 'PT1M', retention: 'P93D' }, { timeGrain: 'PT5M', retention: 'P93D' }, { timeGrain: 'PT1H', retention: 'P93D' }, { timeGrain: 'P1D', retention: 'P93D' }],
    })),
  };
}

const GRAINS = ['PT1M', 'PT5M', 'PT15M', 'PT30M', 'PT1H', 'PT6H', 'PT12H', 'P1D'];
const minutes = (d: string) => (d.startsWith('P1D') ? 1440 : Number(/(\d+)H/.exec(d)?.[1] ?? 0) * 60 + Number(/(\d+)M/.exec(d)?.[1] ?? 0));
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function monitorBeforeWrite(ctx: ArmCtx, info: ResInfo, rec: any): Promise<void> {
  const t = rec._type as string;
  const P = rec.properties;
  if (t === DIAG_SETTING) {
    const scopeId = rec.id.slice(0, rec.id.toLowerCase().lastIndexOf('/providers/microsoft.insights/diagnosticsettings/'));
    const scope = await loadResource(ctx, scopeId);
    if (!scope) throw armError(404, 'ResourceNotFound', `The Resource '${scopeId}' was not found.`);
    const m = monitorOf(scope.type);
    if (!m) throw notSupported(scope.type);
    const logs: any[] = P.logs ?? [];
    const metrics: any[] = P.metrics ?? [];
    for (const l of logs) {
      if (l.categoryGroup ? !['allLogs', 'audit'].includes(l.categoryGroup) || !m.logs.some(([, g]) => g.includes(l.categoryGroup)) : !m.logs.some(([n]) => n === l.category)) {
        throw armError(400, 'BadRequest', `Category '${l.category ?? l.categoryGroup}' is not supported. Supported log categories for '${scope.type}': ${m.logs.map(([n]) => n).join(', ') || 'none'}.`);
      }
    }
    for (const x of metrics) if (!m.metrics.includes(x.category)) throw armError(400, 'BadRequest', `Metric category '${x.category}' is not supported. Supported: ${m.metrics.join(', ') || 'none'}.`);
    if (![...logs, ...metrics].some((x) => x.enabled)) throw armError(400, 'BadRequest', 'At least one log or metric category must be enabled.');
    const sinks: [string, string | undefined][] = [['workspace', P.workspaceId], ['storage', P.storageAccountId], ['eventhub', P.eventHubAuthorizationRuleId]];
    if (!sinks.some(([, v]) => v)) throw armError(400, 'BadRequest', 'At least one destination (Log Analytics workspace, storage account or event hub) must be specified.');
    if (P.workspaceId) {
      const ws = await loadResource(ctx, P.workspaceId);
      if (ws?._type !== 'microsoft.operationalinsights/workspaces') throw armError(400, 'BadRequest', `Log Analytics workspace '${P.workspaceId}' was not found.`);
    }
    if (P.storageAccountId) {
      const sa = await loadResource(ctx, P.storageAccountId);
      if (sa?._type !== 'microsoft.storage/storageaccounts') throw armError(400, 'BadRequest', `Storage account '${P.storageAccountId}' was not found.`);
      if (scope.location && scope.location !== 'global' && sa.location !== scope.location) throw armError(400, 'BadRequest', `Storage account '${sa.name}' is in region '${sa.location}', but the resource is in '${scope.location}'. Diagnostic settings need a storage account in the same region as the resource.`);
    }
    if (P.eventHubAuthorizationRuleId && !(await loadResource(ctx, P.eventHubAuthorizationRuleId))) throw armError(400, 'BadRequest', `Event hub authorization rule '${P.eventHubAuthorizationRuleId}' was not found.`);
    const others = (await store.list('resource', { parent: scopeId, match: { _type: DIAG_SETTING } })).filter((x: any) => x.id.toLowerCase() !== rec.id.toLowerCase());
    if (others.length >= 5) throw armError(400, 'BadRequest', 'A resource can have at most 5 diagnostic settings.');
    const cats = (p: any) => [...(p.logs ?? []), ...(p.metrics ?? [])].filter((x: any) => x.enabled).map((x: any) => x.category ?? x.categoryGroup);
    for (const o of others) {
      for (const [kind, v] of sinks) {
        if (!v || String(o.properties?.[kind === 'workspace' ? 'workspaceId' : kind === 'storage' ? 'storageAccountId' : 'eventHubAuthorizationRuleId'] ?? '').toLowerCase() !== v.toLowerCase()) continue;
        const shared = cats(P).find((c) => cats(o.properties).includes(c));
        if (shared) throw armError(409, 'Conflict', `Data sink '${v}' is already used in diagnostic setting '${o.name}' for category '${shared}'. Data sinks can't be reused in different settings on the same category for the same resource.`);
      }
    }
    P.logs = logs.map((l) => ({ ...l, retentionPolicy: l.retentionPolicy ?? { enabled: false, days: 0 } }));
    P.metrics = metrics.map((x) => ({ ...x, timeGrain: x.timeGrain ?? null, retentionPolicy: x.retentionPolicy ?? { enabled: false, days: 0 } }));
    delete P.provisioningState;
    return;
  }
  if (t === ACTION_GROUP) {
    const short = String(P.groupShortName ?? '');
    if (!short || short.length > 12) throw armError(400, 'BadRequest', 'The groupShortName must be between 1 and 12 characters.');
    const names = new Set<string>();
    P.emailReceivers = (P.emailReceivers ?? []).map((r: any) => {
      if (!r?.name || !EMAIL.test(String(r.emailAddress ?? ''))) throw armError(400, 'BadRequest', `Email receiver '${r?.name ?? ''}' must have a name and a valid emailAddress.`);
      if (names.has(r.name.toLowerCase())) throw armError(400, 'BadRequest', `Receiver names must be unique: '${r.name}' is used more than once.`);
      names.add(r.name.toLowerCase());
      return { name: r.name, emailAddress: r.emailAddress, useCommonAlertSchema: !!r.useCommonAlertSchema, status: 'Enabled' };
    });
    P.enabled ??= true;
    for (const k of ['smsReceivers', 'webhookReceivers', 'azureAppPushReceivers', 'armRoleReceivers', 'azureFunctionReceivers', 'logicAppReceivers', 'automationRunbookReceivers', 'voiceReceivers', 'itsmReceivers', 'eventHubReceivers']) P[k] ??= [];
    delete P.provisioningState;
    return;
  }
  if (t === METRIC_ALERT) {
    const sev = Number(P.severity);
    if (!Number.isInteger(sev) || sev < 0 || sev > 4) throw armError(400, 'BadRequest', 'Severity must be an integer between 0 and 4.');
    const scopes: string[] = P.scopes ?? [];
    if (!scopes.length) throw armError(400, 'BadRequest', 'Scopes must contain at least one resource.');
    const targets = [];
    for (const s of scopes) {
      const r = await loadResource(ctx, s);
      if (!r) throw armError(400, 'BadRequest', `Resource '${s}' in scopes was not found.`);
      targets.push(r);
    }
    P.evaluationFrequency ??= 'PT1M';
    P.windowSize ??= 'PT5M';
    if (!GRAINS.slice(0, 5).includes(P.evaluationFrequency)) throw armError(400, 'BadRequest', `Evaluation frequency '${P.evaluationFrequency}' is not supported. Allowed: ${GRAINS.slice(0, 5).join(', ')}.`);
    if (!GRAINS.includes(P.windowSize)) throw armError(400, 'BadRequest', `Window size '${P.windowSize}' is not supported. Allowed: ${GRAINS.join(', ')}.`);
    if (minutes(P.windowSize) < minutes(P.evaluationFrequency)) throw armError(400, 'BadRequest', 'The window size must be greater than or equal to the evaluation frequency.');
    const crit = P.criteria ?? {};
    const all: any[] = crit.allOf ?? [];
    if (!all.length) throw armError(400, 'BadRequest', 'Criteria must contain at least one condition in allOf.');
    const defs = targets.length === 1 ? monitorOf(targets[0].type)?.defs : undefined;
    for (const c of all) {
      if ((c.criterionType ?? 'StaticThresholdCriterion') === 'StaticThresholdCriterion') {
        if (!['GreaterThan', 'GreaterThanOrEqual', 'LessThan', 'LessThanOrEqual', 'Equals'].includes(c.operator)) throw armError(400, 'BadRequest', `Operator '${c.operator}' is not supported.`);
        if (typeof c.threshold !== 'number' || !Number.isFinite(c.threshold)) throw armError(400, 'BadRequest', `Threshold of condition '${c.name}' must be a number.`);
      }
      if (!AGGS.includes(c.timeAggregation)) throw armError(400, 'BadRequest', `Time aggregation '${c.timeAggregation}' is not supported. Allowed: ${AGGS.join(', ')}.`);
      if (defs && !defs.some(([n]) => n === c.metricName)) throw armError(400, 'BadRequest', `Couldn't find a metric named ${c.metricName}. Make sure the name is correct. Available metrics: ${defs.map(([n]) => n).join(', ')}.`);
      c.criterionType ??= 'StaticThresholdCriterion';
      c.metricNamespace ??= targets[0].type;
      c.dimensions ??= [];
      c.skipMetricValidation ??= false;
    }
    crit['odata.type'] ??= 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria';
    for (const a of P.actions ?? []) {
      const ag = await loadResource(ctx, a.actionGroupId ?? '');
      if (ag?._type !== ACTION_GROUP) throw armError(400, 'BadRequest', `Action group '${a.actionGroupId}' was not found.`);
      a.webHookProperties ??= {};
    }
    P.actions ??= [];
    P.enabled ??= true;
    P.autoMitigate ??= true;
    if (targets.length === 1) { P.targetResourceType ??= targets[0].type; P.targetResourceRegion ??= targets[0].location; }
    delete P.provisioningState;
  }
}
