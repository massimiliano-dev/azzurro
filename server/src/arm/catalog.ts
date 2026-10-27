/**
 * Catalogo dei tipi di risorsa ARM emulati: versioni API, valori di default,
 * proprietà calcolate (endpoint, FQDN...), segreti e azioni POST (listKeys...).
 * Qualsiasi altro tipo resta comunque utilizzabile come risorsa generica.
 */
import { generateKeyPairSync } from 'node:crypto';
import { accountKey, deterministicIp, randomToken, uniqueString, uuid } from '../ids.ts';
import { HttpError } from '../errors.ts';

export type Category = 'compute' | 'containers' | 'web' | 'storage' | 'databases' | 'networking' | 'identity' | 'security' | 'integration' | 'monitor' | 'ai' | 'management';
export type Lbl = { it: string; en: string };

export interface BuildCtx {
  id: string;
  name: string;
  names: string[];
  sub: string;
  rg?: string;
  location?: string;
  tenantId: string;
  now: string;
  existing?: any;
}

export interface ActionCtx extends BuildCtx {
  body: any;
  /** chiamare per salvare le modifiche fatte su res (es. rigenerazione chiavi) */
  save: () => void;
}

export interface UiField {
  key: string;
  label: Lbl;
  kind: 'text' | 'password' | 'number' | 'select' | 'bool';
  options?: string[];
  default?: unknown;
  required?: boolean;
}

/** Voce del catalogo di creazione che preconfigura un tipo (es. Azure AI Foundry = account AIServices con progetti). */
export interface Preset {
  key: string;
  label: Lbl;
  description?: Lbl;
  body: any;
  fields?: UiField[];
}

export interface TypeDef {
  type: string;
  label: Lbl;
  category: Category;
  apiVersions: string[];
  tracked?: boolean;
  global?: boolean;
  /** esiste implicitamente quando esiste il padre (es. storageAccounts/blobServices/default) */
  implicit?: boolean;
  nameRule?: { pattern: RegExp; code: string; message: string };
  globalName?: { code: string; message: (name: string) => string };
  defaults?: (body: any, ctx: BuildCtx) => void;
  computed?: (res: any, ctx: BuildCtx) => void;
  secrets?: (ctx: BuildCtx) => Record<string, string>;
  actions?: Record<string, (res: any, ctx: ActionCtx) => any>;
  writeOnly?: string[];
  inlineChildren?: { prop: string; type: string }[];
  hooks?: ('identity' | 'aks' | 'vm' | 'servicebus' | 'eventhub' | 'sqlserver' | 'kvaccess' | 'kvsecret' | 'uami' | 'vnetSubnetIp' | 'siteconfig' | 'hostname' | 'redisdb' | 'akspool' | 'carevision')[];
  ui?: { fields?: UiField[]; hidden?: boolean; icon?: string; presets?: Preset[] };
}

const V = (...v: string[]) => v;
const lbl = (it: string, en: string): Lbl => ({ it, en });
const f = (key: string, it: string, en: string, kind: UiField['kind'], extra: Partial<UiField> = {}): UiField => ({ key, label: lbl(it, en), kind, ...extra });

function setDefault(obj: any, path: string, value: unknown) {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts.slice(0, -1)) {
    if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p];
  }
  const last = parts[parts.length - 1];
  if (cur[last] === undefined || cur[last] === null) cur[last] = typeof value === 'function' ? (value as () => unknown)() : value;
}

function defaults(map: Record<string, unknown>) {
  return (body: any) => {
    for (const [k, v] of Object.entries(map)) setDefault(body, k, v);
  };
}

const keyPair = () => ({ primaryKey: accountKey(32), secondaryKey: accountKey(32) });
const lower = (s: string) => s.toLowerCase();

const NAME = {
  storage: { pattern: /^[a-z0-9]{3,24}$/, code: 'AccountNameInvalid', message: 'is not a valid storage account name. Storage account name must be between 3 and 24 characters in length and use numbers and lower-case letters only.' },
  vault: { pattern: /^[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]$/, code: 'VaultNameNotValid', message: 'The vault name is invalid. A vault\'s name must be between 3-24 alphanumeric characters. The name must begin with a letter, end with a letter or digit, and not contain consecutive hyphens.' },
  dns: { pattern: /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, code: 'InvalidResourceName', message: 'The name can contain only lowercase letters, numbers and hyphens, must be 3-63 characters long and cannot start or end with a hyphen.' },
  web: { pattern: /^[a-zA-Z0-9][a-zA-Z0-9-]{0,58}[a-zA-Z0-9]$/, code: 'InvalidResourceName', message: 'The name can contain only letters, numbers and hyphens, must be 2-60 characters long and cannot start or end with a hyphen.' },
  acr: { pattern: /^[a-zA-Z0-9]{5,50}$/, code: 'RegistryNameInvalid', message: 'Registry name must be 5-50 alphanumeric characters.' },
  generic: { pattern: /^[^<>%&:\\?/#*$^+|"'\s][^<>%&:\\?/#*$^+|"']{0,259}$/, code: 'InvalidResourceName', message: 'Resource name contains invalid characters.' },
};

const taken = (code: string, what: string) => ({ code, message: (n: string) => `The ${what} named ${n} is already taken.` });

const storageServices = (svc: string, it: string, en: string): TypeDef => ({
  type: `Microsoft.Storage/storageAccounts/${svc}`, label: lbl(it, en), category: 'storage', apiVersions: V('2023-05-01', '2023-01-01', '2022-09-01'), implicit: true, ui: { hidden: true },
  defaults: defaults({ properties: {} }),
});

const sbAuthRule = (type: string, label: Lbl, host: 'servicebus' | 'eventhub'): TypeDef => ({
  type, label, category: 'integration', apiVersions: V('2022-10-01-preview', '2021-11-01', '2017-04-01'), ui: { hidden: true },
  defaults: defaults({ 'properties.rights': ['Listen', 'Send'] }),
  secrets: () => keyPair(),
  actions: {
    listKeys: (res, ctx) => sasKeys(res, ctx),
    regenerateKeys: (res, ctx) => {
      const which = ctx.body?.keyType === 'SecondaryKey' ? 'secondaryKey' : 'primaryKey';
      res._secrets[which] = accountKey(32);
      ctx.save();
      return sasKeys(res, ctx);
    },
  },
});

function appConfigKeys(r: any) {
  const ep = r.properties.endpoint;
  const k = (name: string, id: string, value: string, ro: boolean) => ({ id, name, value, connectionString: `Endpoint=${ep};Id=${id};Secret=${value}`, lastModified: r.properties.creationDate, readOnly: ro });
  return [k('Primary', r._secrets.id1, r._secrets.primary, false), k('Secondary', r._secrets.id2, r._secrets.secondary, false), k('Primary Read Only', r._secrets.id3, r._secrets.primaryRO, true), k('Secondary Read Only', r._secrets.id4, r._secrets.secondaryRO, true)];
}

function sasKeys(res: any, ctx: ActionCtx) {
  const ns = ctx.names[0];
  const entity = ctx.names.length > 2 ? `;EntityPath=${ctx.names[1]}` : '';
  const cs = (k: string) => `Endpoint=sb://${lower(ns)}.servicebus.windows.net/;SharedAccessKeyName=${ctx.name};SharedAccessKey=${k}${entity}`;
  return {
    primaryConnectionString: cs(res._secrets.primaryKey),
    secondaryConnectionString: cs(res._secrets.secondaryKey),
    primaryKey: res._secrets.primaryKey,
    secondaryKey: res._secrets.secondaryKey,
    keyName: ctx.name,
  };
}

function kubeconfig(name: string, fqdn: string, user: string) {
  const yaml = `apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: ${Buffer.from('azzurro-emulated-ca').toString('base64')}
    server: https://${fqdn}:443
  name: ${name}
contexts:
- context:
    cluster: ${name}
    user: ${user}_${name}
  name: ${name}
current-context: ${name}
kind: Config
preferences: {}
users:
- name: ${user}_${name}
  user:
    token: ${randomToken(32)}
`;
  return Buffer.from(yaml).toString('base64');
}

function sshPublicKey(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
  const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
  const enc = (b: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length);
    return Buffer.concat([len, b]);
  };
  const mpint = (b64: string) => {
    let b = Buffer.from(b64, 'base64url');
    if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
    return enc(b);
  };
  const blob = Buffer.concat([enc(Buffer.from('ssh-rsa')), mpint(jwk.e), mpint(jwk.n)]);
  return {
    publicKey: `ssh-rsa ${blob.toString('base64')} generated-by-azzurro`,
    privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
  };
}

export const TYPES: TypeDef[] = [
  // ---------------- Storage ----------------
  {
    type: 'Microsoft.Storage/storageAccounts', label: lbl('Account di archiviazione', 'Storage account'), category: 'storage',
    apiVersions: V('2023-05-01', '2023-01-01', '2022-09-01', '2021-09-01', '2021-04-01', '2019-06-01'),
    nameRule: NAME.storage, globalName: taken('StorageAccountAlreadyTaken', 'storage account'),
    defaults: defaults({
      kind: 'StorageV2', sku: { name: 'Standard_LRS', tier: 'Standard' },
      'properties.accessTier': 'Hot', 'properties.supportsHttpsTrafficOnly': true, 'properties.minimumTlsVersion': 'TLS1_2',
      'properties.allowBlobPublicAccess': false, 'properties.allowSharedKeyAccess': true, 'properties.publicNetworkAccess': 'Enabled',
      'properties.networkAcls': { bypass: 'AzureServices', defaultAction: 'Allow', ipRules: [], virtualNetworkRules: [] },
      'properties.encryption': { keySource: 'Microsoft.Storage', requireInfrastructureEncryption: false, services: { blob: { enabled: true, keyType: 'Account' }, file: { enabled: true, keyType: 'Account' } } },
    }),
    computed: (r, c) => {
      const n = c.name;
      r.sku.tier = String(r.sku.name).startsWith('Premium') ? 'Premium' : 'Standard';
      r.properties.primaryEndpoints = {
        dfs: `https://${n}.dfs.core.windows.net/`, web: `https://${n}.z6.web.core.windows.net/`, blob: `https://${n}.blob.core.windows.net/`,
        queue: `https://${n}.queue.core.windows.net/`, table: `https://${n}.table.core.windows.net/`, file: `https://${n}.file.core.windows.net/`,
      };
      r.properties.primaryLocation = r.location;
      r.properties.statusOfPrimary = 'available';
      r.properties.creationTime = c.existing?.properties?.creationTime ?? c.now;
      r.properties.keyCreationTime = c.existing?.properties?.keyCreationTime ?? { key1: c.now, key2: c.now };
      if (/GRS/.test(r.sku.name)) {
        r.properties.secondaryLocation = 'northeurope';
        r.properties.statusOfSecondary = 'available';
      }
    },
    secrets: () => ({ key1: accountKey(), key2: accountKey() }),
    actions: {
      listKeys: (r) => ({ keys: [{ creationTime: r.properties.creationTime, keyName: 'key1', value: r._secrets.key1, permissions: 'FULL' }, { creationTime: r.properties.creationTime, keyName: 'key2', value: r._secrets.key2, permissions: 'FULL' }] }),
      regenerateKey: (r, c) => {
        const k = c.body?.keyName === 'key2' ? 'key2' : 'key1';
        r._secrets[k] = accountKey();
        r.properties.keyCreationTime = { ...(r.properties.keyCreationTime ?? {}), [k]: c.now };
        c.save();
        return TYPES_BY_TYPE.get('microsoft.storage/storageaccounts')!.actions!.listKeys(r, c);
      },
      listAccountSas: () => ({ accountSasToken: `sv=2022-11-02&ss=bfqt&srt=sco&sp=rwdlacupiytfx&se=2030-01-01T00:00:00Z&spr=https&sig=${encodeURIComponent(accountKey(32))}` }),
      listServiceSas: () => ({ serviceSasToken: `sv=2022-11-02&sr=c&sp=rl&se=2030-01-01T00:00:00Z&spr=https&sig=${encodeURIComponent(accountKey(32))}` }),
    },
    ui: {
      icon: 'storage',
      fields: [
        f('sku.name', 'Ridondanza', 'Redundancy', 'select', { options: ['Standard_LRS', 'Standard_ZRS', 'Standard_GRS', 'Standard_RAGRS', 'Premium_LRS'], default: 'Standard_LRS' }),
        f('kind', 'Tipo di account', 'Account kind', 'select', { options: ['StorageV2', 'BlobStorage', 'BlockBlobStorage', 'FileStorage'], default: 'StorageV2' }),
        f('properties.accessTier', 'Livello di accesso', 'Access tier', 'select', { options: ['Hot', 'Cool', 'Cold'], default: 'Hot' }),
        f('properties.isHnsEnabled', 'Spazio dei nomi gerarchico (Data Lake)', 'Hierarchical namespace (Data Lake)', 'bool', { default: false }),
      ],
    },
  },
  storageServices('blobServices', 'Servizio BLOB', 'Blob service'),
  storageServices('fileServices', 'Servizio file', 'File service'),
  storageServices('queueServices', 'Servizio code', 'Queue service'),
  storageServices('tableServices', 'Servizio tabelle', 'Table service'),
  {
    type: 'Microsoft.Storage/storageAccounts/blobServices/containers', label: lbl('Contenitore BLOB', 'Blob container'), category: 'storage', apiVersions: V('2023-05-01', '2023-01-01', '2022-09-01', '2021-09-01'),
    nameRule: { pattern: /^(\$root|\$web|[a-z0-9](?!.*--)[a-z0-9-]{1,61}[a-z0-9])$/, code: 'ContainerOperationFailure', message: 'The specified resource name contains invalid characters.' },
    defaults: defaults({ 'properties.publicAccess': 'None', 'properties.defaultEncryptionScope': '$account-encryption-key', 'properties.denyEncryptionScopeOverride': false }),
    computed: (r, c) => Object.assign(r.properties, { lastModifiedTime: c.now, leaseStatus: 'Unlocked', leaseState: 'Available', hasImmutabilityPolicy: false, hasLegalHold: false, deleted: false, remainingRetentionDays: 0 }),
    ui: { hidden: true },
  },
  { type: 'Microsoft.Storage/storageAccounts/fileServices/shares', label: lbl('Condivisione file', 'File share'), category: 'storage', apiVersions: V('2023-05-01', '2023-01-01', '2022-09-01'), defaults: defaults({ 'properties.shareQuota': 5120, 'properties.accessTier': 'TransactionOptimized', 'properties.enabledProtocols': 'SMB' }), computed: (r, c) => Object.assign(r.properties, { lastModifiedTime: c.now, leaseStatus: 'unlocked', leaseState: 'available' }), ui: { hidden: true } },
  { type: 'Microsoft.Storage/storageAccounts/queueServices/queues', label: lbl('Coda', 'Queue'), category: 'storage', apiVersions: V('2023-05-01', '2023-01-01'), defaults: defaults({ 'properties.metadata': {} }), computed: (r) => { r.properties.approximateMessageCount = 0; }, ui: { hidden: true } },
  { type: 'Microsoft.Storage/storageAccounts/tableServices/tables', label: lbl('Tabella', 'Table'), category: 'storage', apiVersions: V('2023-05-01', '2023-01-01'), defaults: defaults({ properties: {} }), computed: (r, c) => { r.properties.tableName = c.name; }, ui: { hidden: true } },
  { type: 'Microsoft.Storage/storageAccounts/managementPolicies', label: lbl('Criteri di gestione', 'Management policy'), category: 'storage', apiVersions: V('2023-05-01', '2023-01-01'), computed: (r, c) => { r.properties.lastModifiedTime = c.now; }, ui: { hidden: true } },

  // ---------------- Key Vault ----------------
  {
    type: 'Microsoft.KeyVault/vaults', label: lbl('Insieme di credenziali delle chiavi', 'Key vault'), category: 'security',
    apiVersions: V('2023-07-01', '2023-02-01', '2022-07-01', '2021-10-01', '2019-09-01'),
    nameRule: NAME.vault, globalName: { code: 'VaultAlreadyExists', message: (n) => `The vault name '${n}' is already in use. Vault names are globally unique so it is possible that the name is already taken.` },
    defaults: (b, c) => defaults({
      'properties.tenantId': c.tenantId, 'properties.sku': { family: 'A', name: 'standard' }, 'properties.sku.family': 'A', 'properties.accessPolicies': [],
      'properties.enabledForDeployment': false, 'properties.enabledForDiskEncryption': false, 'properties.enabledForTemplateDeployment': false,
      'properties.enableSoftDelete': true, 'properties.softDeleteRetentionInDays': 90, 'properties.enableRbacAuthorization': true, 'properties.publicNetworkAccess': 'Enabled',
    })(b),
    computed: (r, c) => {
      r.properties.vaultUri = `https://${lower(c.name)}.vault.azure.net/`;
      r.properties.hsmPoolResourceId = null;
    },
    ui: {
      icon: 'vault',
      fields: [
        f('properties.sku.name', 'Piano tariffario', 'Pricing tier', 'select', { options: ['standard', 'premium'], default: 'standard' }),
        f('properties.enableRbacAuthorization', 'Autorizzazione con Azure RBAC', 'Azure RBAC authorization', 'bool', { default: true }),
        f('properties.enablePurgeProtection', 'Protezione dall\'eliminazione', 'Purge protection', 'bool', { default: false }),
      ],
    },
  },
  {
    type: 'Microsoft.KeyVault/vaults/secrets', label: lbl('Segreto', 'Secret'), category: 'security', apiVersions: V('2023-07-01', '2023-02-01', '2022-07-01', '2019-09-01'),
    nameRule: { pattern: /^[a-zA-Z0-9-]{1,127}$/, code: 'BadParameter', message: 'Secret names can only contain alphanumeric characters and dashes.' },
    writeOnly: ['properties.value'], hooks: ['kvsecret'],
    defaults: defaults({ 'properties.attributes': { enabled: true } }),
    computed: (r, c) => {
      const vault = lower(c.names[0]);
      const version = randomToken(16).replace(/[-_]/g, 'a').slice(0, 32);
      r.properties.secretUri = `https://${vault}.vault.azure.net/secrets/${c.name}`;
      r.properties.secretUriWithVersion = `${r.properties.secretUri}/${version}`;
      const created = c.existing?.properties?.attributes?.created ?? Math.floor(Date.now() / 1000);
      r.properties.attributes = { ...r.properties.attributes, created, updated: Math.floor(Date.now() / 1000), recoveryLevel: 'Recoverable+Purgeable' };
    },
    ui: { hidden: true },
  },
  {
    type: 'Microsoft.KeyVault/vaults/keys', label: lbl('Chiave', 'Key'), category: 'security', apiVersions: V('2023-07-01', '2023-02-01', '2022-07-01'),
    defaults: defaults({ 'properties.kty': 'RSA', 'properties.keySize': 2048, 'properties.keyOps': ['encrypt', 'decrypt', 'sign', 'verify', 'wrapKey', 'unwrapKey'], 'properties.attributes': { enabled: true } }),
    computed: (r, c) => {
      const vault = lower(c.names[0]);
      r.properties.keyUri = `https://${vault}.vault.azure.net/keys/${c.name}`;
      r.properties.keyUriWithVersion = `${r.properties.keyUri}/${randomToken(16).replace(/[-_]/g, 'b').slice(0, 32)}`;
    },
    ui: { hidden: true },
  },
  { type: 'Microsoft.KeyVault/vaults/accessPolicies', label: lbl('Criteri di accesso', 'Access policies'), category: 'security', apiVersions: V('2023-07-01', '2023-02-01', '2022-07-01', '2019-09-01'), hooks: ['kvaccess'], ui: { hidden: true } },

  // ---------------- Web ----------------
  {
    type: 'Microsoft.Web/serverfarms', label: lbl('Piano di servizio app', 'App Service plan'), category: 'web', apiVersions: V('2023-12-01', '2023-01-01', '2022-09-01', '2022-03-01', '2021-02-01'),
    defaults: (b) => {
      defaults({ sku: { name: 'B1' }, 'properties.reserved': false, 'properties.perSiteScaling': false, 'properties.zoneRedundant': false })(b);
      const tiers: Record<string, string> = { F: 'Free', D: 'Shared', B: 'Basic', S: 'Standard', P: 'PremiumV3', Y: 'Dynamic', E: 'ElasticPremium', I: 'IsolatedV2' };
      b.sku.tier ??= tiers[String(b.sku.name)[0]] ?? 'Basic';
      b.sku.size ??= b.sku.name;
      b.sku.family ??= String(b.sku.name).replace(/\d.*$/, '');
      b.sku.capacity ??= 1;
      b.kind ??= b.properties.reserved ? 'linux' : 'app';
    },
    computed: (r, c) => {
      // la SKU è sempre coerente col nome, anche dopo un PATCH che cambia solo name/tier
      const name = String(r.sku.name);
      r.sku.size = name;
      r.sku.family = /v\d$/i.test(name) ? `${name[0]}${name.slice(-2)}` : name.replace(/\d.*$/, '');
      return Object.assign(r.properties, { status: 'Ready', numberOfWorkers: r.sku.capacity ?? 1, maximumNumberOfWorkers: 30, numberOfSites: r.properties.numberOfSites ?? 0, geoRegion: r.location, resourceGroup: c.rg, isSpot: false, elasticScaleEnabled: false });
    },
    ui: {
      icon: 'plan',
      fields: [
        f('sku.name', 'Piano tariffario', 'Pricing plan', 'select', { options: ['F1', 'B1', 'B2', 'S1', 'P0v3', 'P1v3', 'P2v3', 'Y1', 'EP1'], default: 'B1' }),
        f('properties.reserved', 'Linux', 'Linux', 'bool', { default: true }),
      ],
    },
  },
  {
    type: 'Microsoft.Web/sites', label: lbl('App Web', 'Web App'), category: 'web', apiVersions: V('2023-12-01', '2023-01-01', '2022-09-01', '2022-03-01', '2021-02-01'),
    nameRule: NAME.web, globalName: { code: 'WebsiteAlreadyExists', message: (n) => `Website with given name ${n} already exists.` },
    defaults: defaults({ kind: 'app', 'properties.httpsOnly': false, 'properties.enabled': true, 'properties.clientAffinityEnabled': true, 'properties.siteConfig': {} }),
    computed: (r, c) => {
      const host = `${lower(c.name)}.azurewebsites.net`;
      Object.assign(r.properties, {
        state: c.existing?.properties?.state ?? 'Running', defaultHostName: host,
        usageState: 'Normal', availabilityState: 'Normal', repositorySiteName: c.name, resourceGroup: c.rg, lastModifiedTimeUtc: c.now,
        outboundIpAddresses: deterministicIp(c.id + 'o', '20'), possibleOutboundIpAddresses: [1, 2, 3].map((i) => deterministicIp(c.id + i, '20')).join(','),
        customDomainVerificationId: uniqueString(c.id, 'cdv').toUpperCase(), containerSize: 0, dailyMemoryTimeQuota: 0,
        inboundIpAddress: deterministicIp(c.id + 'in', '20'),
        hostNames: c.existing?.properties?.hostNames ?? [host],
        enabledHostNames: c.existing?.properties?.enabledHostNames ?? [host, `${lower(c.name)}.scm.azurewebsites.net`],
        hostNameSslStates: c.existing?.properties?.hostNameSslStates ?? [{ name: host, sslState: 'Disabled', hostType: 'Standard' }, { name: `${lower(c.name)}.scm.azurewebsites.net`, sslState: 'Disabled', hostType: 'Repository' }],
      });
    },
    hooks: ['identity', 'siteconfig'],
    secrets: () => ({ publishingPassword: randomToken(45) }),
    actions: {
      start: (r, c) => { r.properties.state = 'Running'; c.save(); return null; },
      stop: (r, c) => { r.properties.state = 'Stopped'; c.save(); return null; },
      restart: () => null,
      publishxml: (r, c) => `<publishData><publishProfile profileName="${c.name} - Web Deploy" publishMethod="MSDeploy" publishUrl="${lower(c.name)}.scm.azurewebsites.net:443" msdeploySite="${c.name}" userName="$${c.name}" userPWD="${r._secrets.publishingPassword}" destinationAppUrl="https://${lower(c.name)}.azurewebsites.net" /></publishData>`,
    },
    ui: {
      icon: 'web',
      fields: [
        f('properties.serverFarmId', 'ID del piano di servizio app', 'App Service plan ID', 'text', { required: false }),
        f('kind', 'Tipo', 'Kind', 'select', { options: ['app', 'app,linux', 'functionapp', 'functionapp,linux', 'app,linux,container'], default: 'app,linux' }),
        f('properties.siteConfig.linuxFxVersion', 'Stack runtime', 'Runtime stack', 'select', { options: ['NODE|22-lts', 'NODE|20-lts', 'PYTHON|3.12', 'DOTNETCORE|8.0', 'JAVA|21-java21', 'PHP|8.3'], default: 'NODE|22-lts' }),
        f('properties.httpsOnly', 'Solo HTTPS', 'HTTPS only', 'bool', { default: true }),
      ],
    },
  },
  {
    type: 'Microsoft.Web/sites/config', label: lbl('Configurazione app', 'App configuration'), category: 'web', apiVersions: V('2023-12-01', '2023-01-01', '2022-09-01'), implicit: true,
    secrets: () => ({}),
    actions: {
      list: (r, c) => {
        if (lower(c.name) === 'publishingcredentials') return { id: c.id, name: 'publishingcredentials', type: 'Microsoft.Web/sites/config', properties: { name: `$${c.names[0]}`, publishingUserName: `$${c.names[0]}`, publishingPassword: randomToken(45), scmUri: `https://$${c.names[0]}:${randomToken(20)}@${lower(c.names[0])}.scm.azurewebsites.net` } };
        return { id: c.id, name: c.name, type: 'Microsoft.Web/sites/config', location: r.location, properties: r.properties ?? {} };
      },
    },
    ui: { hidden: true },
  },
  {
    type: 'Microsoft.Web/sites/slots', label: lbl('Slot di distribuzione', 'Deployment slot'), category: 'web', apiVersions: V('2023-12-01', '2023-01-01', '2022-09-01'), tracked: true,
    defaults: defaults({ kind: 'app', 'properties.enabled': true }),
    computed: (r, c) => {
      const host = `${lower(c.names[0])}-${lower(c.name)}.azurewebsites.net`;
      Object.assign(r.properties, { state: 'Running', defaultHostName: host, hostNames: [host], enabledHostNames: [host], usageState: 'Normal', availabilityState: 'Normal', resourceGroup: c.rg });
    },
    hooks: ['identity'],
    actions: { start: () => null, stop: () => null, restart: () => null },
    ui: { hidden: true },
  },
  {
    type: 'Microsoft.Web/sites/hostNameBindings', label: lbl('Dominio personalizzato', 'Custom domain'), category: 'web', apiVersions: V('2023-12-01', '2022-09-01'),
    nameRule: { pattern: /^(?=.{4,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/, code: 'BadRequest', message: 'The host name is not a valid domain name.' },
    defaults: (b, c) => defaults({ 'properties.siteName': c.names[0], 'properties.hostNameType': 'Verified', 'properties.customHostNameDnsRecordType': 'CName', 'properties.azureResourceType': 'Website', 'properties.sslState': 'Disabled' })(b),
    computed: (r) => { if (r.properties.sslState === 'Disabled') delete r.properties.thumbprint; r.properties.domainId = null; },
    hooks: ['hostname'],
    ui: { hidden: true },
  },
  {
    type: 'Microsoft.Web/certificates', label: lbl('Certificato App Service', 'App Service certificate'), category: 'web', apiVersions: V('2023-12-01', '2022-09-01'),
    defaults: defaults({ 'properties.password': '' }),
    computed: (r, c) => {
      const cn = String(r.properties.canonicalName ?? r.properties.hostNames?.[0] ?? c.name).toLowerCase();
      const issued = c.existing?.properties?.issueDate ?? c.now;
      Object.assign(r.properties, {
        canonicalName: cn, subjectName: cn, hostNames: [cn], issuer: 'GeoTrust Global TLS RSA4096 SHA256 2022 CA1',
        issueDate: issued, expirationDate: new Date(Date.parse(issued) + 182 * 86400_000).toISOString(),
        thumbprint: c.existing?.properties?.thumbprint ?? uniqueString(c.id, 'thumb').toUpperCase().padEnd(40, '0').slice(0, 40),
        valid: true, keyVaultSecretStatus: 'Initialized', publicKeyHash: uniqueString(c.id, 'pk'),
      });
      delete r.properties.password;
    },
    ui: { icon: 'web' },
  },
  {
    type: 'Microsoft.Web/staticSites', label: lbl('App Web statica', 'Static Web App'), category: 'web', apiVersions: V('2023-12-01', '2023-01-01', '2022-09-01'),
    defaults: defaults({ sku: { name: 'Free', tier: 'Free' } }),
    computed: (r, c) => { r.properties.defaultHostname = `${['gentle', 'brave', 'calm', 'proud', 'lively'][c.name.length % 5]}-${uniqueString(c.id).slice(0, 8)}-${uniqueString(c.name).slice(0, 6)}.azurestaticapps.net`; r.properties.contentDistributionEndpoint = `https://content-${c.location}.infrastructure.azurestaticapps.net`; },
    secrets: () => ({ apiKey: randomToken(48) }),
    actions: { listSecrets: (r, c) => ({ id: c.id + '/secrets', name: 'secrets', properties: { apiKey: r._secrets.apiKey } }) },
    ui: { icon: 'web', fields: [f('sku.name', 'Piano', 'Plan', 'select', { options: ['Free', 'Standard'], default: 'Free' })] },
  },

  // ---------------- SQL ----------------
  {
    type: 'Microsoft.Sql/servers', label: lbl('Server SQL', 'SQL server'), category: 'databases', apiVersions: V('2023-08-01-preview', '2023-05-01-preview', '2022-05-01-preview', '2021-11-01', '2021-02-01-preview'),
    nameRule: NAME.dns, globalName: { code: 'ServerNameAlreadyExists', message: (n) => `The name '${n}.database.windows.net' already exists. Choose a different name.` },
    writeOnly: ['properties.administratorLoginPassword'], hooks: ['identity', 'sqlserver'],
    defaults: defaults({ 'properties.version': '12.0', 'properties.publicNetworkAccess': 'Enabled', 'properties.minimalTlsVersion': '1.2', 'properties.restrictOutboundNetworkAccess': 'Disabled' }),
    computed: (r, c) => Object.assign(r.properties, { fullyQualifiedDomainName: `${lower(c.name)}.database.windows.net`, state: 'Ready' }),
    ui: {
      icon: 'sql',
      fields: [
        f('properties.administratorLogin', 'Account di accesso amministratore', 'Admin login', 'text', { default: 'sqladmin', required: true }),
        f('properties.administratorLoginPassword', 'Password', 'Password', 'password', { required: true }),
      ],
    },
  },
  {
    type: 'Microsoft.Sql/servers/databases', label: lbl('Database SQL', 'SQL database'), category: 'databases', apiVersions: V('2023-08-01-preview', '2023-05-01-preview', '2022-05-01-preview', '2021-11-01'), tracked: true,
    defaults: defaults({ sku: { name: 'GP_S_Gen5', tier: 'GeneralPurpose', family: 'Gen5', capacity: 1 }, 'properties.collation': 'SQL_Latin1_General_CP1_CI_AS', 'properties.maxSizeBytes': 34359738368, 'properties.zoneRedundant': false, 'properties.readScale': 'Disabled', 'properties.requestedBackupStorageRedundancy': 'Geo' }),
    computed: (r, c) => Object.assign(r.properties, {
      status: 'Online', databaseId: c.existing?.properties?.databaseId ?? uuid(), creationDate: c.existing?.properties?.creationDate ?? c.now,
      currentServiceObjectiveName: r.sku.name, requestedServiceObjectiveName: r.sku.name, defaultSecondaryLocation: 'northeurope', catalogCollation: 'SQL_Latin1_General_CP1_CI_AS',
      currentSku: r.sku, currentBackupStorageRedundancy: r.properties.requestedBackupStorageRedundancy, earliestRestoreDate: c.now, isLedgerOn: false,
    }),
    ui: { hidden: true },
  },
  { type: 'Microsoft.Sql/servers/firewallRules', label: lbl('Regola firewall', 'Firewall rule'), category: 'databases', apiVersions: V('2023-08-01-preview', '2022-05-01-preview', '2021-11-01'), ui: { hidden: true } },
  { type: 'Microsoft.Sql/servers/administrators', label: lbl('Amministratore Entra', 'Entra administrator'), category: 'databases', apiVersions: V('2023-08-01-preview', '2022-05-01-preview', '2021-11-01'), ui: { hidden: true } },
  { type: 'Microsoft.Sql/servers/elasticPools', label: lbl('Pool elastico', 'Elastic pool'), category: 'databases', apiVersions: V('2023-08-01-preview', '2022-05-01-preview'), tracked: true, defaults: defaults({ sku: { name: 'GP_Gen5', tier: 'GeneralPurpose', family: 'Gen5', capacity: 2 } }), computed: (r) => { r.properties.state = 'Ready'; }, ui: { hidden: true } },
  { type: 'Microsoft.Sql/servers/virtualNetworkRules', label: lbl('Regola rete virtuale', 'Virtual network rule'), category: 'databases', apiVersions: V('2023-08-01-preview', '2022-05-01-preview'), computed: (r) => { r.properties.state = 'Ready'; }, ui: { hidden: true } },

  // ---------------- PostgreSQL / MySQL ----------------
  ...(['DBforPostgreSQL', 'DBforMySQL'] as const).flatMap((ns): TypeDef[] => {
    const pg = ns === 'DBforPostgreSQL';
    return [
      {
        type: `Microsoft.${ns}/flexibleServers`, label: pg ? lbl('Server flessibile PostgreSQL', 'PostgreSQL flexible server') : lbl('Server flessibile MySQL', 'MySQL flexible server'), category: 'databases',
        apiVersions: pg ? V('2024-08-01', '2023-12-01-preview', '2023-06-01-preview', '2022-12-01') : V('2023-12-30', '2023-06-30', '2021-05-01'),
        nameRule: NAME.dns, globalName: { code: 'ServerNameAlreadyExists', message: (n) => `Specified server name '${n}' is already used.` },
        writeOnly: ['properties.administratorLoginPassword'], hooks: ['identity'],
        defaults: defaults({
          sku: { name: 'Standard_B1ms', tier: 'Burstable' }, 'properties.version': pg ? '16' : '8.0.21',
          'properties.storage': pg ? { storageSizeGB: 32, autoGrow: 'Disabled', tier: 'P4' } : { storageSizeGB: 20, iops: 360, autoGrow: 'Enabled' },
          'properties.backup': { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' }, 'properties.highAvailability': { mode: 'Disabled' },
          'properties.network': { publicNetworkAccess: 'Enabled' }, ...(pg ? { 'properties.authConfig': { activeDirectoryAuth: 'Disabled', passwordAuth: 'Enabled' } } : {}),
        }),
        computed: (r, c) => Object.assign(r.properties, { fullyQualifiedDomainName: `${lower(c.name)}.${pg ? 'postgres' : 'mysql'}.database.azure.com`, state: 'Ready', availabilityZone: '1', replicationRole: 'Primary', minorVersion: pg ? '4' : '0' }),
        ui: {
          icon: pg ? 'postgres' : 'mysql',
          fields: [
            f('properties.version', 'Versione', 'Version', 'select', { options: pg ? ['17', '16', '15', '14', '13'] : ['8.4', '8.0.21'], default: pg ? '16' : '8.0.21' }),
            f('sku.name', 'Calcolo', 'Compute', 'select', { options: ['Standard_B1ms', 'Standard_B2s', 'Standard_D2ds_v5', 'Standard_D4ds_v5'], default: 'Standard_B1ms' }),
            f('properties.administratorLogin', 'Account di accesso amministratore', 'Admin login', 'text', { default: pg ? 'pgadmin' : 'mysqladmin', required: true }),
            f('properties.administratorLoginPassword', 'Password', 'Password', 'password', { required: true }),
          ],
        },
      },
      { type: `Microsoft.${ns}/flexibleServers/databases`, label: lbl('Database', 'Database'), category: 'databases', apiVersions: pg ? V('2024-08-01', '2023-12-01-preview', '2022-12-01') : V('2023-12-30', '2021-05-01'), defaults: defaults(pg ? { 'properties.charset': 'UTF8', 'properties.collation': 'en_US.utf8' } : { 'properties.charset': 'utf8mb4', 'properties.collation': 'utf8mb4_0900_ai_ci' }), ui: { hidden: true } },
      { type: `Microsoft.${ns}/flexibleServers/firewallRules`, label: lbl('Regola firewall', 'Firewall rule'), category: 'databases', apiVersions: pg ? V('2024-08-01', '2022-12-01') : V('2023-12-30', '2021-05-01'), ui: { hidden: true } },
      { type: `Microsoft.${ns}/flexibleServers/configurations`, label: lbl('Parametro server', 'Server parameter'), category: 'databases', apiVersions: pg ? V('2024-08-01', '2022-12-01') : V('2023-12-30', '2021-05-01'), implicit: true, computed: (r) => { r.properties.source ??= 'user-override'; r.properties.dataType ??= 'String'; }, ui: { hidden: true } },
      ...(pg ? [{ type: 'Microsoft.DBforPostgreSQL/flexibleServers/administrators', label: lbl('Amministratore Entra', 'Entra administrator'), category: 'databases' as Category, apiVersions: V('2024-08-01', '2022-12-01'), ui: { hidden: true } }] : []),
    ];
  }),

  // ---------------- Cosmos DB ----------------
  {
    type: 'Microsoft.DocumentDB/databaseAccounts', label: lbl('Account Azure Cosmos DB', 'Azure Cosmos DB account'), category: 'databases', apiVersions: V('2024-05-15', '2023-11-15', '2023-04-15', '2022-11-15', '2021-10-15'),
    nameRule: { pattern: /^[a-z0-9][a-z0-9-]{1,42}[a-z0-9]$/, code: 'InvalidResourceName', message: 'Database account name must be 3-44 lowercase letters, numbers or hyphens.' },
    globalName: { code: 'BadRequest', message: (n) => `Database account ${n} already exists. Please use a different name.` },
    defaults: (b, c) => defaults({
      kind: 'GlobalDocumentDB', 'properties.databaseAccountOfferType': 'Standard', 'properties.consistencyPolicy': { defaultConsistencyLevel: 'Session', maxIntervalInSeconds: 5, maxStalenessPrefix: 100 },
      'properties.locations': [{ locationName: c.location, failoverPriority: 0, isZoneRedundant: false }], 'properties.capabilities': [], 'properties.enableFreeTier': false,
      'properties.publicNetworkAccess': 'Enabled', 'properties.disableLocalAuth': false, 'properties.enableAutomaticFailover': false,
    })(b),
    hooks: ['identity'],
    computed: (r, c) => {
      const n = lower(c.name);
      const locs = (r.properties.locations ?? []).map((l: any) => ({ id: `${n}-${String(l.locationName).toLowerCase().replace(/\s/g, '')}`, locationName: l.locationName, documentEndpoint: `https://${n}-${String(l.locationName).toLowerCase().replace(/\s/g, '')}.documents.azure.com:443/`, provisioningState: 'Succeeded', failoverPriority: l.failoverPriority ?? 0, isZoneRedundant: !!l.isZoneRedundant }));
      Object.assign(r.properties, { documentEndpoint: `https://${n}.documents.azure.com:443/`, writeLocations: locs.slice(0, 1), readLocations: locs, failoverPolicies: locs.map((l: any) => ({ id: l.id, locationName: l.locationName, failoverPriority: l.failoverPriority })), instanceId: c.existing?.properties?.instanceId ?? uuid(), createMode: 'Default' });
    },
    secrets: () => ({ primaryMasterKey: accountKey(), secondaryMasterKey: accountKey(), primaryReadonlyMasterKey: accountKey(), secondaryReadonlyMasterKey: accountKey() }),
    actions: {
      listKeys: (r) => ({ ...r._secrets }),
      readonlykeys: (r) => ({ primaryReadonlyMasterKey: r._secrets.primaryReadonlyMasterKey, secondaryReadonlyMasterKey: r._secrets.secondaryReadonlyMasterKey }),
      listConnectionStrings: (r) => {
        const ep = r.properties.documentEndpoint;
        const cs = (k: string) => `AccountEndpoint=${ep};AccountKey=${k};`;
        return { connectionStrings: [
          { connectionString: cs(r._secrets.primaryMasterKey), description: 'Primary SQL Connection String', keyKind: 'Primary', type: 'Sql' },
          { connectionString: cs(r._secrets.secondaryMasterKey), description: 'Secondary SQL Connection String', keyKind: 'Secondary', type: 'Sql' },
          { connectionString: cs(r._secrets.primaryReadonlyMasterKey), description: 'Primary Read-Only SQL Connection String', keyKind: 'PrimaryReadonly', type: 'Sql' },
          { connectionString: cs(r._secrets.secondaryReadonlyMasterKey), description: 'Secondary Read-Only SQL Connection String', keyKind: 'SecondaryReadonly', type: 'Sql' },
        ] };
      },
      regenerateKey: (r, c) => {
        const map: Record<string, string> = { primary: 'primaryMasterKey', secondary: 'secondaryMasterKey', primaryReadonly: 'primaryReadonlyMasterKey', secondaryReadonly: 'secondaryReadonlyMasterKey' };
        const k = map[c.body?.keyKind] ?? 'primaryMasterKey';
        r._secrets[k] = accountKey();
        c.save();
        return null;
      },
    },
    ui: {
      icon: 'cosmos',
      fields: [
        f('kind', 'API', 'API', 'select', { options: ['GlobalDocumentDB', 'MongoDB'], default: 'GlobalDocumentDB' }),
        f('properties.enableFreeTier', 'Livello gratuito', 'Free tier', 'bool', { default: false }),
      ],
    },
  },
  ...['sqlDatabases', 'sqlDatabases/containers', 'mongodbDatabases', 'mongodbDatabases/collections', 'sqlRoleDefinitions', 'sqlRoleAssignments'].map((t): TypeDef => ({
    type: `Microsoft.DocumentDB/databaseAccounts/${t}`, label: lbl(t, t), category: 'databases', apiVersions: V('2024-05-15', '2023-11-15', '2023-04-15', '2022-11-15'), ui: { hidden: true },
    computed: (r, c) => {
      if (r.properties?.resource) r.properties.resource = { ...r.properties.resource, _rid: uniqueString(c.id).slice(0, 8), _ts: Math.floor(Date.now() / 1000), _etag: `"${uuid()}"` };
    },
  })),

  // ---------------- Networking ----------------
  {
    type: 'Microsoft.Network/virtualNetworks', label: lbl('Rete virtuale', 'Virtual network'), category: 'networking', apiVersions: V('2024-01-01', '2023-11-01', '2023-09-01', '2023-05-01', '2022-07-01', '2021-05-01', '2020-11-01'),
    inlineChildren: [{ prop: 'subnets', type: 'subnets' }, { prop: 'virtualNetworkPeerings', type: 'virtualNetworkPeerings' }],
    defaults: defaults({ 'properties.addressSpace': { addressPrefixes: ['10.0.0.0/16'] }, 'properties.enableDdosProtection': false }),
    computed: (r, c) => { r.properties.resourceGuid = c.existing?.properties?.resourceGuid ?? uuid(); r.etag = `W/"${uuid()}"`; },
    ui: { icon: 'network', fields: [f('properties.addressSpace.addressPrefixes.0', 'Spazio di indirizzi IPv4', 'IPv4 address space', 'text', { default: '10.0.0.0/16' })] },
  },
  {
    type: 'Microsoft.Network/virtualNetworks/subnets', label: lbl('Subnet', 'Subnet'), category: 'networking', apiVersions: V('2024-01-01', '2023-11-01', '2023-09-01', '2023-05-01', '2022-07-01'),
    defaults: defaults({ 'properties.privateEndpointNetworkPolicies': 'Disabled', 'properties.privateLinkServiceNetworkPolicies': 'Enabled', 'properties.delegations': [] }),
    computed: (r) => { r.etag = `W/"${uuid()}"`; },
    ui: { hidden: true },
  },
  { type: 'Microsoft.Network/virtualNetworks/virtualNetworkPeerings', label: lbl('Peering', 'Peering'), category: 'networking', apiVersions: V('2024-01-01', '2023-11-01', '2023-05-01'), computed: (r) => Object.assign(r.properties, { peeringState: 'Connected', peeringSyncLevel: 'FullyInSync' }), ui: { hidden: true } },
  {
    type: 'Microsoft.Network/networkSecurityGroups', label: lbl('Gruppo di sicurezza di rete', 'Network security group'), category: 'networking', apiVersions: V('2024-01-01', '2023-11-01', '2023-09-01', '2023-05-01', '2022-07-01'),
    inlineChildren: [{ prop: 'securityRules', type: 'securityRules' }],
    computed: (r, c) => {
      r.properties.resourceGuid = c.existing?.properties?.resourceGuid ?? uuid();
      const rule = (name: string, priority: number, direction: string, access: string, src: string, dst: string, description: string) => ({
        name, id: `${c.id}/defaultSecurityRules/${name}`, type: 'Microsoft.Network/networkSecurityGroups/defaultSecurityRules',
        properties: { provisioningState: 'Succeeded', description, protocol: '*', sourcePortRange: '*', destinationPortRange: '*', sourceAddressPrefix: src, destinationAddressPrefix: dst, access, priority, direction, sourcePortRanges: [], destinationPortRanges: [], sourceAddressPrefixes: [], destinationAddressPrefixes: [] },
      });
      r.properties.defaultSecurityRules = [
        rule('AllowVnetInBound', 65000, 'Inbound', 'Allow', 'VirtualNetwork', 'VirtualNetwork', 'Allow inbound traffic from all VMs in VNET'),
        rule('AllowAzureLoadBalancerInBound', 65001, 'Inbound', 'Allow', 'AzureLoadBalancer', '*', 'Allow inbound traffic from azure load balancer'),
        rule('DenyAllInBound', 65500, 'Inbound', 'Deny', '*', '*', 'Deny all inbound traffic'),
        rule('AllowVnetOutBound', 65000, 'Outbound', 'Allow', 'VirtualNetwork', 'VirtualNetwork', 'Allow outbound traffic from all VMs to all VMs in VNET'),
        rule('AllowInternetOutBound', 65001, 'Outbound', 'Allow', '*', 'Internet', 'Allow outbound traffic from all VMs to Internet'),
        rule('DenyAllOutBound', 65500, 'Outbound', 'Deny', '*', '*', 'Deny all outbound traffic'),
      ];
    },
    ui: { icon: 'shield' },
  },
  { type: 'Microsoft.Network/networkSecurityGroups/securityRules', label: lbl('Regola di sicurezza', 'Security rule'), category: 'networking', apiVersions: V('2024-01-01', '2023-11-01', '2023-05-01', '2022-07-01'), ui: { hidden: true } },
  {
    type: 'Microsoft.Network/publicIPAddresses', label: lbl('Indirizzo IP pubblico', 'Public IP address'), category: 'networking', apiVersions: V('2024-01-01', '2023-11-01', '2023-09-01', '2023-05-01', '2022-07-01'),
    defaults: defaults({ sku: { name: 'Standard', tier: 'Regional' }, 'properties.publicIPAllocationMethod': 'Static', 'properties.publicIPAddressVersion': 'IPv4', 'properties.idleTimeoutInMinutes': 4 }),
    computed: (r, c) => {
      r.properties.resourceGuid = c.existing?.properties?.resourceGuid ?? uuid();
      r.properties.ipAddress = deterministicIp(c.id, '20');
      if (r.properties.dnsSettings?.domainNameLabel) r.properties.dnsSettings.fqdn = `${r.properties.dnsSettings.domainNameLabel}.${c.location}.cloudapp.azure.com`;
    },
    ui: { icon: 'ip', fields: [f('sku.name', 'SKU', 'SKU', 'select', { options: ['Standard', 'Basic'], default: 'Standard' }), f('properties.dnsSettings.domainNameLabel', 'Etichetta nome DNS', 'DNS name label', 'text')] },
  },
  {
    type: 'Microsoft.Network/networkInterfaces', label: lbl('Interfaccia di rete', 'Network interface'), category: 'networking', apiVersions: V('2024-01-01', '2023-11-01', '2023-09-01', '2023-05-01', '2022-07-01'),
    hooks: ['vnetSubnetIp'],
    computed: (r, c) => {
      r.properties.resourceGuid = c.existing?.properties?.resourceGuid ?? uuid();
      r.properties.macAddress = c.existing?.properties?.macAddress ?? uniqueString(c.id).slice(0, 12).toUpperCase().replace(/(..)(?!$)/g, '$1-');
      r.properties.ipConfigurations = (r.properties.ipConfigurations ?? []).map((ip: any, i: number) => ({ ...ip, id: `${c.id}/ipConfigurations/${ip.name}`, type: 'Microsoft.Network/networkInterfaces/ipConfigurations', properties: { privateIPAllocationMethod: 'Dynamic', privateIPAddressVersion: 'IPv4', primary: i === 0, provisioningState: 'Succeeded', ...ip.properties } }));
      r.properties.enableAcceleratedNetworking ??= false;
      r.properties.enableIPForwarding ??= false;
    },
    ui: { hidden: false, icon: 'nic' },
  },
  { type: 'Microsoft.Network/loadBalancers', label: lbl('Bilanciamento del carico', 'Load balancer'), category: 'networking', apiVersions: V('2024-01-01', '2023-11-01', '2023-05-01'), defaults: defaults({ sku: { name: 'Standard', tier: 'Regional' } }), computed: (r, c) => { r.properties.resourceGuid = c.existing?.properties?.resourceGuid ?? uuid(); }, ui: { icon: 'lb' } },
  { type: 'Microsoft.Network/applicationGateways', label: lbl('Gateway applicazione', 'Application gateway'), category: 'networking', apiVersions: V('2024-01-01', '2023-11-01', '2023-05-01'), computed: (r, c) => { r.properties.resourceGuid = c.existing?.properties?.resourceGuid ?? uuid(); r.properties.operationalState = 'Running'; }, hooks: ['identity'], ui: { icon: 'lb' } },
  { type: 'Microsoft.Network/natGateways', label: lbl('Gateway NAT', 'NAT gateway'), category: 'networking', apiVersions: V('2024-01-01', '2023-11-01', '2023-05-01'), defaults: defaults({ sku: { name: 'Standard' }, 'properties.idleTimeoutInMinutes': 4 }), computed: (r, c) => { r.properties.resourceGuid = c.existing?.properties?.resourceGuid ?? uuid(); } },
  { type: 'Microsoft.Network/routeTables', label: lbl('Tabella di route', 'Route table'), category: 'networking', apiVersions: V('2024-01-01', '2023-11-01', '2023-05-01'), inlineChildren: [{ prop: 'routes', type: 'routes' }], defaults: defaults({ 'properties.disableBgpRoutePropagation': false }), computed: (r, c) => { r.properties.resourceGuid = c.existing?.properties?.resourceGuid ?? uuid(); } },
  { type: 'Microsoft.Network/routeTables/routes', label: lbl('Route', 'Route'), category: 'networking', apiVersions: V('2024-01-01', '2023-11-01', '2023-05-01'), ui: { hidden: true } },
  {
    type: 'Microsoft.Network/privateEndpoints', label: lbl('Endpoint privato', 'Private endpoint'), category: 'networking', apiVersions: V('2024-01-01', '2023-11-01', '2023-05-01', '2022-07-01'),
    computed: (r, c) => {
      r.properties.networkInterfaces = [{ id: `/subscriptions/${c.sub}/resourceGroups/${c.rg}/providers/Microsoft.Network/networkInterfaces/${c.name}.nic.${uniqueString(c.id).slice(0, 8)}` }];
      r.properties.customDnsConfigs = r.properties.customDnsConfigs ?? [];
      r.properties.privateLinkServiceConnections = (r.properties.privateLinkServiceConnections ?? []).map((p: any) => ({ ...p, properties: { ...p.properties, privateLinkServiceConnectionState: { status: 'Approved', description: 'Auto-Approved', actionsRequired: 'None' } } }));
    },
    ui: { icon: 'link' },
  },
  { type: 'Microsoft.Network/privateDnsZones', label: lbl('Zona DNS privata', 'Private DNS zone'), category: 'networking', apiVersions: V('2024-06-01', '2020-06-01', '2018-09-01'), global: true, computed: (r) => Object.assign(r.properties, { maxNumberOfRecordSets: 25000, numberOfRecordSets: 1, maxNumberOfVirtualNetworkLinks: 1000, numberOfVirtualNetworkLinks: 0, internalId: uniqueString(r.id) }), ui: { icon: 'dns' } },
  ...['virtualNetworkLinks', 'A', 'AAAA', 'CNAME', 'TXT', 'MX', 'SRV', 'PTR', 'SOA'].map((t): TypeDef => ({ type: `Microsoft.Network/privateDnsZones/${t}`, label: lbl(t, t), category: 'networking', apiVersions: V('2024-06-01', '2020-06-01'), global: t === 'virtualNetworkLinks', tracked: t === 'virtualNetworkLinks', computed: (r, c) => { if (t !== 'virtualNetworkLinks') r.properties.fqdn = `${c.name === '@' ? '' : c.name + '.'}${c.names[0]}.`; else r.properties.virtualNetworkLinkState = 'Completed'; }, ui: { hidden: true } })),
  {
    type: 'Microsoft.Network/dnsZones', label: lbl('Zona DNS', 'DNS zone'), category: 'networking', apiVersions: V('2023-07-01-preview', '2018-05-01'), global: true,
    computed: (r, c) => Object.assign(r.properties, { zoneType: 'Public', maxNumberOfRecordSets: 10000, numberOfRecordSets: 2, nameServers: [1, 2, 3, 4].map((i) => `ns${i}-0${(uniqueString(c.id).charCodeAt(i) % 9) + 1}.azure-dns.${['com', 'net', 'org', 'info'][i - 1]}.`) }),
    ui: { icon: 'dns' },
  },
  ...['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'SRV', 'CAA', 'PTR', 'SOA'].map((t): TypeDef => ({ type: `Microsoft.Network/dnsZones/${t}`, label: lbl(t, t), category: 'networking', apiVersions: V('2023-07-01-preview', '2018-05-01'), computed: (r, c) => { r.properties.fqdn = `${c.name === '@' ? '' : c.name + '.'}${c.names[0]}.`; r.properties.provisioningState = 'Succeeded'; }, ui: { hidden: true } })),
  { type: 'Microsoft.Network/bastionHosts', label: lbl('Bastion', 'Bastion'), category: 'networking', apiVersions: V('2024-01-01', '2023-11-01', '2023-05-01'), defaults: defaults({ sku: { name: 'Basic' } }), computed: (r, c) => { r.properties.dnsName = `bst-${uuid()}.bastion.azure.com`; void c; } },
  { type: 'Microsoft.Network/applicationSecurityGroups', label: lbl('Gruppo di sicurezza delle applicazioni', 'Application security group'), category: 'networking', apiVersions: V('2024-01-01', '2023-11-01', '2023-05-01'), computed: (r, c) => { r.properties.resourceGuid = c.existing?.properties?.resourceGuid ?? uuid(); } },
  { type: 'Microsoft.Network/frontDoorWebApplicationFirewallPolicies', label: lbl('Criterio WAF', 'WAF policy'), category: 'networking', apiVersions: V('2024-02-01', '2022-05-01'), global: true },
  { type: 'Microsoft.Cdn/profiles', label: lbl('Profilo Front Door e CDN', 'Front Door and CDN profile'), category: 'networking', apiVersions: V('2024-02-01', '2023-05-01', '2021-06-01'), global: true, defaults: defaults({ sku: { name: 'Standard_AzureFrontDoor' } }), computed: (r, c) => { r.properties.frontDoorId = c.existing?.properties?.frontDoorId ?? uuid(); r.properties.resourceState = 'Active'; }, ui: { icon: 'cdn' } },
  { type: 'Microsoft.Cdn/profiles/afdEndpoints', label: lbl('Endpoint', 'Endpoint'), category: 'networking', apiVersions: V('2024-02-01', '2023-05-01'), global: true, tracked: true, computed: (r, c) => { r.properties.hostName = `${lower(c.name)}-${uniqueString(c.id).slice(0, 12)}.z01.azurefd.net`; r.properties.enabledState ??= 'Enabled'; r.properties.deploymentStatus = 'Succeeded'; }, ui: { hidden: true } },

  // ---------------- Compute ----------------
  {
    type: 'Microsoft.Compute/virtualMachines', label: lbl('Macchina virtuale', 'Virtual machine'), category: 'compute', apiVersions: V('2024-07-01', '2024-03-01', '2023-09-01', '2023-07-01', '2023-03-01', '2022-11-01', '2022-08-01', '2021-11-01'),
    writeOnly: ['properties.osProfile.adminPassword', 'properties.osProfile.customData'], hooks: ['identity', 'vm'],
    defaults: defaults({ 'properties.hardwareProfile': { vmSize: 'Standard_B2s' } }),
    computed: (r, c) => {
      r.properties.vmId = c.existing?.properties?.vmId ?? uuid();
      r.properties.timeCreated = c.existing?.properties?.timeCreated ?? c.now;
      r._power = c.existing?._power ?? 'running';
    },
    actions: {
      start: (r, c) => { r._power = 'running'; c.save(); return null; },
      powerOff: (r, c) => { r._power = 'stopped'; c.save(); return null; },
      deallocate: (r, c) => { r._power = 'deallocated'; c.save(); return null; },
      restart: (r, c) => { r._power = 'running'; c.save(); return null; },
      redeploy: () => null,
      reapply: () => null,
      generalize: (r, c) => { r._power = 'generalized'; c.save(); return null; },
      runCommand: () => ({ value: [{ code: 'ProvisioningState/succeeded', level: 'Info', displayStatus: 'Provisioning succeeded', message: 'Enable succeeded: \n[stdout]\nAzzurro: comando simulato\n\n[stderr]\n' }] }),
    },
    ui: {
      icon: 'vm',
      fields: [
        f('properties.hardwareProfile.vmSize', 'Dimensioni', 'Size', 'select', { options: ['Standard_B1s', 'Standard_B2s', 'Standard_B2ms', 'Standard_D2s_v5', 'Standard_D4s_v5', 'Standard_E2s_v5'], default: 'Standard_B2s' }),
        f('properties.storageProfile.imageReference.offer', 'Immagine', 'Image', 'select', { options: ['ubuntu-24_04-lts', '0001-com-ubuntu-server-jammy', 'WindowsServer', 'debian-12'], default: 'ubuntu-24_04-lts' }),
        f('properties.osProfile.adminUsername', 'Nome utente amministratore', 'Admin username', 'text', { default: 'azureuser', required: true }),
        f('properties.osProfile.adminPassword', 'Password', 'Password', 'password', { required: true }),
      ],
    },
  },
  { type: 'Microsoft.Compute/virtualMachines/extensions', label: lbl('Estensione VM', 'VM extension'), category: 'compute', apiVersions: V('2024-07-01', '2023-09-01', '2023-03-01', '2022-11-01'), tracked: true, writeOnly: ['properties.protectedSettings'], ui: { hidden: true } },
  {
    type: 'Microsoft.Compute/disks', label: lbl('Disco', 'Disk'), category: 'compute', apiVersions: V('2024-03-02', '2023-10-02', '2023-04-02', '2022-07-02'),
    defaults: defaults({ sku: { name: 'Premium_LRS', tier: 'Premium' }, 'properties.creationData': { createOption: 'Empty' }, 'properties.diskSizeGB': 32 }),
    computed: (r, c) => Object.assign(r.properties, { diskState: r.managedBy ? 'Attached' : 'Unattached', uniqueId: c.existing?.properties?.uniqueId ?? uuid(), timeCreated: c.existing?.properties?.timeCreated ?? c.now, diskSizeBytes: Number(r.properties.diskSizeGB) * 1073741824, diskIOPSReadWrite: 120, diskMBpsReadWrite: 25, networkAccessPolicy: 'AllowAll', publicNetworkAccess: 'Enabled', encryption: { type: 'EncryptionAtRestWithPlatformKey' } }),
    actions: { beginGetAccess: () => ({ accessSAS: `https://md-${uniqueString(uuid())}.blob.core.windows.net/disk/abcd?sv=2018-03-28&sr=b&si=azzurro&sig=${encodeURIComponent(accountKey(32))}` }), endGetAccess: () => null },
    ui: { icon: 'disk', fields: [f('properties.diskSizeGB', 'Dimensione (GiB)', 'Size (GiB)', 'number', { default: 32 }), f('sku.name', 'Tipo di disco', 'Disk type', 'select', { options: ['Premium_LRS', 'StandardSSD_LRS', 'Standard_LRS', 'PremiumV2_LRS'], default: 'Premium_LRS' })] },
  },
  { type: 'Microsoft.Compute/snapshots', label: lbl('Snapshot', 'Snapshot'), category: 'compute', apiVersions: V('2024-03-02', '2023-10-02', '2023-04-02'), defaults: defaults({ sku: { name: 'Standard_LRS' } }), computed: (r, c) => { r.properties.timeCreated = c.existing?.properties?.timeCreated ?? c.now; r.properties.uniqueId = c.existing?.properties?.uniqueId ?? uuid(); } },
  { type: 'Microsoft.Compute/availabilitySets', label: lbl('Set di disponibilità', 'Availability set'), category: 'compute', apiVersions: V('2024-07-01', '2023-09-01', '2023-03-01'), defaults: defaults({ sku: { name: 'Aligned' }, 'properties.platformFaultDomainCount': 2, 'properties.platformUpdateDomainCount': 5 }) },
  { type: 'Microsoft.Compute/virtualMachineScaleSets', label: lbl('Set di scalabilità di macchine virtuali', 'Virtual machine scale set'), category: 'compute', apiVersions: V('2024-07-01', '2023-09-01', '2023-03-01', '2022-11-01'), hooks: ['identity'], writeOnly: ['properties.virtualMachineProfile.osProfile.adminPassword'], computed: (r, c) => { r.properties.uniqueId = c.existing?.properties?.uniqueId ?? uuid(); r.properties.timeCreated = c.existing?.properties?.timeCreated ?? c.now; }, ui: { icon: 'vmss' } },
  {
    type: 'Microsoft.Compute/sshPublicKeys', label: lbl('Chiave SSH', 'SSH key'), category: 'compute', apiVersions: V('2024-07-01', '2023-09-01', '2023-03-01'),
    actions: {
      generateKeyPair: (r, c) => {
        const kp = sshPublicKey();
        r.properties = { ...(r.properties ?? {}), publicKey: kp.publicKey };
        c.save();
        return { privateKey: kp.privateKey, publicKey: kp.publicKey, id: c.id };
      },
    },
    ui: { icon: 'key' },
  },
  { type: 'Microsoft.Compute/images', label: lbl('Immagine', 'Image'), category: 'compute', apiVersions: V('2024-07-01', '2023-09-01') },
  { type: 'Microsoft.Compute/galleries', label: lbl('Raccolta di calcolo di Azure', 'Azure compute gallery'), category: 'compute', apiVersions: V('2023-07-03', '2022-03-03'), computed: (r, c) => { r.properties.identifier = { uniqueName: `${c.sub}-${c.name.toUpperCase()}` }; } },

  // ---------------- Containers ----------------
  {
    type: 'Microsoft.ContainerRegistry/registries', label: lbl('Registro contenitori', 'Container registry'), category: 'containers', apiVersions: V('2023-11-01-preview', '2023-07-01', '2023-01-01-preview', '2022-12-01', '2021-09-01', '2019-05-01'),
    nameRule: NAME.acr, globalName: { code: 'AlreadyInUse', message: (n) => `The registry ${n} is already in use.` }, hooks: ['identity'],
    defaults: defaults({ sku: { name: 'Basic' }, 'properties.adminUserEnabled': false, 'properties.publicNetworkAccess': 'Enabled', 'properties.zoneRedundancy': 'Disabled', 'properties.anonymousPullEnabled': false, 'properties.dataEndpointEnabled': false, 'properties.networkRuleBypassOptions': 'AzureServices' }),
    computed: (r, c) => { r.sku.tier = r.sku.name; Object.assign(r.properties, { loginServer: `${lower(c.name)}.azurecr.io`, creationDate: c.existing?.properties?.creationDate ?? c.now, status: null, policies: { quarantinePolicy: { status: 'disabled' }, trustPolicy: { type: 'Notary', status: 'disabled' }, retentionPolicy: { days: 7, status: 'disabled' } } }); },
    secrets: () => ({ password: randomToken(39), password2: randomToken(39) }),
    actions: {
      listCredentials: (r, c) => {
        if (!r.properties.adminUserEnabled) throw Object.assign(new Error('Admin user is disabled.'), { status: 400, code: 'AdminUserDisabled' });
        return { username: c.name, passwords: [{ name: 'password', value: r._secrets.password }, { name: 'password2', value: r._secrets.password2 }] };
      },
      regenerateCredential: (r, c) => {
        const k = c.body?.name === 'password2' ? 'password2' : 'password';
        r._secrets[k] = randomToken(39);
        c.save();
        return { username: c.name, passwords: [{ name: 'password', value: r._secrets.password }, { name: 'password2', value: r._secrets.password2 }] };
      },
      listUsages: () => ({ value: [{ name: 'Size', limit: 10737418240, currentValue: 0, unit: 'Bytes' }, { name: 'Webhooks', limit: 2, currentValue: 0, unit: 'Count' }] }),
    },
    ui: { icon: 'registry', fields: [f('sku.name', 'SKU', 'SKU', 'select', { options: ['Basic', 'Standard', 'Premium'], default: 'Basic' }), f('properties.adminUserEnabled', 'Utente amministratore', 'Admin user', 'bool', { default: false })] },
  },
  {
    type: 'Microsoft.ContainerRegistry/registries/webhooks', label: lbl('Webhook', 'Webhook'), category: 'containers', apiVersions: V('2023-07-01', '2023-01-01-preview', '2019-05-01'), tracked: true, writeOnly: ['properties.serviceUri', 'properties.customHeaders'], ui: { hidden: true },
    defaults: defaults({ 'properties.status': 'enabled', 'properties.scope': '', 'properties.actions': ['push'] }),
    actions: {
      ping: () => ({ id: uuid() }),
      getCallbackConfig: (r) => ({ serviceUri: r.properties.serviceUri ?? '', customHeaders: r.properties.customHeaders ?? {} }),
    },
  },
  { type: 'Microsoft.ContainerRegistry/registries/scopeMaps', label: lbl('Mappa ambito', 'Scope map'), category: 'containers', apiVersions: V('2023-07-01', '2023-01-01-preview'), ui: { hidden: true } },
  { type: 'Microsoft.ContainerRegistry/registries/tokens', label: lbl('Token', 'Token'), category: 'containers', apiVersions: V('2023-07-01', '2023-01-01-preview'), ui: { hidden: true } },
  {
    type: 'Microsoft.ContainerService/managedClusters', label: lbl('Servizio Kubernetes', 'Kubernetes service'), category: 'containers', apiVersions: V('2024-09-01', '2024-07-01', '2024-05-01', '2024-02-01', '2023-10-01', '2023-08-01', '2023-05-01', '2022-09-01'),
    hooks: ['identity', 'aks'],
    defaults: (b, c) => defaults({
      identity: { type: 'SystemAssigned' }, 'properties.kubernetesVersion': '1.31', 'properties.dnsPrefix': `${c.name}-dns`, 'properties.enableRBAC': true,
      'properties.agentPoolProfiles': [{ name: 'agentpool', count: 2, vmSize: 'Standard_D2s_v5', osType: 'Linux', mode: 'System', type: 'VirtualMachineScaleSets' }],
      'properties.networkProfile': { networkPlugin: 'azure', networkPluginMode: 'overlay', loadBalancerSku: 'standard', podCidr: '10.244.0.0/16', serviceCidr: '10.0.0.0/16', dnsServiceIP: '10.0.0.10', outboundType: 'loadBalancer' },
      sku: { name: 'Base', tier: 'Free' },
    })(b),
    computed: (r, c) => {
      const fq = `${lower(r.properties.dnsPrefix)}-${uniqueString(c.id).slice(0, 8)}.hcp.${c.location}.azmk8s.io`;
      Object.assign(r.properties, {
        fqdn: fq, azurePortalFQDN: fq.replace('.hcp.', '.portal.hcp.'), currentKubernetesVersion: r.properties.kubernetesVersion, powerState: { code: c.existing?._power === 'stopped' ? 'Stopped' : 'Running' },
        nodeResourceGroup: r.properties.nodeResourceGroup ?? `MC_${c.rg}_${c.name}_${c.location}`, maxAgentPools: 100,
        agentPoolProfiles: (r.properties.agentPoolProfiles ?? []).map((p: any) => ({ ...p, provisioningState: 'Succeeded', powerState: { code: 'Running' }, orchestratorVersion: r.properties.kubernetesVersion, currentOrchestratorVersion: r.properties.kubernetesVersion, nodeImageVersion: 'AKSUbuntu-2204gen2containerd-202410.15.0', osSKU: p.osSKU ?? 'Ubuntu', osDiskSizeGB: p.osDiskSizeGB ?? 128 })),
        identityProfile: { kubeletidentity: { resourceId: `/subscriptions/${c.sub}/resourceGroups/MC_${c.rg}_${c.name}_${c.location}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${c.name}-agentpool`, clientId: c.existing?.properties?.identityProfile?.kubeletidentity?.clientId ?? uuid(), objectId: c.existing?.properties?.identityProfile?.kubeletidentity?.objectId ?? uuid() } },
      });
      if (r.properties.oidcIssuerProfile?.enabled) r.properties.oidcIssuerProfile.issuerURL = `https://${c.location}.oic.prod-aks.azure.com/${c.tenantId}/${uuid()}/`;
    },
    actions: {
      listClusterUserCredential: (r, c) => ({ kubeconfigs: [{ name: 'clusterUser', value: kubeconfig(c.name, r.properties.fqdn, 'clusterUser') }] }),
      listClusterAdminCredential: (r, c) => ({ kubeconfigs: [{ name: 'clusterAdmin', value: kubeconfig(c.name, r.properties.fqdn, 'clusterAdmin') }] }),
      start: (r, c) => { r._power = 'running'; c.save(); return null; },
      stop: (r, c) => { r._power = 'stopped'; c.save(); return null; },
    },
    ui: { icon: 'kubernetes', fields: [f('properties.kubernetesVersion', 'Versione Kubernetes', 'Kubernetes version', 'select', { options: ['1.31', '1.30', '1.29'], default: '1.31' }), f('properties.agentPoolProfiles.0.vmSize', 'Dimensioni nodo', 'Node size', 'select', { options: ['Standard_D2s_v5', 'Standard_D4s_v5', 'Standard_B4ms'], default: 'Standard_D2s_v5' }), f('properties.agentPoolProfiles.0.count', 'Numero di nodi', 'Node count', 'number', { default: 2 })] },
  },
  {
    type: 'Microsoft.ContainerService/managedClusters/agentPools', label: lbl('Pool di nodi', 'Node pool'), category: 'containers', apiVersions: V('2024-09-01', '2024-07-01', '2024-05-01', '2024-02-01', '2023-10-01'), hooks: ['akspool'],
    nameRule: { pattern: /^[a-z][a-z0-9]{0,11}$/, code: 'InvalidAgentPoolName', message: 'The agent pool name must start with a lowercase letter, contain only lowercase letters and numbers, and be at most 12 characters long.' },
    defaults: defaults({ 'properties.count': 1, 'properties.vmSize': 'Standard_D2s_v5', 'properties.mode': 'User', 'properties.osType': 'Linux', 'properties.type': 'VirtualMachineScaleSets' }),
    computed: (r) => {
      const n = Number(r.properties.count);
      if (!Number.isInteger(n) || n < 0 || n > 1000) throw new HttpError(400, 'InvalidParameter', 'The agent pool count must be an integer between 0 and 1000.');
      if (r.properties.mode === 'System' && n < 1) throw new HttpError(400, 'InvalidParameter', 'A System agent pool must have at least 1 node.');
      Object.assign(r.properties, { powerState: { code: 'Running' }, osSKU: r.properties.osSKU ?? 'Ubuntu', osDiskSizeGB: r.properties.osDiskSizeGB ?? 128, nodeImageVersion: 'AKSUbuntu-2204gen2containerd-202410.15.0' });
    },
    ui: { hidden: true },
  },
  {
    type: 'Microsoft.App/managedEnvironments', label: lbl('Ambiente app contenitore', 'Container Apps environment'), category: 'containers', apiVersions: V('2024-03-01', '2023-05-01', '2022-10-01'),
    computed: (r, c) => Object.assign(r.properties, { defaultDomain: c.existing?.properties?.defaultDomain ?? `${['happy', 'wonderful', 'nice', 'gentle'][c.name.length % 4]}-${uniqueString(c.id).slice(0, 8)}.${c.location}.azurecontainerapps.io`, staticIp: deterministicIp(c.id, '20'), zoneRedundant: false, eventStreamEndpoint: `https://${c.location}.azurecontainerapps.dev/subscriptions/${c.sub}/resourceGroups/${c.rg}/managedEnvironments/${c.name}/eventstream` }),
    ui: { icon: 'containerapp' },
  },
  {
    type: 'Microsoft.App/containerApps', label: lbl('App contenitore', 'Container App'), category: 'containers', apiVersions: V('2024-03-01', '2023-05-01', '2022-10-01'), hooks: ['identity', 'carevision'],
    writeOnly: ['properties.configuration.secrets'],
    actions: {
      listSecrets: (r) => ({ value: (r.properties.configuration?.secrets ?? []).map((x: any) => ({ name: x.name, value: x.keyVaultUrl ? undefined : x.value ?? '', keyVaultUrl: x.keyVaultUrl, identity: x.identity })) }),
    },
    computed: (r, c) => {
      // nuova revisione solo se cambia il modello (immagine, risorse, scala...), come in Azure
      const same = c.existing && JSON.stringify(c.existing.properties?.template ?? null) === JSON.stringify(r.properties.template ?? null);
      const rev = same && c.existing.properties?.latestRevisionName ? c.existing.properties.latestRevisionName : `${c.name}--${r.properties.template?.revisionSuffix || uniqueString(c.id, c.now).slice(0, 7)}`;
      r.properties.configuration ??= {};
      r.properties.configuration.activeRevisionsMode ??= 'Single';
      Object.assign(r.properties, { latestRevisionName: rev, latestReadyRevisionName: rev, runningStatus: 'Running', outboundIpAddresses: [deterministicIp(c.id, '20')], customDomainVerificationId: uniqueString(c.id).toUpperCase() });
      const envId = r.properties.managedEnvironmentId ?? r.properties.environmentId;
      const ing = r.properties.configuration?.ingress;
      if (ing) {
        const domain = `${uniqueString(envId ?? c.id).slice(0, 8)}.${c.location}.azurecontainerapps.io`;
        ing.fqdn = `${lower(c.name)}${ing.external === false ? '.internal' : ''}.${domain}`;
        r.properties.latestRevisionFqdn = `${lower(rev)}.${domain}`;
      }
    },
    ui: { icon: 'containerapp' },
  },
  {
    type: 'Microsoft.App/containerApps/revisions', label: lbl('Revisione', 'Revision'), category: 'containers', apiVersions: V('2024-03-01', '2023-05-01', '2022-10-01'), ui: { hidden: true },
    actions: {
      activate: (r, c) => { Object.assign(r.properties, { active: true, runningState: 'Running', replicas: Math.max(1, Number(r.properties.template?.scale?.minReplicas ?? 0)) }); c.save(); return null; },
      deactivate: (r, c) => { Object.assign(r.properties, { active: false, runningState: 'Stopped', replicas: 0, trafficWeight: 0 }); c.save(); return null; },
      restart: (r, c) => { r.properties.lastActiveTime = c.now; c.save(); return null; },
    },
  },
  { type: 'Microsoft.App/jobs', label: lbl('Processo app contenitore', 'Container App job'), category: 'containers', apiVersions: V('2024-03-01', '2023-05-01'), hooks: ['identity'] },
  { type: 'Microsoft.ContainerInstance/containerGroups', label: lbl('Istanza di contenitore', 'Container instance'), category: 'containers', apiVersions: V('2023-05-01', '2022-10-01-preview', '2021-10-01'), hooks: ['identity'], computed: (r, c) => { if (r.properties.ipAddress) r.properties.ipAddress.ip = deterministicIp(c.id, '20'); r.properties.instanceView = { state: 'Running', events: [] }; r.properties.osType ??= 'Linux'; }, ui: { icon: 'container' } },

  // ---------------- Identity ----------------
  {
    type: 'Microsoft.ManagedIdentity/userAssignedIdentities', label: lbl('Identità gestita', 'Managed identity'), category: 'identity', apiVersions: V('2023-07-31-preview', '2023-01-31', '2018-11-30'), hooks: ['uami'],
    ui: { icon: 'identity' },
  },
  { type: 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials', label: lbl('Credenziale federata', 'Federated credential'), category: 'identity', apiVersions: V('2023-07-31-preview', '2023-01-31'), defaults: defaults({ 'properties.audiences': ['api://AzureADTokenExchange'] }), ui: { hidden: true } },

  // ---------------- Monitor ----------------
  {
    type: 'Microsoft.OperationalInsights/workspaces', label: lbl('Area di lavoro Log Analytics', 'Log Analytics workspace'), category: 'monitor', apiVersions: V('2023-09-01', '2022-10-01', '2021-12-01-preview', '2020-08-01'),
    defaults: defaults({ 'properties.sku': { name: 'PerGB2018' }, 'properties.retentionInDays': 30, 'properties.publicNetworkAccessForIngestion': 'Enabled', 'properties.publicNetworkAccessForQuery': 'Enabled', 'properties.features': { enableLogAccessUsingOnlyResourcePermissions: true } }),
    computed: (r, c) => { r.properties.customerId = c.existing?.properties?.customerId ?? uuid(); r.properties.createdDate = c.existing?.properties?.createdDate ?? c.now; r.properties.modifiedDate = c.now; r.properties.workspaceCapping = { dailyQuotaGb: Number(r.properties.workspaceCapping?.dailyQuotaGb ?? -1), quotaNextResetTime: `${c.now.slice(0, 10)}T00:00:00Z`, dataIngestionStatus: 'RespectQuota' }; },
    secrets: () => ({ primarySharedKey: accountKey(), secondarySharedKey: accountKey() }),
    actions: { sharedKeys: (r) => ({ primarySharedKey: r._secrets.primarySharedKey, secondarySharedKey: r._secrets.secondarySharedKey }), regenerateSharedKey: (r, c) => { r._secrets.primarySharedKey = accountKey(); c.save(); return { primarySharedKey: r._secrets.primarySharedKey, secondarySharedKey: r._secrets.secondarySharedKey }; } },
    ui: { icon: 'logs' },
  },
  {
    type: 'Microsoft.Insights/components', label: lbl('Application Insights', 'Application Insights'), category: 'monitor', apiVersions: V('2020-02-02', '2020-02-02-preview', '2015-05-01'),
    defaults: defaults({ kind: 'web', 'properties.Application_Type': 'web', 'properties.Flow_Type': 'Bluefield', 'properties.Request_Source': 'rest', 'properties.IngestionMode': 'LogAnalytics', 'properties.publicNetworkAccessForIngestion': 'Enabled', 'properties.publicNetworkAccessForQuery': 'Enabled' }),
    computed: (r, c) => {
      const ikey = c.existing?.properties?.InstrumentationKey ?? uuid();
      const appId = c.existing?.properties?.AppId ?? uuid();
      Object.assign(r.properties, { ApplicationId: c.name, AppId: appId, InstrumentationKey: ikey, ConnectionString: `InstrumentationKey=${ikey};IngestionEndpoint=https://${c.location}-0.in.applicationinsights.azure.com/;LiveEndpoint=https://${c.location}.livediagnostics.monitor.azure.com/;ApplicationId=${appId}`, Name: c.name, CreationDate: c.existing?.properties?.CreationDate ?? c.now, TenantId: c.sub, RetentionInDays: r.properties.RetentionInDays ?? 90, SamplingPercentage: null });
    },
    ui: { icon: 'insights' },
  },
  { type: 'Microsoft.Insights/actionGroups', label: lbl('Gruppo di azioni', 'Action group'), category: 'monitor', apiVersions: V('2023-01-01', '2022-06-01', '2021-09-01'), global: true, defaults: defaults({ 'properties.enabled': true, 'properties.emailReceivers': [] }), ui: { icon: 'alert' } },
  { type: 'Microsoft.Insights/metricAlerts', label: lbl('Regola di avviso metrica', 'Metric alert rule'), category: 'monitor', apiVersions: V('2018-03-01'), global: true, ui: { icon: 'alert' } },
  { type: 'Microsoft.Insights/scheduledQueryRules', label: lbl('Regola di avviso di ricerca log', 'Log search alert rule'), category: 'monitor', apiVersions: V('2023-12-01', '2022-06-15', '2021-08-01'), ui: { icon: 'alert' } },
  { type: 'Microsoft.Insights/activityLogAlerts', label: lbl('Avviso log attività', 'Activity log alert'), category: 'monitor', apiVersions: V('2020-10-01'), global: true },
  { type: 'Microsoft.Insights/autoscalesettings', label: lbl('Impostazione di scalabilità automatica', 'Autoscale setting'), category: 'monitor', apiVersions: V('2022-10-01', '2015-04-01') },
  { type: 'Microsoft.Insights/diagnosticSettings', label: lbl('Impostazione di diagnostica', 'Diagnostic setting'), category: 'monitor', apiVersions: V('2021-05-01-preview', '2017-05-01-preview'), tracked: false, ui: { hidden: true } },
  { type: 'Microsoft.Insights/dataCollectionRules', label: lbl('Regola di raccolta dati', 'Data collection rule'), category: 'monitor', apiVersions: V('2023-03-11', '2022-06-01'), computed: (r, c) => { r.properties.immutableId = c.existing?.properties?.immutableId ?? `dcr-${uniqueString(c.id)}${uniqueString(c.name)}`.slice(0, 36); } },
  { type: 'Microsoft.Insights/workbooks', label: lbl('Cartella di lavoro', 'Workbook'), category: 'monitor', apiVersions: V('2023-06-01', '2022-04-01') },
  { type: 'Microsoft.Portal/dashboards', label: lbl('Dashboard', 'Dashboard'), category: 'monitor', apiVersions: V('2020-09-01-preview', '2019-01-01-preview') },

  // ---------------- Integration ----------------
  ...(['ServiceBus', 'EventHub'] as const).flatMap((ns): TypeDef[] => {
    const sb = ns === 'ServiceBus';
    const av = sb ? V('2022-10-01-preview', '2021-11-01', '2021-06-01-preview', '2017-04-01') : V('2024-01-01', '2022-10-01-preview', '2021-11-01', '2017-04-01');
    const out: TypeDef[] = [
      {
        type: `Microsoft.${ns}/namespaces`, label: sb ? lbl('Spazio dei nomi del bus di servizio', 'Service Bus namespace') : lbl('Spazio dei nomi di Hub eventi', 'Event Hubs namespace'), category: 'integration', apiVersions: av,
        nameRule: { pattern: /^[a-zA-Z][a-zA-Z0-9-]{4,48}[a-zA-Z0-9]$/, code: 'InvalidNamespaceName', message: 'The namespace name can contain only letters, numbers, and hyphens. The namespace must start with a letter, and it must end with a letter or number. Length 6-50.' },
        globalName: { code: 'NamespaceNameNotAvailable', message: (n) => `The specified service namespace is invalid or already in use: ${n}.` },
        hooks: ['identity', sb ? 'servicebus' : 'eventhub'],
        defaults: defaults({ sku: { name: 'Standard', tier: 'Standard', ...(sb ? {} : { capacity: 1 }) }, 'properties.minimumTlsVersion': '1.2', 'properties.publicNetworkAccess': 'Enabled', 'properties.disableLocalAuth': false, 'properties.zoneRedundant': false }),
        computed: (r, c) => Object.assign(r.properties, { serviceBusEndpoint: `https://${lower(c.name)}.servicebus.windows.net:443/`, status: 'Active', metricId: `${c.sub}:${lower(c.name)}`, createdAt: c.existing?.properties?.createdAt ?? c.now, updatedAt: c.now, ...(sb ? {} : { kafkaEnabled: r.sku.name !== 'Basic', isAutoInflateEnabled: false, maximumThroughputUnits: 0 }) }),
        ui: { icon: sb ? 'servicebus' : 'eventhub', fields: [f('sku.name', 'Piano tariffario', 'Pricing tier', 'select', { options: sb ? ['Basic', 'Standard', 'Premium'] : ['Basic', 'Standard', 'Premium'], default: 'Standard' })] },
      },
      sbAuthRule(`Microsoft.${ns}/namespaces/authorizationRules`, lbl('Criterio di accesso condiviso', 'Shared access policy'), sb ? 'servicebus' : 'eventhub'),
    ];
    if (sb) {
      out.push(
        { type: 'Microsoft.ServiceBus/namespaces/queues', label: lbl('Coda', 'Queue'), category: 'integration', apiVersions: av, defaults: defaults({ 'properties.maxSizeInMegabytes': 1024, 'properties.lockDuration': 'PT1M', 'properties.requiresDuplicateDetection': false, 'properties.requiresSession': false, 'properties.defaultMessageTimeToLive': 'P14D', 'properties.deadLetteringOnMessageExpiration': false, 'properties.maxDeliveryCount': 10, 'properties.enablePartitioning': false, 'properties.enableBatchedOperations': true }), computed: (r, c) => Object.assign(r.properties, { status: 'Active', messageCount: 0, sizeInBytes: 0, createdAt: c.existing?.properties?.createdAt ?? c.now, updatedAt: c.now, countDetails: { activeMessageCount: 0, deadLetterMessageCount: 0, scheduledMessageCount: 0, transferMessageCount: 0, transferDeadLetterMessageCount: 0 } }), ui: { hidden: true } },
        { type: 'Microsoft.ServiceBus/namespaces/topics', label: lbl('Argomento', 'Topic'), category: 'integration', apiVersions: av, defaults: defaults({ 'properties.maxSizeInMegabytes': 1024, 'properties.defaultMessageTimeToLive': 'P14D', 'properties.enableBatchedOperations': true }), computed: (r, c) => Object.assign(r.properties, { status: 'Active', subscriptionCount: 0, sizeInBytes: 0, createdAt: c.existing?.properties?.createdAt ?? c.now, updatedAt: c.now }), ui: { hidden: true } },
        { type: 'Microsoft.ServiceBus/namespaces/topics/subscriptions', label: lbl('Sottoscrizione', 'Subscription'), category: 'integration', apiVersions: av, defaults: defaults({ 'properties.lockDuration': 'PT1M', 'properties.maxDeliveryCount': 10, 'properties.requiresSession': false }), computed: (r) => Object.assign(r.properties, { status: 'Active', messageCount: 0 }), ui: { hidden: true } },
        { type: 'Microsoft.ServiceBus/namespaces/topics/subscriptions/rules', label: lbl('Regola', 'Rule'), category: 'integration', apiVersions: av, ui: { hidden: true } },
        sbAuthRule('Microsoft.ServiceBus/namespaces/queues/authorizationRules', lbl('Criterio coda', 'Queue policy'), 'servicebus'),
        sbAuthRule('Microsoft.ServiceBus/namespaces/topics/authorizationRules', lbl('Criterio argomento', 'Topic policy'), 'servicebus'),
      );
    } else {
      out.push(
        { type: 'Microsoft.EventHub/namespaces/eventhubs', label: lbl('Hub eventi', 'Event hub'), category: 'integration', apiVersions: av, defaults: defaults({ 'properties.partitionCount': 4, 'properties.messageRetentionInDays': 1 }), computed: (r, c) => Object.assign(r.properties, { status: 'Active', partitionIds: Array.from({ length: Number(r.properties.partitionCount) }, (_, i) => String(i)), createdAt: c.existing?.properties?.createdAt ?? c.now, updatedAt: c.now }), ui: { hidden: true } },
        { type: 'Microsoft.EventHub/namespaces/eventhubs/consumergroups', label: lbl('Gruppo di consumer', 'Consumer group'), category: 'integration', apiVersions: av, computed: (r, c) => Object.assign(r.properties, { createdAt: c.existing?.properties?.createdAt ?? c.now, updatedAt: c.now }), ui: { hidden: true } },
        sbAuthRule('Microsoft.EventHub/namespaces/eventhubs/authorizationRules', lbl('Criterio hub eventi', 'Event hub policy'), 'eventhub'),
      );
    }
    return out;
  }),
  {
    type: 'Microsoft.EventGrid/topics', label: lbl('Argomento di Griglia di eventi', 'Event Grid topic'), category: 'integration', apiVersions: V('2024-06-01-preview', '2023-12-15-preview', '2022-06-15', '2021-12-01'), hooks: ['identity'],
    defaults: defaults({ 'properties.inputSchema': 'EventGridSchema', 'properties.publicNetworkAccess': 'Enabled' }),
    computed: (r, c) => { r.properties.endpoint = `https://${lower(c.name)}.${c.location}-1.eventgrid.azure.net/api/events`; r.properties.metricResourceId = c.existing?.properties?.metricResourceId ?? uuid(); },
    secrets: () => ({ key1: accountKey(32), key2: accountKey(32) }),
    actions: { listKeys: (r) => ({ key1: r._secrets.key1, key2: r._secrets.key2 }), regenerateKey: (r, c) => { const k = c.body?.keyName === 'key2' ? 'key2' : 'key1'; r._secrets[k] = accountKey(32); c.save(); return { key1: r._secrets.key1, key2: r._secrets.key2 }; } },
    ui: { icon: 'eventgrid' },
  },
  { type: 'Microsoft.EventGrid/systemTopics', label: lbl('Argomento di sistema', 'System topic'), category: 'integration', apiVersions: V('2024-06-01-preview', '2022-06-15'), computed: (r, c) => { r.properties.metricResourceId = c.existing?.properties?.metricResourceId ?? uuid(); } },
  { type: 'Microsoft.EventGrid/eventSubscriptions', label: lbl('Sottoscrizione eventi', 'Event subscription'), category: 'integration', apiVersions: V('2024-06-01-preview', '2022-06-15'), tracked: false, computed: (r) => { r.properties.topic ??= null; }, ui: { hidden: true } },
  { type: 'Microsoft.EventGrid/systemTopics/eventSubscriptions', label: lbl('Sottoscrizione eventi', 'Event subscription'), category: 'integration', apiVersions: V('2024-06-01-preview', '2022-06-15'), ui: { hidden: true } },
  { type: 'Microsoft.Logic/workflows', label: lbl('App per la logica', 'Logic app'), category: 'integration', apiVersions: V('2019-05-01', '2016-06-01'), hooks: ['identity'], defaults: defaults({ 'properties.state': 'Enabled', 'properties.definition': { $schema: 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#', contentVersion: '1.0.0.0', triggers: {}, actions: {}, outputs: {} } }), computed: (r, c) => { r.properties.accessEndpoint = `https://prod-00.${c.location}.logic.azure.com:443/workflows/${uniqueString(c.id)}${uniqueString(c.name)}`; r.properties.createdTime = c.existing?.properties?.createdTime ?? c.now; r.properties.changedTime = c.now; r.properties.version = uniqueString(c.now); }, ui: { icon: 'logic' } },
  {
    type: 'Microsoft.SignalRService/signalR', label: lbl('SignalR', 'SignalR'), category: 'integration', apiVersions: V('2024-03-01', '2023-02-01', '2022-02-01'), hooks: ['identity'],
    defaults: defaults({ sku: { name: 'Free_F1', tier: 'Free', capacity: 1 }, kind: 'SignalR' }),
    computed: (r, c) => Object.assign(r.properties, { hostName: `${lower(c.name)}.service.signalr.net`, externalIP: deterministicIp(c.id, '20'), publicPort: 443, serverPort: 443, version: '1.0' }),
    secrets: () => ({ primaryKey: accountKey(32), secondaryKey: accountKey(32) }),
    actions: { listKeys: (r) => ({ primaryKey: r._secrets.primaryKey, secondaryKey: r._secrets.secondaryKey, primaryConnectionString: `Endpoint=https://${r.properties.hostName};AccessKey=${r._secrets.primaryKey};Version=1.0;`, secondaryConnectionString: `Endpoint=https://${r.properties.hostName};AccessKey=${r._secrets.secondaryKey};Version=1.0;` }) },
    ui: { icon: 'signalr', fields: [f('sku.name', 'Piano', 'Tier', 'select', { options: ['Free_F1', 'Standard_S1', 'Premium_P1'], default: 'Free_F1' })] },
  },
  {
    type: 'Microsoft.SignalRService/webPubSub', label: lbl('Web PubSub', 'Web PubSub'), category: 'integration', apiVersions: V('2024-03-01', '2023-02-01'), hooks: ['identity'],
    defaults: defaults({ sku: { name: 'Free_F1', tier: 'Free', capacity: 1 } }),
    computed: (r, c) => Object.assign(r.properties, { hostName: `${lower(c.name)}.webpubsub.azure.com`, externalIP: deterministicIp(c.id, '20'), publicPort: 443, serverPort: 443, version: '1.0' }),
    secrets: () => ({ primaryKey: accountKey(32), secondaryKey: accountKey(32) }),
    actions: { listKeys: (r) => ({ primaryKey: r._secrets.primaryKey, secondaryKey: r._secrets.secondaryKey, primaryConnectionString: `Endpoint=https://${r.properties.hostName};AccessKey=${r._secrets.primaryKey};Version=1.0;`, secondaryConnectionString: `Endpoint=https://${r.properties.hostName};AccessKey=${r._secrets.secondaryKey};Version=1.0;` }) },
  },
  {
    type: 'Microsoft.ApiManagement/service', label: lbl('Gestione API', 'API Management'), category: 'integration', apiVersions: V('2023-09-01-preview', '2023-05-01-preview', '2022-08-01', '2021-08-01'), hooks: ['identity'],
    defaults: defaults({ sku: { name: 'Developer', capacity: 1 }, 'properties.publisherEmail': 'admin@contoso.com', 'properties.publisherName': 'Contoso' }),
    computed: (r, c) => { const n = lower(c.name); Object.assign(r.properties, { gatewayUrl: `https://${n}.azure-api.net`, developerPortalUrl: `https://${n}.developer.azure-api.net`, managementApiUrl: `https://${n}.management.azure-api.net`, scmUrl: `https://${n}.scm.azure-api.net`, portalUrl: `https://${n}.portal.azure-api.net`, publicIPAddresses: [deterministicIp(c.id, '20')], platformVersion: 'stv2', createdAtUtc: c.existing?.properties?.createdAtUtc ?? c.now }); },
    ui: { icon: 'api' },
  },
  ...['apis', 'products', 'subscriptions', 'namedValues', 'backends', 'apis/operations', 'apis/policies', 'policies', 'loggers'].map((t): TypeDef => ({ type: `Microsoft.ApiManagement/service/${t}`, label: lbl(t, t), category: 'integration', apiVersions: V('2023-09-01-preview', '2022-08-01', '2021-08-01'), ui: { hidden: true } })),
  {
    type: 'Microsoft.AppConfiguration/configurationStores', label: lbl('Configurazione app', 'App Configuration'), category: 'integration', apiVersions: V('2024-05-01', '2023-03-01', '2022-05-01'), hooks: ['identity'],
    defaults: defaults({ sku: { name: 'free' }, 'properties.publicNetworkAccess': 'Enabled', 'properties.disableLocalAuth': false }),
    computed: (r, c) => { r.properties.endpoint = `https://${lower(c.name)}.azconfig.io`; r.properties.creationDate = c.existing?.properties?.creationDate ?? c.now; },
    secrets: () => ({ primary: accountKey(32), secondary: accountKey(32), primaryRO: accountKey(32), secondaryRO: accountKey(32), id1: randomToken(9), id2: randomToken(9), id3: randomToken(9), id4: randomToken(9) }),
    actions: {
      listKeys: (r) => {
        return { value: appConfigKeys(r) };
      },
      regenerateKey: (r, c) => {
        const slot = ([['id1', 'primary'], ['id2', 'secondary'], ['id3', 'primaryRO'], ['id4', 'secondaryRO']] as const).find(([id]) => r._secrets[id] === c.body?.id);
        if (!slot) throw Object.assign(new Error(`The access key '${c.body?.id ?? ''}' was not found.`), { status: 404, code: 'NotFound' });
        r._secrets[slot[0]] = randomToken(9);
        r._secrets[slot[1]] = accountKey(32);
        c.save();
        return appConfigKeys(r).find((k) => k.id === r._secrets[slot[0]]);
      },
    },
    ui: { icon: 'config', fields: [f('sku.name', 'Piano', 'Tier', 'select', { options: ['free', 'standard'], default: 'free' })] },
  },
  {
    type: 'Microsoft.AppConfiguration/configurationStores/keyValues', label: lbl('Valore chiave', 'Key-value'), category: 'integration', apiVersions: V('2024-05-01', '2023-03-01'), ui: { hidden: true },
    // nome ARM = chiave$etichetta
    computed: (r, c) => { const i = c.name.indexOf('$'); Object.assign(r.properties, { key: i < 0 ? c.name : c.name.slice(0, i), label: i < 0 ? null : c.name.slice(i + 1), eTag: uniqueString(c.id, c.now), lastModified: c.now, locked: false, tags: r.properties.tags ?? {} }); },
  },

  // ---------------- Cache ----------------
  {
    type: 'Microsoft.Cache/redis', label: lbl('Cache di Azure per Redis', 'Azure Cache for Redis'), category: 'databases', apiVersions: V('2024-03-01', '2023-08-01', '2023-04-01', '2022-06-01'),
    globalName: { code: 'NameNotAvailable', message: (n) => `The name '${n}' is already in use.` }, hooks: ['identity'],
    defaults: defaults({ 'properties.sku': { name: 'Basic', family: 'C', capacity: 0 }, 'properties.enableNonSslPort': false, 'properties.minimumTlsVersion': '1.2', 'properties.redisVersion': '6', 'properties.publicNetworkAccess': 'Enabled' }),
    computed: (r, c) => Object.assign(r.properties, { hostName: `${lower(c.name)}.redis.cache.windows.net`, port: 6379, sslPort: 6380, instances: [{ sslPort: 15000, isMaster: true, isPrimary: true }], linkedServers: [], accessKeys: null }),
    secrets: () => ({ primaryKey: accountKey(32), secondaryKey: accountKey(32) }),
    actions: { listKeys: (r) => ({ primaryKey: r._secrets.primaryKey, secondaryKey: r._secrets.secondaryKey }), regenerateKey: (r, c) => { const k = c.body?.keyType === 'Secondary' ? 'secondaryKey' : 'primaryKey'; r._secrets[k] = accountKey(32); c.save(); return { primaryKey: r._secrets.primaryKey, secondaryKey: r._secrets.secondaryKey }; } },
    ui: { icon: 'redis', fields: [f('properties.sku.name', 'Piano', 'Tier', 'select', { options: ['Basic', 'Standard', 'Premium'], default: 'Basic' })] },
  },

  {
    type: 'Microsoft.Cache/redis/firewallRules', label: lbl('Regola firewall', 'Firewall rule'), category: 'databases', apiVersions: V('2024-03-01', '2023-08-01'),
    ui: { hidden: true },
  },
  {
    type: 'Microsoft.Cache/redisEnterprise', label: lbl('Azure Managed Redis', 'Azure Managed Redis'), category: 'databases', apiVersions: V('2025-07-01', '2025-04-01', '2024-10-01', '2024-09-01-preview'),
    nameRule: { pattern: /^[a-zA-Z0-9](?!.*--)[a-zA-Z0-9-]{0,58}[a-zA-Z0-9]$/, code: 'InvalidResourceName', message: 'The name must be 1-60 characters: letters, numbers and single hyphens.' },
    globalName: { code: 'NameNotAvailable', message: (n) => `The name '${n}' is already in use.` }, hooks: ['identity', 'redisdb'],
    defaults: defaults({ sku: { name: 'Balanced_B1' }, 'properties.minimumTlsVersion': '1.2', 'properties.highAvailability': 'Enabled', 'properties.publicNetworkAccess': 'Enabled' }),
    computed: (r, c) => Object.assign(r.properties, { hostName: `${lower(c.name)}.${c.location}.redis.azure.net`, redisVersion: '7.4', resourceState: 'Running', privateEndpointConnections: [] }),
    ui: { icon: 'redis', fields: [f('sku.name', 'Piano', 'Plan', 'select', { options: ['Balanced_B0', 'Balanced_B1', 'Balanced_B3', 'Balanced_B5', 'Balanced_B10', 'MemoryOptimized_M10', 'ComputeOptimized_X3'], default: 'Balanced_B1' })] },
  },
  {
    type: 'Microsoft.Cache/redisEnterprise/databases', label: lbl('Database Redis', 'Redis database'), category: 'databases', apiVersions: V('2025-07-01', '2025-04-01', '2024-10-01'),
    defaults: defaults({ 'properties.clientProtocol': 'Encrypted', 'properties.port': 10000, 'properties.clusteringPolicy': 'OSSCluster', 'properties.evictionPolicy': 'VolatileLRU', 'properties.persistence': { aofEnabled: false, rdbEnabled: false }, 'properties.modules': [], 'properties.accessKeysAuthentication': 'Disabled' }),
    computed: (r) => { r.properties.resourceState = 'Running'; },
    secrets: () => ({ primaryKey: accountKey(32), secondaryKey: accountKey(32) }),
    actions: {
      listKeys: (r) => ({ primaryKey: r._secrets.primaryKey, secondaryKey: r._secrets.secondaryKey }),
      regenerateKey: (r, c) => { const k = String(c.body?.keyType ?? 'Primary').toLowerCase() === 'secondary' ? 'secondaryKey' : 'primaryKey'; r._secrets[k] = accountKey(32); c.save(); return { primaryKey: r._secrets.primaryKey, secondaryKey: r._secrets.secondaryKey }; },
      flush: () => null,
    },
    ui: { hidden: true },
  },
  // ---------------- AI ----------------
  {
    type: 'Microsoft.CognitiveServices/accounts', label: lbl('Servizi di Azure AI', 'Azure AI services'), category: 'ai', apiVersions: V('2025-06-01', '2025-04-01-preview', '2024-10-01', '2024-06-01-preview', '2023-10-01-preview', '2023-05-01', '2022-12-01'), hooks: ['identity'],
    defaults: (b, c) => defaults({ kind: 'OpenAI', sku: { name: 'S0' }, 'properties.publicNetworkAccess': 'Enabled', 'properties.customSubDomainName': lower(c.name) })(b),
    computed: (r, c) => {
      const sub = lower(r.properties.customSubDomainName ?? c.name);
      const openai = String(r.kind).toLowerCase() === 'openai';
      r.properties.endpoint = openai ? `https://${sub}.openai.azure.com/` : `https://${sub}.cognitiveservices.azure.com/`;
      const aiServices = String(r.kind).toLowerCase() === 'aiservices';
      r.properties.endpoints = openai
        ? { 'OpenAI Language Model Instance API': r.properties.endpoint, 'OpenAI Dall-E API': r.properties.endpoint }
        : aiServices
          ? { 'AI Foundry API': `https://${sub}.services.ai.azure.com/`, 'OpenAI Language Model Instance API': `https://${sub}.openai.azure.com/`, 'Azure AI Model Inference API': `https://${sub}.services.ai.azure.com/models`, 'Cognitive Services': r.properties.endpoint }
          : { 'Cognitive Services': r.properties.endpoint };
      if (aiServices && r.properties.allowProjectManagement) r.properties.associatedProjects = c.existing?.properties?.associatedProjects ?? [];
      r.properties.dateCreated = c.existing?.properties?.dateCreated ?? c.now;
      r.properties.internalId = c.existing?.properties?.internalId ?? uniqueString(c.id) + uniqueString(c.name);
    },
    secrets: () => ({ key1: randomToken(24).replace(/[-_]/g, '0'), key2: randomToken(24).replace(/[-_]/g, '1') }),
    actions: { listKeys: (r) => ({ key1: r._secrets.key1, key2: r._secrets.key2 }), regenerateKey: (r, c) => { const k = c.body?.keyName === 'Key2' ? 'key2' : 'key1'; r._secrets[k] = randomToken(24).replace(/[-_]/g, '2'); c.save(); return { key1: r._secrets.key1, key2: r._secrets.key2 }; } },
    ui: { icon: 'ai', presets: [{
      key: 'foundry', label: lbl('Azure AI Foundry', 'Azure AI Foundry'),
      description: lbl('Risorsa Foundry: modelli, agenti e progetti in un unico account AI Services.', 'Foundry resource: models, agents and projects in one AI Services account.'),
      body: { kind: 'AIServices', sku: { name: 'S0' }, identity: { type: 'SystemAssigned' }, properties: { allowProjectManagement: true, publicNetworkAccess: 'Enabled' } },
      fields: [f('sku.name', 'Piano', 'Tier', 'select', { options: ['S0'], default: 'S0' })],
    }], fields: [f('kind', 'Tipo', 'Kind', 'select', { options: ['OpenAI', 'AIServices', 'CognitiveServices', 'TextAnalytics', 'ComputerVision', 'SpeechServices', 'FormRecognizer'], default: 'OpenAI' }), f('sku.name', 'Piano', 'Tier', 'select', { options: ['S0', 'F0'], default: 'S0' })] },
  },
  {
    type: 'Microsoft.CognitiveServices/accounts/projects', label: lbl('Progetto Foundry', 'Foundry project'), category: 'ai', apiVersions: V('2025-06-01', '2025-04-01-preview'), tracked: true, hooks: ['identity'],
    defaults: (b, c) => defaults({ identity: { type: 'SystemAssigned' }, 'properties.displayName': c.name, 'properties.description': '' })(b),
    computed: (r, c) => {
      const account = lower(c.names[0]);
      r.properties.endpoints = { 'AI Foundry API': `https://${account}.services.ai.azure.com/api/projects/${c.name}` };
      r.properties.isDefault = c.existing?.properties?.isDefault ?? false;
    },
    ui: { hidden: true, icon: 'ai' },
  },
  { type: 'Microsoft.CognitiveServices/accounts/deployments', label: lbl('Distribuzione modello', 'Model deployment'), category: 'ai', apiVersions: V('2024-10-01', '2024-06-01-preview', '2023-05-01'), defaults: defaults({ sku: { name: 'Standard', capacity: 10 }, 'properties.versionUpgradeOption': 'OnceNewDefaultVersionAvailable' }), computed: (r) => { r.properties.rateLimits = [{ key: 'request', renewalPeriod: 10, count: Number(r.sku.capacity ?? 10) }]; r.properties.capabilities = { chatCompletion: 'true' }; }, ui: { hidden: true } },
  {
    type: 'Microsoft.Search/searchServices', label: lbl('Ricerca di Azure AI', 'Azure AI Search'), category: 'ai', apiVersions: V('2024-06-01-preview', '2023-11-01', '2022-09-01', '2020-08-01'), hooks: ['identity'],
    globalName: { code: 'ServiceNameUnavailable', message: (n) => `Service name '${n}' is already in use.` },
    defaults: defaults({ sku: { name: 'basic' }, 'properties.replicaCount': 1, 'properties.partitionCount': 1, 'properties.hostingMode': 'default', 'properties.publicNetworkAccess': 'enabled' }),
    computed: (r) => Object.assign(r.properties, { status: 'running', statusDetails: '' }),
    secrets: () => ({ primaryKey: randomToken(39), secondaryKey: randomToken(39), queryKey: randomToken(39) }),
    actions: { listAdminKeys: (r) => ({ primaryKey: r._secrets.primaryKey, secondaryKey: r._secrets.secondaryKey }), listQueryKeys: (r) => ({ value: [{ name: null, key: r._secrets.queryKey }] }) },
    ui: { icon: 'search', fields: [f('sku.name', 'Piano', 'Tier', 'select', { options: ['free', 'basic', 'standard'], default: 'basic' })] },
  },
  { type: 'Microsoft.MachineLearningServices/workspaces', label: lbl('Area di lavoro di Azure Machine Learning', 'Azure Machine Learning workspace'), category: 'ai', apiVersions: V('2024-10-01', '2024-04-01', '2023-10-01'), hooks: ['identity'], computed: (r, c) => { r.properties.workspaceId = c.existing?.properties?.workspaceId ?? uuid(); r.properties.discoveryUrl = `https://${c.location}.api.azureml.ms/discovery`; }, ui: { presets: [{ key: 'foundryHub', label: lbl('Hub di Azure AI Foundry (classico)', 'Azure AI Foundry hub (classic)'), description: lbl('Hub basato su Azure Machine Learning con progetti collegati.', 'Azure Machine Learning-based hub with linked projects.'), body: { kind: 'Hub', identity: { type: 'SystemAssigned' }, sku: { name: 'Basic', tier: 'Basic' } } }], icon: 'ai' } },

  // ---------------- Management ----------------
  { type: 'Microsoft.Authorization/policyDefinitions', label: lbl('Definizione di criterio', 'Policy definition'), category: 'management', apiVersions: V('2023-04-01', '2021-06-01', '2020-09-01'), tracked: false, computed: (r) => { r.properties.policyType ??= 'Custom'; r.properties.mode ??= 'All'; }, ui: { hidden: true } },
  { type: 'Microsoft.Authorization/policySetDefinitions', label: lbl('Iniziativa', 'Initiative'), category: 'management', apiVersions: V('2023-04-01', '2021-06-01'), tracked: false, ui: { hidden: true } },
  { type: 'Microsoft.Authorization/policyAssignments', label: lbl('Assegnazione di criterio', 'Policy assignment'), category: 'management', apiVersions: V('2023-04-01', '2022-06-01', '2021-06-01'), tracked: false, hooks: ['identity'], computed: (r) => { r.properties.enforcementMode ??= 'Default'; r.properties.scope = r.id.split('/providers/Microsoft.Authorization/')[0] || '/'; }, ui: { hidden: true } },
  { type: 'Microsoft.Resources/templateSpecs', label: lbl('Specifica di modello', 'Template spec'), category: 'management', apiVersions: V('2022-02-01', '2021-05-01'), ui: { icon: 'template' } },
  { type: 'Microsoft.Resources/templateSpecs/versions', label: lbl('Versione', 'Version'), category: 'management', apiVersions: V('2022-02-01', '2021-05-01'), tracked: true, ui: { hidden: true } },
  { type: 'Microsoft.Resources/deploymentScripts', label: lbl('Script di distribuzione', 'Deployment script'), category: 'management', apiVersions: V('2023-08-01', '2020-10-01'), hooks: ['identity'], computed: (r, c) => { r.properties.outputs ??= {}; r.properties.status = { startTime: c.now, endTime: c.now, expirationTime: new Date(Date.now() + 86400_000).toISOString() }; }, ui: { hidden: true } },
  { type: 'Microsoft.Automation/automationAccounts', label: lbl('Account di Automazione', 'Automation account'), category: 'management', apiVersions: V('2023-11-01', '2022-08-08'), hooks: ['identity'], defaults: defaults({ 'properties.sku': { name: 'Basic' } }), computed: (r, c) => { r.properties.state = 'Ok'; r.properties.creationTime = c.existing?.properties?.creationTime ?? c.now; r.properties.automationHybridServiceUrl = `https://${uuid()}.jrds.${c.location}.azure-automation.net/automationAccounts/${uuid()}`; }, ui: { icon: 'automation' } },
  { type: 'Microsoft.RecoveryServices/vaults', label: lbl('Insieme di credenziali di Servizi di ripristino', 'Recovery Services vault'), category: 'management', apiVersions: V('2024-04-01', '2023-06-01'), hooks: ['identity'], defaults: defaults({ sku: { name: 'RS0', tier: 'Standard' } }), ui: { icon: 'backup' } },
  {
    type: 'Microsoft.Consumption/budgets', label: lbl('Budget', 'Budget'), category: 'management', apiVersions: V('2023-11-01', '2023-05-01', '2021-10-01', '2019-10-01'), tracked: false,
    defaults: (b) => {
      const now = new Date();
      defaults({ 'properties.category': 'Cost', 'properties.timeGrain': 'Monthly', 'properties.timePeriod.startDate': new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().replace('.000Z', 'Z'), 'properties.notifications': {} })(b);
    },
    computed: (r) => { if (!(Number(r.properties.amount) > 0)) r.properties.amount = Number(r.properties.amount ?? 0); },
    ui: { hidden: true, icon: 'cost' },
  },
];

export const TYPES_BY_TYPE = new Map(TYPES.map((t) => [t.type.toLowerCase(), t]));

export function typeDef(type: string): TypeDef | undefined {
  return TYPES_BY_TYPE.get(type.toLowerCase());
}

export function namespaces(): string[] {
  const base = new Set(TYPES.map((t) => t.type.split('/')[0]));
  for (const ns of ['Microsoft.Resources', 'Microsoft.Authorization', 'Microsoft.Insights', 'Microsoft.Subscription', 'Microsoft.Features', 'Microsoft.Network', 'Microsoft.Compute', 'Microsoft.Security', 'Microsoft.PolicyInsights', 'Microsoft.Management', 'Microsoft.AlertsManagement', 'Microsoft.OperationsManagement', 'Microsoft.ResourceHealth', 'Microsoft.Support', 'Microsoft.CostManagement', 'Microsoft.Consumption']) base.add(ns);
  return [...base].sort();
}
