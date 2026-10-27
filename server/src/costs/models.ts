/**
 * Listino dei modelli AI di Microsoft Foundry / Azure OpenAI (GPT, o-series, DeepSeek, Grok,
 * Llama, Mistral, Phi…) letto dall'API pubblica Azure Retail Prices, in EUR, per regione.
 * I nomi dei meter sono abbreviati ("5.1 pp cd inp Dz 1M Tokens"): qui diventano righe
 * modello × tipo di distribuzione con prezzo per 1M token di input, input in cache e output.
 * Claude su Foundry è fatturato tramite Azure Marketplace: listino Anthropic in USD, a parte.
 */
import { readFileSync } from 'node:fs';
import * as store from '../db/store.ts';

export type Deployment = 'global' | 'datazone' | 'regional';
export interface ModelPrice {
  family: string;
  model: string;
  deployment: Deployment;
  /** Batch, Flex, Priority, Long context, Fine-tuned */
  flags: string[];
  input?: number;
  cachedInput?: number;
  output?: number;
}
export interface OtherMeter { family: string; meter: string; unit: string; price: number }
export interface ModelPriceList { region: string; currency: 'EUR'; source: 'live' | 'cache' | 'snapshot'; fetchedAt: string; rows: ModelPrice[]; other: OtherMeter[] }

export const MODEL_REGIONS = ['swedencentral', 'italynorth', 'westeurope', 'francecentral', 'germanywestcentral', 'polandcentral', 'spaincentral', 'switzerlandnorth', 'norwayeast', 'uksouth', 'eastus', 'eastus2', 'westus', 'westus3', 'northcentralus', 'southcentralus', 'canadaeast', 'brazilsouth', 'japaneast', 'koreacentral', 'australiaeast', 'southeastasia', 'southindia'];

const FAMILY: [RegExp, string, RegExp | null][] = [
  // [productName, etichetta, se il nome del modello non la contiene già si antepone]
  [/GPT6/i, 'GPT-6', /gpt/i],
  [/GPT5/i, 'GPT-5', /gpt|chat-latest|codex|o\d/i],
  [/OSS/i, 'gpt-oss', /oss/i],
  [/Embedding/i, 'Azure OpenAI', null],
  [/Reasoning/i, 'Azure OpenAI', null],
  [/Media/i, 'Azure OpenAI', null],
  [/PP FT|^FT /i, 'Fine-tuning', null],
  [/OpenAI/i, 'Azure OpenAI', null],
  [/Deepseek/i, 'DeepSeek', /deepseek|mai-ds/i],
  [/Grok/i, 'Grok', /grok/i],
  [/Llama/i, 'Llama', /llama/i],
  [/Mistral/i, 'Mistral', /mistral|codestral|ministral|pixtral|magistral|devstral/i],
  [/Phi/i, 'Phi', /phi/i],
  [/Cohere/i, 'Cohere', /cohere|command|embed|rerank/i],
  [/Kimi/i, 'Kimi', /kimi/i],
  [/MAI/i, 'MAI', /mai/i],
  [/Flux|BFL/i, 'FLUX', /flux/i],
];

function familyOf(product: string): { label: string; prefixUnless: RegExp | null } {
  for (const [re, label, unless] of FAMILY) if (re.test(product)) return { label, prefixUnless: unless };
  return { label: product.replace(/^Azure\s+/i, '').replace(/\s+Models?$/i, ''), prefixUnless: null };
}

const DROP = new Set(['tokens', 'token', '1m', '1k', 'unit', 'units']);

/** Scompone un meter: direzione (input/cache/output), distribuzione, varianti e nome del modello. */
export function parseMeter(meter: string): { dir?: 'input' | 'cachedInput' | 'output'; deployment: Deployment; flags: string[]; name: string } {
  const tokens = meter
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/(\d)(Outp|Inp|Batch)/gi, '$1 $2')
    .replace(/([a-z])(\d{4})\b/gi, '$1 $2') // "mini0718" → "mini 0718"
    .replace(/\bgpt(?=\d)/gi, 'gpt ') // "gpt4o" → "gpt 4o"
    .split(/[\s_-]+/)
    .filter(Boolean);
  let dir: 'input' | 'output' | undefined;
  let cached = false;
  let deployment: Deployment | undefined;
  const flags = new Set<string>();
  const name: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    const l = tk.toLowerCase();
    if (DROP.has(l)) continue;
    if (['inp', 'inpt', 'input'].includes(l) || (l === 'in' && i > 0)) { dir = 'input'; continue; }
    if (['opt', 'outp', 'output', 'out', 'otpt'].includes(l)) { dir = 'output'; continue; }
    if (['cd', 'cchd', 'cached', 'cache', 'cachd', 'cch'].includes(l)) { cached = true; continue; }
    if (['gl', 'glb', 'glbl', 'global', 'globl'].includes(l)) { deployment = 'global'; continue; }
    if (['dz', 'dzn', 'dzone', 'datazone'].includes(l)) { deployment = 'datazone'; continue; }
    if (l === 'data' && tokens[i + 1]?.toLowerCase() === 'zone') { deployment = 'datazone'; i++; continue; }
    if (['regnl', 'rgnl', 'regional', 'regn', 'rgn'].includes(l)) { deployment = 'regional'; continue; }
    if (l === 'batch') { flags.add('Batch'); continue; }
    if (l === 'flex') { flags.add('Flex'); continue; }
    if (l === 'pp') { flags.add('Priority'); continue; }
    if (l === 'ft' || l === 'finetuned') { flags.add('Fine-tuned'); continue; }
    if (l === 'l' && i === tokens.length - 1 - tokens.slice(i + 1).filter((x) => DROP.has(x.toLowerCase())).length) { flags.add('Long context'); continue; }
    name.push(tk);
  }
  // gli embedding hanno solo input e il meter non lo dice
  if (!dir && !cached && /embed/i.test(meter)) dir = 'input';
  if (['finetuned', 'fine-tuned'].some((f) => meter.toLowerCase().includes(f))) flags.add('Fine-tuned');
  return { dir: dir === 'input' && cached ? 'cachedInput' : cached && !dir ? 'cachedInput' : dir, deployment: deployment ?? 'regional', flags: [...flags].sort(), name: name.join(' ') };
}

function modelName(raw: string, fam: { label: string; prefixUnless: RegExp | null }): string {
  let n = raw.trim().replace(/^gpt[\s-]?/i, 'GPT-').replace(/\s+/g, ' ');
  if (fam.label === 'GPT-5' || fam.label === 'GPT-6') {
    n = n.replace(/^(\d)(\d)\b/, '$1.$2'); // "54 mini" → "5.4 mini"
    if (/^\d/.test(n)) n = `GPT-${n}`;
  }
  if (fam.prefixUnless && !fam.prefixUnless.test(n)) n = `${fam.label} ${n}`;
  return n || fam.label;
}

interface RetailItem { productName: string; meterName: string; unitOfMeasure: string; retailPrice: number; type: string; tierMinimumUnits?: number }

export function buildList(items: RetailItem[]): { rows: ModelPrice[]; other: OtherMeter[] } {
  const rows = new Map<string, ModelPrice>();
  const other: OtherMeter[] = [];
  for (const it of items) {
    if (it.type !== 'Consumption' || (it.tierMinimumUnits ?? 0) > 0) continue;
    const fam = familyOf(it.productName);
    const perM = it.unitOfMeasure === '1K' ? 1000 : it.unitOfMeasure === '1M' ? 1 : 0;
    const p = parseMeter(it.meterName);
    if (!perM || !/tokens?\b/i.test(it.meterName) || !p.dir || /training|hosting|grdr|grader/i.test(it.meterName)) {
      other.push({ family: fam.label, meter: it.meterName, unit: it.unitOfMeasure, price: it.retailPrice });
      continue;
    }
    const model = modelName(p.name, fam);
    const key = `${fam.label}|${model.toLowerCase()}|${p.deployment}|${p.flags.join(',')}`;
    const row = rows.get(key) ?? { family: fam.label, model, deployment: p.deployment, flags: p.flags };
    row[p.dir] = Math.round(it.retailPrice * perM * 10000) / 10000;
    rows.set(key, row);
  }
  // solo il prezzo in cache, senza input né output: meter isolato, va tra gli altri
  for (const [k, r] of rows) {
    if (r.input === undefined && r.output === undefined) {
      rows.delete(k);
      other.push({ family: r.family, meter: `${r.model} · cached input · ${r.deployment}`, unit: '1M', price: r.cachedInput ?? 0 });
    }
  }
  const order: Record<Deployment, number> = { global: 0, datazone: 1, regional: 2 };
  return {
    rows: [...rows.values()].sort((a, b) => a.family.localeCompare(b.family) || a.model.localeCompare(b.model, undefined, { numeric: true }) || order[a.deployment] - order[b.deployment] || a.flags.length - b.flags.length),
    other: other.sort((a, b) => a.family.localeCompare(b.family) || a.meter.localeCompare(b.meter)),
  };
}

const DAY = 24 * 3600_000;
const memo = new Map<string, ModelPriceList>();
const SNAPSHOT = new URL('./models-snapshot.json', import.meta.url);

async function fetchRetail(region: string): Promise<RetailItem[]> {
  const filter = `serviceName eq 'Foundry Models' and armRegionName eq '${region}'`;
  let url: string | undefined = `https://prices.azure.com/api/retail/prices?currencyCode=EUR&$filter=${encodeURIComponent(filter)}`;
  const items: RetailItem[] = [];
  for (let page = 0; url && page < 40; page++) {
    const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`Azure Retail Prices ${r.status}`);
    const j = (await r.json()) as { Items: RetailItem[]; NextPageLink?: string | null };
    items.push(...j.Items);
    url = j.NextPageLink ?? undefined;
  }
  return items;
}

/** Listino per regione: in memoria, poi nel database (24 ore), poi dal vivo; se Azure non risponde, l'ultima copia o l'istantanea inclusa. */
export async function modelPrices(region: string): Promise<ModelPriceList> {
  if (!MODEL_REGIONS.includes(region)) region = 'swedencentral';
  const hit = memo.get(region);
  if (hit && Date.now() - Date.parse(hit.fetchedAt) < DAY) return hit;
  const saved = await store.get<ModelPriceList>('modelPriceList', region).catch(() => null);
  if (saved && Date.now() - Date.parse(saved.fetchedAt) < DAY) { memo.set(region, { ...saved, source: 'cache' }); return memo.get(region)!; }
  try {
    const list: ModelPriceList = { region, currency: 'EUR', source: 'live', fetchedAt: new Date().toISOString(), ...buildList(await fetchRetail(region)) };
    if (list.rows.length) {
      memo.set(region, list);
      await store.put('modelPriceList', region, list).catch(() => undefined);
      return list;
    }
  } catch { /* offline o Azure non raggiungibile */ }
  if (saved) return { ...saved, source: 'cache' };
  const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as ModelPriceList;
  return { ...snap, source: 'snapshot' };
}

/**
 * Claude su Microsoft Foundry: fatturato tramite Azure Marketplace al listino Anthropic, in USD
 * per 1M token (fonte: documentazione Anthropic, ottobre 2026).
 */
export const CLAUDE_PRICES = {
  currency: 'USD' as const,
  asOf: '2026-10',
  rows: [
    { model: 'Claude Opus 5.5', id: 'claude-opus-5-5', input: 4, cachedInput: 0.2, output: 20, batchInput: 2, batchOutput: 10 },
    { model: 'Claude Opus 5', id: 'claude-opus-5', input: 5, cachedInput: 0.5, output: 25 },
    { model: 'Claude Sonnet 5.5', id: 'claude-sonnet-5-5', input: 2, cachedInput: 0.2, output: 10 },
    { model: 'Claude Haiku 5.5', id: 'claude-haiku-5-5', input: 0.1, cachedInput: 0.01, output: 0.5, note: { it: 'prompt ≤ 100K token; oltre: 0,50 $ input / 2,50 $ output', en: 'prompt ≤ 100K tokens; above: $0.50 input / $2.50 output' } },
  ],
};
