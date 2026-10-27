/**
 * Ciclo dell'assistente: chiama il modello, esegue gli strumenti, si ferma quando
 * serve l'approvazione dell'utente e riprende dopo la decisione.
 */
import * as store from '../db/store.ts';
import { nowIso, uuid } from '../ids.ts';
import { tenant } from '../directory.ts';
import { classify, describeCall, execute, validate, type ExecCtx, type Kind } from './tools.ts';
import type { Provider, ToolCall } from './provider.ts';

export type DisplayItem =
  | { type: 'user'; text: string; at: string }
  | { type: 'assistant'; text: string; reasoning?: string; model?: string; fallbackModel?: string; at: string }
  | { type: 'tool'; id: string; name: string; input: unknown; kind: Kind; status: 'running' | 'ok' | 'error' | 'pending' | 'rejected'; summary: string; request?: { method: string; path: string; status: number; ms: number }; preview?: string; at: string }
  | { type: 'notice'; tone: 'warn' | 'bad'; text: string; at: string };

export interface Conversation {
  id: string;
  userId: string;
  provider: Provider['id'];
  title: string;
  createdAt: string;
  updatedAt: string;
  autoApprove: boolean;
  history: unknown[];
  display: DisplayItem[];
  pending: null | { calls: ToolCall[]; results: Record<string, { content: string; isError: boolean }>; awaiting: string[] };
}

export type Emit = (event: string, data: unknown) => Promise<void> | void;

const MAX_STEPS = 12;
const busy = new Set<string>();

export async function loadConversation(userId: string, id: string): Promise<Conversation | null> {
  const c = await store.get<Conversation>('assistantConversation', id);
  return c && c.userId === userId ? c : null;
}

export async function saveConversation(c: Conversation): Promise<void> {
  c.updatedAt = nowIso();
  await store.put('assistantConversation', c.id, c, c.userId);
}

export function newConversation(userId: string, provider: Provider['id'], text: string, autoApprove: boolean): Conversation {
  const now = nowIso();
  return { id: uuid(), userId, provider, title: text.slice(0, 80), createdAt: now, updatedAt: now, autoApprove, history: [], display: [], pending: null };
}

export interface SystemInfo {
  locale: 'it' | 'en';
  real?: { tenantId: string; name: string } | null;
  user: { displayName: string; upn: string; appRoles: string[] };
  subscriptions: { id: string; name: string }[];
  resourceGroups: { id: string; location: string }[];
}

export function systemPrompt(info: SystemInfo): string {
  const lang = info.locale === 'it' ? 'Italian' : 'English';
  return [
    `You are the assistant inside Azzurro, a local emulator of Microsoft Azure used by a company development team. Azzurro exposes the same Azure Resource Manager, Microsoft Graph and Entra ID APIs as Azure, so everything you do goes through those real API shapes.`,
    `You work for ${info.user.displayName} (${info.user.upn}). Their Azzurro roles: ${info.user.appRoles.join(', ') || 'from the local directory'}. Every call runs with their permissions; if a call returns 403, explain which role is missing instead of retrying.`,
    info.real
      ? `ACTIVE DIRECTORY: the REAL Microsoft Azure directory "${info.real.name}" (${info.real.tenantId}), not the emulator. Every call reaches real Azure: changes affect real resources and real money. Be conservative, read first, and state clearly what each change will do before proposing it. query_costs returns real Azure Cost Management data; get_pricing and estimate_resource are indicative list-price estimates only.`
      : `Tenant: ${tenant().displayName} (${tenant().id}), the local emulator.`,
    `Today: ${new Date().toISOString().slice(0, 10)}.`,
    `Subscriptions: ${info.subscriptions.map((s) => `${s.name} = /subscriptions/${s.id}`).join('; ') || 'none'}.`,
    `Resource groups: ${info.resourceGroups.slice(0, 60).map((g) => `${g.id} (${g.location})`).join('; ') || 'none'}.`,
    '',
    'How to work:',
    '- Use the tools to read the real state before answering or changing anything; never invent resource names, IDs or numbers.',
    '- To create something, check the type with get_resource_type when unsure, pick sensible defaults (the resource group location, the cheapest plan that fits unless the user asked otherwise), and say the estimated monthly cost from get_pricing.',
    '- Creations, updates and actions may wait for the user to approve them in the chat; deletions always do. If the user rejects a call, do not retry it; ask what they want instead.',
    info.real
      ? '- Costs from query_costs are the real billed costs of this Azure directory; prices from get_pricing are indicative list prices.'
      : '- Costs are estimates in EUR: indicative plan rate × hours the resource existed, plus simulated usage, because the emulator has no real traffic. Say so when you report costs, and never present them as an Azure invoice.',
    '- Secret values (keys, connection strings, client secrets) are hidden from you. Tell the user where to see them in the portal: the Keys tab of the resource, or Certificates & secrets of the app registration.',
    '- Link resources with markdown links to portal paths: [name](/resource?id=<full resource id>), resource groups as [name](/resource-groups/<subscription id>/<name>), app registrations as [name](/entra/apps/<object id>).',
    `- Answer in ${lang} unless the user writes in another language. Be brief and concrete; use short lists or a small table for several items. Use Azure's official terminology.`,
    '- When you use a tool, you may say a brief sentence first. If no tool can express what the user asked for, say so instead of guessing. Do not include internal or system XML tags in your response.',
  ].join('\n');
}

function summarize(content: string): string {
  try {
    const j = JSON.parse(content);
    if (j?.body?.value && Array.isArray(j.body.value)) return `${j.status ?? ''} · ${j.body.value.length} item`;
    if (j?.body?.error) return `${j.status} · ${j.body.error.code ?? ''} ${j.body.error.message ?? ''}`.slice(0, 200);
    if (j?.error) return String(j.error).slice(0, 200);
    if (j?.status) return String(j.status);
  } catch { /* testo */ }
  return '';
}

async function runCall(ctx: ExecCtx, call: ToolCall, conv: Conversation, emit: Emit): Promise<{ content: string; isError: boolean }> {
  const item = conv.display.find((d) => d.type === 'tool' && d.id === call.id) as Extract<DisplayItem, { type: 'tool' }> | undefined;
  const v = validate(call.name, call.input);
  if (!v.ok) {
    const r = { content: JSON.stringify({ INVALID_INPUT: v.error }), isError: true };
    if (item) { item.status = 'error'; item.summary = v.error; await emit('tool', item); }
    return r;
  }
  if (item) { item.status = 'running'; await emit('tool', item); }
  try {
    const r = await execute(ctx, call.name, v.value);
    if (item) {
      item.status = r.isError ? 'error' : 'ok';
      item.request = r.request;
      item.summary = summarize(r.content);
      item.preview = r.content.slice(0, 4000);
      await emit('tool', item);
    }
    return { content: r.content, isError: r.isError };
  } catch (e) {
    if (item) { item.status = 'error'; item.summary = (e as Error).message; await emit('tool', item); }
    return { content: JSON.stringify({ error: (e as Error).message }), isError: true };
  }
}

/** Continua il ciclo finché il modello termina, chiede conferma o si raggiunge il limite di passi. */
async function loop(provider: Provider, conv: Conversation, ctx: ExecCtx, system: string, emit: Emit): Promise<void> {
  for (let step = 0; step < MAX_STEPS; step++) {
    let streamed = '';
    const { turn, assistantMessage } = await provider.run(conv.history, system, (d) => { streamed += d; void emit('text', { delta: d }); }, (d) => { void emit('reasoning', { delta: d }); });
    conv.history.push(assistantMessage);
    const text = turn.text || streamed;
    if (text.trim() || turn.reasoning?.trim()) {
      const item: DisplayItem = { type: 'assistant', text, reasoning: turn.reasoning?.trim() || undefined, model: turn.model, fallbackModel: turn.fallbackModel, at: nowIso() };
      conv.display.push(item);
      await emit('message', item);
    }
    if (turn.stop === 'refusal') {
      const n: DisplayItem = { type: 'notice', tone: 'warn', text: turn.refusal ? `refusal: ${turn.refusal}` : 'refusal', at: nowIso() };
      conv.display.push(n);
      await emit('notice', n);
      return;
    }
    if (turn.stop === 'max_tokens') {
      const n: DisplayItem = { type: 'notice', tone: 'warn', text: 'max_tokens', at: nowIso() };
      conv.display.push(n);
      await emit('notice', n);
      return;
    }
    if (turn.stop !== 'tool_use' || !turn.calls.length) return;

    const results: Record<string, { content: string; isError: boolean }> = {};
    const awaiting: string[] = [];
    for (const call of turn.calls) {
      const kind = classify(call.name, call.input);
      const needs = kind === 'delete' || (kind === 'write' && (!conv.autoApprove || !!ctx.real));
      const item: DisplayItem = { type: 'tool', id: call.id, name: call.name, input: call.input, kind, status: needs ? 'pending' : 'running', summary: describeCall(call.name, call.input), at: nowIso() };
      conv.display.push(item);
      await emit('tool', item);
      if (needs) awaiting.push(call.id);
      else results[call.id] = await runCall(ctx, call, conv, emit);
    }
    if (awaiting.length) {
      conv.pending = { calls: turn.calls, results, awaiting };
      await emit('pending', { ids: awaiting });
      return;
    }
    conv.history.push(...provider.toolResults(turn.calls.map((c) => ({ id: c.id, ...results[c.id] }))));
  }
  const n: DisplayItem = { type: 'notice', tone: 'warn', text: 'max_steps', at: nowIso() };
  conv.display.push(n);
  await emit('notice', n);
}

async function guarded(conv: Conversation, fn: () => Promise<void>, provider: Provider, emit: Emit) {
  if (busy.has(conv.id)) throw Object.assign(new Error('The assistant is still working on this conversation.'), { code: 'busy' });
  busy.add(conv.id);
  try {
    await fn();
  } catch (e) {
    const known = provider.describeError(e);
    const n: DisplayItem = { type: 'notice', tone: 'bad', text: known?.message ?? (e as Error).message, at: nowIso() };
    conv.display.push(n);
    await emit('error', { code: known?.code ?? 'error', message: n.text });
  } finally {
    busy.delete(conv.id);
    await saveConversation(conv);
  }
}

export async function chat(provider: Provider, conv: Conversation, text: string, ctx: ExecCtx, system: string, emit: Emit): Promise<void> {
  await guarded(conv, async () => {
    if (conv.pending) await settle(provider, conv, ctx, Object.fromEntries(conv.pending.awaiting.map((id) => [id, false])), emit);
    conv.history.push(provider.userMessage(text));
    const u: DisplayItem = { type: 'user', text, at: nowIso() };
    conv.display.push(u);
    await saveConversation(conv);
    await loop(provider, conv, ctx, system, emit);
  }, provider, emit);
}

async function settle(provider: Provider, conv: Conversation, ctx: ExecCtx, decisions: Record<string, boolean>, emit: Emit) {
  const p = conv.pending!;
  for (const id of p.awaiting) {
    const call = p.calls.find((c) => c.id === id)!;
    const item = conv.display.find((d) => d.type === 'tool' && d.id === id) as Extract<DisplayItem, { type: 'tool' }> | undefined;
    if (decisions[id]) {
      p.results[id] = await runCall(ctx, call, conv, emit);
    } else {
      p.results[id] = { content: JSON.stringify({ rejected: true, message: 'The user rejected this call. Do not retry it.' }), isError: true };
      if (item) { item.status = 'rejected'; await emit('tool', item); }
    }
  }
  conv.history.push(...provider.toolResults(p.calls.map((c) => ({ id: c.id, ...(p.results[c.id] ?? { content: '{"skipped":true}', isError: true }) }))));
  conv.pending = null;
}

export async function decide(provider: Provider, conv: Conversation, decisions: Record<string, boolean>, ctx: ExecCtx, system: string, emit: Emit): Promise<void> {
  await guarded(conv, async () => {
    if (!conv.pending) return;
    await settle(provider, conv, ctx, decisions, emit);
    await saveConversation(conv);
    await loop(provider, conv, ctx, system, emit);
  }, provider, emit);
}
