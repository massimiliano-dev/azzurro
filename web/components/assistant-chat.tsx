'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, Check, ChevronRight, MessageSquarePlus, Sparkles, Square, Trash2, X } from 'lucide-react';
import { portal } from '@/lib/api';
import { postSSE } from '@/lib/sse';
import { invalidateAll } from '@/lib/cache';
import { useAsync } from '@/lib/hooks';
import { useI18n, type MessageKey } from '@/i18n';
import { PageHeader } from '@/components/page';
import { Button, CodeBlock, Notice, Skeleton, Switch } from '@/components/ui';
import { Markdown } from '@/components/markdown';
import { useToast } from '@/components/overlay';

type Item =
  | { type: 'user'; text: string; at: string }
  | { type: 'assistant'; text: string; reasoning?: string; model?: string; fallbackModel?: string; at: string }
  | { type: 'tool'; id: string; name: string; input: any; kind: 'read' | 'write' | 'delete'; status: 'running' | 'ok' | 'error' | 'pending' | 'rejected'; summary: string; request?: { method: string; path: string; status: number; ms: number }; preview?: string; at: string }
  | { type: 'notice'; tone: 'warn' | 'bad'; text: string; at: string };

const SUGGESTIONS: MessageKey[] = ['ai.s1', 'ai.s2', 'ai.s3', 'ai.s4'];
const DOCK_SUGGESTIONS: MessageKey[] = ['ai.c1', 'ai.c2', 'ai.c3'];
const TOOL_LABEL: Record<string, MessageKey> = { arm_request: 'ai.tool.arm', graph_request: 'ai.tool.graph', query_costs: 'ai.tool.costs', get_pricing: 'ai.tool.pricing', estimate_resource: 'ai.tool.estimate', get_resource_type: 'ai.tool.type' };

export function AssistantChat({ mode = 'page', context, onClose }: { mode?: 'page' | 'dock'; context?: () => Record<string, unknown>; onClose?: () => void }) {
  const { t, fmtRelative } = useI18n();
  const toast = useToast();
  const status = useAsync(() => portal.get<any>('/assistant/status'), []);
  const list = useAsync(() => portal.get<{ value: any[] }>('/assistant/conversations'), []);
  const [convId, setConvId] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [pending, setPending] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [thinking, setThinking] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [provider, setProvider] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { if (!provider && status.data?.default) setProvider(status.data.default); }, [status.data, provider]);
  const DOCK_KEY = 'azzurro:dock-conversation';
  useEffect(() => {
    if (mode !== 'dock') return;
    let id: string | null = null;
    try { id = localStorage.getItem(DOCK_KEY); } catch { /* niente */ }
    if (id) void open(id).catch(() => { try { localStorage.removeItem(DOCK_KEY); } catch { /* niente */ } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);
  useEffect(() => {
    if (mode !== 'dock') return;
    try { if (convId) localStorage.setItem(DOCK_KEY, convId); else localStorage.removeItem(DOCK_KEY); } catch { /* niente */ }
  }, [mode, convId]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }); }, [items, draft]);

  const open = useCallback(async (id: string | null) => {
    abort.current?.abort();
    setConvId(id);
    setDraft('');
    if (!id) { setItems([]); setPending([]); return; }
    const c = await portal.get<any>(`/assistant/conversations/${id}`);
    setItems(c.display);
    setPending(c.pending);
    setProvider(c.provider);
    setAuto(c.autoApprove);
  }, []);

  const onEvent = useCallback((event: string, data: any) => {
    if (event === 'conversation') setConvId(data.id);
    else if (event === 'reasoning') setThinking((d) => d + data.delta);
    else if (event === 'text') setDraft((d) => d + data.delta);
    else if (event === 'message') { setDraft(''); setThinking(''); setItems((xs) => [...xs, data]); }
    else if (event === 'tool') {
      setDraft(''); setThinking('');
      setItems((xs) => {
        const i = xs.findIndex((x) => x.type === 'tool' && x.id === data.id);
        if (i < 0) return [...xs, data];
        const copy = xs.slice();
        copy[i] = data;
        return copy;
      });
    } else if (event === 'pending') setPending(data.ids);
    else if (event === 'notice' || event === 'error') setItems((xs) => [...xs, { type: 'notice', tone: event === 'error' ? 'bad' : 'warn', text: data.message ?? data.text, at: new Date().toISOString() }]);
    else if (event === 'done') { setItems(data.display); setPending(data.pending); setDraft(''); setThinking(''); if ((data.display ?? []).some((d: any) => d.type === 'tool' && d.kind !== 'read' && d.status === 'ok')) invalidateAll(); }
  }, []);

  const run = async (fn: (signal: AbortSignal) => Promise<void>) => {
    setBusy(true);
    const ctrl = new AbortController();
    abort.current = ctrl;
    try { await fn(ctrl.signal); } catch (e: any) {
      if (e?.name !== 'AbortError') toast.error(e);
    } finally {
      setBusy(false);
      setDraft('');
      setThinking('');
      list.reload();
    }
  };

  const send = (msg?: string) => {
    const m = (msg ?? text).trim();
    if (!m || busy) return;
    setText('');
    setItems((xs) => [...xs, { type: 'user', text: m, at: new Date().toISOString() }]);
    setPending([]);
    void run((signal) => postSSE('/api/portal/assistant/chat', { conversationId: convId, provider, message: m, autoApprove: auto, context: context?.() }, onEvent, signal));
  };

  const decide = (decisions: Record<string, boolean>) => {
    if (!convId) return;
    setPending([]);
    void run((signal) => postSSE(`/api/portal/assistant/conversations/${convId}/decide`, { decisions, context: context?.() }, onEvent, signal));
  };

  const providers: any[] = status.data?.providers ?? [];
  const none = status.data && !providers.some((p) => p.available);

  const chat = (
        <section className="ai-chat">
          <div className="ai-bar">
            <div className="seg" role="group" aria-label={t('ai.provider')}>
              {providers.map((p) => (
                <button key={p.id} type="button" className={provider === p.id ? 'on' : ''} disabled={!p.available || (!!convId && items.length > 0)} onClick={() => setProvider(p.id)} title={p.available ? p.model : t('ai.missingKey', { env: p.env })}>
                  {p.label} <span className="mono small">{p.model}</span>
                </button>
              ))}
            </div>
            <Switch checked={auto} onChange={setAuto} label={t('ai.auto')} />
          </div>

          {none && (
            <div className="ai-setup">
              <Notice tone="warn" title={t('ai.setupTitle')}>{t('ai.setupText')}</Notice>
              <CodeBlock value={'# .env\nANTHROPIC_API_KEY=…\nOPENAI_API_KEY=…\n# facoltativi\nAZZURRO_CLAUDE_MODEL=claude-opus-5-5\nAZZURRO_OPENAI_MODEL=gpt-5'} />
            </div>
          )}

          <div className="ai-log" aria-live="polite">
            {!items.length && !draft && !none && (
              <div className="ai-empty">
                <p className="display-sm">{t('ai.empty')}</p>
                <div className="ai-suggest">
                  {(mode === 'dock' && context?.().resourceId ? DOCK_SUGGESTIONS : SUGGESTIONS).map((k) => <button key={k} type="button" className="chip" onClick={() => send(t(k))} disabled={busy || !provider}>{t(k)}</button>)}
                </div>
                <p className="small muted">{t('ai.privacy')}</p>
              </div>
            )}
            {items.map((it, i) => <Row key={`${it.type}-${'id' in it ? it.id : i}`} it={it} pending={pending} onDecide={decide} busy={busy} />)}
            {(draft || thinking) && (
              <div className="ai-row assistant streaming"><span className="who">{t('ai.who.assistant')}</span>
                <div className="body">
                  {thinking && <details className="ai-reasoning" open={!draft}><summary>{draft ? t('ai.reasoned') : t('ai.reasoning')}</summary><div className="txt">{thinking}</div></details>}
                  {draft && <Markdown text={draft} />}
                </div>
              </div>
            )}
            {busy && !draft && !thinking && <div className="ai-row thinking"><span className="who">{t('ai.who.assistant')}</span><div className="body"><span className="dots" aria-label={t('ai.working')}><i /><i /><i /></span></div></div>}
            {pending.length > 1 && !busy && (
              <div className="ai-bulk">
                <Button variant="primary" icon={Check} onClick={() => decide(Object.fromEntries(pending.map((id) => [id, true])))}>{t('ai.approveAll')}</Button>
                <Button icon={X} onClick={() => decide(Object.fromEntries(pending.map((id) => [id, false])))}>{t('ai.rejectAll')}</Button>
              </div>
            )}
            <div ref={end} />
          </div>

          <form className="ai-compose" onSubmit={(e) => { e.preventDefault(); send(); }}>
            <textarea ref={input} rows={2} value={text} placeholder={pending.length ? t('ai.placeholderPending') : t('ai.placeholder')} disabled={!provider}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} aria-label={t('ai.placeholder')} />
            {busy
              ? <Button type="button" icon={Square} onClick={() => abort.current?.abort()}>{t('ai.stop')}</Button>
              : <Button type="submit" variant="primary" icon={ArrowUp} disabled={!text.trim() || !provider}>{t('ai.send')}</Button>}
          </form>
        </section>
  );

  if (mode === 'dock') {
    return (
      <div className="ai-dock-inner">
        <div className="ai-dock-head">
          <Sparkles size={18} aria-hidden />
          <strong>{t('ai.title')}</strong>
          <span style={{ flex: 1 }} />
          <Button size="sm" variant="ghost" icon={MessageSquarePlus} onClick={() => open(null)} title={t('ai.new')} aria-label={t('ai.new')} />
          <Button size="sm" variant="ghost" icon={X} onClick={onClose} aria-label={t('common.close')} />
        </div>
        {chat}
      </div>
    );
  }

  return (
    <>
      <PageHeader title={t('ai.title')} subtitle={t('ai.subtitle')} icon={Sparkles}
        actions={<Button icon={MessageSquarePlus} onClick={() => open(null)}>{t('ai.new')}</Button>} />
      <div className="ai-layout">
        <aside className="ai-history" aria-label={t('ai.history')}>
          <h2>{t('ai.history')}</h2>
          {!list.data ? <Skeleton rows={3} /> : list.data.value.length ? list.data.value.map((c) => (
            <div key={c.id} className={`ai-conv ${c.id === convId ? 'on' : ''}`}>
              <button type="button" onClick={() => open(c.id)}>
                <span className="t">{c.title}</span>
                <span className="small muted">{c.provider === 'openai' ? 'GPT' : c.provider === 'local' ? t('ai.local') : 'Claude'} · {fmtRelative(c.updatedAt)}{c.pending ? ` · ${t('ai.waiting')}` : ''}</span>
              </button>
              <button type="button" className="del" aria-label={t('common.delete')} onClick={async () => { await portal.del(`/assistant/conversations/${c.id}`); if (c.id === convId) open(null); list.reload(); }}><Trash2 size={14} /></button>
            </div>
          )) : <p className="small muted">{t('ai.noHistory')}</p>}
        </aside>

        {chat}
      </div>
    </>
  );
}

function Row({ it, pending, onDecide, busy }: { it: Item; pending: string[]; onDecide: (d: Record<string, boolean>) => void; busy: boolean }) {
  const { t } = useI18n();
  const [openTool, setOpenTool] = useState(false);
  if (it.type === 'user') return <div className="ai-row user"><span className="who">{t('ai.who.user')}</span><div className="body">{it.text}</div></div>;
  if (it.type === 'assistant') {
    return (
      <div className="ai-row assistant">
        <span className="who">{t('ai.who.assistant')}{it.model ? <span className="mono">{it.model}</span> : null}</span>
        <div className="body">{it.reasoning && <details className="ai-reasoning"><summary>{t('ai.reasoned')}</summary><div className="txt">{it.reasoning}</div></details>}<Markdown text={it.text} />{it.fallbackModel && <p className="small muted">{t('ai.fallback', { model: it.fallbackModel })}</p>}</div>
      </div>
    );
  }
  if (it.type === 'notice') {
    const msg = it.text === 'max_steps' ? t('ai.maxSteps') : it.text === 'max_tokens' ? t('ai.maxTokens') : it.text.startsWith('refusal') ? t('ai.refusal') : it.text;
    return <div className="ai-row notice"><Notice tone={it.tone}>{msg}</Notice></div>;
  }
  const isPending = it.status === 'pending' && pending.includes(it.id);
  const method = it.request?.method ?? (it.input?.method as string | undefined);
  const path = it.request?.path ?? (it.name === 'graph_request' ? `/v1.0${it.input?.path ?? ''}` : it.input?.path);
  return (
    <div className={`ai-row tool ${it.status} ${it.kind}`}>
      <span className="who">{t(TOOL_LABEL[it.name] ?? 'ai.tool.arm')}</span>
      <div className="body">
        <button type="button" className="ai-req" onClick={() => setOpenTool((o) => !o)} aria-expanded={openTool}>
          <ChevronRight size={14} className="chev" aria-hidden />
          {method && <span className={`m ${method}`}>{method}</span>}
          <span className="p mono">{path ?? it.summary}</span>
          <span className="s mono">{it.status === 'running' ? '…' : it.status === 'rejected' ? t('ai.rejected') : it.status === 'pending' ? t('ai.needsOk') : it.request ? `${it.request.status} · ${it.request.ms}ms` : it.status === 'error' ? t('ai.failed') : 'ok'}</span>
        </button>
        {isPending && (
          <div className="ai-approve">
            <p>{it.kind === 'delete' ? t('ai.confirmDelete') : t('ai.confirmWrite')}</p>
            {it.input?.body && <CodeBlock value={it.input.body} maxHeight={240} />}
            <div className="row">
              <Button variant={it.kind === 'delete' ? 'danger-solid' : 'primary'} icon={Check} disabled={busy} onClick={() => onDecide({ [it.id]: true })}>{it.kind === 'delete' ? t('ai.approveDelete') : t('ai.approve')}</Button>
              <Button icon={X} disabled={busy} onClick={() => onDecide({ [it.id]: false })}>{t('ai.reject')}</Button>
            </div>
          </div>
        )}
        {openTool && (
          <div className="ai-detail">
            <div className="small muted">{t('ai.input')}</div>
            <CodeBlock value={it.input} maxHeight={240} />
            {it.preview && <><div className="small muted">{t('ai.output')}</div><CodeBlock value={(() => { try { return JSON.parse(it.preview); } catch { return it.preview; } })()} maxHeight={320} /></>}
          </div>
        )}
      </div>
    </div>
  );
}
