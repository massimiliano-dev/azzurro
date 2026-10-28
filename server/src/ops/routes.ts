/** Endpoint della sezione Operazioni: avvio, elenco, dettaglio, annullamento. */
import type { Hono } from 'hono';
import * as store from '../db/store.ts';
import { HttpError } from '../errors.ts';
import { readJson } from '../http.ts';
import type { AppEnv } from '../types.ts';
import { bindApp, startOperation, type Operation } from './engine.ts';
import { MOVE_STEPS, runDeleteGroup, runDeleteResources, runMove, runPower } from './kinds.ts';

const ARM_ID = /^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[^/]+(\/providers\/.+)?$/i;
const rgName = (id: string) => decodeURIComponent(id.split('/')[4] ?? id);

export function operationRoutes(app: Hono<AppEnv>): void {
  bindApp(app);

  app.get('/_portal/operations', async (c) => {
    const list = await store.list<Operation>('portalOperation', { parent: c.get('principal').oid });
    list.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return c.json({ value: list.slice(0, 200), running: list.filter((o) => o.status === 'Running').length });
  });

  app.get('/_portal/operations/:id', async (c) => {
    const op = await store.get<Operation>('portalOperation', c.req.param('id'));
    if (!op || op.userId !== c.get('principal').oid) throw new HttpError(404, 'not_found', 'Operation not found.');
    return c.json(op);
  });

  app.post('/_portal/operations/:id/cancel', async (c) => {
    const op = await store.get<Operation>('portalOperation', c.req.param('id'));
    if (!op || op.userId !== c.get('principal').oid) throw new HttpError(404, 'not_found', 'Operation not found.');
    if (op.status === 'Running') { op.cancelRequested = true; await store.put('portalOperation', op.id, op, op.userId); }
    return c.body(null, 202);
  });

  /** Toglie dall'elenco le operazioni concluse. */
  app.delete('/_portal/operations', async (c) => {
    for (const op of await store.list<Operation>('portalOperation', { parent: c.get('principal').oid })) {
      if (op.status !== 'Running') await store.remove('portalOperation', op.id);
    }
    return c.body(null, 204);
  });

  app.post('/_portal/operations', async (c) => {
    const p = c.get('principal');
    if (p.kind !== 'user') throw new HttpError(403, 'not_a_user', 'Operations require a user session.');
    const body = await readJson(c);
    const cookie = c.req.header('cookie') ?? '';
    const bad = (m: string) => new HttpError(400, 'invalid_operation', m);
    switch (body.kind) {
      case 'move': {
        const { source, target, resources } = body;
        if (!ARM_ID.test(source ?? '') || !ARM_ID.test(target ?? '') || !Array.isArray(resources) || !resources.length) throw bad('source, target and resources are required.');
        if (resources.some((r: unknown) => typeof r !== 'string' || !r.toLowerCase().startsWith(String(source).toLowerCase() + '/'))) throw bad('Every resource must belong to the source resource group.');
        const op = await startOperation({
          userId: p.oid, cookie, kind: 'move', target: source,
          title: (() => {
            // stessa sottoscrizione: basta il nome del gruppo; altrimenti si dice anche dove
            const where = String(source).split('/')[2].toLowerCase() === String(target).split('/')[2].toLowerCase() ? rgName(target) : `${rgName(target)} (${String(body.targetSubscriptionName ?? target.split('/')[2]).slice(0, 80)})`;
            return { it: `Sposta ${resources.length} risorse da ${rgName(source)} a ${where}`, en: `Move ${resources.length} resources from ${rgName(source)} to ${where}` };
          })(),
          steps: MOVE_STEPS,
          run: (ctx) => runMove(ctx, { source, target, resources, createTarget: body.createTarget ?? null, cleanup: !!body.cleanup, movesAll: !!body.movesAll }),
        });
        return c.json(op, 202);
      }
      case 'power': {
        const VERBS: Record<string, { it: string; en: string }> = {
          start: { it: 'Avvia', en: 'Start' }, stop: { it: 'Arresta', en: 'Stop' }, powerOff: { it: 'Spegni', en: 'Power off' },
          restart: { it: 'Riavvia', en: 'Restart' }, deallocate: { it: 'Dealloca', en: 'Deallocate' },
        };
        const verb = VERBS[body.action];
        if (!verb || !ARM_ID.test(body.id ?? '') || !String(body.id).includes('/providers/') || typeof body.apiVersion !== 'string') throw bad('id, action and apiVersion are required.');
        const name = decodeURIComponent(String(body.id).split('/').pop() ?? '');
        const op = await startOperation({
          userId: p.oid, cookie, kind: 'power', target: String(body.id).split('/providers/')[0],
          title: { it: `${verb.it} ${name}`, en: `${verb.en} ${name}` },
          steps: [{ key: 'action', label: { it: `${verb.it}: richiesta ad Azure e attesa del completamento`, en: `${verb.en}: request to Azure and wait for completion` } }],
          run: (ctx) => runPower(ctx, body.id, body.action, body.apiVersion),
        });
        return c.json(op, 202);
      }
      case 'deleteResourceGroup': {
        if (!ARM_ID.test(body.id ?? '') || String(body.id).includes('/providers/')) throw bad('id must be a resource group id.');
        const op = await startOperation({
          userId: p.oid, cookie, kind: 'deleteResourceGroup', target: body.id,
          title: { it: `Elimina il gruppo di risorse ${rgName(body.id)}`, en: `Delete resource group ${rgName(body.id)}` },
          steps: [{ key: 'delete', label: { it: 'Eliminazione del gruppo e di tutte le risorse', en: 'Delete the group and all its resources' } }],
          run: (ctx) => runDeleteGroup(ctx, body.id),
        });
        return c.json(op, 202);
      }
      case 'deleteResources': {
        const items = Array.isArray(body.resources) ? body.resources : [];
        if (!items.length || items.some((x: any) => !ARM_ID.test(x?.id ?? '') || typeof x?.apiVersion !== 'string')) throw bad('resources must be [{ id, apiVersion }].');
        const op = await startOperation({
          userId: p.oid, cookie, kind: 'deleteResources', target: items[0].id.split('/providers/')[0],
          title: { it: `Elimina ${items.length} risorse da ${rgName(items[0].id)}`, en: `Delete ${items.length} resources from ${rgName(items[0].id)}` },
          steps: [{ key: 'delete', label: { it: 'Eliminazione delle risorse', en: 'Delete the resources' } }],
          run: (ctx) => runDeleteResources(ctx, items),
        });
        return c.json(op, 202);
      }
      default:
        throw bad(`Unknown operation kind '${body.kind}'.`);
    }
  });
}
