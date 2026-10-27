import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

process.env.AZZURRO_DB_SCHEMA = 'azzurro_test';
process.env.AZZURRO_QUIET = '1';

let app: any;
let closeDb: () => Promise<void>;
let cookie: string;
let userId: string;
let sub: string;

before(async () => {
  const { config } = await import('../../src/config.ts');
  const admin = new pg.Client({ connectionString: config.databaseUrl });
  await admin.connect();
  await admin.query('DROP SCHEMA IF EXISTS azzurro_test CASCADE');
  await admin.end();
  const db = await import('../../src/db/pool.ts');
  closeDb = db.closeDb;
  await db.initDb(config.databaseUrl, 'azzurro_test');
  await (await import('../../src/auth/keys.ts')).initKeys();
  await (await import('../../src/seed.ts')).seed();
  (await import('../../src/push.ts')).initPush();
  app = (await import('../../src/app.ts')).createApp();
  const { userByUpn } = await import('../../src/directory.ts');
  userId = (await userByUpn('admin@azzurro.local')).id;
  const s = await (await import('../../src/auth/session.ts')).createSession(userId, { source: 'test' });
  const { SESSION_COOKIE } = await import('../../src/http.ts');
  cookie = `${SESSION_COOKIE}=${s.id}`;
  const store = await import('../../src/db/store.ts');
  sub = (await store.list('subscription'))[0].subscriptionId;
});

after(async () => closeDb?.());

/** Provider finto: segue un copione di turni, registrando ciò che riceve. */
function scripted(turns: any[]) {
  const seen: any[] = [];
  let i = 0;
  const p = {
    id: 'claude' as const, model: 'fake', label: 'Fake',
    userMessage: (text: string) => ({ role: 'user', content: text }),
    toolResults: (results: any[]) => [{ role: 'user', content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, is_error: r.isError })) }],
    async run(history: any[], _system: string, onText: (d: string) => void) {
      seen.push(JSON.parse(JSON.stringify(history)));
      const t = turns[i++] ?? { text: 'fine', calls: [] };
      if (t.text) onText(t.text);
      return { turn: { text: t.text ?? '', calls: t.calls ?? [], stop: t.calls?.length ? 'tool_use' : 'end', model: 'fake' }, assistantMessage: { role: 'assistant', content: t.text ?? '', calls: t.calls } };
    },
    describeError: () => undefined,
  };
  return { p, seen };
}

test('assistente: letture automatiche, scrittura in attesa di conferma, ripresa dopo approvazione', async () => {
  const agent = await import('../../src/assistant/agent.ts');
  const ctx = { app, cookie, userId };
  const rgPath = `/subscriptions/${sub}/resourceGroups/rg-assistente`;
  const { p, seen } = scripted([
    { text: 'Controllo i gruppi.', calls: [{ id: 't1', name: 'arm_request', input: { method: 'GET', path: `/subscriptions/${sub}/resourcegroups` } }] },
    { calls: [{ id: 't2', name: 'arm_request', input: { method: 'PUT', path: rgPath, body: { location: 'westeurope' } } }] },
    { text: 'Gruppo creato.' },
  ]);
  const conv = agent.newConversation(userId, 'claude', 'crea un gruppo', false);
  const events: string[] = [];
  const emit = (e: string) => { events.push(e); };
  await agent.chat(p as any, conv, 'crea un gruppo di risorse', ctx, 'system', emit);
  assert.deepEqual(conv.pending?.awaiting, ['t2'], 'la PUT deve attendere conferma');
  const t1 = conv.display.find((d: any) => d.id === 't1') as any;
  assert.equal(t1.status, 'ok');
  assert.equal(t1.request.status, 200);
  assert.ok(events.includes('pending'));
  // la risorsa non esiste ancora
  const before = await app.request(`${rgPath}?api-version=2021-04-01`, { headers: { cookie } });
  assert.equal(before.status, 404);

  await agent.decide(p as any, conv, { t2: true }, ctx, 'system', emit);
  assert.equal(conv.pending, null);
  const afterRes = await app.request(`${rgPath}?api-version=2021-04-01`, { headers: { cookie } });
  assert.equal(afterRes.status, 200);
  const last = conv.display.at(-1) as any;
  assert.equal(last.type, 'assistant');
  assert.equal(last.text, 'Gruppo creato.');
  // il terzo turno ha ricevuto il tool_result della PUT
  const results = seen[2].at(-1).content;
  assert.equal(results[0].tool_use_id, 't2');
  assert.match(results[0].content, /"status":20[01]/);
});

test('assistente: eliminazione rifiutata, segreti nascosti, costi e listino', async () => {
  const agent = await import('../../src/assistant/agent.ts');
  const tools = await import('../../src/assistant/tools.ts');
  const ctx = { app, cookie, userId };
  const sa = `/subscriptions/${sub}/resourceGroups/rg-assistente/providers/Microsoft.Storage/storageAccounts/stassistente01`;
  const put = await app.request(`${sa}?api-version=2023-05-01`, { method: 'PUT', headers: { cookie, 'X-Azzurro-Portal': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'westeurope', kind: 'StorageV2', sku: { name: 'Standard_LRS' } }) });
  assert.ok(put.status < 300, String(put.status));

  const keys = await tools.execute(ctx, 'arm_request', { method: 'POST', path: `${sa}/listKeys` });
  assert.equal(tools.classify('arm_request', { method: 'POST', path: `${sa}/listKeys` }), 'read');
  assert.doesNotMatch(keys.content, /"value":"[A-Za-z0-9+/=]{30,}"/, 'le chiavi non devono arrivare al modello');
  assert.match(keys.content, /hidden/);

  const costs = await tools.execute(ctx, 'query_costs', { scope: `/subscriptions/${sub}`, group_by: ['ServiceName'] });
  assert.equal(costs.isError, false, costs.content);
  assert.match(costs.content, /Storage/);
  const price = await tools.execute(ctx, 'get_pricing', { resource_type: 'Microsoft.Web/serverfarms' });
  assert.match(price.content, /P1v3/);
  const est = await tools.execute(ctx, 'estimate_resource', { resource_id: sa });
  assert.match(est.content, /Standard_LRS/);
  assert.match(tools.defaultApiVersion(`${sa}/blobServices/default/containers/x`), /^\d{4}-\d{2}-\d{2}/);

  const { p } = scripted([
    { calls: [{ id: 'd1', name: 'arm_request', input: { method: 'DELETE', path: sa } }] },
    { text: 'Va bene, non elimino.' },
  ]);
  const conv = agent.newConversation(userId, 'claude', 'elimina', true);
  await agent.chat(p as any, conv, 'elimina lo storage', ctx, 'system', () => {});
  assert.deepEqual(conv.pending?.awaiting, ['d1'], 'le eliminazioni chiedono sempre conferma, anche in automatico');
  await agent.decide(p as any, conv, { d1: false }, ctx, 'system', () => {});
  const still = await app.request(`${sa}?api-version=2023-05-01`, { headers: { cookie } });
  assert.equal(still.status, 200, 'la risorsa deve esistere ancora');
  assert.equal((conv.display.find((d: any) => d.id === 'd1') as any).status, 'rejected');
});

test('cost management: query, forecast, budget e risorse eliminate nello storico', async () => {
  const H = { cookie, 'X-Azzurro-Portal': '1', 'Content-Type': 'application/json' };
  const q = await app.request(`/subscriptions/${sub}/providers/Microsoft.CostManagement/query?api-version=2023-03-01`, { method: 'POST', headers: H, body: JSON.stringify({ type: 'ActualCost', timeframe: 'MonthToDate', dataset: { granularity: 'Daily', aggregation: { totalCost: { name: 'Cost', function: 'Sum' } }, grouping: [{ type: 'Dimension', name: 'ResourceGroupName' }] } }) });
  assert.equal(q.status, 200);
  const qj = await q.json();
  assert.deepEqual(qj.properties.columns.map((c: any) => c.name), ['Cost', 'UsageDate', 'ResourceGroupName', 'Currency']);
  const bad = await app.request(`/subscriptions/${sub}/providers/Microsoft.CostManagement/query?api-version=2023-03-01`, { method: 'POST', headers: H, body: JSON.stringify({ timeframe: 'Custom' }) });
  assert.equal(bad.status, 400);

  const b = await app.request(`/subscriptions/${sub}/providers/Microsoft.Consumption/budgets/test?api-version=2023-05-01`, { method: 'PUT', headers: H, body: JSON.stringify({ properties: { category: 'Cost', amount: 10, timeGrain: 'Monthly', timePeriod: { startDate: '2026-01-01T00:00:00Z' } } }) });
  assert.equal(b.status < 300, true);
  const list = await (await app.request(`/subscriptions/${sub}/providers/Microsoft.Consumption/budgets?api-version=2023-05-01`, { headers: H })).json();
  assert.equal(list.value.length, 1);
  assert.equal(list.value[0].properties.currentSpend.unit, 'EUR');

  const store = await import('../../src/db/store.ts');
  const sa = `/subscriptions/${sub}/resourceGroups/rg-assistente/providers/Microsoft.Storage/storageAccounts/stassistente01`;
  const del = await app.request(`${sa}?api-version=2023-05-01`, { method: 'DELETE', headers: H });
  assert.ok(del.status < 300);
  const retired = await store.list('retiredResource', { prefix: sa.toLowerCase() });
  assert.equal(retired.length, 1, 'la risorsa eliminata resta nello storico dei costi');
});
