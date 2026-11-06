/** Comportamenti di App Service: configurazione generale, domini personalizzati, verifica DNS. */
import { resolveCname, resolveTxt, resolve4 } from 'node:dns/promises';
import * as store from '../db/store.ts';
import { armError } from './context.ts';

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

// ---------------- slot di distribuzione ----------------

/** Slot consentiti dal livello del piano, come App Service (Free, Shared e Basic: nessuno). */
export const maxSlots = (tier: string): number => (/^(free|shared|basic|dynamic)$/i.test(tier) ? 0 : /^standard$/i.test(tier) ? 5 : 20);

/** Nuovo slot: area, tipo e piano dell'app di produzione; rispetta il limite di slot del piano. */
export async function prepareSlot(rec: any, siteId: string): Promise<void> {
  const site = await store.get<any>('resource', siteId);
  if (!site) return;
  rec.location = site.location;
  rec.kind ??= site.kind;
  rec.properties.serverFarmId ??= site.properties?.serverFarmId;
  const plan = rec.properties.serverFarmId ? await store.get<any>('resource', rec.properties.serverFarmId) : null;
  const max = maxSlots(plan?.sku?.tier ?? 'Standard');
  const depth = siteId.split('/').length + 2;
  const slots = (await store.list<any>('resource', { prefix: `${siteId.toLowerCase()}/slots/` })).filter((x) => x.id.split('/').length === depth);
  if (slots.length >= max) throw armError(409, 'Conflict', `Cannot create more than ${max} deployment slots for this site.`);
}

/** Impostazioni generali che restano allo slot nello scambio (come documentato da App Service). */
const STAY_WEB = new Set(['alwaysOn', 'ipSecurityRestrictions', 'ipSecurityRestrictionsDefaultAction', 'scmIpSecurityRestrictions', 'scmIpSecurityRestrictionsDefaultAction', 'scmIpSecurityRestrictionsUseMain', 'cors', 'vnetName', 'vnetRouteAllEnabled', 'minTlsVersion', 'scmMinTlsVersion', 'http20Enabled', 'ftpsState', 'numberOfWorkers']);

/**
 * POST {sito}[/slots/{slot}]/slotsswap { targetSlot }: scambia stack, impostazioni generali, impostazioni
 * dell'app e stringhe di connessione tra due slot («production» è l'app). Restano al loro posto le impostazioni
 * di slot (config/slotConfigNames), quelle *_EXTENSION_VERSION, domini, certificati, scalabilità e rete.
 */
export async function swapSlots(siteId: string, source: string, target: string, put: (id: string, properties: any) => Promise<void>): Promise<void> {
  const norm = (s: string) => (!s || s.toLowerCase() === 'production' ? 'production' : s);
  if (!target) throw armError(400, 'BadRequest', "The 'targetSlot' parameter is required.");
  const a = norm(source);
  const b = norm(target);
  if (a.toLowerCase() === b.toLowerCase()) throw armError(400, 'BadRequest', 'The source and target slots of a swap must be different.');
  const idOf = (s: string) => (s === 'production' ? siteId : `${siteId}/slots/${s}`);
  const recA = await store.get<any>('resource', idOf(a));
  const recB = await store.get<any>('resource', idOf(b));
  if (!recA || !recB) throw armError(404, 'NotFound', `Cannot find slot '${recA ? b : a}' for site '${siteId.split('/').pop()}'.`);
  const sticky = (await store.get<any>('resource', `${siteId}/config/slotConfigNames`))?.properties ?? {};
  const names = (k: string) => new Set<string>((sticky[k] ?? []).map((x: string) => x.toLowerCase()));
  const stickyApp = names('appSettingNames');
  const stickyConn = names('connectionStringNames');
  const cfg = async (s: string, name: string) => {
    const { provisioningState: _, ...p } = (await store.get<any>('resource', `${idOf(s)}/config/${name}`))?.properties ?? {};
    return p as Record<string, any>;
  };
  // a riceve ciò che si sposta da b e tiene ciò che resta suo
  const swapped = (from: Record<string, any>, own: Record<string, any>, stays: (k: string) => boolean) => ({
    ...Object.fromEntries(Object.entries(from).filter(([k]) => !stays(k))),
    ...Object.fromEntries(Object.entries(own).filter(([k]) => stays(k))),
  });
  const rules: [string, (k: string) => boolean][] = [
    ['appsettings', (k) => stickyApp.has(k.toLowerCase()) || /_EXTENSION_VERSION$/i.test(k)],
    ['connectionstrings', (k) => stickyConn.has(k.toLowerCase())],
    ['web', (k) => STAY_WEB.has(k)],
  ];
  const webOf: Record<string, any> = {};
  for (const [name, stays] of rules) {
    const x = await cfg(a, name);
    const y = await cfg(b, name);
    const nx = swapped(y, x, stays);
    const ny = swapped(x, y, stays);
    await put(`${idOf(a)}/config/${name}`, nx);
    await put(`${idOf(b)}/config/${name}`, ny);
    if (name === 'web') Object.assign(webOf, { [a]: nx, [b]: ny });
  }
  // stack sul record (log del contenitore) e riavvio di entrambi, come fa lo scambio
  for (const [s, rec] of [[a, recA], [b, recB]] as const) {
    rec.properties.siteConfig = { ...(rec.properties.siteConfig ?? {}), linuxFxVersion: webOf[s].linuxFxVersion ?? rec.properties.siteConfig?.linuxFxVersion };
    (rec._events ??= []).push({ at: new Date().toISOString(), kind: 'restart' });
    rec._events = rec._events.slice(-50);
    await store.replaceData('resource', rec.id, rec);
  }
}
