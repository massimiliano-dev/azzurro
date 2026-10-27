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

const view = (c: Conversation) => ({ id: c.id, title: c.title, provider: c.provider, autoApprove: c.autoApprove, createdAt: c.createdAt, updatedAt: c.updatedAt, display: c.display, pending: c.pending ? c.pending.awaiting : [] });

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
    return c.json({ value: list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 50).map((x) => ({ id: x.id, title: x.title, provider: x.provider, updatedAt: x.updatedAt, pending: !!x.pending })) });
  });

  app.get('/_portal/assistant/conversations/:id', async (c) => {
    const conv = await loadConversation(c.get('principal').oid, c.req.param('id'));
    if (!conv) throw new HttpError(404, 'not_found', 'Conversation not found.');
    return c.json(view(conv));
  });

  app.delete('/_portal/assistant/conversations/:id', async (c) => {
    const conv = await loadConversation(c.get('principal').oid, c.req.param('id'));
    if (conv) await store.remove('assistantConversation', conv.id);
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
    const ctx = { app, cookie: c.req.header('cookie') ?? '', userId: p.oid, real };
    const target = conv;
    c.header('Cache-Control', 'no-cache, no-transform');
    c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async (stream) => {
      const emit = (event: string, data: unknown) => stream.writeSSE({ event, data: JSON.stringify(data) });
      await emit('conversation', { id: target.id, provider: provider.id, model: provider.model });
      await chat(provider, target, text, ctx, system, emit);
      await emit('done', view(target));
    });
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
    const ctx = { app, cookie: c.req.header('cookie') ?? '', userId: p.oid, real };
    c.header('Cache-Control', 'no-cache, no-transform');
    c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async (stream) => {
      const emit = (event: string, data: unknown) => stream.writeSSE({ event, data: JSON.stringify(data) });
      await decide(provider, conv, decisions, ctx, system, emit);
      await emit('done', view(conv));
    });
  });
}
