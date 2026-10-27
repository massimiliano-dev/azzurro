/**
 * Motore dei template ARM (JSON). Supporta: parametri tipizzati e validati,
 * variabili lazy, funzioni definite dall'utente, cicli copy (risorse, proprietà,
 * variabili, output), condition, dependsOn + dipendenze implicite via reference(),
 * deployment annidati inner/outer (moduli Bicep compilati), languageVersion 2.0
 * con nomi simbolici e risorse "existing", output.
 */
import { createHash, randomUUID } from 'node:crypto';
import { uniqueString, uuidV5 } from '../ids.ts';
import { TYPES } from './catalog.ts';
import { LOCATIONS } from './locations.ts';

// ============ errori ============

export class TemplateError extends Error {
  code: string;
  details?: { code: string; message: string; target?: string }[];
  constructor(code: string, message: string, details?: TemplateError['details']) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/** La risorsa referenziata non è ancora stata distribuita: riprova più tardi. */
class Pending extends Error {
  target: string;
  constructor(target: string) {
    super(`pending ${target}`);
    this.target = target;
  }
}

const invalid = (message: string) => new TemplateError('InvalidTemplate', message);

// ============ tipi pubblici ============

export interface DeployScope {
  level: 'resourceGroup' | 'subscription' | 'tenant' | 'managementGroup';
  subscriptionId?: string;
  resourceGroup?: string;
}

export interface OperationRecord {
  operationId: string;
  provisioningOperation: 'Create' | 'Read' | 'Delete' | 'Action';
  provisioningState: 'Succeeded' | 'Failed';
  statusCode: string;
  statusMessage?: any;
  timestamp: string;
  duration: string;
  targetResource: { id: string; resourceType: string; resourceName: string; apiVersion?: string };
}

export interface EngineHost {
  dryRun: boolean;
  origin: string;
  tenantId: string;
  getResourceGroup(sub: string, rg: string): Promise<any | null>;
  getSubscription(sub: string): Promise<any | null>;
  get(id: string, apiVersion?: string): Promise<any | null>;
  put(id: string, apiVersion: string, body: any): Promise<{ status: number; body: any }>;
  action(id: string, action: string, apiVersion: string, body?: any): Promise<any>;
  remove(id: string, apiVersion: string): Promise<void>;
  listGroupResources(sub: string, rg: string): Promise<{ id: string; type: string }[]>;
  nested(input: NestedInput): Promise<any>;
  keyVaultSecret(vaultId: string, name: string, version?: string): Promise<string>;
  fetchJson(uri: string): Promise<any>;
  templateSpec(id: string): Promise<any>;
  operation(op: OperationRecord): Promise<void>;
  canceled(): boolean;
}

export interface NestedInput {
  name: string;
  scope: DeployScope;
  location?: string;
  properties: any;
  outer?: Env;
  parentTemplateLink?: string;
}

export interface RunInput {
  template: any;
  parameters?: Record<string, any>;
  scope: DeployScope;
  deploymentName: string;
  deploymentLocation?: string;
  mode?: 'Incremental' | 'Complete';
  host: EngineHost;
  templateLink?: any;
  outer?: Env;
}

export interface RunResult {
  outputs: Record<string, { type: string; value?: unknown }>;
  outputResources: { id: string }[];
  validatedResources: { id: string; type: string; apiVersion: string; name: string; body: any }[];
  parameters: Record<string, { type: string; value?: unknown }>;
  templateHash: string;
  providers: { namespace: string; resourceTypes: { resourceType: string; locations: string[] }[] }[];
  dependencies: any[];
}

// ============ espressioni ============

type Node =
  | { t: 'str'; v: string }
  | { t: 'num'; v: number }
  | { t: 'call'; name: string; args: Node[] }
  | { t: 'prop'; obj: Node; name: string }
  | { t: 'idx'; obj: Node; index: Node };

type Tok = { k: 'str' | 'num' | 'id' | 'p'; v: any };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === "'") {
      let s = '';
      i++;
      for (;;) {
        if (i >= src.length) throw invalid(`The language expression '${src}' is not valid: the string literal is not properly terminated.`);
        if (src[i] === "'") {
          if (src[i + 1] === "'") { s += "'"; i += 2; continue; }
          i++;
          break;
        }
        s += src[i++];
      }
      out.push({ k: 'str', v: s });
      continue;
    }
    if ('()[],.'.includes(ch)) { out.push({ k: 'p', v: ch }); i++; continue; }
    const num = /^-?\d+(\.\d+)?/.exec(src.slice(i));
    if (num && (ch !== '-' || !out.length || out[out.length - 1].k === 'p')) { out.push({ k: 'num', v: Number(num[0]) }); i += num[0].length; continue; }
    const id = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i));
    if (id) { out.push({ k: 'id', v: id[0] }); i += id[0].length; continue; }
    throw invalid(`The language expression '${src}' is not valid: unexpected character '${ch}'.`);
  }
  return out;
}

const exprCache = new Map<string, Node>();

export function parseExpression(src: string): Node {
  const hit = exprCache.get(src);
  if (hit) return hit;
  const toks = tokenize(src);
  let pos = 0;
  const peek = (v?: string) => toks[pos] && toks[pos].k === 'p' && (v === undefined || toks[pos].v === v);
  const expect = (v: string) => {
    if (!peek(v)) throw invalid(`The language expression '${src}' is not valid: expected '${v}'.`);
    pos++;
  };
  function args(): Node[] {
    expect('(');
    const out: Node[] = [];
    while (!peek(')')) {
      out.push(expr());
      if (peek(',')) pos++;
      else if (!peek(')')) throw invalid(`The language expression '${src}' is not valid: expected ',' or ')'.`);
    }
    expect(')');
    return out;
  }
  function primary(): Node {
    const tk = toks[pos++];
    if (!tk) throw invalid(`The language expression '${src}' is not valid: unexpected end.`);
    if (tk.k === 'str') return { t: 'str', v: tk.v };
    if (tk.k === 'num') return { t: 'num', v: tk.v };
    if (tk.k === 'id') {
      if (peek('(')) return { t: 'call', name: tk.v, args: args() };
      if (peek('.') && toks[pos + 1]?.k === 'id' && toks[pos + 2]?.k === 'p' && toks[pos + 2].v === '(') {
        pos++;
        const fn = toks[pos++].v;
        return { t: 'call', name: `${tk.v}.${fn}`, args: args() };
      }
      const low = tk.v.toLowerCase();
      if (low === 'true') return { t: 'call', name: 'true', args: [] };
      if (low === 'false') return { t: 'call', name: 'false', args: [] };
      if (low === 'null') return { t: 'call', name: 'null', args: [] };
      throw invalid(`The language expression '${src}' is not valid: '${tk.v}' is not a function.`);
    }
    throw invalid(`The language expression '${src}' is not valid: unexpected '${tk.v}'.`);
  }
  function expr(): Node {
    let n = primary();
    for (;;) {
      if (peek('.')) {
        pos++;
        const tk = toks[pos++];
        if (!tk || tk.k !== 'id') throw invalid(`The language expression '${src}' is not valid: expected property name.`);
        n = { t: 'prop', obj: n, name: tk.v };
      } else if (peek('[')) {
        pos++;
        const index = expr();
        expect(']');
        n = { t: 'idx', obj: n, index };
      } else break;
    }
    return n;
  }
  const node = expr();
  if (pos < toks.length) throw invalid(`The language expression '${src}' is not valid: unexpected '${toks[pos].v}'.`);
  exprCache.set(src, node);
  return node;
}

export function isExpression(v: unknown): boolean {
  return typeof v === 'string' && v.length >= 2 && v.startsWith('[') && v.endsWith(']') && !v.startsWith('[[');
}

// ============ ambiente di valutazione ============

interface Lambda { __lambda: true; params: string[]; body: Node; env: Env }

interface ResDecl {
  key: string;
  symbolic?: string;
  raw: any;
  parent?: ResDecl;
  copy?: { name: string; count: any; mode?: string; batchSize?: any };
}

interface Instance {
  decl: ResDecl;
  copyCtx: Map<string, number>;
  index: number;
  header?: { id: string; type: string; name: string; apiVersion: string; condition: boolean; existing: boolean };
  state: 'pending' | 'done' | 'skipped';
  result?: any;
  keys: Set<string>;
  extraDeps: string[];
}

export interface Env {
  t: any;
  params: Map<string, any>;
  paramTypes: Map<string, string>;
  vars: Map<string, { raw: any; state: 0 | 1 | 2; value?: any; copy?: any }>;
  fns: Map<string, any>;
  /** scope usato da resourceGroup(), resourceId()... */
  fnScope: DeployScope;
  /** scope dove vengono create le risorse */
  deployScope: DeployScope;
  host: EngineHost;
  deployment: any;
  copyCtx: Map<string, number>;
  currentLoop?: string;
  lambdaVars: Map<string, any>;
  instances: Instance[];
  udfParams?: Map<string, any>;
  phase: 'parameters' | 'variables' | 'resources' | 'outputs';
}

function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

function typeOf(v: unknown): string {
  if (v === null || v === undefined) return 'Null';
  if (Array.isArray(v)) return 'Array';
  if (typeof v === 'string') return 'String';
  if (typeof v === 'number') return Number.isInteger(v) ? 'Integer' : 'Float';
  if (typeof v === 'boolean') return 'Boolean';
  return 'Object';
}

function getPropCI(obj: any, name: string): unknown {
  if (obj === null || obj === undefined || typeof obj !== 'object') {
    throw invalid(`The language expression property '${name}' can't be evaluated, property name must be a string or the object is null.`);
  }
  if (name in obj) return obj[name];
  const low = name.toLowerCase();
  const key = Object.keys(obj).find((k) => k.toLowerCase() === low);
  if (key === undefined) {
    throw invalid(`The language expression property '${name}' doesn't exist, available properties are '${Object.keys(obj).join(', ')}'.`);
  }
  return obj[key];
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function sortKeys(v: any): any {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

function toStr(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function scopeId(s: DeployScope): string {
  if (s.level === 'resourceGroup') return `/subscriptions/${s.subscriptionId}/resourceGroups/${s.resourceGroup}`;
  if (s.level === 'subscription') return `/subscriptions/${s.subscriptionId}`;
  return '';
}

function joinIdSegments(base: string, type: string, names: string[]): string {
  const segs = type.split('/');
  const ns = segs[0];
  const types = segs.slice(1);
  const flat = names.flatMap((n) => String(n).split('/'));
  if (flat.length !== types.length) {
    throw invalid(`The template resource '${names.join('/')}' for type '${type}' has incorrect segment lengths. A nested resource type must have identical number of segments as its resource name. A root resource type must have segment length one greater than its resource name.`);
  }
  let id = `${base}/providers/${ns}`;
  for (let i = 0; i < types.length; i++) id += `/${types[i]}/${flat[i]}`;
  return id;
}

// ---------- formattazione date (.NET) ----------

function pad(n: number, w = 2) {
  return String(n).padStart(w, '0');
}

function formatDate(d: Date, fmt = 'yyyyMMddTHHmmssZ'): string {
  const std: Record<string, string> = { u: 'yyyy-MM-dd HH:mm:ssZ', s: 'yyyy-MM-ddTHH:mm:ss', d: 'M/d/yyyy', D: 'dddd, MMMM d, yyyy', o: 'yyyy-MM-ddTHH:mm:ss.fffffffZ', O: 'yyyy-MM-ddTHH:mm:ss.fffffffZ', g: 'M/d/yyyy h:mm tt', G: 'M/d/yyyy h:mm:ss tt', t: 'h:mm tt', T: 'h:mm:ss tt' };
  const f = std[fmt] ?? fmt;
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return f.replace(/yyyy|yy|MMMM|MM|M|dddd|dd|d|HH|H|hh|h|mm|m|ss|s|fffffff|fff|tt|'[^']*'/g, (tok) => {
    switch (tok) {
      case 'yyyy': return String(d.getUTCFullYear());
      case 'yy': return pad(d.getUTCFullYear() % 100);
      case 'MMMM': return months[d.getUTCMonth()];
      case 'MM': return pad(d.getUTCMonth() + 1);
      case 'M': return String(d.getUTCMonth() + 1);
      case 'dddd': return days[d.getUTCDay()];
      case 'dd': return pad(d.getUTCDate());
      case 'd': return String(d.getUTCDate());
      case 'HH': return pad(d.getUTCHours());
      case 'H': return String(d.getUTCHours());
      case 'hh': return pad(d.getUTCHours() % 12 || 12);
      case 'h': return String(d.getUTCHours() % 12 || 12);
      case 'mm': return pad(d.getUTCMinutes());
      case 'm': return String(d.getUTCMinutes());
      case 'ss': return pad(d.getUTCSeconds());
      case 's': return String(d.getUTCSeconds());
      case 'fffffff': return pad(d.getUTCMilliseconds(), 3) + '0000';
      case 'fff': return pad(d.getUTCMilliseconds(), 3);
      case 'tt': return d.getUTCHours() < 12 ? 'AM' : 'PM';
      default: return tok.slice(1, -1);
    }
  });
}

function addDuration(d: Date, iso: string): Date {
  const m = /^(-)?P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(iso);
  if (!m) throw invalid(`The duration '${iso}' is not a valid ISO 8601 duration.`);
  const s = m[1] ? -1 : 1;
  const out = new Date(d.getTime());
  out.setUTCFullYear(out.getUTCFullYear() + s * Number(m[2] ?? 0));
  out.setUTCMonth(out.getUTCMonth() + s * Number(m[3] ?? 0));
  out.setUTCDate(out.getUTCDate() + s * (Number(m[4] ?? 0) * 7 + Number(m[5] ?? 0)));
  out.setTime(out.getTime() + s * ((Number(m[6] ?? 0) * 3600 + Number(m[7] ?? 0) * 60 + Number(m[8] ?? 0)) * 1000));
  return out;
}

// ---------- CIDR ----------

function ipToInt(ip: string): number {
  return ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
}
function intToIp(n: number): string {
  return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
}
function parseCidr(cidr: string) {
  const [ip, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip) || !(bits >= 0 && bits <= 32)) throw invalid(`The CIDR '${cidr}' is not valid.`);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const network = (ipToInt(ip) & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  return { network, mask, broadcast, bits };
}

// ---------- funzioni ----------

type Fn = (args: unknown[], env: Env) => unknown | Promise<unknown>;

function str(v: unknown, fn: string): string {
  if (typeof v !== 'string') throw invalid(`The template language function '${fn}' expects its parameter to be of type 'String'. The provided value is of type '${typeOf(v)}'.`);
  return v;
}
function num(v: unknown, fn: string): number {
  if (typeof v !== 'number') throw invalid(`The template language function '${fn}' expects its parameter to be of type 'Integer'. The provided value is of type '${typeOf(v)}'.`);
  return v;
}
function arr(v: unknown, fn: string): unknown[] {
  if (!Array.isArray(v)) throw invalid(`The template language function '${fn}' expects its parameter to be of type 'Array'. The provided value is of type '${typeOf(v)}'.`);
  return v;
}

function unionValues(a: any, b: any): any {
  if (Array.isArray(a) && Array.isArray(b)) {
    const out = [...a];
    for (const x of b) if (!out.some((y) => deepEqual(x, y))) out.push(x);
    return out;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const out: any = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = k in out && out[k] && typeof out[k] === 'object' && v && typeof v === 'object' ? unionValues(out[k], v) : v;
    return out;
  }
  return b;
}

async function callLambda(l: unknown, args: unknown[]): Promise<unknown> {
  if (!l || typeof l !== 'object' || !(l as Lambda).__lambda) throw invalid('The template language function expects a lambda expression.');
  const lam = l as Lambda;
  const vars = new Map(lam.env.lambdaVars);
  lam.params.forEach((p, i) => vars.set(p.toLowerCase(), args[i]));
  return ev(lam.body, { ...lam.env, lambdaVars: vars });
}

function environmentObject(env: Env) {
  const o = env.host.origin.replace(/\/$/, '');
  return {
    name: 'AzureCloud',
    gallery: 'https://gallery.azure.com/',
    graph: 'https://graph.windows.net/',
    portal: o,
    graphAudience: 'https://graph.windows.net/',
    activeDirectoryDataLake: 'https://datalake.azure.net/',
    batch: 'https://batch.core.windows.net/',
    media: 'https://rest.media.azure.net',
    sqlManagement: 'https://management.core.windows.net:8443/',
    vmImageAliasDoc: 'https://raw.githubusercontent.com/Azure/azure-rest-api-specs/main/arm-compute/quickstart-templates/aliases.json',
    resourceManager: `${o}/`,
    authentication: { loginEndpoint: `${o}/`, audiences: ['https://management.core.windows.net/', 'https://management.azure.com/'], tenant: 'common', identityProvider: 'AAD' },
    suffixes: {
      acrLoginServer: '.azurecr.io', azureDatalakeAnalyticsCatalogAndJob: 'azuredatalakeanalytics.net', azureDatalakeStoreFileSystem: 'azuredatalakestore.net',
      azureFrontDoorEndpointSuffix: 'azurefd.net', keyvaultDns: '.vault.azure.net', sqlServerHostname: '.database.windows.net', storage: 'core.windows.net',
    },
  };
}

const FUNCS: Record<string, Fn> = {
  // ---- array / oggetti ----
  array: ([v]) => (Array.isArray(v) ? v : [v]),
  concat: (args) => {
    if (!args.length) return '';
    if (Array.isArray(args[0])) return args.flatMap((a) => (Array.isArray(a) ? a : [a]));
    return args.map(toStr).join('');
  },
  contains: ([c, item]) => {
    if (typeof c === 'string') return c.includes(toStr(item));
    if (Array.isArray(c)) return c.some((x) => deepEqual(x, item));
    if (c && typeof c === 'object') return Object.keys(c).some((k) => k.toLowerCase() === toStr(item).toLowerCase());
    return false;
  },
  createarray: (args) => [...args],
  createobject: (args) => {
    if (args.length % 2) throw invalid("The template language function 'createObject' must have an even number of parameters.");
    const o: any = {};
    for (let i = 0; i < args.length; i += 2) o[str(args[i], 'createObject')] = args[i + 1];
    return o;
  },
  empty: ([v]) => v === null || v === undefined || (typeof v === 'string' && !v.length) || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v as object).length),
  first: ([v]) => (typeof v === 'string' ? v.slice(0, 1) : Array.isArray(v) ? (v.length ? v[0] : null) : null),
  last: ([v]) => (typeof v === 'string' ? v.slice(-1) : Array.isArray(v) ? (v.length ? v[v.length - 1] : null) : null),
  flatten: ([v]) => arr(v, 'flatten').flatMap((x) => (Array.isArray(x) ? x : [x])),
  indexof: ([c, item]) => (typeof c === 'string' ? c.toLowerCase().indexOf(toStr(item).toLowerCase()) : arr(c, 'indexOf').findIndex((x) => deepEqual(x, item))),
  lastindexof: ([c, item]) => (typeof c === 'string' ? c.toLowerCase().lastIndexOf(toStr(item).toLowerCase()) : (() => { const a = arr(c, 'lastIndexOf'); for (let i = a.length - 1; i >= 0; i--) if (deepEqual(a[i], item)) return i; return -1; })()),
  intersection: (args) => {
    if (Array.isArray(args[0])) return (args[0] as unknown[]).filter((x, i, self) => self.findIndex((y) => deepEqual(x, y)) === i && args.slice(1).every((a) => arr(a, 'intersection').some((y) => deepEqual(x, y))));
    const first = args[0] as Record<string, unknown>;
    const out: any = {};
    for (const [k, v] of Object.entries(first ?? {})) if (args.slice(1).every((o: any) => o && k in o && deepEqual(o[k], v))) out[k] = v;
    return out;
  },
  union: (args) => args.reduce((a, b) => unionValues(a, b)),
  items: ([o]) => Object.keys((o as object) ?? {}).sort((a, b) => a.localeCompare(b)).map((k) => ({ key: k, value: (o as any)[k] })),
  length: ([v]) => (typeof v === 'string' || Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : (() => { throw invalid("The template language function 'length' expects its parameter to be an array, object, or a string."); })()),
  max: (args) => Math.max(...(args.length === 1 && Array.isArray(args[0]) ? (args[0] as number[]) : (args as number[]))),
  min: (args) => Math.min(...(args.length === 1 && Array.isArray(args[0]) ? (args[0] as number[]) : (args as number[]))),
  range: ([start, count]) => Array.from({ length: num(count, 'range') }, (_, i) => num(start, 'range') + i),
  skip: ([v, n]) => (typeof v === 'string' ? v.slice(Math.max(0, num(n, 'skip'))) : arr(v, 'skip').slice(Math.max(0, num(n, 'skip')))),
  take: ([v, n]) => (typeof v === 'string' ? v.slice(0, Math.max(0, num(n, 'take'))) : arr(v, 'take').slice(0, Math.max(0, num(n, 'take')))),
  objectkeys: ([o]) => Object.keys((o as object) ?? {}),
  shallowmerge: ([a]) => Object.assign({}, ...arr(a, 'shallowMerge') as object[]),
  tryget: (args) => {
    let cur: any = args[0];
    for (const k of args.slice(1)) {
      if (cur === null || cur === undefined) return null;
      if (typeof k === 'number') cur = Array.isArray(cur) ? cur[k] : null;
      else if (typeof cur === 'object') {
        const key = Object.keys(cur).find((x) => x.toLowerCase() === String(k).toLowerCase());
        cur = key === undefined ? null : cur[key];
      } else return null;
    }
    return cur ?? null;
  },
  json: ([s]) => { try { return JSON.parse(str(s, 'json')); } catch { throw invalid(`The template language function 'json' parameter is not valid. The provided value '${s}' cannot be parsed.`); } },
  null: () => null,
  // ---- confronto / logica ----
  coalesce: (args) => args.find((a) => a !== null && a !== undefined) ?? null,
  equals: ([a, b]) => deepEqual(a, b),
  greater: ([a, b]) => (a as any) > (b as any),
  greaterorequals: ([a, b]) => (a as any) >= (b as any),
  less: ([a, b]) => (a as any) < (b as any),
  lessorequals: ([a, b]) => (a as any) <= (b as any),
  not: ([v]) => !v,
  bool: ([v]) => (typeof v === 'string' ? v.toLowerCase() === 'true' : !!v),
  true: () => true,
  false: () => false,
  // ---- numeri ----
  add: ([a, b]) => num(a, 'add') + num(b, 'add'),
  sub: ([a, b]) => num(a, 'sub') - num(b, 'sub'),
  mul: ([a, b]) => num(a, 'mul') * num(b, 'mul'),
  div: ([a, b]) => { if (num(b, 'div') === 0) throw invalid("The template language function 'div' cannot divide by zero."); return Math.trunc(num(a, 'div') / (b as number)); },
  mod: ([a, b]) => num(a, 'mod') % num(b, 'mod'),
  int: ([v]) => { const n = typeof v === 'number' ? Math.trunc(v) : parseInt(toStr(v), 10); if (Number.isNaN(n)) throw invalid(`The template language function 'int' was invoked with a parameter that is not valid. The value cannot be converted to the target type.`); return n; },
  float: ([v]) => Number(v),
  // ---- stringhe ----
  base64: ([s]) => Buffer.from(str(s, 'base64'), 'utf8').toString('base64'),
  base64tostring: ([s]) => Buffer.from(str(s, 'base64ToString'), 'base64').toString('utf8'),
  base64tojson: ([s]) => JSON.parse(Buffer.from(str(s, 'base64ToJson'), 'base64').toString('utf8')),
  datauri: ([s]) => `data:text/plain;charset=utf8;base64,${Buffer.from(toStr(s)).toString('base64')}`,
  datauritostring: ([s]) => Buffer.from(str(s, 'dataUriToString').split(',')[1] ?? '', 'base64').toString('utf8'),
  endswith: ([s, t]) => str(s, 'endsWith').toLowerCase().endsWith(str(t, 'endsWith').toLowerCase()),
  startswith: ([s, t]) => str(s, 'startsWith').toLowerCase().startsWith(str(t, 'startsWith').toLowerCase()),
  format: ([fmt, ...args]) => str(fmt, 'format').replace(/\{\{|\}\}|\{(\d+)(?::([^}]*))?\}/g, (m, i, spec) => {
    if (m === '{{') return '{';
    if (m === '}}') return '}';
    const v = args[Number(i)];
    if (spec && typeof v === 'number') {
      const d = /^D(\d+)$/i.exec(spec);
      if (d) return String(Math.trunc(v)).padStart(Number(d[1]), '0');
      const x = /^X(\d*)$/.exec(spec) ?? /^x(\d*)$/.exec(spec);
      if (x) { const h = Math.trunc(v).toString(16); return (spec[0] === 'X' ? h.toUpperCase() : h).padStart(Number(x[1] || 0), '0'); }
      const n = /^N(\d*)$/i.exec(spec);
      if (n) return v.toLocaleString('en-US', { minimumFractionDigits: Number(n[1] || 2), maximumFractionDigits: Number(n[1] || 2) });
    }
    return toStr(v);
  }),
  guid: (args) => uuidV5(args.map(toStr).join('-'), '11fb06fb-712d-4ddd-98c7-e71bbd588830'),
  newguid: () => randomUUID(),
  padleft: ([v, total, ch]) => toStr(v).padStart(num(total, 'padLeft'), ch === undefined ? ' ' : toStr(ch).slice(0, 1)),
  replace: ([s, a, b]) => str(s, 'replace').split(toStr(a)).join(toStr(b)),
  split: ([s, d]) => {
    const delims = Array.isArray(d) ? d.map(toStr) : [toStr(d)];
    let parts = [str(s, 'split')];
    for (const dl of delims) parts = parts.flatMap((p) => p.split(dl));
    return parts;
  },
  string: ([v]) => toStr(v),
  substring: ([s, start, len]) => {
    const t = str(s, 'substring');
    const st = num(start ?? 0, 'substring');
    const l = len === undefined ? t.length - st : num(len, 'substring');
    if (st < 0 || st > t.length || l < 0 || st + l > t.length) throw invalid(`The index and length parameters must refer to a location within the string. The index parameter: '${st}', the length parameter: '${l}', the length of the string parameter: '${t.length}'.`);
    return t.substr(st, l);
  },
  tolower: ([s]) => toStr(s).toLowerCase(),
  toupper: ([s]) => toStr(s).toUpperCase(),
  trim: ([s]) => toStr(s).trim(),
  uniquestring: (args) => uniqueString(...args.map(toStr)),
  uri: ([base, rel]) => new URL(toStr(rel), toStr(base)).toString(),
  uricomponent: ([s]) => encodeURIComponent(toStr(s)),
  uricomponenttostring: ([s]) => decodeURIComponent(toStr(s)),
  join: ([a, d]) => arr(a, 'join').map(toStr).join(toStr(d)),
  // ---- date ----
  utcnow: ([fmt]) => formatDate(new Date(), fmt === undefined ? undefined : toStr(fmt)),
  datetimeadd: ([base, dur, fmt]) => {
    const d = addDuration(new Date(str(base, 'dateTimeAdd')), str(dur, 'dateTimeAdd'));
    return fmt === undefined ? d.toISOString().replace(/\.\d{3}Z$/, 'Z') : formatDate(d, toStr(fmt));
  },
  datetimefromepoch: ([n]) => new Date(num(n, 'dateTimeFromEpoch') * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  datetimetoepoch: ([s]) => Math.floor(new Date(str(s, 'dateTimeToEpoch')).getTime() / 1000),
  // ---- CIDR ----
  parsecidr: ([c]) => {
    const p = parseCidr(str(c, 'parseCidr'));
    return { network: intToIp(p.network), netmask: intToIp(p.mask), broadcast: intToIp(p.broadcast), firstUsable: intToIp(p.bits >= 31 ? p.network : p.network + 1), lastUsable: intToIp(p.bits >= 31 ? p.broadcast : p.broadcast - 1), cidr: p.bits };
  },
  cidrsubnet: ([c, newBits, index]) => {
    const p = parseCidr(str(c, 'cidrSubnet'));
    const nb = num(newBits, 'cidrSubnet');
    if (nb < p.bits || nb > 32) throw invalid(`The new CIDR '${nb}' must be between ${p.bits} and 32.`);
    const size = 2 ** (32 - nb);
    const net = p.network + num(index, 'cidrSubnet') * size;
    if (net + size - 1 > p.broadcast) throw invalid(`The index '${index}' is out of range for subnet '/${nb}' in '${c}'.`);
    return `${intToIp(net >>> 0)}/${nb}`;
  },
  cidrhost: ([c, index]) => {
    const p = parseCidr(str(c, 'cidrHost'));
    const ip = p.network + 1 + num(index, 'cidrHost');
    if (ip >= p.broadcast) throw invalid(`The host index '${index}' is out of range for '${c}'.`);
    return intToIp(ip >>> 0);
  },
  // ---- lambda ----
  filter: async ([a, l]) => { const out = []; for (const [i, x] of arr(a, 'filter').entries()) if (await callLambda(l, [x, i])) out.push(x); return out; },
  map: async ([a, l]) => { const out = []; for (const [i, x] of arr(a, 'map').entries()) out.push(await callLambda(l, [x, i])); return out; },
  reduce: async ([a, init, l]) => { let acc = init; for (const [i, x] of arr(a, 'reduce').entries()) acc = await callLambda(l, [acc, x, i]); return acc; },
  sort: async ([a, l]) => {
    const items = [...arr(a, 'sort')];
    for (let i = 1; i < items.length; i++) {
      const cur = items[i];
      let j = i - 1;
      while (j >= 0 && (await callLambda(l, [cur, items[j]]))) { items[j + 1] = items[j]; j--; }
      items[j + 1] = cur;
    }
    return items;
  },
  toobject: async ([a, kl, vl]) => { const o: any = {}; for (const x of arr(a, 'toObject')) o[toStr(await callLambda(kl, [x]))] = vl === undefined ? x : await callLambda(vl, [x]); return o; },
  groupby: async ([a, l]) => { const o: any = {}; for (const x of arr(a, 'groupBy')) { const k = toStr(await callLambda(l, [x])); (o[k] ??= []).push(x); } return o; },
  mapvalues: async ([obj, l]) => { const o: any = {}; for (const [k, v] of Object.entries((obj as object) ?? {})) o[k] = await callLambda(l, [v]); return o; },
  lambdavariables: ([n], env) => {
    const k = toStr(n).toLowerCase();
    if (!env.lambdaVars.has(k)) throw invalid(`The lambda variable '${n}' is not defined.`);
    return env.lambdaVars.get(k);
  },
  // ---- deployment ----
  parameters: ([n], env) => {
    const k = str(n, 'parameters').toLowerCase();
    if (env.udfParams) {
      if (!env.udfParams.has(k)) throw invalid(`The function parameter '${n}' is not defined.`);
      return env.udfParams.get(k);
    }
    if (!env.params.has(k)) throw invalid(`The template parameter '${n}' is not found. Please see https://aka.ms/arm-syntax-parameters for usage details.`);
    return env.params.get(k);
  },
  variables: async ([n], env) => getVariable(env, str(n, 'variables')),
  deployment: (_a, env) => env.deployment,
  environment: (_a, env) => environmentObject(env),
  copyindex: (args, env) => {
    let loop: string | undefined;
    let offset = 0;
    if (typeof args[0] === 'string') { loop = args[0]; offset = Number(args[1] ?? 0); } else if (typeof args[0] === 'number') offset = args[0];
    const name = (loop ?? env.currentLoop)?.toLowerCase();
    if (!name || !env.copyCtx.has(name)) throw invalid(`The template function 'copyIndex' is not expected at this location. ${loop ? `The copy loop '${loop}' was not found.` : 'The function can only be used within a resource or property copy loop.'}`);
    return env.copyCtx.get(name)! + offset;
  },
  // ---- scope ----
  resourcegroup: async (_a, env) => {
    const s = env.fnScope;
    if (s.level !== 'resourceGroup') throw invalid("The template function 'RESOURCEGROUP' is not expected at this location. Please see https://aka.ms/arm-functions-resource for usage details.");
    const rg = await env.host.getResourceGroup(s.subscriptionId!, s.resourceGroup!);
    if (!rg) throw new TemplateError('ResourceGroupNotFound', `Resource group '${s.resourceGroup}' could not be found.`);
    return { id: rg.id, name: rg.name, type: 'Microsoft.Resources/resourceGroups', location: rg.location, ...(rg.managedBy ? { managedBy: rg.managedBy } : {}), tags: rg.tags ?? {}, properties: { provisioningState: 'Succeeded' } };
  },
  subscription: async (_a, env) => {
    const s = env.fnScope;
    if (!s.subscriptionId) throw invalid("The template function 'SUBSCRIPTION' is not expected at this location.");
    const sub = await env.host.getSubscription(s.subscriptionId);
    return { id: `/subscriptions/${s.subscriptionId}`, subscriptionId: s.subscriptionId, tenantId: env.host.tenantId, displayName: sub?.displayName ?? s.subscriptionId };
  },
  tenant: (_a, env) => ({ countryCode: 'IT', displayName: 'Azzurro', id: `/tenants/${env.host.tenantId}`, tenantId: env.host.tenantId }),
  managementgroup: () => { throw invalid('Management groups are not supported by Azzurro.'); },
  resourceid: (args, env) => {
    const a = args.map(toStr);
    const ti = a.findIndex((x) => x.includes('/') && x.split('/')[0].includes('.'));
    if (ti < 0) throw invalid("Unable to evaluate template language function 'resourceId': function requires a resource type argument.");
    const before = a.slice(0, ti);
    let sub = env.fnScope.subscriptionId;
    let rg = env.fnScope.level === 'resourceGroup' ? env.fnScope.resourceGroup : undefined;
    if (before.length >= 2) { sub = before[0]; rg = before[1]; } else if (before.length === 1) rg = before[0];
    const base = rg ? `/subscriptions/${sub}/resourceGroups/${rg}` : sub ? `/subscriptions/${sub}` : '';
    return joinIdSegments(base, a[ti], a.slice(ti + 1));
  },
  subscriptionresourceid: (args, env) => {
    const a = args.map(toStr);
    const ti = a.findIndex((x) => x.includes('/') && x.split('/')[0].includes('.'));
    const sub = ti === 1 ? a[0] : env.fnScope.subscriptionId;
    return joinIdSegments(`/subscriptions/${sub}`, a[ti], a.slice(ti + 1));
  },
  tenantresourceid: (args) => {
    const a = args.map(toStr);
    return joinIdSegments('', a[0], a.slice(1));
  },
  extensionresourceid: (args) => {
    const a = args.map(toStr);
    return joinIdSegments(a[0].replace(/\/$/, ''), a[1], a.slice(2));
  },
  managementgroupresourceid: (args) => {
    const a = args.map(toStr);
    return joinIdSegments('', a[a.length > 2 && !a[0].includes('/') ? 1 : 0], a.slice(a.length > 2 && !a[0].includes('/') ? 2 : 1));
  },
  pickzones: ([, , , count]) => (count === undefined ? ['1'] : Array.from({ length: Number(count) }, (_, i) => String(i + 1))),
  providers: ([ns, type]) => {
    const types = TYPES.filter((t) => t.type.split('/')[0].toLowerCase() === toStr(ns).toLowerCase() && (!type || t.type.split('/').slice(1).join('/').toLowerCase() === toStr(type).toLowerCase()));
    const rt = types.map((t) => ({ resourceType: t.type.split('/').slice(1).join('/'), locations: LOCATIONS.map((l) => l.displayName), apiVersions: t.apiVersions }));
    return type ? rt[0] ?? null : { namespace: ns, resourceTypes: rt };
  },
  reference: async (args, env) => reference(env, args),
  references: async (args, env) => {
    const sym = toStr(args[0]).toLowerCase();
    const insts = env.instances.filter((i) => i.decl.symbolic?.toLowerCase() === sym);
    const out = [];
    for (const i of insts) out.push(await referenceInstance(env, i, toStr(args[1] ?? '').toLowerCase() === 'full'));
    return out;
  },
  resourceinfo: ([sym], env) => {
    const inst = env.instances.find((i) => i.decl.symbolic?.toLowerCase() === toStr(sym).toLowerCase());
    if (!inst?.header) throw new Pending(toStr(sym));
    return { id: inst.header.id, name: inst.header.name, type: inst.header.type, apiVersion: inst.header.apiVersion };
  },
};

async function getVariable(env: Env, name: string): Promise<unknown> {
  const k = name.toLowerCase();
  const v = env.vars.get(k);
  if (!v) throw invalid(`The template variable '${name}' is not found. Please see https://aka.ms/arm-syntax-variables for usage details.`);
  if (v.state === 2) return v.value;
  if (v.state === 1) throw invalid(`The template variable '${name}' has a circular reference.`);
  v.state = 1;
  try {
    const venv: Env = { ...env, phase: env.phase === 'parameters' ? 'variables' : env.phase, udfParams: undefined };
    if (v.copy) {
      const count = Number(await evalValue(v.copy.count, venv));
      const out = [];
      for (let i = 0; i < count; i++) {
        const cc = new Map(venv.copyCtx);
        cc.set(String(v.copy.name).toLowerCase(), i);
        out.push(await evalValue(v.copy.input, { ...venv, copyCtx: cc, currentLoop: String(v.copy.name).toLowerCase() }));
      }
      v.value = out;
    } else {
      v.value = await evalValue(v.raw, venv);
    }
    v.state = 2;
    return v.value;
  } catch (e) {
    v.state = 0;
    throw e;
  }
}

async function ev(node: Node, env: Env): Promise<unknown> {
  switch (node.t) {
    case 'str': return node.v;
    case 'num': return node.v;
    case 'prop': {
      const o = await ev(node.obj, env);
      return getPropCI(o, node.name);
    }
    case 'idx': {
      const o: any = await ev(node.obj, env);
      const i = await ev(node.index, env);
      if (Array.isArray(o)) {
        if (typeof i !== 'number') throw invalid('The language expression array index must be an integer.');
        if (i < 0 || i >= o.length) throw invalid(`The language expression property array index '${i}' is out of bounds.`);
        return o[i];
      }
      return getPropCI(o, toStr(i));
    }
    case 'call': {
      const name = node.name.toLowerCase();
      // funzioni lazy
      if (name === 'if') {
        if (node.args.length !== 3) throw invalid("The template language function 'if' must have three parameters.");
        return (await ev(node.args[0], env)) ? ev(node.args[1], env) : ev(node.args[2], env);
      }
      if (name === 'and') {
        for (const a of node.args) if (!(await ev(a, env))) return false;
        return true;
      }
      if (name === 'or') {
        for (const a of node.args) if (await ev(a, env)) return true;
        return false;
      }
      if (name === 'lambda') {
        const params = [];
        for (const a of node.args.slice(0, -1)) params.push(toStr(await ev(a, env)));
        return { __lambda: true, params, body: node.args[node.args.length - 1], env } satisfies Lambda;
      }
      const args = [];
      for (const a of node.args) args.push(await ev(a, env));
      if (name.includes('.')) return callUserFunction(env, name, args);
      if (name.startsWith('list') && !FUNCS[name]) return listFunction(env, node.name, args);
      const fn = FUNCS[name];
      if (!fn) throw invalid(`The template function '${node.name}' is not valid. Please see https://aka.ms/arm-functions for usage details.`);
      return fn(args, env);
    }
  }
}

async function callUserFunction(env: Env, name: string, args: unknown[]) {
  const f = env.fns.get(name);
  if (!f) throw invalid(`The template function '${name}' is not valid. Please see https://aka.ms/arm-functions for usage details.`);
  const params = new Map<string, unknown>();
  (f.parameters ?? []).forEach((p: any, i: number) => params.set(String(p.name).toLowerCase(), args[i]));
  return evalValue(f.output?.value, { ...env, udfParams: params, lambdaVars: new Map() });
}

export async function evalString(s: string, env: Env): Promise<unknown> {
  if (isExpression(s)) {
    try {
      return await ev(parseExpression(s.slice(1, -1)), env);
    } catch (e) {
      if (e instanceof Pending || (e instanceof TemplateError && e.code !== 'InvalidTemplate')) throw e;
      if (e instanceof TemplateError) throw e;
      throw invalid(`Unable to evaluate template language expression '${s}': ${(e as Error).message}`);
    }
  }
  if (s.startsWith('[[')) return s.slice(1);
  return s;
}

export async function evalValue(v: unknown, env: Env): Promise<any> {
  if (typeof v === 'string') return evalString(v, env);
  if (Array.isArray(v)) {
    const out = [];
    for (const x of v) out.push(await evalValue(x, env));
    return out;
  }
  if (v && typeof v === 'object') {
    const o: any = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === 'copy' && Array.isArray(val) && val.every((c: any) => c && typeof c === 'object' && 'name' in c && 'input' in c)) {
        for (const c of val as any[]) {
          const count = Number(await evalValue(c.count, env));
          const items = [];
          for (let i = 0; i < count; i++) {
            const cc = new Map(env.copyCtx);
            cc.set(String(c.name).toLowerCase(), i);
            items.push(await evalValue(c.input, { ...env, copyCtx: cc, currentLoop: String(c.name).toLowerCase() }));
          }
          o[c.name] = items;
        }
        continue;
      }
      const key = isExpression(k) ? toStr(await evalString(k, env)) : k;
      o[key] = await evalValue(val, env);
    }
    return o;
  }
  return v;
}

// ============ reference / list ============

function findInstance(env: Env, target: string): Instance | undefined {
  const t = target.toLowerCase();
  const bySym = env.instances.filter((i) => i.decl.symbolic?.toLowerCase() === t);
  if (bySym.length === 1) return bySym[0];
  return env.instances.find((i) => i.keys.has(t));
}

async function referenceInstance(env: Env, inst: Instance, full: boolean): Promise<unknown> {
  if (inst.state === 'pending') throw new Pending(inst.header?.id ?? inst.decl.key);
  if (inst.state === 'skipped') throw invalid(`The template resource '${inst.header?.name ?? inst.decl.key}' is not found. The resource was not deployed because its condition evaluated to false.`);
  const r = inst.result;
  if (full) return { ...r, apiVersion: inst.header?.apiVersion };
  return r?.properties ?? {};
}

async function reference(env: Env, args: unknown[]): Promise<unknown> {
  const target = toStr(args[0]);
  const full = toStr(args[2] ?? args[1] ?? '').toLowerCase() === 'full';
  const inst = findInstance(env, target);
  if (inst) return referenceInstance(env, inst, full);
  let id = target;
  if (!id.startsWith('/')) {
    throw invalid(`The template resource '${target}' is not found. Please see https://aka.ms/arm-syntax-resources for usage details.`);
  }
  const r = await env.host.get(id, typeof args[1] === 'string' && args[1].toLowerCase() !== 'full' ? args[1] : undefined);
  if (!r) throw new TemplateError('ResourceNotFound', `The Resource '${id}' was not found.`);
  return full ? r : r.properties ?? {};
}

async function listFunction(env: Env, fnName: string, args: unknown[]): Promise<unknown> {
  const target = toStr(args[0]);
  const inst = findInstance(env, target);
  let id = target;
  if (inst) {
    if (inst.state === 'pending') throw new Pending(inst.header?.id ?? target);
    id = inst.header!.id;
  }
  if (!id.startsWith('/')) throw invalid(`The template function '${fnName}' requires a resource ID.`);
  return env.host.action(id, fnName, toStr(args[1] ?? ''), args[2]);
}

// ============ parametri ============

function resolveType(def: any, t: any): { type: string; nullable: boolean; def: any } {
  let cur = def;
  let guard = 0;
  while (cur?.$ref && guard++ < 20) {
    const name = String(cur.$ref).replace('#/definitions/', '');
    const target = t.definitions?.[name];
    if (!target) break;
    cur = { ...target, ...Object.fromEntries(Object.entries(cur).filter(([k]) => k !== '$ref')) };
  }
  return { type: String(cur?.type ?? 'object').toLowerCase(), nullable: !!cur?.nullable, def: cur };
}

function checkType(name: string, type: string, v: unknown) {
  if (v === null) return;
  const ok = (type === 'string' || type === 'securestring') ? typeof v === 'string'
    : type === 'int' ? typeof v === 'number' && Number.isInteger(v)
    : type === 'bool' ? typeof v === 'boolean'
    : type === 'array' ? Array.isArray(v)
    : type === 'object' || type === 'secureobject' ? typeof v === 'object' && !Array.isArray(v)
    : true;
  if (!ok) throw invalid(`Template parameter '${name}' was provided an invalid value. Expected a value of type '${type === 'securestring' ? 'String' : type === 'int' ? 'Integer' : type === 'bool' ? 'Boolean' : type[0].toUpperCase() + type.slice(1)}', but received a value of type '${typeOf(v)}'.`);
}

function normalizeParameterValues(input: Record<string, any> | undefined): Record<string, any> {
  if (!input) return {};
  if (input.$schema && input.parameters && typeof input.parameters === 'object') return input.parameters;
  return input;
}

async function initParameters(env: Env, provided: Record<string, any>) {
  const t = env.t;
  const defs: Record<string, any> = t.parameters ?? {};
  const providedLower = new Map(Object.entries(provided).map(([k, v]) => [k.toLowerCase(), { k, v }]));
  const declared = new Set(Object.keys(defs).map((k) => k.toLowerCase()));
  const extra = [...providedLower.values()].filter((p) => !declared.has(p.k.toLowerCase())).map((p) => p.k);
  if (extra.length) throw invalid(`The template parameters '${extra.join(', ')}' in the parameters file are not valid; they are not present in the original template and can therefore not be provided at deployment time. The only supported parameters for this template are '${Object.keys(defs).join(', ')}'. Please see https://aka.ms/arm-pass-parameter-values for usage details.`);
  for (const [name, rawDef] of Object.entries(defs)) {
    const { type, nullable, def } = resolveType(rawDef, t);
    env.paramTypes.set(name.toLowerCase(), type);
    const p = providedLower.get(name.toLowerCase())?.v;
    let value: unknown;
    if (p !== undefined) {
      if (p && typeof p === 'object' && 'reference' in p && p.reference?.keyVault) {
        value = await env.host.keyVaultSecret(p.reference.keyVault.id, p.reference.secretName, p.reference.secretVersion);
      } else if (p && typeof p === 'object' && 'value' in p) {
        value = p.value;
      } else {
        value = p;
      }
    } else if (def?.defaultValue !== undefined) {
      value = await evalValue(def.defaultValue, { ...env, phase: 'parameters' });
    } else if (nullable) {
      value = null;
    } else {
      throw invalid(`Deployment template validation failed: 'The value for the template parameter '${name}' at line '1' and column '1' is not provided. Please see https://aka.ms/arm-create-parameter-file for usage details.'.`);
    }
    checkType(name, type, value);
    if (Array.isArray(def?.allowedValues) && value !== null) {
      const vals = Array.isArray(value) && type === 'array' ? value : [value];
      for (const v of vals) if (!def.allowedValues.some((a: unknown) => deepEqual(a, v))) throw invalid(`Deployment template validation failed: 'The provided value '${toStr(v)}' for the template parameter '${name}' is not valid. The parameter value is not part of the allowed value(s): '${def.allowedValues.map(toStr).join(',')}'.'.`);
    }
    if (typeof value === 'number') {
      if (def?.minValue !== undefined && value < def.minValue) throw invalid(`The provided value '${value}' for the template parameter '${name}' is not valid. The value must be greater than or equal to '${def.minValue}'.`);
      if (def?.maxValue !== undefined && value > def.maxValue) throw invalid(`The provided value '${value}' for the template parameter '${name}' is not valid. The value must be less than or equal to '${def.maxValue}'.`);
    }
    if ((typeof value === 'string' || Array.isArray(value)) && value !== null) {
      if (def?.minLength !== undefined && value.length < def.minLength) throw invalid(`The provided value for the template parameter '${name}' is not valid. Length of the value should be greater than or equal to '${def.minLength}'.`);
      if (def?.maxLength !== undefined && value.length > def.maxLength) throw invalid(`The provided value for the template parameter '${name}' is not valid. Length of the value should be less than or equal to '${def.maxLength}'.`);
    }
    env.params.set(name.toLowerCase(), value);
  }
}

// ============ risorse ============

function normalizeResources(t: any): ResDecl[] {
  const out: ResDecl[] = [];
  const add = (raw: any, key: string, symbolic?: string, parent?: ResDecl) => {
    const d: ResDecl = { key, symbolic, raw, parent, copy: raw.copy };
    out.push(d);
    (raw.resources ?? []).forEach((child: any, i: number) => add(child, `${key}/${i}`, undefined, d));
  };
  if (Array.isArray(t.resources)) t.resources.forEach((r: any, i: number) => add(r, `#${i}`));
  else if (t.resources && typeof t.resources === 'object') for (const [sym, r] of Object.entries(t.resources)) add(r, sym, sym);
  return out;
}

function deployScopeFor(level: DeployScope['level'], sub?: string, rg?: string): DeployScope {
  return { level, subscriptionId: sub, resourceGroup: rg };
}

function templateLevel(t: any): DeployScope['level'] {
  const s = String(t.$schema ?? '').toLowerCase();
  if (s.includes('subscriptiondeploymenttemplate')) return 'subscription';
  if (s.includes('tenantdeploymenttemplate')) return 'tenant';
  if (s.includes('managementgroupdeploymenttemplate')) return 'managementGroup';
  return 'resourceGroup';
}

export function templateScopeLevel(t: any): DeployScope['level'] {
  return templateLevel(t);
}

async function computeHeader(env: Env, inst: Instance): Promise<void> {
  const raw = inst.decl.raw;
  const ienv = instanceEnv(env, inst);
  const condition = raw.condition === undefined ? true : !!(await evalValue(raw.condition, ienv));
  let type: string = toStr(await evalValue(raw.type, ienv));
  let name: string = toStr(await evalValue(raw.name, ienv));
  const apiVersion = toStr(await evalValue(raw.apiVersion ?? '', ienv));
  // risorse figlie annidate (1.0)
  if (inst.decl.parent) {
    const p = env.instances.find((x) => x.decl === inst.decl.parent && x.index === 0) ?? env.instances.find((x) => x.decl === inst.decl.parent);
    if (!p?.header) await computeHeader(env, p!);
    if (!type.includes('/') || !type.split('/')[0].includes('.')) type = `${p!.header!.type}/${type}`;
    if (name.split('/').length < type.split('/').length - 1) name = `${p!.header!.name}/${name}`;
    inst.extraDeps.push(p!.header!.id.toLowerCase());
  }
  let id: string;
  const lowType = type.toLowerCase();
  const target = await targetScopeOf(env, ienv, raw);
  const base = scopeId(target);
  if (lowType === 'microsoft.resources/deployments') {
    id = `${base}/providers/Microsoft.Resources/deployments/${name}`;
  } else if (lowType === 'microsoft.resources/resourcegroups') {
    const sub = target.subscriptionId ?? env.deployScope.subscriptionId;
    id = `/subscriptions/${sub}/resourceGroups/${name}`;
  } else if (raw.scope !== undefined) {
    let sc = toStr(await evalValue(raw.scope, ienv));
    const symInst = env.instances.find((i) => i.decl.symbolic && i.decl.symbolic.toLowerCase() === sc.toLowerCase());
    if (symInst) {
      if (!symInst.header) await computeHeader(env, symInst);
      sc = symInst.header!.id;
    } else if (!sc.startsWith('/')) {
      // forma relativa "Microsoft.Storage/storageAccounts/nome" nello scope corrente
      const segs = sc.split('/');
      sc = joinIdSegments(scopeId(env.deployScope), segs.slice(0, Math.ceil(segs.length / 2)).join('/'), segs.slice(Math.ceil(segs.length / 2)));
    }
    id = joinIdSegments(sc.replace(/\/$/, ''), type, name.split('/'));
  } else if (lowType.includes('/providers/')) {
    // vecchio stile: Microsoft.Storage/storageAccounts/providers/roleAssignments con nome "acct/Microsoft.Authorization/guid"
    const [baseType, extType] = type.split(/\/providers\//i);
    const nameSegs = name.split('/');
    const baseCount = baseType.split('/').length - 1;
    const baseId = joinIdSegments(base, baseType, nameSegs.slice(0, baseCount));
    const extNs = nameSegs[baseCount];
    id = joinIdSegments(baseId, `${extNs}/${extType}`, nameSegs.slice(baseCount + 1));
    type = `${extNs}/${extType}`;
  } else {
    id = joinIdSegments(base, type, name.split('/'));
  }
  inst.header = { id, type, name, apiVersion, condition, existing: raw.existing === true };
  const keys = inst.keys;
  keys.add(id.toLowerCase());
  keys.add(`${type}/${name}`.toLowerCase());
  keys.add(name.toLowerCase());
  if (inst.decl.symbolic) keys.add(inst.decl.symbolic.toLowerCase());
  if (inst.decl.copy?.name) keys.add(String(inst.decl.copy.name).toLowerCase());
}

async function targetScopeOf(env: Env, ienv: Env, raw: any): Promise<DeployScope> {
  const isDeployment = String(raw.type ?? '').toLowerCase() === 'microsoft.resources/deployments';
  if (!isDeployment && String(raw.type ?? '').toLowerCase() !== 'microsoft.resources/resourcegroups') return env.deployScope;
  const sub = raw.subscriptionId !== undefined ? toStr(await evalValue(raw.subscriptionId, ienv)) : undefined;
  const rg = raw.resourceGroup !== undefined ? toStr(await evalValue(raw.resourceGroup, ienv)) : undefined;
  if (!isDeployment) return deployScopeFor('subscription', sub ?? env.deployScope.subscriptionId);
  if (raw.scope !== undefined) {
    const sc = toStr(await evalValue(raw.scope, ienv));
    if (/managementgroups/i.test(sc)) throw invalid('Management group scoped deployments are not supported by Azzurro.');
    if (sc === '/' || sc === '') return deployScopeFor('tenant');
    const m = /^\/subscriptions\/([^/]+)(?:\/resourceGroups\/([^/]+))?$/i.exec(sc);
    if (m) return m[2] ? deployScopeFor('resourceGroup', m[1], m[2]) : deployScopeFor('subscription', m[1]);
  }
  if (rg) return deployScopeFor('resourceGroup', sub ?? env.deployScope.subscriptionId, rg);
  if (sub) return deployScopeFor('subscription', sub);
  return env.deployScope;
}

function instanceEnv(env: Env, inst: Instance): Env {
  const cc = new Map(env.copyCtx);
  for (const [k, v] of inst.copyCtx) cc.set(k, v);
  return { ...env, copyCtx: cc, currentLoop: inst.decl.copy ? String(inst.decl.copy.name).toLowerCase() : env.currentLoop };
}

const SKIP_BODY_KEYS = new Set(['type', 'apiVersion', 'name', 'dependsOn', 'condition', 'copy', 'comments', 'resources', 'scope', 'existing', 'metadata', 'import', 'asserts', 'subscriptionId', 'resourceGroup', 'parent']);

function opRecord(inst: Instance, ok: boolean, statusCode: string, started: number, message?: any): OperationRecord {
  const h = inst.header!;
  const ms = Date.now() - started;
  return {
    operationId: uniqueString(h.id, String(started)).toUpperCase(),
    provisioningOperation: h.existing ? 'Read' : 'Create',
    provisioningState: ok ? 'Succeeded' : 'Failed',
    statusCode,
    ...(message ? { statusMessage: message } : {}),
    timestamp: new Date().toISOString(),
    duration: `PT${(ms / 1000).toFixed(7)}S`,
    targetResource: { id: h.id, resourceType: h.type, resourceName: h.name, apiVersion: h.apiVersion },
  };
}

async function executeInstance(env: Env, inst: Instance): Promise<void> {
  const h = inst.header!;
  const ienv = instanceEnv(env, inst);
  if (h.existing) {
    const r = await env.host.get(h.id, h.apiVersion);
    if (!r) throw new TemplateError('ResourceNotFound', `The Resource '${h.type}/${h.name}' was not found. The existing resource is referenced by the template but does not exist.`);
    inst.result = r;
    return;
  }
  const raw = inst.decl.raw;
  const started = Date.now();
  if (h.type.toLowerCase() === 'microsoft.resources/deployments') {
    const props = raw.properties ?? {};
    const scopeOpt = String(props.expressionEvaluationOptions?.scope ?? (env.t.languageVersion ? 'inner' : 'outer')).toLowerCase();
    const evaluated: any = {};
    for (const [k, v] of Object.entries(props)) {
      if (k === 'template') continue;
      if (k === 'parameters' && scopeOpt === 'outer') continue;
      evaluated[k] = await evalValue(v, ienv);
    }
    if (props.template) evaluated.template = props.template;
    const target = await targetScopeOf(env, ienv, raw);
    const location = raw.location !== undefined ? toStr(await evalValue(raw.location, ienv)) : env.deployment.location;
    try {
      inst.result = await env.host.nested({ name: h.name, scope: target, location, properties: evaluated, outer: scopeOpt === 'outer' ? { ...env, deployScope: target } : undefined, parentTemplateLink: env.deployment.properties?.templateLink?.uri });
      await env.host.operation(opRecord(inst, true, 'Created', started));
    } catch (e: any) {
      await env.host.operation(opRecord(inst, false, e.code === 'Conflict' ? 'Conflict' : 'BadRequest', started, { error: { code: e.code ?? 'DeploymentFailed', message: e.message, details: e.details } }));
      throw e;
    }
    return;
  }
  const body: any = {};
  for (const [k, v] of Object.entries(raw)) {
    if (SKIP_BODY_KEYS.has(k)) continue;
    body[k] = await evalValue(v, ienv);
  }
  try {
    const res = await env.host.put(h.id, h.apiVersion, body);
    inst.result = res.body;
    await env.host.operation(opRecord(inst, true, res.status === 201 ? 'Created' : 'OK', started));
  } catch (e: any) {
    if (e instanceof Pending) throw e;
    const code = e.status === 409 ? 'Conflict' : e.status === 404 ? 'NotFound' : e.status === 403 ? 'Forbidden' : 'BadRequest';
    await env.host.operation(opRecord(inst, false, code, started, { error: { code: e.code ?? 'BadRequest', message: e.message, ...(e.details ? { details: e.details } : {}) } }));
    throw e;
  }
}

async function dependencyKeys(env: Env, inst: Instance): Promise<string[]> {
  const out = [...inst.extraDeps];
  const ienv = instanceEnv(env, inst);
  for (const d of inst.decl.raw.dependsOn ?? []) {
    try {
      out.push(toStr(await evalValue(d, ienv)).toLowerCase());
    } catch (e) {
      if (e instanceof Pending) out.push(e.target.toLowerCase());
      else throw e;
    }
  }
  return out;
}

// ============ esecuzione ============

export async function runTemplate(input: RunInput): Promise<RunResult> {
  const t = input.template;
  if (!t || typeof t !== 'object') throw invalid('The template is missing or is not a valid JSON object.');
  const host = input.host;
  const providedParams = normalizeParameterValues(input.parameters);
  const level = input.outer ? input.scope.level : templateLevel(t);
  if (!input.outer && level !== input.scope.level) {
    throw invalid(`The template schema '${t.$schema}' is not supported for a deployment at the ${input.scope.level} scope. Use a template with the matching $schema.`);
  }
  const templateHash = BigInt('0x' + createHash('sha256').update(JSON.stringify(t)).digest('hex').slice(0, 15)).toString();

  const env: Env = input.outer
    ? { ...input.outer, t: { ...input.outer.t, ...t, parameters: input.outer.t.parameters, variables: input.outer.t.variables }, instances: [], deployScope: input.scope, copyCtx: new Map(), lambdaVars: new Map(), phase: 'resources' }
    : {
        t,
        params: new Map(),
        paramTypes: new Map(),
        vars: new Map(),
        fns: new Map(),
        fnScope: input.scope,
        deployScope: input.scope,
        host,
        deployment: {},
        copyCtx: new Map(),
        lambdaVars: new Map(),
        instances: [],
        phase: 'parameters',
      };

  if (!input.outer) {
    for (const ns of Array.isArray(t.functions) ? t.functions : []) {
      for (const [name, def] of Object.entries(ns.members ?? {})) env.fns.set(`${ns.namespace}.${name}`.toLowerCase(), def);
    }
    env.deployment = {
      name: input.deploymentName,
      ...(input.deploymentLocation ? { location: input.deploymentLocation } : {}),
      properties: {
        ...(input.templateLink ? { templateLink: input.templateLink } : {}),
        template: { contentVersion: t.contentVersion ?? '1.0.0.0', ...(t.metadata ? { metadata: t.metadata } : {}), ...(t.languageVersion ? { languageVersion: t.languageVersion } : {}) },
        templateHash,
        parameters: providedParams,
        mode: input.mode ?? 'Incremental',
        provisioningState: 'Accepted',
      },
    };
    await initParameters(env, providedParams);
    env.phase = 'variables';
    for (const [k, v] of Object.entries(t.variables ?? {})) {
      if (k === 'copy' && Array.isArray(v)) {
        for (const c of v) env.vars.set(String(c.name).toLowerCase(), { raw: null, state: 0, copy: c });
      } else {
        env.vars.set(k.toLowerCase(), { raw: v, state: 0 });
      }
    }
  }
  env.phase = 'resources';

  // istanze (espansione dei cicli copy)
  const decls = normalizeResources(t);
  for (const d of decls) {
    if (d.copy) {
      const count = Number(await evalValue(d.copy.count, env));
      if (!Number.isInteger(count) || count < 0 || count > 800) throw invalid(`The copy count for '${d.copy.name}' must be an integer between 0 and 800.`);
      const serial = String(d.copy.mode ?? 'parallel').toLowerCase() === 'serial';
      const batch = Math.max(1, Number(d.copy.batchSize ? await evalValue(d.copy.batchSize, env) : 1));
      for (let i = 0; i < count; i++) {
        const inst: Instance = { decl: d, copyCtx: new Map([[String(d.copy.name).toLowerCase(), i]]), index: i, state: 'pending', keys: new Set(), extraDeps: [] };
        inst.keys.add(`__loop:${String(d.copy.name).toLowerCase()}:${i}`);
        if (serial && i >= batch) inst.extraDeps.push(`__loop:${String(d.copy.name).toLowerCase()}:${i - batch}`);
        env.instances.push(inst);
      }
    } else {
      env.instances.push({ decl: d, copyCtx: new Map(), index: 0, state: 'pending', keys: new Set(), extraDeps: [] });
    }
  }
  for (const inst of env.instances) {
    try {
      if (!inst.header) await computeHeader(env, inst);
    } catch (e) {
      if (!(e instanceof Pending)) throw e;
    }
  }

  const failures: TemplateError['details'] = [];
  let pending = [...env.instances];
  while (pending.length) {
    let progressed = false;
    for (const inst of [...pending]) {
      if (host.canceled()) throw new TemplateError('DeploymentCanceled', 'The deployment was canceled.');
      const deps = await dependencyKeys(env, inst);
      const blocked = deps.some((k) => pending.some((o) => o !== inst && o.keys.has(k)));
      if (blocked) continue;
      try {
        if (!inst.header) await computeHeader(env, inst);
        if (!inst.header!.condition) inst.state = 'skipped';
        else {
          await executeInstance(env, inst);
          inst.state = 'done';
        }
        pending = pending.filter((p) => p !== inst);
        progressed = true;
      } catch (e: any) {
        if (e instanceof Pending) continue;
        if (e instanceof TemplateError && e.code === 'InvalidTemplate') throw new TemplateError('InvalidTemplate', `Deployment template validation failed: 'The template resource '${inst.header?.name ?? inst.decl.key}' ${inst.header ? `of type '${inst.header.type}' ` : ''}is not valid: ${e.message}'.`);
        failures.push({ code: e.code ?? 'BadRequest', message: e.message, target: inst.header?.id });
        pending = pending.filter((p) => p !== inst);
        progressed = true;
        break;
      }
    }
    if (failures.length) break;
    if (!progressed) {
      const names = pending.map((p) => p.header?.id ?? p.decl.key).join("', '");
      throw invalid(`Deployment template validation failed: 'Circular dependency detected on resource: '${names}'. Please see https://aka.ms/arm-syntax-resources for usage details.'.`);
    }
  }
  if (failures.length) {
    throw new TemplateError('DeploymentFailed', 'At least one resource deployment operation failed. Please list deployment operations for details. Please see https://aka.ms/arm-deployment-operations for usage details.', failures);
  }

  // modalità Complete: elimina le risorse del gruppo non presenti nel template
  if (!input.outer && (input.mode ?? 'Incremental') === 'Complete' && input.scope.level === 'resourceGroup') {
    const deployed = new Set(env.instances.filter((i) => i.header).map((i) => i.header!.id.toLowerCase()));
    for (const r of await host.listGroupResources(input.scope.subscriptionId!, input.scope.resourceGroup!)) {
      if (!deployed.has(r.id.toLowerCase())) await host.remove(r.id, '2021-04-01');
    }
  }

  // output
  env.phase = 'outputs';
  const outputs: RunResult['outputs'] = {};
  for (const [name, o] of Object.entries<any>(t.outputs ?? {})) {
    if (o.condition !== undefined && !(await evalValue(o.condition, env))) continue;
    const { type } = resolveType(o, t);
    let value: unknown;
    if (o.copy) {
      const count = Number(await evalValue(o.copy.count, env));
      const arrOut = [];
      for (let i = 0; i < count; i++) {
        const cc = new Map(env.copyCtx);
        cc.set('__output', i);
        arrOut.push(await evalValue(o.copy.input, { ...env, copyCtx: cc, currentLoop: '__output' }));
      }
      value = arrOut;
    } else {
      value = await evalValue(o.value, env);
    }
    const typeName = { string: 'String', securestring: 'SecureString', int: 'Int', bool: 'Bool', array: 'Array', object: 'Object', secureobject: 'SecureObject' }[type] ?? 'Object';
    outputs[name] = typeName.startsWith('Secure') ? { type: typeName } : { type: typeName, value };
  }

  const parameters: RunResult['parameters'] = {};
  if (!input.outer) {
    for (const [name] of Object.entries(t.parameters ?? {})) {
      const type = env.paramTypes.get(name.toLowerCase()) ?? 'object';
      const typeName = { string: 'String', securestring: 'SecureString', int: 'Int', bool: 'Bool', array: 'Array', object: 'Object', secureobject: 'SecureObject' }[type] ?? 'Object';
      parameters[name] = typeName.startsWith('Secure') ? { type: typeName } : { type: typeName, value: env.params.get(name.toLowerCase()) };
    }
  }
  const done = env.instances.filter((i) => i.state === 'done' && i.header && !i.header.existing);
  const provMap = new Map<string, Map<string, Set<string>>>();
  for (const i of done) {
    const [ns, ...rest] = i.header!.type.split('/');
    const m = provMap.get(ns) ?? new Map();
    const loc = i.result?.location ?? null;
    const s = m.get(rest.join('/')) ?? new Set();
    if (loc) s.add(loc);
    m.set(rest.join('/'), s);
    provMap.set(ns, m);
  }
  return {
    outputs,
    outputResources: done.filter((i) => i.header!.type.toLowerCase() !== 'microsoft.resources/deployments').map((i) => ({ id: i.header!.id })),
    validatedResources: env.instances.filter((i) => i.header && i.header.condition && !i.header.existing).map((i) => ({ id: i.header!.id, type: i.header!.type, apiVersion: i.header!.apiVersion, name: i.header!.name, body: i.result })),
    parameters,
    templateHash,
    providers: [...provMap.entries()].map(([ns, m]) => ({ namespace: ns, resourceTypes: [...m.entries()].map(([rt, locs]) => ({ resourceType: rt, locations: [...locs] })) })),
    dependencies: [],
  };
}

export { clone as cloneValue };
