/**
 * Listino indicativo di Azzurro (EUR, area West Europe, pagamento a consumo, Linux).
 * Sono STIME a scopo didattico e di confronto: non sono il listino ufficiale Azure,
 * non includono sconti, prenotazioni, IVA né licenze Windows/SQL.
 */
export type Lbl = { it: string; en: string };
const l = (it: string, en: string = it): Lbl => ({ it, en });

export interface Plan {
  sku: string;
  specs: Lbl;
  /** €/ora per unità (istanza, nodo, unità di scala...) */
  hourly?: number;
  /** €/mese per unità */
  monthly?: number;
  /** prezzi dei contatori che cambiano con il piano */
  meterPrices?: Record<string, number>;
  /** quota inclusa dei contatori che cambia con il piano */
  meterIncluded?: Record<string, number>;
  free?: boolean;
}

export interface Meter {
  key: string;
  label: Lbl;
  /** unità di fatturazione, es. «GB/mese», «10.000 operazioni» */
  unit: Lbl;
  /** € per `per` unità */
  price: number;
  per?: number;
  /** quantità mensile gratuita (nelle stesse unità di `sim`) */
  included?: number;
  /** consumo mensile simulato per la risorsa (l'emulatore non ha un data plane) */
  sim: (res: any) => number;
}

export type Model = 'plan' | 'consumption' | 'mixed' | 'free' | 'included';

export interface PriceDef {
  type: string;
  /** ServiceName / MeterCategory di Cost Management */
  service: string;
  model: Model;
  plans?: Plan[];
  /** sku del piano attuale della risorsa */
  plan?: (res: any) => string | undefined;
  /** moltiplicatore del piano (istanze, nodi, unità, GB...) */
  units?: (res: any) => number;
  unitLabel?: Lbl;
  meters?: Meter[];
  /** la risorsa non è fatturata quando è ferma/deallocata */
  idle?: (res: any) => boolean;
  /** dove è fatturata una risorsa inclusa */
  billedWith?: Lbl;
  notes?: Lbl;
}

const HOURS = 730;
const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);
const lc = (v: unknown) => String(v ?? '').toLowerCase();

// ---------------------------------------------------------------- tabelle condivise

/** Dimensioni VM: [vCPU, GiB, €/ora Linux] */
export const VM_SIZES: Record<string, [number, number, number, string?]> = {
  Standard_B1ls: [1, 0.5, 0.0049], Standard_B1s: [1, 1, 0.0098], Standard_B1ms: [1, 2, 0.0195],
  Standard_B2s: [2, 4, 0.039], Standard_B2ms: [2, 8, 0.078], Standard_B4ms: [4, 16, 0.156], Standard_B8ms: [8, 32, 0.312],
  Standard_D2s_v5: [2, 8, 0.089], Standard_D4s_v5: [4, 16, 0.178], Standard_D8s_v5: [8, 32, 0.356], Standard_D16s_v5: [16, 64, 0.712],
  Standard_D2as_v5: [2, 8, 0.08], Standard_D4as_v5: [4, 16, 0.16], Standard_D8as_v5: [8, 32, 0.32],
  Standard_D2ds_v5: [2, 8, 0.105], Standard_D4ds_v5: [4, 16, 0.21],
  Standard_E2s_v5: [2, 16, 0.117], Standard_E4s_v5: [4, 32, 0.234], Standard_E8s_v5: [8, 64, 0.468],
  Standard_F2s_v2: [2, 4, 0.088], Standard_F4s_v2: [4, 8, 0.176], Standard_F8s_v2: [8, 16, 0.352],
  Standard_NC4as_T4_v3: [4, 28, 0.488, 'GPU NVIDIA T4'], Standard_NC24ads_A100_v4: [24, 220, 3.42, 'GPU NVIDIA A100'],
};
const vmPlans = (): Plan[] => Object.entries(VM_SIZES).map(([sku, [cpu, gb, h, extra]]) => ({
  sku, hourly: h, specs: l(`${cpu} vCPU · ${gb} GiB${extra ? ` · ${extra}` : ''}`, `${cpu} vCPU · ${gb} GiB${extra ? ` · ${extra}` : ''}`),
}));

/** Dischi gestiti: livelli per dimensione [GiB massimi, €/mese] */
const DISK_TIERS: Record<string, [string, number, number][]> = {
  Premium_LRS: [['P4', 32, 4.9], ['P6', 64, 9.5], ['P10', 128, 18.4], ['P15', 256, 35.5], ['P20', 512, 68.6], ['P30', 1024, 126.4], ['P40', 2048, 242], ['P50', 4096, 463]],
  StandardSSD_LRS: [['E4', 32, 2.2], ['E6', 64, 4.4], ['E10', 128, 8.8], ['E15', 256, 17.6], ['E20', 512, 35.2], ['E30', 1024, 70.4], ['E40', 2048, 140.8], ['E50', 4096, 281.6]],
  Standard_LRS: [['S4', 32, 1.4], ['S6', 64, 2.75], ['S10', 128, 5.3], ['S15', 256, 10.3], ['S20', 512, 19.7], ['S30', 1024, 38], ['S40', 2048, 72.8], ['S50', 4096, 139]],
};
export function diskTier(sku: string, sizeGb: number): { tier: string; monthly: number } {
  if (sku === 'PremiumV2_LRS' || sku === 'UltraSSD_LRS') return { tier: sku, monthly: Math.max(1, sizeGb) * (sku === 'UltraSSD_LRS' ? 0.115 : 0.077) };
  const tiers = DISK_TIERS[sku] ?? DISK_TIERS.StandardSSD_LRS;
  const t = tiers.find(([, max]) => sizeGb <= max) ?? tiers[tiers.length - 1];
  return { tier: t[0], monthly: t[2] };
}

const OPENAI_MODELS: Record<string, [number, number]> = {
  'gpt-4o': [2.3, 9.2], 'gpt-4o-mini': [0.14, 0.56], 'gpt-4.1': [1.85, 7.4], 'gpt-4.1-mini': [0.37, 1.48], 'gpt-4.1-nano': [0.09, 0.37],
  'o3-mini': [1.02, 4.07], 'o4-mini': [1.02, 4.07], 'gpt-5': [1.16, 9.25], 'gpt-5-mini': [0.23, 1.85],
  'text-embedding-3-small': [0.019, 0], 'text-embedding-3-large': [0.12, 0], 'text-embedding-ada-002': [0.093, 0],
};

// ---------------------------------------------------------------- consumi simulati

/** 0.6–1.4, deterministico per risorsa e contatore: due risorse uguali non consumano uguale */
export function jitter(id: string, key: string): number {
  let h = 2166136261;
  for (const ch of `${lc(id)}|${key}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return 0.6 + ((h >>> 0) % 1000) / 1250;
}
const sim = (base: number, key: string) => (r: any) => Math.round(base * jitter(r?.id ?? '', key));

// ---------------------------------------------------------------- listino

const FREE = (type: string, service: string, notes?: Lbl): PriceDef => ({ type, service, model: 'free', notes });
const INCL = (type: string, service: string, billedWith: Lbl, notes?: Lbl): PriceDef => ({ type, service, model: 'included', billedWith, notes });

const ops10k = (key: string, it: string, en: string, price: number, base: number, included = 0): Meter =>
  ({ key, label: l(it, en), unit: l('10.000 operazioni', '10,000 operations'), price, per: 10_000, included, sim: sim(base, key) });
const perMillion = (key: string, it: string, en: string, price: number, base: number, included = 0): Meter =>
  ({ key, label: l(it, en), unit: l('milione', 'million'), price, per: 1_000_000, included, sim: sim(base, key) });
const perGb = (key: string, it: string, en: string, price: number, base: number | ((r: any) => number), included = 0, unit = l('GB/mese', 'GB/month')): Meter =>
  ({ key, label: l(it, en), unit, price, per: 1, included, sim: typeof base === 'function' ? base : sim(base, key) });
const egress: Meter = perGb('egress', 'Trasferimento dati in uscita', 'Data transfer out', 0.08, 40, 100, l('GB', 'GB'));

const capacity = (r: any) => Math.max(1, num(r?.sku?.capacity, 1));

export const PRICES: PriceDef[] = [
  // ---------------- Storage
  {
    type: 'Microsoft.Storage/storageAccounts', service: 'Storage', model: 'consumption',
    plan: (r) => r?.sku?.name ?? 'Standard_LRS',
    plans: [
      { sku: 'Standard_LRS', specs: l('3 copie nello stesso datacenter', '3 copies in one datacenter'), meterPrices: { capacity: 0.0184 } },
      { sku: 'Standard_ZRS', specs: l('3 zone di disponibilità', '3 availability zones'), meterPrices: { capacity: 0.023 } },
      { sku: 'Standard_GRS', specs: l('LRS + copia in area abbinata', 'LRS + copy in paired region'), meterPrices: { capacity: 0.0368 } },
      { sku: 'Standard_RAGRS', specs: l('GRS con lettura nell\'area secondaria', 'GRS with read access in secondary'), meterPrices: { capacity: 0.046 } },
      { sku: 'Standard_GZRS', specs: l('ZRS + copia in area abbinata', 'ZRS + copy in paired region'), meterPrices: { capacity: 0.0414 } },
      { sku: 'Premium_LRS', specs: l('SSD, bassa latenza', 'SSD, low latency'), meterPrices: { capacity: 0.155, writeOps: 0.0186, readOps: 0.0015 } },
    ],
    meters: [
      perGb('capacity', 'Capacità BLOB (livello Hot)', 'Blob capacity (Hot tier)', 0.0184, 100),
      ops10k('writeOps', 'Operazioni di scrittura', 'Write operations', 0.05, 2_000_000),
      ops10k('readOps', 'Operazioni di lettura', 'Read operations', 0.004, 10_000_000),
      egress,
    ],
    notes: l('Livello Cool: capacità circa −45%, operazioni più care. Livello Cold: circa −80%. Le prime 100 GB in uscita al mese sono gratuite.', 'Cool tier: capacity about −45%, operations cost more. Cold tier: about −80%. The first 100 GB out per month are free.'),
  },
  ...['blobServices', 'fileServices', 'queueServices', 'tableServices', 'blobServices/containers', 'fileServices/shares', 'queueServices/queues', 'tableServices/tables', 'managementPolicies']
    .map((t) => INCL(`Microsoft.Storage/storageAccounts/${t}`, 'Storage', l('Account di archiviazione', 'Storage account'))),

  // ---------------- Key Vault
  {
    type: 'Microsoft.KeyVault/vaults', service: 'Key Vault', model: 'consumption',
    plan: (r) => r?.properties?.sku?.name ?? 'standard',
    plans: [
      { sku: 'standard', specs: l('Chiavi software, segreti, certificati', 'Software keys, secrets, certificates') },
      { sku: 'premium', specs: l('Anche chiavi protette da HSM', 'Adds HSM-protected keys'), monthly: 0.97 },
    ],
    meters: [
      ops10k('ops', 'Operazioni su segreti e chiavi', 'Secret and key operations', 0.029, 60_000),
      { key: 'renewals', label: l('Rinnovi certificati', 'Certificate renewals'), unit: l('rinnovo', 'renewal'), price: 2.79, sim: () => 0 },
    ],
    notes: l('Premium: 0,97 € al mese per ogni chiave HSM (stimata una chiave).', 'Premium: €0.97 per HSM key per month (one key assumed).'),
  },
  ...['secrets', 'keys', 'accessPolicies'].map((t) => INCL(`Microsoft.KeyVault/vaults/${t}`, 'Key Vault', l('Key Vault', 'Key Vault'))),

  // ---------------- Web
  {
    type: 'Microsoft.Web/serverfarms', service: 'Azure App Service', model: 'plan',
    plan: (r) => r?.sku?.name ?? 'F1', units: capacity, unitLabel: l('istanze', 'instances'),
    plans: [
      { sku: 'F1', free: true, specs: l('Condiviso · 60 min CPU/giorno · 1 GB', 'Shared · 60 CPU min/day · 1 GB') },
      { sku: 'B1', hourly: 0.017, specs: l('1 core · 1,75 GB · 10 GB', '1 core · 1.75 GB · 10 GB') },
      { sku: 'B2', hourly: 0.034, specs: l('2 core · 3,5 GB · 10 GB', '2 cores · 3.5 GB · 10 GB') },
      { sku: 'B3', hourly: 0.068, specs: l('4 core · 7 GB · 10 GB', '4 cores · 7 GB · 10 GB') },
      { sku: 'S1', hourly: 0.088, specs: l('1 core · 1,75 GB · slot e scalabilità automatica', '1 core · 1.75 GB · slots and autoscale') },
      { sku: 'S2', hourly: 0.176, specs: l('2 core · 3,5 GB', '2 cores · 3.5 GB') },
      { sku: 'S3', hourly: 0.352, specs: l('4 core · 7 GB', '4 cores · 7 GB') },
      { sku: 'P0v3', hourly: 0.077, specs: l('1 vCPU · 4 GB · 250 GB', '1 vCPU · 4 GB · 250 GB') },
      { sku: 'P1v3', hourly: 0.155, specs: l('2 vCPU · 8 GB · 250 GB', '2 vCPU · 8 GB · 250 GB') },
      { sku: 'P2v3', hourly: 0.31, specs: l('4 vCPU · 16 GB · 250 GB', '4 vCPU · 16 GB · 250 GB') },
      { sku: 'P3v3', hourly: 0.62, specs: l('8 vCPU · 32 GB · 250 GB', '8 vCPU · 32 GB · 250 GB') },
      { sku: 'Y1', specs: l('Functions a consumo: si paga per esecuzione', 'Functions consumption: pay per execution'), meterPrices: { executions: 0.169, gbs: 0.000014 }, meterIncluded: { executions: 1_000_000, gbs: 400_000 } },
      { sku: 'EP1', hourly: 0.173, specs: l('Functions Premium · 1 core · 3,5 GB', 'Functions Premium · 1 core · 3.5 GB') },
      { sku: 'EP2', hourly: 0.346, specs: l('Functions Premium · 2 core · 7 GB', 'Functions Premium · 2 cores · 7 GB') },
      { sku: 'EP3', hourly: 0.692, specs: l('Functions Premium · 4 core · 14 GB', 'Functions Premium · 4 cores · 14 GB') },
      { sku: 'WS1', hourly: 0.19, specs: l('Logic Apps Standard · 1 vCPU · 3,5 GB', 'Logic Apps Standard · 1 vCPU · 3.5 GB') },
    ],
    meters: [
      { key: 'executions', label: l('Esecuzioni Functions', 'Function executions'), unit: l('milione', 'million'), price: 0, per: 1_000_000, sim: (r) => (r?.sku?.name === 'Y1' ? sim(3_000_000, 'executions')(r) : 0) },
      { key: 'gbs', label: l('Tempo di esecuzione', 'Execution time'), unit: l('GB-s', 'GB-s'), price: 0, per: 1, sim: (r) => (r?.sku?.name === 'Y1' ? sim(900_000, 'gbs')(r) : 0) },
    ],
    notes: l('Il piano si paga anche senza app. Prezzi Linux; su Windows circa +30–40%.', 'The plan is billed even with no apps. Linux prices; Windows is about +30–40%.'),
  },
  INCL('Microsoft.Web/sites', 'Azure App Service', l('Piano di App Service', 'App Service plan')),
  FREE('Microsoft.Web/certificates', 'Azure App Service', l('I certificati gestiti di App Service sono gratuiti; il binding SNI è incluso dal piano Basic in su.', 'App Service managed certificates are free; SNI binding is included from the Basic plan up.')),
  ...['config', 'slots', 'hostNameBindings'].map((t) => INCL(`Microsoft.Web/sites/${t}`, 'Azure App Service', l('Piano di App Service', 'App Service plan'))),
  {
    type: 'Microsoft.Web/staticSites', service: 'Static Web Apps', model: 'plan', plan: (r) => r?.sku?.name ?? 'Free',
    plans: [
      { sku: 'Free', free: true, specs: l('100 GB banda · 2 domini personalizzati', '100 GB bandwidth · 2 custom domains') },
      { sku: 'Standard', monthly: 8.43, specs: l('SLA · 5 domini · autenticazione personalizzata', 'SLA · 5 domains · custom authentication') },
    ],
  },
  ...['customDomains', 'config'].map((t) => INCL(`Microsoft.Web/staticSites/${t}`, 'Static Web Apps', l('App Web statica', 'Static Web App'))),

  // ---------------- SQL
  FREE('Microsoft.Sql/servers', 'SQL Database', l('Il server logico è gratuito: si pagano database e pool elastici.', 'The logical server is free: databases and elastic pools are billed.')),
  {
    type: 'Microsoft.Sql/servers/databases', service: 'SQL Database', model: 'mixed',
    plan: (r) => (lc(r?.name) === 'master' ? 'System' : (r?.sku?.name ?? 'GP_S_Gen5')),
    units: (r) => (/^(GP_Gen5|BC_Gen5|HS_Gen5|GP_S_Gen5)$/.test(r?.sku?.name ?? '') ? Math.max(1, num(r?.sku?.capacity, 1)) : 1), unitLabel: l('vCore', 'vCores'),
    plans: [
      { sku: 'System', free: true, specs: l('Database master: gratuito', 'master database: free') },
      { sku: 'Free', free: true, specs: l('Offerta gratuita · 100.000 vCore-s/mese · 32 GB', 'Free offer · 100,000 vCore-s/month · 32 GB') },
      { sku: 'Basic', monthly: 4.21, specs: l('5 DTU · 2 GB', '5 DTU · 2 GB') },
      { sku: 'S0', monthly: 13.7, specs: l('10 DTU · 250 GB', '10 DTU · 250 GB') },
      { sku: 'S1', monthly: 27.39, specs: l('20 DTU · 250 GB', '20 DTU · 250 GB') },
      { sku: 'S2', monthly: 68.48, specs: l('50 DTU · 250 GB', '50 DTU · 250 GB') },
      { sku: 'S3', monthly: 136.96, specs: l('100 DTU · 1 TB', '100 DTU · 1 TB') },
      { sku: 'P1', monthly: 427.3, specs: l('125 DTU · 1 TB · SSD locale', '125 DTU · 1 TB · local SSD') },
      { sku: 'GP_S_Gen5', specs: l('Serverless · si paga il vCore al secondo · pausa automatica', 'Serverless · pay per vCore-second · auto-pause'), meterPrices: { vcoreSeconds: 0.000145 } },
      { sku: 'GP_Gen5', hourly: 0.253, specs: l('Per uso generico · per vCore', 'General Purpose · per vCore') },
      { sku: 'BC_Gen5', hourly: 0.68, specs: l('Business Critical · per vCore', 'Business Critical · per vCore') },
      { sku: 'HS_Gen5', hourly: 0.18, specs: l('Hyperscale · per vCore', 'Hyperscale · per vCore') },
    ],
    meters: [
      { key: 'vcoreSeconds', label: l('Calcolo serverless', 'Serverless compute'), unit: l('vCore-s', 'vCore-s'), price: 0, per: 1, sim: (r) => (r?.sku?.name === 'GP_S_Gen5' ? sim(260_000, 'vcore')(r) : 0) },
      perGb('storage', 'Archiviazione dati', 'Data storage', 0.11, (r) => (/^(GP|BC|HS)/.test(r?.sku?.name ?? '') ? Math.round(num(r?.properties?.maxSizeBytes, 34359738368) / 2 ** 30) : 0)),
    ],
    notes: l('Per i livelli vCore lo spazio dati si paga a parte. Licenza SQL Server inclusa (senza Azure Hybrid Benefit).', 'vCore tiers bill data storage separately. SQL Server licence included (no Azure Hybrid Benefit).'),
  },
  {
    type: 'Microsoft.Sql/servers/elasticPools', service: 'SQL Database', model: 'plan',
    plan: (r) => r?.sku?.name ?? 'GP_Gen5', units: (r) => (/Gen5/.test(r?.sku?.name ?? '') ? Math.max(1, num(r?.sku?.capacity, 2)) : 1), unitLabel: l('vCore', 'vCores'),
    plans: [
      { sku: 'BasicPool', monthly: 67.6, specs: l('50 eDTU · 5 GB', '50 eDTU · 5 GB') },
      { sku: 'StandardPool', monthly: 101.3, specs: l('50 eDTU · 50 GB', '50 eDTU · 50 GB') },
      { sku: 'PremiumPool', monthly: 633.4, specs: l('125 eDTU · 250 GB', '125 eDTU · 250 GB') },
      { sku: 'GP_Gen5', hourly: 0.253, specs: l('Per uso generico · per vCore', 'General Purpose · per vCore') },
      { sku: 'BC_Gen5', hourly: 0.68, specs: l('Business Critical · per vCore', 'Business Critical · per vCore') },
    ],
    notes: l('I database dentro il pool non si pagano singolarmente.', 'Databases inside the pool are not billed individually.'),
  },
  ...['firewallRules', 'administrators', 'virtualNetworkRules'].map((t) => FREE(`Microsoft.Sql/servers/${t}`, 'SQL Database')),

  // ---------------- PostgreSQL / MySQL
  ...(['PostgreSQL', 'MySQL'] as const).flatMap((db): PriceDef[] => {
    const k = db === 'MySQL' ? 0.95 : 1;
    const service = `Azure Database for ${db}`;
    const ns = `Microsoft.DBfor${db}/flexibleServers`;
    return [
      {
        type: ns, service, model: 'plan', plan: (r) => r?.sku?.name ?? 'Standard_B1ms',
        idle: (r) => r?.properties?.state === 'Stopped',
        plans: [
          { sku: 'Standard_B1ms', hourly: +(0.0177 * k).toFixed(4), specs: l('Burstable · 1 vCore · 2 GiB', 'Burstable · 1 vCore · 2 GiB') },
          { sku: 'Standard_B2s', hourly: +(0.067 * k).toFixed(4), specs: l('Burstable · 2 vCore · 4 GiB', 'Burstable · 2 vCores · 4 GiB') },
          { sku: 'Standard_B2ms', hourly: +(0.135 * k).toFixed(4), specs: l('Burstable · 2 vCore · 8 GiB', 'Burstable · 2 vCores · 8 GiB') },
          { sku: 'Standard_D2ds_v5', hourly: +(0.165 * k).toFixed(4), specs: l('Per uso generico · 2 vCore · 8 GiB', 'General Purpose · 2 vCores · 8 GiB') },
          { sku: 'Standard_D4ds_v5', hourly: +(0.33 * k).toFixed(4), specs: l('Per uso generico · 4 vCore · 16 GiB', 'General Purpose · 4 vCores · 16 GiB') },
          { sku: 'Standard_E2ds_v5', hourly: +(0.215 * k).toFixed(4), specs: l('Ottimizzata per la memoria · 2 vCore · 16 GiB', 'Memory Optimized · 2 vCores · 16 GiB') },
        ],
        meters: [
          perGb('storage', 'Archiviazione', 'Storage', +(0.115 * k).toFixed(3), (r) => num(r?.properties?.storage?.storageSizeGB, 32)),
          perGb('backup', 'Backup oltre lo spazio allocato', 'Backup beyond provisioned size', 0.092, 0),
        ],
        notes: l('Un server arrestato non paga il calcolo ma continua a pagare lo spazio. Azure lo riavvia dopo 7 giorni.', 'A stopped server pays no compute but still pays storage. Azure restarts it after 7 days.'),
      },
      ...['databases', 'firewallRules', 'configurations', 'administrators'].map((t) => INCL(`${ns}/${t}`, service, l('Server flessibile', 'Flexible server'))),
    ];
  }),

  // ---------------- Cosmos DB
  {
    type: 'Microsoft.DocumentDB/databaseAccounts', service: 'Azure Cosmos DB', model: 'consumption',
    plan: (r) => ((r?.properties?.capabilities ?? []).some((c: any) => c?.name === 'EnableServerless') ? 'Serverless' : r?.properties?.enableFreeTier ? 'FreeTier' : 'Provisioned'),
    plans: [
      { sku: 'Provisioned', specs: l('Velocità effettiva con provisioning (RU/s)', 'Provisioned throughput (RU/s)'), meterPrices: { ru: 0.0075 } },
      { sku: 'FreeTier', specs: l('1000 RU/s e 25 GB gratuiti per account', '1000 RU/s and 25 GB free per account'), meterPrices: { ru: 0.0075 }, meterIncluded: { ru: 7300, storage: 25 } },
      { sku: 'Serverless', specs: l('Si pagano le RU consumate', 'Pay per consumed RU'), meterPrices: { ru: 0, ruServerless: 0.233 } },
    ],
    meters: [
      { key: 'ru', label: l('Velocità effettiva (100 RU/s)', 'Throughput (100 RU/s)'), unit: l('100 RU/s all\'ora', '100 RU/s per hour'), price: 0.0075, per: 1, sim: () => 4 * HOURS },
      perMillion('ruServerless', 'Unità richiesta consumate', 'Consumed request units', 0, 15_000_000),
      perGb('storage', 'Archiviazione transazionale', 'Transactional storage', 0.233, 10),
    ],
    notes: l('Stimati 400 RU/s con provisioning. La velocità effettiva vera dipende da database e contenitori.', 'Assumes 400 provisioned RU/s. Real throughput depends on databases and containers.'),
  },
  ...['sqlDatabases', 'sqlDatabases/containers', 'mongodbDatabases', 'mongodbDatabases/collections', 'sqlRoleDefinitions', 'sqlRoleAssignments']
    .map((t) => INCL(`Microsoft.DocumentDB/databaseAccounts/${t}`, 'Azure Cosmos DB', l('Account Cosmos DB', 'Cosmos DB account'))),

  // ---------------- Rete
  FREE('Microsoft.Network/virtualNetworks', 'Virtual Network', l('La rete è gratuita. Il peering costa circa 0,009 € per GB in ciascuna direzione.', 'The network is free. Peering costs about €0.009 per GB each way.')),
  FREE('Microsoft.Network/virtualNetworks/subnets', 'Virtual Network'),
  {
    type: 'Microsoft.Network/virtualNetworks/virtualNetworkPeerings', service: 'Virtual Network', model: 'consumption',
    meters: [perGb('peering', 'Traffico di peering', 'Peering traffic', 0.0093, 20, 0, l('GB', 'GB'))],
  },
  FREE('Microsoft.Network/networkSecurityGroups', 'Virtual Network'),
  FREE('Microsoft.Network/networkSecurityGroups/securityRules', 'Virtual Network'),
  FREE('Microsoft.Network/networkInterfaces', 'Virtual Network'),
  FREE('Microsoft.Network/applicationSecurityGroups', 'Virtual Network'),
  FREE('Microsoft.Network/routeTables', 'Virtual Network'),
  FREE('Microsoft.Network/routeTables/routes', 'Virtual Network'),
  {
    type: 'Microsoft.Network/publicIPAddresses', service: 'Virtual Network', model: 'plan', plan: (r) => r?.sku?.name ?? 'Standard',
    plans: [
      { sku: 'Standard', hourly: 0.0047, specs: l('Statico · ridondante nelle zone', 'Static · zone-redundant') },
      { sku: 'Basic', hourly: 0.0034, specs: l('Ritirato da Azure a settembre 2025', 'Retired by Azure in September 2025') },
    ],
  },
  {
    type: 'Microsoft.Network/loadBalancers', service: 'Load Balancer', model: 'mixed', plan: (r) => r?.sku?.name ?? 'Standard',
    plans: [
      { sku: 'Standard', hourly: 0.0234, specs: l('Prime 5 regole incluse', 'First 5 rules included') },
      { sku: 'Gateway', hourly: 0.0117, specs: l('Per appliance di rete virtuali', 'For network virtual appliances') },
      { sku: 'Basic', free: true, specs: l('Ritirato da Azure a settembre 2025', 'Retired by Azure in September 2025') },
    ],
    meters: [perGb('data', 'Dati elaborati', 'Data processed', 0.0047, 200, 0, l('GB', 'GB'))],
  },
  {
    type: 'Microsoft.Network/applicationGateways', service: 'Application Gateway', model: 'mixed', plan: (r) => r?.sku?.tier ?? r?.properties?.sku?.tier ?? 'Standard_v2',
    plans: [
      { sku: 'Standard_v2', hourly: 0.229, specs: l('Costo fisso + unità di capacità', 'Fixed cost + capacity units'), meterPrices: { cu: 0.0072 } },
      { sku: 'WAF_v2', hourly: 0.413, specs: l('Con Web Application Firewall', 'With Web Application Firewall'), meterPrices: { cu: 0.0131 } },
      { sku: 'Basic', hourly: 0.0234, specs: l('Fino a 200 connessioni/s', 'Up to 200 connections/s'), meterPrices: { cu: 0.0076 } },
    ],
    meters: [{ key: 'cu', label: l('Unità di capacità', 'Capacity units'), unit: l('unità all\'ora', 'unit-hour'), price: 0.0072, per: 1, sim: () => 2 * HOURS }],
  },
  {
    type: 'Microsoft.Network/natGateways', service: 'NAT Gateway', model: 'mixed', plans: [{ sku: 'Standard', hourly: 0.042, specs: l('Fino a 16 IP pubblici', 'Up to 16 public IPs') }], plan: () => 'Standard',
    meters: [perGb('data', 'Dati elaborati', 'Data processed', 0.042, 100, 0, l('GB', 'GB'))],
  },
  {
    type: 'Microsoft.Network/privateEndpoints', service: 'Azure Private Link', model: 'mixed', plans: [{ sku: 'Standard', hourly: 0.0094, specs: l('Un IP privato nella subnet', 'One private IP in the subnet') }], plan: () => 'Standard',
    meters: [perGb('data', 'Dati in ingresso e uscita', 'Data in and out', 0.0094, 50, 0, l('GB', 'GB'))],
  },
  ...(['privateDnsZones', 'dnsZones'] as const).flatMap((z): PriceDef[] => [
    {
      type: `Microsoft.Network/${z}`, service: 'Azure DNS', model: 'mixed', plans: [{ sku: 'Zone', monthly: z === 'dnsZones' ? 0.46 : 0.46, specs: l('Prime 25 zone', 'First 25 zones') }], plan: () => 'Zone',
      meters: [perMillion('queries', 'Query DNS', 'DNS queries', z === 'dnsZones' ? 0.37 : 0.37, 2_000_000)],
    },
    ...(z === 'dnsZones' ? ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'SRV', 'CAA', 'PTR', 'SOA'] : ['virtualNetworkLinks', 'A', 'AAAA', 'CNAME', 'TXT', 'MX', 'SRV', 'PTR', 'SOA'])
      .map((t) => INCL(`Microsoft.Network/${z}/${t}`, 'Azure DNS', l('Zona DNS', 'DNS zone'))),
  ]),
  {
    type: 'Microsoft.Network/bastionHosts', service: 'Azure Bastion', model: 'plan', plan: (r) => r?.sku?.name ?? 'Basic',
    plans: [
      { sku: 'Developer', free: true, specs: l('Una connessione alla volta, rete condivisa', 'One connection at a time, shared network') },
      { sku: 'Basic', hourly: 0.176, specs: l('2 istanze · RDP/SSH dal portale', '2 instances · RDP/SSH from the portal') },
      { sku: 'Standard', hourly: 0.268, specs: l('Scalabile · client nativo · IP', 'Scalable · native client · IP connect') },
      { sku: 'Premium', hourly: 0.351, specs: l('Registrazione sessioni · solo privato', 'Session recording · private-only') },
    ],
    meters: [egress],
  },
  {
    type: 'Microsoft.Network/frontDoorWebApplicationFirewallPolicies', service: 'Azure Front Door Service', model: 'mixed', plans: [{ sku: 'Policy', monthly: 4.66, specs: l('Criterio WAF', 'WAF policy') }], plan: () => 'Policy',
    meters: [{ key: 'rules', label: l('Regole personalizzate', 'Custom rules'), unit: l('regola/mese', 'rule/month'), price: 0.93, per: 1, sim: (r) => (r?.properties?.customRules?.rules ?? []).length }],
  },
  {
    type: 'Microsoft.Cdn/profiles', service: 'Azure Front Door Service', model: 'mixed', plan: (r) => r?.sku?.name ?? 'Standard_AzureFrontDoor',
    plans: [
      { sku: 'Standard_AzureFrontDoor', monthly: 32.5, specs: l('CDN globale, regole, domini', 'Global CDN, rules, domains') },
      { sku: 'Premium_AzureFrontDoor', monthly: 307, specs: l('Anche WAF gestito e Private Link', 'Adds managed WAF and Private Link') },
      { sku: 'Standard_Microsoft', specs: l('CDN classica Microsoft, solo consumo', 'Classic Microsoft CDN, usage only') },
    ],
    meters: [
      perGb('egress', 'Trasferimento dal bordo al client', 'Edge to client transfer', 0.078, 80, 0, l('GB', 'GB')),
      ops10k('requests', 'Richieste', 'Requests', 0.0084, 3_000_000),
    ],
  },
  INCL('Microsoft.Cdn/profiles/afdEndpoints', 'Azure Front Door Service', l('Profilo Front Door', 'Front Door profile')),

  // ---------------- Calcolo
  {
    type: 'Microsoft.Compute/virtualMachines', service: 'Virtual Machines', model: 'plan',
    plan: (r) => r?.properties?.hardwareProfile?.vmSize ?? 'Standard_B1s', plans: vmPlans(),
    idle: (r) => r?._power === 'deallocated' || r?._power === 'generalized' || (r?.properties?.instanceView?.statuses ?? []).some((x: any) => /PowerState\/(deallocated|deallocating)/i.test(String(x?.code))),
    notes: l('Solo il calcolo: il disco del sistema operativo è una risorsa a parte. Una VM arrestata ma non deallocata si paga ancora.', 'Compute only: the OS disk is a separate resource. A VM that is stopped but not deallocated is still billed.'),
  },
  INCL('Microsoft.Compute/virtualMachines/extensions', 'Virtual Machines', l('Macchina virtuale', 'Virtual machine')),
  {
    type: 'Microsoft.Compute/disks', service: 'Storage', model: 'plan',
    plan: (r) => `${r?.sku?.name ?? 'Premium_LRS'}`,
    plans: [
      { sku: 'Premium_LRS', specs: l('SSD Premium · P4 32 GiB 4,90 € … P30 1 TiB 126 €', 'Premium SSD · P4 32 GiB €4.90 … P30 1 TiB €126') },
      { sku: 'StandardSSD_LRS', specs: l('SSD Standard · E4 32 GiB 2,20 € … E30 1 TiB 70 €', 'Standard SSD · E4 32 GiB €2.20 … E30 1 TiB €70') },
      { sku: 'Standard_LRS', specs: l('HDD Standard · S4 32 GiB 1,40 € … S30 1 TiB 38 €', 'Standard HDD · S4 32 GiB €1.40 … S30 1 TiB €38') },
      { sku: 'PremiumV2_LRS', specs: l('SSD Premium v2 · 0,077 €/GiB, 3000 IOPS inclusi', 'Premium SSD v2 · €0.077/GiB, 3000 IOPS included') },
      { sku: 'UltraSSD_LRS', specs: l('Disco Ultra · 0,115 €/GiB + IOPS e banda', 'Ultra Disk · €0.115/GiB + IOPS and throughput') },
    ],
    notes: l('Il prezzo va a scaglioni di dimensione: un disco da 40 GiB paga il livello da 64 GiB. Si paga anche quando la VM è deallocata.', 'Pricing is by size tier: a 40 GiB disk pays for the 64 GiB tier. Disks are billed even while the VM is deallocated.'),
  },
  {
    type: 'Microsoft.Compute/snapshots', service: 'Storage', model: 'consumption',
    meters: [perGb('snapshot', 'Snapshot (incrementale)', 'Snapshot (incremental)', 0.046, (r) => num(r?.properties?.diskSizeGB, 32))],
  },
  FREE('Microsoft.Compute/availabilitySets', 'Virtual Machines'),
  {
    type: 'Microsoft.Compute/virtualMachineScaleSets', service: 'Virtual Machines', model: 'plan',
    plan: (r) => r?.sku?.name ?? 'Standard_D2s_v5', units: (r) => Math.max(0, num(r?.sku?.capacity, 1)), unitLabel: l('istanze', 'instances'), plans: vmPlans(),
    notes: l('Si pagano le istanze, al prezzo della dimensione VM. I nodi AKS sono fatturati qui, nel gruppo di risorse del nodo.', 'Instances are billed at the VM size price. AKS nodes are billed here, in the node resource group.'),
  },
  FREE('Microsoft.Compute/sshPublicKeys', 'Virtual Machines'),
  { type: 'Microsoft.Compute/images', service: 'Storage', model: 'consumption', meters: [perGb('storage', 'Archiviazione immagine', 'Image storage', 0.046, 30)] },
  FREE('Microsoft.Compute/galleries', 'Virtual Machines', l('La raccolta è gratuita; si paga lo spazio delle versioni immagine e delle repliche.', 'The gallery is free; image version and replica storage is billed.')),

  // ---------------- Contenitori
  {
    type: 'Microsoft.ContainerRegistry/registries', service: 'Container Registry', model: 'mixed', plan: (r) => r?.sku?.name ?? 'Basic',
    plans: [
      { sku: 'Basic', monthly: 4.66, specs: l('10 GB inclusi · 2 webhook', '10 GB included · 2 webhooks'), meterIncluded: { storage: 10 } },
      { sku: 'Standard', monthly: 18.62, specs: l('100 GB inclusi · 10 webhook', '100 GB included · 10 webhooks'), meterIncluded: { storage: 100 } },
      { sku: 'Premium', monthly: 46.55, specs: l('500 GB · geo-replica · Private Link', '500 GB · geo-replication · Private Link'), meterIncluded: { storage: 500 } },
    ],
    meters: [perGb('storage', 'Spazio oltre il limite incluso', 'Storage beyond included', 0.093, 12)],
  },
  ...['webhooks', 'scopeMaps', 'tokens'].map((t) => INCL(`Microsoft.ContainerRegistry/registries/${t}`, 'Container Registry', l('Registro contenitori', 'Container registry'))),
  {
    type: 'Microsoft.ContainerService/managedClusters', service: 'Azure Kubernetes Service', model: 'plan', plan: (r) => r?.sku?.tier ?? 'Free',
    idle: (r) => r?._power === 'stopped',
    plans: [
      { sku: 'Free', free: true, specs: l('Piano di controllo gratuito, senza SLA', 'Free control plane, no SLA') },
      { sku: 'Standard', hourly: 0.093, specs: l('SLA 99,95% · fino a 5000 nodi', '99.95% SLA · up to 5000 nodes') },
      { sku: 'Premium', hourly: 0.56, specs: l('Standard + supporto a lungo termine', 'Standard + long-term support') },
    ],
    notes: l('Qui c\'è solo il piano di controllo. I nodi si pagano come set di scalabilità nel gruppo di risorse del nodo (MC_…).', 'This is the control plane only. Nodes are billed as scale sets in the node resource group (MC_…).'),
  },
  INCL('Microsoft.App/containerApps/revisions', 'Azure Container Apps', l('App contenitore', 'Container App')),
  INCL('Microsoft.ContainerService/managedClusters/agentPools', 'Azure Kubernetes Service', l('Set di scalabilità nel gruppo del nodo', 'Scale set in the node resource group')),
  {
    type: 'Microsoft.App/managedEnvironments', service: 'Azure Container Apps', model: 'mixed',
    plan: (r) => ((r?.properties?.workloadProfiles ?? []).some((p: any) => p?.workloadProfileType && p.workloadProfileType !== 'Consumption') ? 'Dedicated' : 'Consumption'),
    plans: [
      { sku: 'Consumption', free: true, specs: l('Nessun costo fisso: si pagano le app', 'No fixed cost: apps are billed') },
      { sku: 'Dedicated', hourly: 0.093, specs: l('Gestione profili dedicati + nodi D4/E4', 'Dedicated profile management + D4/E4 nodes') },
    ],
  },
  ...(['containerApps', 'jobs'] as const).map((t): PriceDef => ({
    type: `Microsoft.App/${t}`, service: 'Azure Container Apps', model: 'consumption',
    meters: [
      { key: 'vcpu', label: l('vCPU attiva', 'Active vCPU'), unit: l('vCPU-s', 'vCPU-s'), price: 0.0000223, per: 1, included: 180_000, sim: (r) => {
        const cpu = num(r?.properties?.template?.containers?.[0]?.resources?.cpu, 0.5);
        const always = t === 'containerApps' && num(r?.properties?.template?.scale?.minReplicas, 0) > 0;
        return Math.round((always ? 2_628_000 : 350_000 * jitter(r?.id ?? '', 'vcpu')) * cpu);
      } },
      { key: 'mem', label: l('Memoria attiva', 'Active memory'), unit: l('GiB-s', 'GiB-s'), price: 0.0000028, per: 1, included: 360_000, sim: (r) => {
        const mem = parseFloat(String(r?.properties?.template?.containers?.[0]?.resources?.memory ?? '1Gi')) || 1;
        const always = t === 'containerApps' && num(r?.properties?.template?.scale?.minReplicas, 0) > 0;
        return Math.round((always ? 2_628_000 : 350_000 * jitter(r?.id ?? '', 'mem')) * mem);
      } },
      ...(t === 'containerApps' ? [perMillion('requests', 'Richieste HTTP', 'HTTP requests', 0.37, 3_000_000, 2_000_000)] : []),
    ],
    notes: l('Prime 180.000 vCPU-s, 360.000 GiB-s e 2 milioni di richieste gratuite al mese. Con repliche minime > 0 l\'app è sempre attiva.', 'First 180,000 vCPU-s, 360,000 GiB-s and 2 million requests free each month. With min replicas > 0 the app is always active.'),
  })),
  {
    type: 'Microsoft.ContainerInstance/containerGroups', service: 'Container Instances', model: 'consumption',
    idle: (r) => r?.properties?.instanceView?.state === 'Stopped',
    meters: [
      { key: 'vcpu', label: l('vCPU', 'vCPU'), unit: l('vCPU-ora', 'vCPU-hour'), price: 0.0385, per: 1, sim: (r) => HOURS * (r?.properties?.containers ?? []).reduce((s: number, c: any) => s + num(c?.properties?.resources?.requests?.cpu, 1), 0) || HOURS },
      { key: 'mem', label: l('Memoria', 'Memory'), unit: l('GB-ora', 'GB-hour'), price: 0.0043, per: 1, sim: (r) => HOURS * (r?.properties?.containers ?? []).reduce((s: number, c: any) => s + num(c?.properties?.resources?.requests?.memoryInGB, 1.5), 0) || HOURS * 1.5 },
    ],
    notes: l('Si paga al secondo mentre il gruppo è in esecuzione.', 'Billed per second while the group runs.'),
  },

  // ---------------- Identità, monitoraggio
  FREE('Microsoft.ManagedIdentity/userAssignedIdentities', 'Microsoft Entra ID'),
  FREE('Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials', 'Microsoft Entra ID'),
  {
    type: 'Microsoft.OperationalInsights/workspaces', service: 'Log Analytics', model: 'consumption',
    plan: (r) => r?.properties?.sku?.name ?? 'PerGB2018',
    plans: [
      { sku: 'PerGB2018', specs: l('A consumo: si pagano i GB inseriti', 'Pay-as-you-go: billed per GB ingested') },
      { sku: 'CapacityReservation', specs: l('Impegno da 100 GB/giorno (circa −15%)', '100 GB/day commitment (about −15%)'), meterPrices: { ingest: 2.35 } },
      { sku: 'Free', free: true, specs: l('Legacy · 500 MB/giorno · 7 giorni', 'Legacy · 500 MB/day · 7 days'), meterPrices: { ingest: 0, retention: 0 } },
    ],
    meters: [
      perGb('ingest', 'Dati inseriti (Analytics)', 'Data ingested (Analytics)', 2.76, 8, 5, l('GB', 'GB')),
      perGb('retention', 'Conservazione oltre 31 giorni', 'Retention beyond 31 days', 0.12, (r) => (num(r?.properties?.retentionInDays, 30) > 31 ? 8 : 0)),
    ],
    notes: l('I primi 5 GB al mese sono gratuiti.', 'The first 5 GB per month are free.'),
  },
  {
    type: 'Microsoft.Insights/components', service: 'Application Insights', model: 'consumption',
    meters: [perGb('ingest', 'Telemetria inserita', 'Telemetry ingested', 2.76, 2, 0, l('GB', 'GB'))],
    notes: l('Basata sull\'area di lavoro: i GB si sommano a quelli di Log Analytics.', 'Workspace-based: GB add up with Log Analytics.'),
  },
  {
    type: 'Microsoft.Insights/actionGroups', service: 'Azure Monitor', model: 'consumption',
    meters: [
      { key: 'email', label: l('Email', 'Email'), unit: l('100.000 email', '100,000 emails'), price: 1.86, per: 100_000, included: 1000, sim: sim(300, 'email') },
      { key: 'sms', label: l('SMS (Italia)', 'SMS (Italy)'), unit: l('SMS', 'SMS'), price: 0.035, per: 1, sim: () => 0 },
      { key: 'webhook', label: l('Webhook', 'Webhooks'), unit: l('milione', 'million'), price: 0.56, per: 1_000_000, included: 100_000, sim: sim(500, 'webhook') },
    ],
  },
  {
    type: 'Microsoft.Insights/metricAlerts', service: 'Azure Monitor', model: 'plan', plans: [{ sku: 'Signal', monthly: 0.093, specs: l('Per serie temporale monitorata', 'Per monitored time series') }], plan: () => 'Signal',
    units: (r) => Math.max(1, (r?.properties?.scopes ?? []).length), unitLabel: l('serie', 'series'),
  },
  {
    type: 'Microsoft.Insights/scheduledQueryRules', service: 'Azure Monitor', model: 'plan',
    plan: (r) => ({ PT1M: 'PT1M', PT5M: 'PT5M', PT10M: 'PT10M' } as Record<string, string>)[r?.properties?.evaluationFrequency] ?? 'PT15M',
    plans: [
      { sku: 'PT15M', monthly: 1.4, specs: l('Valutazione ogni 15 minuti', 'Evaluated every 15 minutes') },
      { sku: 'PT10M', monthly: 2.79, specs: l('Ogni 10 minuti', 'Every 10 minutes') },
      { sku: 'PT5M', monthly: 4.65, specs: l('Ogni 5 minuti', 'Every 5 minutes') },
      { sku: 'PT1M', monthly: 13.94, specs: l('Ogni minuto', 'Every minute') },
    ],
  },
  FREE('Microsoft.Insights/activityLogAlerts', 'Azure Monitor'),
  FREE('Microsoft.Insights/autoscalesettings', 'Azure Monitor'),
  FREE('Microsoft.Insights/diagnosticSettings', 'Azure Monitor', l('Gratuite: si paga la destinazione (Log Analytics, archiviazione, Event Hubs).', 'Free: the destination is billed (Log Analytics, storage, Event Hubs).')),
  FREE('Microsoft.Insights/dataCollectionRules', 'Azure Monitor', l('Gratuite: si pagano i dati inseriti nell\'area di lavoro.', 'Free: ingested data is billed in the workspace.')),
  FREE('Microsoft.Insights/workbooks', 'Azure Monitor'),
  FREE('Microsoft.Portal/dashboards', 'Azure Portal'),

  // ---------------- Integrazione
  {
    type: 'Microsoft.ServiceBus/namespaces', service: 'Service Bus', model: 'mixed', plan: (r) => r?.sku?.name ?? 'Standard',
    units: (r) => (r?.sku?.name === 'Premium' ? Math.max(1, num(r?.sku?.capacity, 1)) : 1), unitLabel: l('unità di messaggistica', 'messaging units'),
    plans: [
      { sku: 'Basic', specs: l('Solo code · si pagano le operazioni', 'Queues only · pay per operation'), meterPrices: { ops: 0.047 } },
      { sku: 'Standard', hourly: 0.0125, specs: l('Code e argomenti · 13 milioni di operazioni incluse', 'Queues and topics · 13 million operations included'), meterPrices: { ops: 0.75 }, meterIncluded: { ops: 13_000_000 } },
      { sku: 'Premium', hourly: 0.856, specs: l('Risorse dedicate · reti private · messaggi fino a 100 MB', 'Dedicated resources · private networking · messages up to 100 MB'), meterPrices: { ops: 0 } },
    ],
    meters: [perMillion('ops', 'Operazioni di messaggistica', 'Messaging operations', 0.047, 8_000_000)],
  },
  ...['authorizationRules', 'queues', 'topics', 'topics/subscriptions', 'topics/subscriptions/rules', 'queues/authorizationRules', 'topics/authorizationRules']
    .map((t) => INCL(`Microsoft.ServiceBus/namespaces/${t}`, 'Service Bus', l('Spazio dei nomi', 'Namespace'))),
  {
    type: 'Microsoft.EventHub/namespaces', service: 'Event Hubs', model: 'mixed', plan: (r) => r?.sku?.name ?? 'Standard',
    units: capacity, unitLabel: l('unità elaborate', 'throughput units'),
    plans: [
      { sku: 'Basic', hourly: 0.0141, specs: l('1 gruppo di consumer · 1 giorno di conservazione', '1 consumer group · 1 day retention') },
      { sku: 'Standard', hourly: 0.0282, specs: l('20 gruppi di consumer · Kafka · Capture opzionale', '20 consumer groups · Kafka · optional Capture') },
      { sku: 'Premium', hourly: 1.293, specs: l('Unità di elaborazione dedicate · 90 giorni', 'Dedicated processing units · 90 days'), meterPrices: { events: 0 } },
    ],
    meters: [perMillion('events', 'Eventi in ingresso', 'Ingress events', 0.026, 20_000_000)],
  },
  ...['authorizationRules', 'eventhubs', 'eventhubs/consumergroups', 'eventhubs/authorizationRules']
    .map((t) => INCL(`Microsoft.EventHub/namespaces/${t}`, 'Event Hubs', l('Spazio dei nomi', 'Namespace'))),
  ...(['topics', 'systemTopics'] as const).map((t): PriceDef => ({
    type: `Microsoft.EventGrid/${t}`, service: 'Event Grid', model: 'consumption',
    meters: [perMillion('ops', 'Operazioni', 'Operations', 0.56, 600_000, 100_000)],
    notes: l('Prime 100.000 operazioni al mese gratuite.', 'First 100,000 operations per month free.'),
  })),
  INCL('Microsoft.EventGrid/eventSubscriptions', 'Event Grid', l('Argomento', 'Topic')),
  INCL('Microsoft.EventGrid/systemTopics/eventSubscriptions', 'Event Grid', l('Argomento di sistema', 'System topic')),
  {
    type: 'Microsoft.Logic/workflows', service: 'Logic Apps', model: 'consumption',
    meters: [
      { key: 'actions', label: l('Azioni e trigger', 'Actions and triggers'), unit: l('esecuzione', 'execution'), price: 0.0000233, per: 1, included: 4000, sim: sim(40_000, 'actions') },
      { key: 'std', label: l('Connettori standard', 'Standard connectors'), unit: l('chiamata', 'call'), price: 0.000116, per: 1, sim: sim(5_000, 'std') },
      { key: 'ent', label: l('Connettori enterprise', 'Enterprise connectors'), unit: l('chiamata', 'call'), price: 0.00093, per: 1, sim: () => 0 },
    ],
    notes: l('Logic Apps a consumo. Logic Apps Standard si paga con un piano WS1/WS2/WS3.', 'Consumption Logic Apps. Logic Apps Standard is billed through a WS1/WS2/WS3 plan.'),
  },
  ...(['signalR', 'webPubSub'] as const).map((t): PriceDef => ({
    type: `Microsoft.SignalRService/${t}`, service: t === 'signalR' ? 'SignalR' : 'Azure Web PubSub', model: 'mixed', plan: (r) => r?.sku?.name ?? 'Free_F1',
    units: capacity, unitLabel: l('unità', 'units'),
    plans: [
      { sku: 'Free_F1', free: true, specs: l('20 connessioni · 20.000 messaggi/giorno', '20 connections · 20,000 messages/day'), meterPrices: { messages: 0 } },
      { sku: 'Standard_S1', monthly: 46.5, specs: l('1000 connessioni per unità · 1 milione di messaggi/giorno', '1000 connections per unit · 1 million messages/day') },
      { sku: 'Premium_P1', monthly: 60.5, specs: l('Scalabilità automatica · zone di disponibilità', 'Autoscale · availability zones') },
      { sku: 'Premium_P2', monthly: 605, specs: l('Da 100 a 1000 unità', 'From 100 to 1000 units') },
    ],
    meters: [perMillion('messages', 'Messaggi oltre la quota giornaliera', 'Messages above daily quota', 0.93, 5_000_000, 30_000_000)],
  })),
  {
    type: 'Microsoft.ApiManagement/service', service: 'API Management', model: 'plan', plan: (r) => r?.sku?.name ?? 'Developer',
    units: capacity, unitLabel: l('unità', 'units'),
    plans: [
      { sku: 'Consumption', specs: l('Serverless · 1 milione di chiamate gratuite', 'Serverless · 1 million calls free'), meterPrices: { calls: 3.24 } },
      { sku: 'Developer', hourly: 0.061, specs: l('Senza SLA · solo sviluppo e test', 'No SLA · development and test only') },
      { sku: 'Basic', hourly: 0.188, specs: l('SLA 99,95% · 2 unità max', '99.95% SLA · 2 units max') },
      { sku: 'BasicV2', hourly: 0.192, specs: l('Nuova generazione · avvio rapido', 'New generation · fast provisioning') },
      { sku: 'Standard', hourly: 0.87, specs: l('4 unità max · 50 GB di cache', '4 units max · 50 GB cache') },
      { sku: 'StandardV2', hourly: 0.89, specs: l('Integrazione con la rete virtuale', 'Virtual network integration') },
      { sku: 'Premium', hourly: 3.52, specs: l('Più aree · zone · rete virtuale', 'Multi-region · zones · virtual network') },
    ],
    meters: [perMillion('calls', 'Chiamate API', 'API calls', 0, 1_500_000, 1_000_000)],
    notes: l('Developer non ha SLA: non va usato in produzione.', 'Developer has no SLA: do not use it in production.'),
  },
  ...['apis', 'products', 'subscriptions', 'namedValues', 'backends', 'apis/operations', 'apis/policies', 'policies', 'loggers']
    .map((t) => INCL(`Microsoft.ApiManagement/service/${t}`, 'API Management', l('Istanza Gestione API', 'API Management instance'))),
  {
    type: 'Microsoft.AppConfiguration/configurationStores', service: 'Azure App Configuration', model: 'mixed', plan: (r) => r?.sku?.name ?? 'free',
    plans: [
      { sku: 'free', free: true, specs: l('1000 richieste/giorno · 10 MB', '1000 requests/day · 10 MB'), meterPrices: { requests: 0 } },
      { sku: 'developer', monthly: 8.4, specs: l('6000 richieste/giorno · 500 MB', '6000 requests/day · 500 MB') },
      { sku: 'standard', monthly: 33.5, specs: l('200.000 richieste/giorno incluse · 1 GB · SLA', '200,000 requests/day included · 1 GB · SLA') },
      { sku: 'premium', monthly: 223, specs: l('Repliche e scalabilità', 'Replicas and scale') },
    ],
    meters: [ops10k('requests', 'Richieste oltre la quota', 'Requests over quota', 0.056, 300_000)],
  },
  INCL('Microsoft.AppConfiguration/configurationStores/keyValues', 'Azure App Configuration', l('Archivio configurazioni', 'Configuration store')),
  {
    type: 'Microsoft.Cache/redis', service: 'Redis Cache', model: 'plan',
    plan: (r) => { const s = r?.properties?.sku ?? {}; return `${s.name ?? 'Basic'} ${s.family ?? 'C'}${num(s.capacity, 0)}`; },
    units: (r) => (r?.properties?.sku?.name === 'Premium' ? Math.max(1, num(r?.properties?.shardCount, 1)) : 1), unitLabel: l('shard', 'shards'),
    plans: [
      { sku: 'Basic C0', hourly: 0.0216, specs: l('250 MB · nodo singolo, senza SLA', '250 MB · single node, no SLA') },
      { sku: 'Basic C1', hourly: 0.054, specs: l('1 GB · nodo singolo', '1 GB · single node') },
      { sku: 'Basic C2', hourly: 0.089, specs: l('2,5 GB · nodo singolo', '2.5 GB · single node') },
      { sku: 'Standard C0', hourly: 0.054, specs: l('250 MB · replica · SLA 99,9%', '250 MB · replicated · 99.9% SLA') },
      { sku: 'Standard C1', hourly: 0.135, specs: l('1 GB · replica', '1 GB · replicated') },
      { sku: 'Standard C2', hourly: 0.222, specs: l('2,5 GB · replica', '2.5 GB · replicated') },
      { sku: 'Standard C3', hourly: 0.445, specs: l('6 GB · replica', '6 GB · replicated') },
      { sku: 'Premium P1', hourly: 0.534, specs: l('6 GB · cluster · persistenza · rete virtuale', '6 GB · clustering · persistence · virtual network') },
      { sku: 'Premium P2', hourly: 1.067, specs: l('13 GB', '13 GB') },
      { sku: 'Premium P3', hourly: 2.135, specs: l('26 GB', '26 GB') },
    ],
  },

  INCL('Microsoft.Cache/redis/firewallRules', 'Redis Cache', l('Cache Redis', 'Redis cache')),
  {
    type: 'Microsoft.Cache/redisEnterprise', service: 'Redis Cache', model: 'plan', plan: (r) => r?.sku?.name ?? 'Balanced_B1',
    plans: [
      { sku: 'Balanced_B0', hourly: 0.018, specs: l('0,5 GB · 2 vCPU condivise · sviluppo', '0.5 GB · 2 shared vCPUs · development') },
      { sku: 'Balanced_B1', hourly: 0.046, specs: l('1 GB · 2 vCPU', '1 GB · 2 vCPUs') },
      { sku: 'Balanced_B3', hourly: 0.12, specs: l('3 GB · 2 vCPU', '3 GB · 2 vCPUs') },
      { sku: 'Balanced_B5', hourly: 0.23, specs: l('6 GB · 2 vCPU', '6 GB · 2 vCPUs') },
      { sku: 'Balanced_B10', hourly: 0.46, specs: l('12 GB · 4 vCPU', '12 GB · 4 vCPUs') },
      { sku: 'Balanced_B20', hourly: 0.92, specs: l('24 GB · 8 vCPU', '24 GB · 8 vCPUs') },
      { sku: 'MemoryOptimized_M10', hourly: 0.33, specs: l('12 GB · 2 vCPU · più memoria per vCPU', '12 GB · 2 vCPUs · more memory per vCPU') },
      { sku: 'MemoryOptimized_M20', hourly: 0.66, specs: l('24 GB · 4 vCPU', '24 GB · 4 vCPUs') },
      { sku: 'ComputeOptimized_X3', hourly: 0.22, specs: l('3 GB · 4 vCPU · più calcolo', '3 GB · 4 vCPUs · more compute') },
      { sku: 'ComputeOptimized_X5', hourly: 0.43, specs: l('6 GB · 4 vCPU', '6 GB · 4 vCPUs') },
    ],
    notes: l('Con l\'alta disponibilità attiva (predefinita) il costo comprende la replica.', 'With high availability on (the default) the cost includes the replica.'),
  },
  INCL('Microsoft.Cache/redisEnterprise/databases', 'Redis Cache', l('Azure Managed Redis', 'Azure Managed Redis')),

  // ---------------- IA
  {
    type: 'Microsoft.CognitiveServices/accounts', service: 'Cognitive Services', model: 'consumption',
    plan: (r) => (r?.sku?.name === 'F0' ? 'F0' : r?.kind === 'OpenAI' || r?.kind === 'AIServices' ? 'OpenAI' : 'S0'),
    plans: [
      { sku: 'F0', free: true, specs: l('Livello gratuito con limiti mensili', 'Free tier with monthly limits'), meterPrices: { tx: 0 } },
      { sku: 'S0', specs: l('Standard · si pagano le transazioni', 'Standard · pay per transaction') },
      { sku: 'OpenAI', specs: l('Azure OpenAI / AI Services: si pagano i token sulle distribuzioni', 'Azure OpenAI / AI Services: tokens are billed on deployments'), meterPrices: { tx: 0 } },
    ],
    meters: [{ key: 'tx', label: l('Transazioni', 'Transactions'), unit: l('1000 transazioni', '1000 transactions'), price: 0.93, per: 1000, sim: sim(5000, 'tx') }],
  },
  {
    type: 'Microsoft.CognitiveServices/accounts/deployments', service: 'Cognitive Services', model: 'consumption',
    plan: (r) => (r?.sku?.name === 'ProvisionedManaged' || r?.sku?.name === 'GlobalProvisionedManaged' ? 'Provisioned' : 'Standard'),
    units: (r) => (/Provisioned/.test(r?.sku?.name ?? '') ? Math.max(1, num(r?.sku?.capacity, 15)) : 1), unitLabel: l('PTU', 'PTU'),
    plans: [
      { sku: 'Standard', specs: l('A consumo: si pagano i token', 'Pay-as-you-go: tokens are billed') },
      { sku: 'Provisioned', hourly: 0.93, specs: l('Unità di velocità effettiva riservate (PTU)', 'Reserved throughput units (PTU)'), meterPrices: { input: 0, output: 0 } },
    ],
    meters: [
      { key: 'input', label: l('Token in ingresso', 'Input tokens'), unit: l('milione di token', 'million tokens'), price: 1.85, per: 1_000_000, sim: sim(3_000_000, 'input') },
      { key: 'output', label: l('Token in uscita', 'Output tokens'), unit: l('milione di token', 'million tokens'), price: 7.4, per: 1_000_000, sim: sim(600_000, 'output') },
    ],
    notes: l('Il prezzo dei token dipende dal modello distribuito: gpt-4o-mini costa circa un decimo di gpt-4o.', 'Token price depends on the deployed model: gpt-4o-mini costs about a tenth of gpt-4o.'),
  },
  INCL('Microsoft.CognitiveServices/accounts/projects', 'Cognitive Services', l('Risorsa Azure AI Foundry (token e modelli sulle distribuzioni)', 'Azure AI Foundry resource (tokens and models on deployments)')),
  {
    type: 'Microsoft.Search/searchServices', service: 'Azure Cognitive Search', model: 'plan', plan: (r) => r?.sku?.name ?? 'basic',
    units: (r) => Math.max(1, num(r?.properties?.replicaCount, 1)) * Math.max(1, num(r?.properties?.partitionCount, 1)), unitLabel: l('unità di ricerca', 'search units'),
    plans: [
      { sku: 'free', free: true, specs: l('50 MB · 3 indici · condiviso', '50 MB · 3 indexes · shared') },
      { sku: 'basic', hourly: 0.1, specs: l('15 GB per partizione · 15 indici', '15 GB per partition · 15 indexes') },
      { sku: 'standard', hourly: 0.336, specs: l('160 GB per partizione · 50 indici', '160 GB per partition · 50 indexes') },
      { sku: 'standard2', hourly: 1.343, specs: l('512 GB per partizione · 200 indici', '512 GB per partition · 200 indexes') },
      { sku: 'standard3', hourly: 2.686, specs: l('1 TB per partizione · 200 indici', '1 TB per partition · 200 indexes') },
      { sku: 'storage_optimized_l1', hourly: 3.81, specs: l('2 TB per partizione', '2 TB per partition') },
    ],
    notes: l('Unità di ricerca = repliche × partizioni.', 'Search units = replicas × partitions.'),
  },
  FREE('Microsoft.MachineLearningServices/workspaces', 'Azure Machine Learning', l('L\'area di lavoro è gratuita: si pagano calcolo, archiviazione, Key Vault, registro e Application Insights associati.', 'The workspace is free: the attached compute, storage, Key Vault, registry and Application Insights are billed.')),

  // ---------------- Gestione
  FREE('Microsoft.Authorization/policyDefinitions', 'Azure Policy'),
  FREE('Microsoft.Authorization/policySetDefinitions', 'Azure Policy'),
  FREE('Microsoft.Authorization/policyAssignments', 'Azure Policy'),
  FREE('Microsoft.Resources/templateSpecs', 'Azure Resource Manager'),
  FREE('Microsoft.Resources/templateSpecs/versions', 'Azure Resource Manager'),
  {
    type: 'Microsoft.Resources/deploymentScripts', service: 'Container Instances', model: 'consumption',
    meters: [{ key: 'runs', label: l('Esecuzioni (ACI + archiviazione temporanei)', 'Runs (temporary ACI + storage)'), unit: l('esecuzione', 'run'), price: 0.012, per: 1, sim: () => 1 }],
  },
  {
    type: 'Microsoft.Automation/automationAccounts', service: 'Automation', model: 'consumption',
    meters: [{ key: 'minutes', label: l('Minuti di esecuzione dei job', 'Job run minutes'), unit: l('minuto', 'minute'), price: 0.0019, per: 1, included: 500, sim: sim(600, 'minutes') }],
    notes: l('Primi 500 minuti al mese gratuiti.', 'First 500 minutes per month free.'),
  },
  {
    type: 'Microsoft.RecoveryServices/vaults', service: 'Backup', model: 'consumption',
    meters: [
      { key: 'instances', label: l('Istanze protette (fino a 50 GB)', 'Protected instances (up to 50 GB)'), unit: l('istanza/mese', 'instance/month'), price: 4.65, per: 1, sim: () => 1 },
      perGb('storage', 'Archiviazione backup (GRS)', 'Backup storage (GRS)', 0.0416, 40),
    ],
    notes: l('Stimata una VM protetta. I costi reali dipendono dagli elementi sottoposti a backup.', 'Assumes one protected VM. Real cost depends on the items backed up.'),
  },
  FREE('Microsoft.Consumption/budgets', 'Cost Management'),
];

const BY_TYPE = new Map(PRICES.map((p) => [p.type.toLowerCase(), p]));
export function priceDef(type: string): PriceDef | undefined {
  return BY_TYPE.get(type.toLowerCase());
}

/** prezzo €/milione di token per il modello di una distribuzione Azure OpenAI */
export function openAiTokenPrices(model: string | undefined): [number, number] | undefined {
  if (!model) return undefined;
  const m = model.toLowerCase();
  return OPENAI_MODELS[m] ?? Object.entries(OPENAI_MODELS).find(([k]) => m.startsWith(k))?.[1];
}

export const HOURS_PER_MONTH = HOURS;
