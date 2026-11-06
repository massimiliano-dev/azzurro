/** Comportamenti di App Service: configurazione generale, domini personalizzati, verifica DNS. */
import { resolveCname, resolveTxt, resolve4 } from 'node:dns/promises';
import * as store from '../db/store.ts';

/** Impostazioni generali di un'app (config/web) come le restituisce Azure. */
export function defaultSiteConfig(site: any): any {
  const sc = site?.properties?.siteConfig ?? {};
  const linux = String(site?.kind ?? '').includes('linux');
  return {
    numberOfWorkers: 1,
    defaultDocuments: ['Default.htm', 'Default.html', 'index.html', 'index.php', 'hostingstart.html'],
    netFrameworkVersion: 'v4.0',
    phpVersion: linux ? '' : '5.6',
    pythonVersion: '',
    nodeVersion: '',
    linuxFxVersion: sc.linuxFxVersion ?? (linux ? 'NODE|22-lts' : ''),
    windowsFxVersion: null,
    requestTracingEnabled: false,
    remoteDebuggingEnabled: false,
    httpLoggingEnabled: false,
    detailedErrorLoggingEnabled: false,
    use32BitWorkerProcess: !linux,
    webSocketsEnabled: false,
    alwaysOn: false,
    appCommandLine: '',
    managedPipelineMode: 'Integrated',
    loadBalancing: 'LeastRequests',
    autoHealEnabled: false,
    http20Enabled: true,
    minTlsVersion: '1.2',
    scmMinTlsVersion: '1.2',
    ftpsState: 'FtpsOnly',
    healthCheckPath: null,
    preWarmedInstanceCount: 0,
    functionsRuntimeScaleMonitoringEnabled: false,
    minimumElasticInstanceCount: 0,
    ipSecurityRestrictions: [{ ipAddress: 'Any', action: 'Allow', priority: 2147483647, name: 'Allow all', description: 'Allow all access' }],
    ipSecurityRestrictionsDefaultAction: 'Allow',
    scmIpSecurityRestrictions: [{ ipAddress: 'Any', action: 'Allow', priority: 2147483647, name: 'Allow all', description: 'Allow all access' }],
    scmIpSecurityRestrictionsUseMain: false,
    vnetRouteAllEnabled: false,
    publicNetworkAccess: 'Enabled',
    ...sc,
  };
}

/** Aggiorna hostNames e hostNameSslStates del sito quando cambia un'associazione di dominio. */
export async function syncSiteHostnames(siteId: string): Promise<void> {
  const site = await store.get('resource', siteId);
  if (!site) return;
  const bindings = await store.list('resource', { parent: siteId.toLowerCase(), match: { _type: 'microsoft.web/sites/hostnamebindings' } });
  const def = site.properties.defaultHostName;
  const scm = `${String(site.name).toLowerCase()}.scm.azurewebsites.net`;
  const custom = bindings.map((b: any) => b.name).filter((n: string) => n.toLowerCase() !== def);
  site.properties.hostNames = [def, ...custom];
  site.properties.enabledHostNames = [def, ...custom, scm];
  site.properties.hostNameSslStates = [
    { name: def, sslState: 'Disabled', hostType: 'Standard' },
    ...bindings.filter((b: any) => b.name.toLowerCase() !== def).map((b: any) => ({ name: b.name, sslState: b.properties?.sslState ?? 'Disabled', thumbprint: b.properties?.thumbprint ?? null, hostType: 'Standard', toUpdate: false })),
    { name: scm, sslState: 'Disabled', hostType: 'Repository' },
  ];
  await store.put('resource', site.id, site, siteId.toLowerCase().split('/providers/')[0]);
}

async function safe<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), 2500))]);
  } catch {
    return null;
  }
}

/** Verifica reale dei record DNS per un dominio personalizzato (GET sites/{name}/analyzeCustomHostname). */
export async function analyzeCustomHostname(site: any, hostName: string, inboundIp: string): Promise<any> {
  const host = hostName.toLowerCase().replace(/\.$/, '');
  const [cname, txt, a] = await Promise.all([safe(resolveCname(host)), safe(resolveTxt(`asuid.${host}`)), safe(resolve4(host))]);
  const cNameRecords = cname ?? [];
  const txtRecords = (txt ?? []).map((r) => r.join(''));
  const aRecords = a ?? [];
  const verificationId = String(site.properties.customDomainVerificationId);
  const txtOk = txtRecords.includes(verificationId);
  const cnameOk = cNameRecords.some((c) => c.toLowerCase().replace(/\.$/, '') === site.properties.defaultHostName);
  const aOk = aRecords.includes(inboundIp);
  const passed = txtOk && (cnameOk || aOk);
  const already = (site.properties.hostNames ?? []).some((h: string) => h.toLowerCase() === host);
  return {
    id: `${site.id}/analyzeCustomHostname`,
    name: host,
    type: 'Microsoft.Web/sites/analyzeCustomHostname',
    properties: {
      isHostnameAlreadyVerified: already,
      customDomainVerificationTest: passed ? 'Passed' : 'Failed',
      customDomainVerificationFailureInfo: passed ? null : {
        code: 'BadRequest',
        message: !txtOk
          ? `A TXT record pointing from asuid.${host} to ${verificationId} was not found.`
          : `A CNAME record pointing from ${host} to ${site.properties.defaultHostName} or an A record pointing to ${inboundIp} was not found.`,
      },
      hasConflictOnScaleUnit: false,
      hasConflictAcrossSubscription: false,
      conflictingAppResourceId: null,
      cNameRecords,
      txtRecords,
      aRecords,
      alternateCNameRecords: [],
      alternateTxtRecords: [],
      expected: { txt: { name: `asuid.${host}`, value: verificationId }, cname: { name: host, value: site.properties.defaultHostName }, a: { name: host, value: inboundIp } },
    },
  };
}

/**
 * Log del contenitore di un'app (POST .../containerlogs su Azure): l'emulatore non esegue codice,
 * quindi il log racconta il ciclo di vita registrato dalle azioni (creazione, avvio, arresto, riavvio)
 * con le stesse righe della piattaforma App Service.
 */
export function containerLog(site: any): string {
  const name = site.name as string;
  const stack = String(site.properties?.siteConfig?.linuxFxVersion || 'NODE|22-lts');
  const image = `mcr.microsoft.com/appsvc/${stack.split('|')[0].toLowerCase()}:${(stack.split('|')[1] ?? 'latest').toLowerCase()}_20251015.1.tuxprod`;
  const container = `${name.toLowerCase()}_0_${String(site.id).length.toString(16).padStart(8, '0')}`;
  const at = (t: number, ms: number, msg: string) => `${new Date(t + ms).toISOString()} ${msg}`;
  const startup = (t: number) => [
    at(t, 0, `INFO  - Pulling image: ${image}`),
    at(t, 4200, `INFO  - ${stack.split('|')[1] ?? 'latest'}_20251015.1.tuxprod Pulling from appsvc/${stack.split('|')[0].toLowerCase()}`),
    at(t, 4300, 'INFO  -  Digest: sha256:4f0d7c1e8a9b2c3d4e5f60718293a4b5c6d7e8f9012a3b4c5d6e7f8091a2b3c4'),
    at(t, 4400, `INFO  -  Status: Image is up to date for ${image}`),
    at(t, 4500, `INFO  - Pull Image successful, Time taken: 0 Seconds`),
    at(t, 4600, `INFO  - Starting container for site`),
    at(t, 4700, `INFO  - docker run -d --expose=8080 --name ${container} -e WEBSITE_SITE_NAME=${name} -e WEBSITE_AUTH_ENABLED=False -e PORT=8080 -e WEBSITES_ENABLE_APP_SERVICE_STORAGE=false ${image}`),
    at(t, 12000, `INFO  - Initiating warmup request to container ${container} for site ${name}`),
    at(t, 19500, `INFO  - Container ${container} for site ${name} initialized successfully and is ready to serve requests.`),
  ];
  const created = Date.parse(site._created ?? site.properties?.lastModifiedTimeUtc ?? new Date().toISOString());
  const lines = startup(created);
  for (const e of (site._events ?? []) as { at: string; kind: 'start' | 'stop' | 'restart' }[]) {
    const t = Date.parse(e.at);
    if (e.kind !== 'start') lines.push(at(t, 0, `INFO  - Stopping site ${name} because it was ${e.kind === 'restart' ? 'restarted' : 'stopped'} by the user.`), at(t, 900, `INFO  - Container ${container} for site ${name} stopped.`));
    if (e.kind !== 'stop') lines.push(...startup(t + 2000));
  }
  return lines.join('\n') + '\n';
}
