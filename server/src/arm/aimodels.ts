/**
 * Modelli distribuibili su un account Azure OpenAI / AI Services, nella forma di
 * GET {account}/models (AccountModel): nome, versione, SKU di distribuzione con capacità.
 */
interface ModelDef {
  name: string;
  version: string;
  format?: string;
  kinds: ('OpenAI' | 'AIServices')[];
  caps: Record<string, string>;
  skus: string[];
  max?: number;
  isDefault?: boolean;
  preview?: boolean;
}

const CHAT = { chatCompletion: 'true', responses: 'true', assistants: 'true', agentsV2: 'true', maxContextToken: '128000', maxOutputToken: '16384' };
const STD = ['GlobalStandard', 'DataZoneStandard', 'Standard', 'GlobalBatch', 'GlobalProvisionedManaged', 'ProvisionedManaged'];
const BOTH: ModelDef['kinds'] = ['OpenAI', 'AIServices'];

const MODELS: ModelDef[] = [
  { name: 'gpt-5', version: '2025-08-07', kinds: BOTH, caps: { ...CHAT, maxContextToken: '400000', maxOutputToken: '128000', reasoning: 'true' }, skus: ['GlobalStandard', 'DataZoneStandard', 'GlobalProvisionedManaged'], max: 10000, isDefault: true },
  { name: 'gpt-5-mini', version: '2025-08-07', kinds: BOTH, caps: { ...CHAT, maxContextToken: '400000', maxOutputToken: '128000', reasoning: 'true' }, skus: ['GlobalStandard', 'DataZoneStandard', 'GlobalProvisionedManaged'], max: 10000, isDefault: true },
  { name: 'gpt-5-nano', version: '2025-08-07', kinds: BOTH, caps: { ...CHAT, maxContextToken: '400000', maxOutputToken: '128000', reasoning: 'true' }, skus: ['GlobalStandard', 'DataZoneStandard'], max: 10000, isDefault: true },
  { name: 'gpt-4.1', version: '2025-04-14', kinds: BOTH, caps: { ...CHAT, maxContextToken: '1047576', maxOutputToken: '32768' }, skus: STD, max: 10000, isDefault: true },
  { name: 'gpt-4.1-mini', version: '2025-04-14', kinds: BOTH, caps: { ...CHAT, maxContextToken: '1047576', maxOutputToken: '32768' }, skus: STD, max: 10000, isDefault: true },
  { name: 'gpt-4o', version: '2024-11-20', kinds: BOTH, caps: CHAT, skus: STD, max: 10000, isDefault: true },
  { name: 'gpt-4o-mini', version: '2024-07-18', kinds: BOTH, caps: CHAT, skus: STD, max: 10000, isDefault: true },
  { name: 'o4-mini', version: '2025-04-16', kinds: BOTH, caps: { ...CHAT, maxContextToken: '200000', maxOutputToken: '100000', reasoning: 'true' }, skus: ['GlobalStandard', 'DataZoneStandard', 'GlobalProvisionedManaged'], max: 10000, isDefault: true },
  { name: 'text-embedding-3-large', version: '1', kinds: BOTH, caps: { embeddings: 'true', embeddingsMaxInputs: '2048' }, skus: ['GlobalStandard', 'Standard', 'GlobalBatch'], max: 1000, isDefault: true },
  { name: 'text-embedding-3-small', version: '1', kinds: BOTH, caps: { embeddings: 'true', embeddingsMaxInputs: '2048' }, skus: ['GlobalStandard', 'Standard', 'GlobalBatch'], max: 1000, isDefault: true },
  { name: 'gpt-image-1', version: '2025-04-15', kinds: BOTH, caps: { imageGenerations: 'true' }, skus: ['GlobalStandard'], max: 20, isDefault: true, preview: true },
  { name: 'gpt-4o-transcribe', version: '2025-03-20', kinds: BOTH, caps: { audio: 'true' }, skus: ['GlobalStandard'], max: 1000, isDefault: true },
  { name: 'gpt-4o-mini-tts', version: '2025-03-20', kinds: BOTH, caps: { audio: 'true' }, skus: ['GlobalStandard'], max: 1000, isDefault: true },
  // modelli di altri fornitori su Foundry (solo AI Services)
  { name: 'DeepSeek-R1', version: '1', format: 'DeepSeek', kinds: ['AIServices'], caps: { chatCompletion: 'true', reasoning: 'true' }, skus: ['GlobalStandard'], max: 5000, isDefault: true },
  { name: 'Llama-4-Maverick-17B-128E-Instruct-FP8', version: '1', format: 'Meta', kinds: ['AIServices'], caps: { chatCompletion: 'true' }, skus: ['GlobalStandard'], max: 5000, isDefault: true },
  { name: 'mistral-medium-2505', version: '1', format: 'Mistral AI', kinds: ['AIServices'], caps: { chatCompletion: 'true' }, skus: ['GlobalStandard'], max: 5000, isDefault: true },
  { name: 'grok-3', version: '1', format: 'xAI', kinds: ['AIServices'], caps: { chatCompletion: 'true' }, skus: ['GlobalStandard'], max: 5000, isDefault: true },
];

const PROVISIONED = /Provisioned/;
const usageName = (sku: string, name: string) => `OpenAI.${sku}.${name}`;

/** Elenco dei modelli per il tipo di account, come la risposta di GET {account}/models. */
export function accountModels(kind: string): any[] {
  const k = (String(kind).toLowerCase() === 'aiservices' ? 'AIServices' : String(kind).toLowerCase() === 'openai' ? 'OpenAI' : null);
  if (!k) return [];
  return MODELS.filter((m) => m.kinds.includes(k)).map((m) => ({
    format: m.format ?? 'OpenAI',
    name: m.name,
    version: m.version,
    isDefaultVersion: m.isDefault ?? false,
    lifecycleStatus: m.preview ? 'Preview' : 'GenerallyAvailable',
    capabilities: m.caps,
    maxCapacity: m.max ?? 1000,
    deprecation: { inference: '2027-06-30T00:00:00Z' },
    skus: m.skus.map((s) => ({
      name: s,
      usageName: usageName(s, m.name),
      deprecationDate: '2027-06-30T00:00:00Z',
      capacity: PROVISIONED.test(s) ? { minimum: 15, maximum: 1000, step: 5, default: 15 } : { maximum: m.max ?? 1000, default: Math.min(m.max ?? 1000, s === 'Standard' ? 10 : 50) },
    })),
    systemData: { createdAt: '2025-01-01T00:00:00Z', lastModifiedAt: '2025-08-07T00:00:00Z' },
  }));
}

/** Modello e SKU validi per una distribuzione: altrimenti il messaggio d'errore di Azure. */
export function checkDeployment(model: { format?: string; name?: string; version?: string } | undefined, sku: { name?: string; capacity?: number } | undefined): { error?: { code: string; message: string }; caps?: Record<string, string> } {
  if (!model?.name) return { error: { code: 'InvalidResourceProperties', message: 'The model of the deployment is required.' } };
  const m = MODELS.find((x) => x.name.toLowerCase() === model.name!.toLowerCase() && (!model.version || x.version === model.version));
  if (!m) return { error: { code: 'DeploymentModelNotSupported', message: `The model '${model.format ?? 'OpenAI'}/${model.name}/${model.version ?? ''}' is not supported.` } };
  const skuName = sku?.name ?? 'Standard';
  if (!m.skus.includes(skuName)) return { error: { code: 'InvalidResourceProperties', message: `The specified SKU '${skuName}' for model '${m.name} ${m.version}' is not supported in this region.` } };
  const cap = Number(sku?.capacity ?? 1);
  const max = PROVISIONED.test(skuName) ? 1000 : m.max ?? 1000;
  if (!Number.isInteger(cap) || cap < 1 || cap > max) return { error: { code: 'InvalidCapacity', message: `The capacity should be an integer between 1 and ${max} for SKU '${skuName}'.` } };
  if (PROVISIONED.test(skuName) && (cap < 15 || cap % 5 !== 0)) return { error: { code: 'InvalidCapacity', message: 'Provisioned deployments need at least 15 PTU in steps of 5.' } };
  return { caps: m.caps };
}
