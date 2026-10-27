/**
 * Provider "Claude Code": l'assistente usa l'account Claude Code già collegato su questo Mac
 * (abbonamento Claude) invece di una chiave API, tramite Claude Agent SDK.
 *
 * - Login e token restano al binario ufficiale di Claude Code incluso nell'SDK: Azzurro non legge
 *   né conserva credenziali.
 * - È personale: lo abilita in Impostazioni un amministratore, solo per il proprio utente, perché
 *   i termini Anthropic non consentono di usare un abbonamento per conto di altri utenti.
 * - Niente strumenti di Claude Code (Bash, file, web) né impostazioni/CLAUDE.md dell'utente:
 *   solo gli strumenti di Azzurro, con le stesse conferme degli altri provider.
 */
import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { Inputs, TOOL_SPECS } from './tools.ts';
import type { AgentRunOptions, Provider } from './provider.ts';

export const claudeCodeModel = (): string => process.env.AZZURRO_CLAUDE_CODE_MODEL || '';
/** id dell'utente Azzurro che può usare l'account Claude Code di questo Mac */
export const claudeCodeOwner = (): string => process.env.AZZURRO_CLAUDE_CODE_OWNER || '';

const require = createRequire(import.meta.url);
function binary(): string {
  try { return join(dirname(require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`)), 'claude'); } catch { return join(homedir(), '.local/bin/claude'); }
}

/** Ambiente senza chiavi API: altrimenti Claude Code userebbe la chiave invece dell'abbonamento. */
function subscriptionEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) delete env[k];
  env.HOME ??= homedir();
  return env;
}

export interface ClaudeAccount { loggedIn: boolean; email?: string; subscriptionType?: string; authMethod?: string; error?: string }
let account: { at: number; v: ClaudeAccount } | null = null;

/** Stato del login di Claude Code su questo Mac (comando locale, nessun token consumato). */
export function claudeCodeAccount(force = false): Promise<ClaudeAccount> {
  if (!force && account && Date.now() - account.at < 60_000) return Promise.resolve(account.v);
  return new Promise((resolve) => {
    execFile(binary(), ['auth', 'status', '--json'], { env: subscriptionEnv(), timeout: 15_000 }, (err, stdout) => {
      let v: ClaudeAccount;
      try {
        const j = JSON.parse(String(stdout));
        v = { loggedIn: !!j.loggedIn, email: j.email, subscriptionType: j.subscriptionType, authMethod: j.authMethod };
      } catch {
        v = { loggedIn: false, error: err ? err.message.split('\n')[0] : 'Claude Code non risponde.' };
      }
      account = { at: Date.now(), v };
      resolve(v);
    });
  });
}

export function claudeCodeAvailableFor(userId: string): boolean {
  return !!userId && claudeCodeOwner() === userId && !!account?.v.loggedIn;
}

function workdir(): string {
  // le sessioni di Claude Code dell'assistente finiscono qui, separate dai progetti dell'utente
  const dir = join(homedir(), 'Library', 'Application Support', 'Azzurro', 'claude-code');
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function run(o: AgentRunOptions): Promise<{ sessionId?: string; error?: string }> {
  const server = createSdkMcpServer({
    name: 'azzurro',
    version: '1.0.0',
    tools: TOOL_SPECS.map((t) => tool(t.name, t.description, (Inputs as Record<string, any>)[t.name].shape, async (args) => {
      const r = await o.runTool(t.name, args);
      return { content: [{ type: 'text' as const, text: r.content }], isError: r.isError };
    })),
  });
  const abort = new AbortController();
  o.signal?.addEventListener('abort', () => abort.abort(), { once: true });
  let sessionId: string | undefined;
  let error: string | undefined;
  const q = query({
    prompt: o.prompt,
    options: {
      systemPrompt: o.system,
      ...(claudeCodeModel() ? { model: claudeCodeModel() } : {}),
      tools: [],
      mcpServers: { azzurro: server },
      // le conferme le chiede Azzurro dentro lo strumento, come per gli altri provider
      allowedTools: TOOL_SPECS.map((t) => `mcp__azzurro__${t.name}`),
      canUseTool: async () => ({ behavior: 'deny' as const, message: 'Only Azzurro tools are available.' }),
      settingSources: [],
      includePartialMessages: true,
      thinking: { type: 'adaptive', display: 'summarized' },
      maxTurns: 24,
      cwd: workdir(),
      env: subscriptionEnv(),
      abortController: abort,
      ...(o.resume ? { resume: o.resume } : {}),
    },
  });
  for await (const m of q) {
    if (m.type === 'system' && m.subtype === 'init') {
      sessionId = m.session_id;
      o.onModel(m.model);
    } else if (m.type === 'stream_event') {
      const e = m.event as { type: string; delta?: { type: string; text?: string; thinking?: string } };
      if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) o.onText(e.delta.text);
      else if (e.type === 'content_block_delta' && e.delta?.type === 'thinking_delta' && e.delta.thinking) o.onReasoning(e.delta.thinking);
    } else if (m.type === 'result') {
      sessionId = m.session_id;
      if (m.subtype !== 'success') error = (m as { errors?: string[] }).errors?.join(' ') || m.subtype;
      else if (m.is_error) error = m.result;
    }
  }
  return { sessionId, error };
}

export const claudeCode: Provider = {
  id: 'claudecode',
  get model() { return claudeCodeModel() || 'Claude Code'; },
  label: 'Claude Code',
  userMessage: (text) => text,
  toolResults: () => [],
  run: async () => { throw new Error('Claude Code runs its own agent loop.'); },
  agent: { run },
  describeError(err) {
    const msg = (err as Error)?.message ?? String(err);
    if (/not logged in|login|authenticat|401/i.test(msg)) return { code: 'claude_code_login', message: 'Claude Code on this Mac is not signed in: run `claude` in the Terminal and sign in, then try again.' };
    if (/usage limit|rate limit|429/i.test(msg)) return { code: 'rate_limited', message: 'The Claude plan usage limit has been reached. Try again later or pick another provider.' };
    return undefined;
  },
};
