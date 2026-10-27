/** Provider Claude (API Anthropic, @anthropic-ai/sdk). */
import Anthropic from '@anthropic-ai/sdk';
import type { BetaMessageParam, BetaTool, BetaToolUseBlock, BetaToolResultBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { TOOL_SPECS } from './tools.ts';
import type { Provider, Turn } from './provider.ts';

import { onConfigChange } from '../overrides.ts';

export const claudeModel = (): string => process.env.AZZURRO_CLAUDE_MODEL || 'claude-opus-5-5';

const tools: BetaTool[] = TOOL_SPECS.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.schema as BetaTool['input_schema'],
  eager_input_streaming: true,
}));

let client: Anthropic | undefined;
onConfigChange(() => { client = undefined; });

export function claudeAvailable(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

export const claude: Provider = {
  id: 'claude',
  get model() { return claudeModel(); },
  label: 'Claude',
  userMessage: (text) => ({ role: 'user', content: text }) satisfies BetaMessageParam,
  toolResults: (results) => [{
    role: 'user',
    content: results.map((r): BetaToolResultBlockParam => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, is_error: r.isError || undefined })),
  } satisfies BetaMessageParam],
  async run(history, system, onText, onReasoning) {
    client ??= new Anthropic();
    let jsonRetries = 0;
    for (;;) {
      const stream = client.beta.messages.stream({
        model: claudeModel(),
        max_tokens: 16000,
        system,
        tools,
        messages: history as BetaMessageParam[],
        output_config: { effort: 'medium' },
        // ragionamento riassunto e visibile all'utente nella chat
        thinking: { type: 'adaptive', display: 'summarized' },
        // se i classificatori di sicurezza rifiutano, Anthropic riesegue la richiesta su un modello di riserva
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
      let reasoning = '';
      stream.on('text', (delta) => onText(delta));
      stream.on('thinking', (delta) => { reasoning += delta; onReasoning?.(delta); });
      let message;
      try {
        message = await stream.finalMessage();
        jsonRetries = 0;
      } catch (err) {
        // con eager_input_streaming un input non analizzabile fa fallire finalMessage(): si ripete il turno
        if (err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err;
        continue;
      }
      if (message.stop_reason === 'pause_turn') {
        history.push({ role: 'assistant', content: message.content } satisfies BetaMessageParam);
        continue;
      }
      const calls = message.content.filter((b): b is BetaToolUseBlock => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input }));
      const text = message.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
      const fallback = message.content.find((b) => b.type === 'fallback') as { to?: { model?: string } } | undefined;
      const stop: Turn['stop'] = message.stop_reason === 'refusal' ? 'refusal' : message.stop_reason === 'max_tokens' ? 'max_tokens' : calls.length ? 'tool_use' : 'end';
      return {
        turn: { text, reasoning: reasoning || undefined, calls: stop === 'tool_use' ? calls : [], stop, model: message.model, fallbackModel: fallback?.to?.model, refusal: message.stop_reason === 'refusal' ? (message as { stop_details?: { explanation?: string } }).stop_details?.explanation ?? undefined : undefined },
        // il contenuto torna identico (anche i blocchi di ragionamento): sono legati a modello e conversazione
        assistantMessage: { role: 'assistant', content: message.content } satisfies BetaMessageParam,
      };
    }
  },
  describeError(err) {
    if (err instanceof Anthropic.AuthenticationError) return { code: 'invalid_key', message: 'ANTHROPIC_API_KEY is not valid.' };
    if (err instanceof Anthropic.RateLimitError) return { code: 'rate_limited', message: 'Claude rate limit reached. Try again shortly.' };
    if (err instanceof Anthropic.APIError) return { code: 'provider_error', message: `${err.status ?? ''} ${err.message}`.trim() };
    return undefined;
  },
};
