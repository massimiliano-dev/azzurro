/** Provider OpenAI GPT (openai SDK, Chat Completions con function calling). */
import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionFunctionTool } from 'openai/resources/chat/completions/completions';
import { TOOL_SPECS } from './tools.ts';
import type { Provider, Turn } from './provider.ts';

import { onConfigChange } from '../overrides.ts';

export const openaiModel = (): string => process.env.AZZURRO_OPENAI_MODEL || 'gpt-5';
export const localUrl = (): string => (process.env.AZZURRO_LOCAL_AI_URL || 'http://localhost:11434/v1').replace(/\/+$/, '');
export const localModel = (): string => process.env.AZZURRO_LOCAL_MODEL || 'qwen3.8:27b';

const tools: ChatCompletionFunctionTool[] = TOOL_SPECS.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.schema },
}));

export function openaiAvailable(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

/** Modello locale (Ollama, LM Studio...) tramite l'endpoint compatibile OpenAI. */
let localUp: { ok: boolean; at: number; models: string[] } = { ok: false, at: 0, models: [] };
export async function probeLocal(): Promise<{ ok: boolean; models: string[] }> {
  if (Date.now() - localUp.at < 15_000) return localUp;
  try {
    const r = await fetch(`${localUrl()}/models`, { signal: AbortSignal.timeout(1500) });
    const j = (await r.json()) as { data?: { id: string }[] };
    localUp = { ok: r.ok, at: Date.now(), models: (j.data ?? []).map((m) => m.id) };
  } catch {
    localUp = { ok: false, at: Date.now(), models: [] };
  }
  return localUp;
}
export function localAvailable(): boolean {
  return localUp.ok && (localUp.models.length === 0 || localUp.models.some((m) => m === localModel() || m === `${localModel()}:latest`));
}

function compatible(id: Provider['id'], label: string, modelOf: () => string, make: () => OpenAI): Provider {
  let client: OpenAI | undefined;
  onConfigChange(() => { client = undefined; localUp.at = 0; });
  return {
  id,
  get model() { return modelOf(); },
  label,
  userMessage: (text) => ({ role: 'user', content: text }) satisfies ChatCompletionMessageParam,
  toolResults: (results) => results.map((r) => ({ role: 'tool', tool_call_id: r.id, content: r.content }) satisfies ChatCompletionMessageParam),
  async run(history, system, onText, onReasoning) {
    client ??= make();
    const model = modelOf();
    const stream = await client.chat.completions.create({
      model,
      messages: [{ role: 'system', content: system }, ...(history as ChatCompletionMessageParam[])],
      tools,
      tool_choice: 'auto',
      stream: true,
    });
    let text = '';
    let reasoning = '';
    let finish: string | null = null;
    let refusal = '';
    let modelName = model;
    const calls: { id: string; name: string; args: string }[] = [];
    for await (const chunk of stream) {
      modelName = chunk.model || modelName;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const d = choice.delta as typeof choice.delta & { reasoning?: string; reasoning_content?: string };
      const r = d.reasoning ?? d.reasoning_content;
      if (r) { reasoning += r; onReasoning?.(r); }
      if (d.content) { text += d.content; onText(d.content); }
      if (d.refusal) refusal += d.refusal;
      for (const tc of d.tool_calls ?? []) {
        const slot = (calls[tc.index] ??= { id: '', name: '', args: '' });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    const parsed = calls.filter(Boolean).map((c, i) => {
      let input: unknown;
      try { input = JSON.parse(c.args || '{}'); } catch { input = { __invalid_json: c.args }; }
      return { id: c.id || `call_${i}`, name: c.name, input };
    });
    const stop: Turn['stop'] = refusal ? 'refusal' : finish === 'length' ? 'max_tokens' : parsed.length ? 'tool_use' : 'end';
    const assistantMessage: ChatCompletionMessageParam = {
      role: 'assistant',
      content: text || null,
      ...(parsed.length ? { tool_calls: parsed.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.input) } })) } : {}),
    };
    return { turn: { text, reasoning: reasoning || undefined, calls: parsed, stop, model: modelName, refusal: refusal || undefined }, assistantMessage };
  },
  describeError(err) {
    if (id === 'local' && err instanceof OpenAI.APIConnectionError) return { code: 'local_unreachable', message: `The local model server at ${localUrl()} is not reachable.` };
    if (err instanceof OpenAI.AuthenticationError) return { code: 'invalid_key', message: 'OPENAI_API_KEY is not valid.' };
    if (err instanceof OpenAI.RateLimitError) return { code: 'rate_limited', message: 'OpenAI rate limit reached. Try again shortly.' };
    if (err instanceof OpenAI.APIError) return { code: 'provider_error', message: `${err.status ?? ''} ${err.message}`.trim() };
    return undefined;
  },
};
}

export const openai: Provider = compatible('openai', 'GPT', openaiModel, () => new OpenAI());
export const local: Provider = compatible('local', 'Locale', localModel, () => new OpenAI({ baseURL: localUrl(), apiKey: process.env.AZZURRO_LOCAL_AI_KEY || 'local' }));
