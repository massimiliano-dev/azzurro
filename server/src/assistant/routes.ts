/** Endpoint del portale per l'assistente (SSE per testo, strumenti e richieste di conferma). */
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import * as store from '../db/store.ts';
import { readJson } from '../http.ts';
import { HttpError } from '../errors.ts';
import { getSettings } from '../push.ts';
import { loadAccess, can, hasAnyAccessWithin } from '../arm/rbac.ts';
import type { AppEnv } from '../types.ts';
import { chat, decide, loadConversation, newConversation, systemPrompt, type Conversation } from './agent.ts';
import { claude, claudeAvailable, claudeModel } from './claude.ts';
import { local, localAvailable, localModel, localUrl, openai, openaiAvailable, openaiModel, probeLocal } from './openai.ts';
import type { Provider } from './provider.ts';
import { realJson, sessionDirectory, type Directory } from '../real/proxy.ts';

const PROVIDERS: Record<Provider['id'], { p: Provider; available: () => boolean }> = {
  local: { p: local, available: localAvailable },
  claude: { p: claude, available: claudeAvailable },
  openai: { p: openai, available: openaiAvailable },
};

function pick(id?: string): Provider {
  const wanted = (id ?? process.env.AZZURRO_ASSISTANT_PROVIDER ?? '') as Provider['id'];
  if (PROVIDERS[wanted]?.available()) return PROVIDERS[wanted].p;
  if (wanted && PROVIDERS[wanted]) throw new HttpError(400, 'provider_not_configured', `${PROVIDERS[wanted].p.label} is not configured on the server.`);
  const first = Object.values(PROVIDERS).find((x) => x.available());
  if (!first) throw new HttpError(400, 'provider_not_configured', 'No AI provider is configured: set ANTHROPIC_API_KEY or OPENAI_API_KEY.');
  return first.p;
}

/** Pagina che l'utente sta guardando, mandata dal dock: solo campi noti, testo corto. */
function pageContext(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return '';
  const r = raw as Record<string, unknown>;
  const str = (k: string, max = 300) => (typeof r[k] === 'string' ? (r[k] as string).replace(/[\r\n<>]/g, ' ').slice(0, max) : '');
  const parts = [
    str('title', 120) && `page "${str('title', 120)}"`,
    str('url') && `URL ${str('url')}`,
    str('resourceId') && `resource ${str('resourceId')}`,
    str('appObjectId', 40) && `app registration object id ${str('appObjectId', 40)}`,
    str('tab', 40) && `tab ${str('tab', 40)}`,
  ].filter(Boolean);
  if (!parts.length) return '';
  return `\nCURRENT PAGE: the user opened you from ${parts.join(', ')}. Questions like "this", "it" or "here" refer to that page; read it with the tools first and prefer acting on it. Ignore this if the user clearly asks about something else.`;
}

async function systemFor(userId: string, principal: any, real: Directory | null, context?: unknown): Promise<string> {
  return (await baseSystem(userId, principal, real)) + pageContext(context);
}

async function baseSystem(userId: string, principal: any, real: Directory | null): Promise<string> {
  const u = await store.get('user', userId);
  const settings = await getSettings(userId);
  const locale = (settings.locale ?? (String(u?.preferredLanguage ?? 'it').startsWith('en') ? 'en' : 'it')) as 'it' | 'en';
  const user = { displayName: u?.displayName ?? principal.upn, upn: u?.userPrincipalName ?? principal.upn, appRoles: u?._loginRoles ?? [] };
  if (real) {
    let subs: any[] = [];
    try { subs = (await realJson(userId, real.tenantId, 'arm', '/subscriptions?api-version=2022-12-01')).json?.value ?? []; } catch { /* consenso mancante */ }
    return systemPrompt({ locale, real, user, subscriptions: subs.map((s) => ({ id: s.subscriptionId, name: s.displayName })), resourceGroups: [] });
  }
  const access = await loadAccess(principal);
  const subs = (await store.list('subscription')).filter((s) => hasAnyAccessWithin(access, `/subscriptions/${s.subscriptionId}`));
  const rgs = (await store.list('resourceGroup')).filter((r) => can(access, 'Microsoft.Resources/subscriptions/resourceGroups/read', r.id));
  return systemPrompt({
    locale,
    user,
    subscriptions: subs.map((s) => ({ id: s.subscriptionId, name: s.displayName })),
    resourceGroups: rgs.map((r) => ({ id: r.id, location: r.location })),
  });
}

/**
 * Esecuzioni in corso, indipendenti dalla connessione: chiudere il pannello o ricaricare la pagina
 * non ferma l'assistente; il browser si riaggancia e riceve lo stato attuale più gli eventi dal vivo.
 * Solo "Ferma" (POST .../stop) interrompe il modello.
 */
interface RunEvent { event: string; data: unknown }
interface Run { conv: Conversation; userId: string; events: RunEvent[]; listeners: Set<() => void>; done: boolean; abort: AbortController; thinking: string; draft: string }
const runs = new Map<string, Run>();
const running = (id: string) => { const r = runs.get(id); return !!r && !r.done; };

function startRun(conv: Conversation, userId: string, work: (emit: (event: string, data: unknown) => Promise<void>, signal: AbortSignal) => Promise<void>): Run {
  if (running(conv.id)) throw new HttpError(409, 'busy', 'The assistant is still working on this conversation.');
  const run: Run = { conv, userId, events: [], listeners: new Set(), done: false, abort: new AbortController(), thinking: '', draft: '' };
  runs.set(conv.id, run);
  const emit = async (event: string, data: unknown) => {
    if (event === 'reasoning') run.thinking += (data as { delta: string }).delta;
    else if (event === 'text') run.draft += (data as { delta: string }).delta;
    else if (event === 'message' || event === 'tool') { run.thinking = ''; run.draft = ''; }
    run.events.push({ event, data });
    for (const l of run.listeners) l();
  };
  // parte al giro successivo, così chi ha avviato l'esecuzione è già in ascolto
  setImmediate(() => {
    void work(emit, run.abort.signal)
      .catch(async (e) => { await emit('error', { code: 'error', message: (e as Error).message }); })
      .finally(() => {
        run.done = true;
        for (const l of run.listeners) l();
        setTimeout(() => { if (runs.get(conv.id) === run) runs.delete(conv.id); }, 60_000);
      });
  });
  return run;
}

/** Inoltra un'esecuzione come SSE dall'evento `from`; chiudere la connessione smette solo di ascoltare. */
function pipe(c: any, run: Run, from: number, first?: RunEvent): Response {
  c.header('Cache-Control', 'no-cache, no-transform');
  c.header('X-Accel-Buffering', 'no');
  return streamSSE(c, async (stream) => {
    let i = from;
    let chain: Promise<unknown> = first ? stream.writeSSE({ event: first.event, data: JSON.stringify(first.data) }) : Promise.resolve();
    await new Promise<void>((resolve) => {
      const flush = () => {
        while (i < run.events.length) {
          const e = run.events[i++];
          chain = chain.then(() => stream.writeSSE({ event: e.event, data: JSON.stringify(e.data) }));
        }
        if (run.done) { run.listeners.delete(flush); void chain.then(() => resolve()); }
      };
      run.listeners.add(flush);
      stream.onAbort(() => { run.listeners.delete(flush); resolve(); });
      flush();
    });
  });
}

const view = (c: Conversation) => ({ id: c.id, title: c.title, provider: c.provider, autoApprove: c.autoApprove, createdAt: c.createdAt, updatedAt: c.updatedAt, display: c.display, pending: c.pending ? c.pending.awaiting : [], running: running(c.id) });

export function assistantRoutes(app: Hono<AppEnv>): void {
  app.use('/_portal/assistant/*', async (_c, next) => { await probeLocal(); await next(); });
  app.get('/_portal/assistant/status', (c) => c.json({
    providers: [
      { id: 'local', label: 'Locale', model: localModel(), available: localAvailable(), env: `AZZURRO_LOCAL_MODEL (${localUrl()})` },
      { id: 'claude', label: 'Claude', model: claudeModel(), available: claudeAvailable(), env: 'ANTHROPIC_API_KEY' },
      { id: 'openai', label: 'GPT', model: openaiModel(), available: openaiAvailable(), env: 'OPENAI_API_KEY' },
    ],
    default: (() => { try { return pick().id; } catch { return null; } })(),
  }));

  app.get('/_portal/assistant/conversations', async (c) => {
    const p = c.get('principal');
    const list = await store.list<Conversation>('assistantConversation', { parent: p.oid });
    return c.json({ value: list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 50).map((x) => ({ id: x.id, title: x.title, provider: x.provider, updatedAt: x.updatedAt, pending: !!x.pending, running: running(x.id) })) });
  });

  app.get('/_portal/assistant/conversations/:id', async (c) => {
    const id = c.req.param('id');
    const live = runs.get(id);
    if (live && !live.done && live.userId === c.get('principal').oid) return c.json(view(live.conv));
    const conv = await loadConversation(c.get('principal').oid, id);
    if (!conv) throw new HttpError(404, 'not_found', 'Conversation not found.');
    return c.json(view(conv));
  });

  /** Riaggancio a un'esecuzione in corso: prima lo stato attuale (snapshot), poi gli eventi dal vivo. */
  app.get('/_portal/assistant/conversations/:id/stream', (c) => {
    const run = runs.get(c.req.param('id'));
    if (!run || run.done || run.userId !== c.get('principal').oid) return c.body(null, 204);
    const snapshot = { ...view(run.conv), thinking: run.thinking, draft: run.draft };
    return pipe(c, run, run.events.length, { event: 'snapshot', data: snapshot });
  });

  app.post('/_portal/assistant/conversations/:id/stop', (c) => {
    const run = runs.get(c.req.param('id'));
    if (run && !run.done && run.userId === c.get('principal').oid) run.abort.abort('user');
    return c.body(null, 204);
  });

  app.delete('/_portal/assistant/conversations/:id', async (c) => {
    const conv = await loadConversation(c.get('principal').oid, c.req.param('id'));
    if (conv) {
      runs.get(conv.id)?.abort.abort('user');
      await store.remove('assistantConversation', conv.id);
    }
    return c.body(null, 204);
  });

  app.post('/_portal/assistant/chat', async (c) => {
    const p = c.get('principal');
    if (p.kind !== 'user') throw new HttpError(403, 'not_a_user', 'The assistant requires a user session.');
    const body = await readJson(c);
    const text = String(body.message ?? '').trim();
    if (!text) throw new HttpError(400, 'empty_message', 'Write a message.');
    if (text.length > 8000) throw new HttpError(400, 'message_too_long', 'The message is too long.');
    let conv = body.conversationId ? await loadConversation(p.oid, String(body.conversationId)) : null;
    const provider = pick(conv?.provider ?? body.provider);
    conv ??= newConversation(p.oid, provider.id, text, body.autoApprove !== false);
    if (typeof body.autoApprove === 'boolean') conv.autoApprove = body.autoApprove;
    const real = (await sessionDirectory(c))?.directory ?? null;
    const system = await systemFor(p.oid, p, real, body.context);
    const cookie = c.req.header('cookie') ?? '';
    const target = conv;
    const run = startRun(target, p.oid, async (emit, signal) => {
      await emit('conversation', { id: target.id, provider: provider.id, model: provider.model });
      await chat(provider, target, text, { app, cookie, userId: p.oid, real, signal }, system, emit);
      await emit('done', view(target));
    });
    return pipe(c, run, 0);
  });

  app.post('/_portal/assistant/conversations/:id/decide', async (c) => {
    const p = c.get('principal');
    const conv = await loadConversation(p.oid, c.req.param('id'));
    if (!conv) throw new HttpError(404, 'not_found', 'Conversation not found.');
    const body = await readJson(c);
    const decisions: Record<string, boolean> = Object.fromEntries(Object.entries(body.decisions ?? {}).map(([k, v]) => [k, v === true || v === 'approve']));
    const provider = pick(conv.provider);
    const real = (await sessionDirectory(c))?.directory ?? null;
    const system = await systemFor(p.oid, p, real, body.context);
    const cookie = c.req.header('cookie') ?? '';
    const run = startRun(conv, p.oid, async (emit, signal) => {
      await decide(provider, conv, decisions, { app, cookie, userId: p.oid, real, signal }, system, emit);
      await emit('done', view(conv));
    });
    return pipe(c, run, 0);
  });
}
