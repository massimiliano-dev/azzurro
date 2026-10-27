/**
 * Impostazioni del server modificabili dal portale (chiavi AI, app Microsoft, accesso).
 * Stanno in un file KEY=VALUE fuori dalla copia dell'app (AZZURRO_CONFIG_FILE) e prevalgono
 * su .env e sull'ambiente; si applicano a caldo, senza riavviare il server.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const CONFIG_FILE = process.env.AZZURRO_CONFIG_FILE || new URL('../../.azzurro.env', import.meta.url).pathname;

export interface Field {
  key: string;
  group: 'ai' | 'microsoft' | 'access';
  kind: 'text' | 'secret' | 'url' | 'select' | 'bool' | 'owner';
  def?: string;
  options?: string[];
}

export const FIELDS: Field[] = [
  { key: 'AZZURRO_ASSISTANT_PROVIDER', group: 'ai', kind: 'select', options: ['', 'local', 'claudecode', 'claude', 'openai'] },
  { key: 'AZZURRO_CLAUDE_CODE_OWNER', group: 'ai', kind: 'owner' },
  { key: 'AZZURRO_CLAUDE_CODE_MODEL', group: 'ai', kind: 'text' },
  { key: 'AZZURRO_LOCAL_AI_URL', group: 'ai', kind: 'url', def: 'http://localhost:11434/v1' },
  { key: 'AZZURRO_LOCAL_MODEL', group: 'ai', kind: 'text', def: 'qwen3.8:27b' },
  { key: 'AZZURRO_LOCAL_AI_KEY', group: 'ai', kind: 'secret' },
  { key: 'ANTHROPIC_API_KEY', group: 'ai', kind: 'secret' },
  { key: 'AZZURRO_CLAUDE_MODEL', group: 'ai', kind: 'text', def: 'claude-opus-5-5' },
  { key: 'OPENAI_API_KEY', group: 'ai', kind: 'secret' },
  { key: 'AZZURRO_OPENAI_MODEL', group: 'ai', kind: 'text', def: 'gpt-5' },
  { key: 'AZZURRO_MS_TENANT_ID', group: 'microsoft', kind: 'text' },
  { key: 'AZZURRO_MS_CLIENT_ID', group: 'microsoft', kind: 'text' },
  { key: 'AZZURRO_MS_CLIENT_SECRET', group: 'microsoft', kind: 'secret' },
  { key: 'AZZURRO_MS_REDIRECT_BASE', group: 'microsoft', kind: 'url' },
  { key: 'AZZURRO_LOCAL_LOGIN', group: 'access', kind: 'bool' },
];
const KEYS = new Set(FIELDS.map((f) => f.key));

/** Valori di partenza (ambiente + .env), per tornarci quando un override viene tolto. */
const base: Record<string, string | undefined> = Object.fromEntries(FIELDS.map((f) => [f.key, process.env[f.key]]));

function parse(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=(.*)$/.exec(line);
    if (!m || !KEYS.has(m[1])) continue;
    const raw = m[2].trim();
    try { out[m[1]] = raw.startsWith('"') ? JSON.parse(raw) : raw; } catch { /* riga rovinata: ignorata */ }
  }
  return out;
}

export function readOverrides(): Record<string, string> {
  try { return existsSync(CONFIG_FILE) ? parse(readFileSync(CONFIG_FILE, 'utf8')) : {}; } catch { return {}; }
}

function apply(over: Record<string, string>): void {
  for (const { key } of FIELDS) {
    const v = key in over ? over[key] : base[key];
    if (v === undefined) delete process.env[key];
    else process.env[key] = v;
  }
}

const listeners: (() => void)[] = [];
export function onConfigChange(fn: () => void): void { listeners.push(fn); }

/** Applica le modifiche: stringa = nuovo valore, null = torna al valore di .env/ambiente. */
export function writeOverrides(changes: Record<string, string | null>): void {
  const over = readOverrides();
  for (const [k, v] of Object.entries(changes)) {
    if (!KEYS.has(k)) continue;
    if (v === null) delete over[k];
    else if (/[\r\n]/.test(v)) throw new Error(`${k}: the value cannot contain line breaks.`);
    else over[k] = v.trim();
  }
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  const body = FIELDS.filter((f) => f.key in over).map((f) => `${f.key}=${JSON.stringify(over[f.key])}`).join('\n');
  writeFileSync(CONFIG_FILE, `# Impostazioni di Azzurro modificate dal portale (${new Date().toISOString()})\n${body}\n`, { mode: 0o600 });
  chmodSync(CONFIG_FILE, 0o600);
  apply(over);
  for (const fn of listeners) fn();
}

/** Stato per il portale: i segreti non escono mai, solo se sono impostati. */
export function describeConfig() {
  const over = readOverrides();
  return FIELDS.map((f) => {
    const v = process.env[f.key];
    return {
      key: f.key, group: f.group, kind: f.kind, options: f.options, def: f.def,
      set: !!v,
      value: f.kind === 'secret' ? undefined : v ?? '',
      hint: f.kind === 'secret' && v ? `…${v.slice(-4)}` : undefined,
      source: f.key in over ? 'portal' : base[f.key] ? 'env' : 'default',
    };
  });
}

apply(readOverrides());
