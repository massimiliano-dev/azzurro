/**
 * Operazioni in background, come le operazioni asincrone di Azure: partono per conto proprio,
 * proseguono anche chiudendo il pannello o il browser, e si seguono nella sezione Operazioni.
 * Ogni operazione è fatta di passi con stato; le chiamate ARM passano dall'app con la sessione
 * dell'utente, quindi valgono i suoi permessi e la directory attiva (emulatore o Azure reale).
 */
import type { Hono } from 'hono';
import * as store from '../db/store.ts';
import { nowIso, uuid } from '../ids.ts';
import { notifyLater } from '../push.ts';
import type { AppEnv } from '../types.ts';

export type Lang = { it: string; en: string };
export type StepStatus = 'todo' | 'run' | 'ok' | 'error' | 'skip';
export interface OpStep { key: string; label: Lang; status: StepStatus; startedAt?: string; endedAt?: string; detail?: string }
export interface OpError { code: string; message: string; details?: { code?: string; message?: string; target?: string }[] }
export interface Operation {
  id: string;
  userId: string;
  kind: string;
  title: Lang;
  /** risorsa o gruppo su cui lavora, e dove portare l'utente alla fine */
  target?: string;
  href?: string;
  status: 'Running' | 'Succeeded' | 'Failed' | 'Canceled';
  startedAt: string;
  endedAt?: string;
  steps: OpStep[];
  error?: OpError;
  note?: Lang;
  cancelRequested?: boolean;
}

export class Canceled extends Error {}

let app: Hono<AppEnv> | null = null;
export function bindApp(a: Hono<AppEnv>): void { app = a; }

/** Contesto di un'operazione in corso: chiamate ARM con la sessione dell'utente e avanzamento dei passi. */
export class OpCtx {
  readonly op: Operation;
  private cookie: string;
  constructor(op: Operation, cookie: string) {
    this.op = op;
    this.cookie = cookie;
  }

  async save(): Promise<void> {
    await store.put('portalOperation', this.op.id, this.op, this.op.userId);
  }

  async arm(method: string, path: string, apiVersion: string, body?: unknown): Promise<{ status: number; json: any; headers: Headers }> {
    const url = `${path}${path.includes('?') ? '&' : '?'}api-version=${apiVersion}`;
    const res = await app!.request(url, {
      method,
      headers: { cookie: this.cookie, 'X-Azzurro-Portal': '1', 'Content-Type': 'application/json', 'User-Agent': 'Azzurro-Operations' },
      body: body === undefined || method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    if (res.status >= 400) throw armFailure(res.status, json);
    return { status: res.status, json, headers: res.headers };
  }

  /** Chiamata che su Azure può rispondere 202: si segue Location / Azure-AsyncOperation fino alla fine. */
  async armLongRunning(method: string, path: string, apiVersion: string, body?: unknown): Promise<any> {
    const first = await this.arm(method, path, apiVersion, body);
    if (first.status !== 202 && first.status !== 201) return first.json;
    const asyncUrl = first.headers.get('azure-asyncoperation');
    const target = asyncUrl ?? first.headers.get('location');
    if (!target) return first.json;
    const rel = target.replace(/^https?:\/\/[^/]+/, '');
    let retry = Number(first.headers.get('retry-after') ?? 5);
    for (;;) {
      await sleep(Math.min(Math.max(retry, 2), 30) * 1000);
      this.checkCancel();
      const res = await app!.request(rel, { headers: { cookie: this.cookie, 'X-Azzurro-Portal': '1' } });
      const text = await res.text();
      let json: any = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = text; }
      if (res.status >= 400) throw armFailure(res.status, json);
      retry = Number(res.headers.get('retry-after') ?? retry);
      if (asyncUrl) {
        if (/^succeeded$/i.test(json?.status)) return json;
        if (/^(failed|canceled)$/i.test(json?.status)) throw armFailure(400, json);
      } else if (res.status !== 202) return json;
    }
  }

  checkCancel(): void {
    if (this.op.cancelRequested) throw new Canceled('Canceled by the user.');
  }

  /** Esegue un passo: stato "in corso", poi "fatto" o "errore", salvando a ogni cambio. */
  async step<T>(key: string, fn: () => Promise<T | 'skip'>): Promise<T | undefined> {
    const s = this.op.steps.find((x) => x.key === key)!;
    this.checkCancel();
    s.status = 'run';
    s.startedAt = nowIso();
    await this.save();
    try {
      const r = await fn();
      s.status = r === 'skip' ? 'skip' : 'ok';
      s.endedAt = nowIso();
      await this.save();
      return r === 'skip' ? undefined : r;
    } catch (e) {
      s.status = 'error';
      s.endedAt = nowIso();
      s.detail = (e as Error).message;
      await this.save();
      throw e;
    }
  }

  skip(key: string): void {
    const s = this.op.steps.find((x) => x.key === key);
    if (s) s.status = 'skip';
  }
}

function armFailure(status: number, json: any): Error {
  const err = json?.error ?? {};
  return Object.assign(new Error(err.message ?? `HTTP ${status}`), { code: err.code ?? `HTTP${status}`, details: err.details, status });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Avvia un'operazione e restituisce subito il suo stato iniziale. */
export async function startOperation(o: {
  userId: string;
  cookie: string;
  kind: string;
  title: Lang;
  target?: string;
  steps: { key: string; label: Lang }[];
  run: (ctx: OpCtx) => Promise<{ href?: string; note?: Lang } | void>;
}): Promise<Operation> {
  const op: Operation = {
    id: uuid(), userId: o.userId, kind: o.kind, title: o.title, target: o.target,
    status: 'Running', startedAt: nowIso(), steps: o.steps.map((s) => ({ ...s, status: 'todo' as const })),
  };
  const ctx = new OpCtx(op, o.cookie);
  await ctx.save();
  setImmediate(async () => {
    try {
      const r = await o.run(ctx);
      if (r?.href) op.href = r.href;
      if (r?.note) op.note = r.note;
      op.status = 'Succeeded';
    } catch (e) {
      const x = e as Error & { code?: string; details?: OpError['details'] };
      op.status = e instanceof Canceled ? 'Canceled' : 'Failed';
      if (!(e instanceof Canceled)) op.error = { code: x.code ?? 'OperationFailed', message: x.message, details: x.details };
      if ((e as { note?: Lang }).note) op.note = (e as { note?: Lang }).note;
    } finally {
      for (const s of op.steps) if (s.status === 'todo' && op.status !== 'Succeeded') s.status = 'skip';
      op.endedAt = nowIso();
      await ctx.save().catch(() => undefined);
      notifyLater([op.userId], {
        category: 'resources',
        key: op.status === 'Succeeded' ? 'operationSucceeded' : op.status === 'Canceled' ? 'operationCanceled' : 'operationFailed',
        params: { title: op.title.it, error: op.error?.message ?? '' },
        localizedParams: { en: { title: op.title.en } },
        url: `/operations?id=${op.id}`,
      });
    }
  });
  return op;
}

/** All'avvio: le operazioni rimaste "in corso" sono state interrotte dal riavvio del server. */
export async function recoverOperations(): Promise<void> {
  for (const op of await store.list<Operation>('portalOperation', { match: { status: 'Running' } })) {
    op.status = 'Failed';
    op.endedAt = nowIso();
    op.error = { code: 'ServerRestarted', message: 'The operation was interrupted because Azzurro restarted. Check the resources and run it again if needed.' };
    for (const s of op.steps) if (s.status === 'run') s.status = 'error';
    await store.put('portalOperation', op.id, op, op.userId);
  }
}
