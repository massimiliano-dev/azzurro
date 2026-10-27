import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTemplate, type EngineHost, type RunInput } from '../../src/arm/templates.ts';

function fakeHost(): EngineHost & { puts: { id: string; body: any }[] } {
  const store = new Map<string, any>();
  const puts: { id: string; body: any }[] = [];
  return {
    puts,
    dryRun: false,
    origin: 'http://localhost:4000',
    tenantId: 't0',
    async getResourceGroup(sub, rg) { return { id: `/subscriptions/${sub}/resourceGroups/${rg}`, name: rg, location: 'westeurope', tags: {} }; },
    async getSubscription(sub) { return { subscriptionId: sub, displayName: 'Sub' }; },
    async get(id) { return store.get(id.toLowerCase()) ?? null; },
    async put(id, _v, body) {
      puts.push({ id, body });
      const r = { id, name: id.split('/').pop(), ...body, properties: { ...(body.properties ?? {}), provisioningState: 'Succeeded', computed: id.split('/').pop() } };
      store.set(id.toLowerCase(), r);
      return { status: 201, body: r };
    },
    async action(id, action) { return { action, id, keys: [{ value: 'k1' }] }; },
    async remove() {},
    async listGroupResources() { return []; },
    async nested(input) {
      const r = await runTemplate({ template: input.properties.template, parameters: input.properties.parameters, scope: input.scope, deploymentName: input.name, host: this, outer: input.outer });
      return { properties: { outputs: r.outputs } };
    },
    async keyVaultSecret() { return 's3cr3t'; },
    async fetchJson() { return {}; },
    async templateSpec() { return null; },
    async operation() {},
    canceled() { return false; },
  };
}

const scope = { level: 'resourceGroup' as const, subscriptionId: 'sub1', resourceGroup: 'rg1' };
const run = (template: any, parameters: any = {}, host = fakeHost()) => runTemplate({ template: { $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#', contentVersion: '1.0.0.0', ...template }, parameters, scope, deploymentName: 'd', host } as RunInput);

test('funzioni stringa, array, oggetti, numeri', async () => {
  const r = await run({ outputs: {
    a: { type: 'string', value: "[concat('a', 'b', string(1))]" },
    b: { type: 'array', value: "[union(createArray(1,2), createArray(2,3))]" },
    c: { type: 'object', value: "[union(createObject('x', createObject('y', 1)), createObject('x', createObject('z', 2)))]" },
    d: { type: 'int', value: "[add(mul(2, 3), div(7, 2))]" },
    e: { type: 'string', value: "[format('{0}-{1:D3}', 'n', 7)]" },
    f: { type: 'bool', value: "[and(startsWith('Hello', 'he'), not(empty('x')), contains(createArray('a'), 'a'))]" },
    g: { type: 'string', value: "[toUpper(substring('azzurro', 0, 3))]" },
    h: { type: 'array', value: "[split('a,b;c', createArray(',', ';'))]" },
    i: { type: 'string', value: "[last(split('/a/b/c', '/'))]" },
    j: { type: 'string', value: "[if(equals(1, 1), 'yes', 'no')]" },
    k: { type: 'array', value: "[range(5, 3)]" },
    l: { type: 'string', value: "[[literal]" },
  } });
  assert.equal(r.outputs.a.value, 'ab1');
  assert.deepEqual(r.outputs.b.value, [1, 2, 3]);
  assert.deepEqual(r.outputs.c.value, { x: { y: 1, z: 2 } });
  assert.equal(r.outputs.d.value, 9);
  assert.equal(r.outputs.e.value, 'n-007');
  assert.equal(r.outputs.f.value, true);
  assert.equal(r.outputs.g.value, 'AZZ');
  assert.deepEqual(r.outputs.h.value, ['a', 'b', 'c']);
  assert.equal(r.outputs.i.value, 'c');
  assert.equal(r.outputs.j.value, 'yes');
  assert.deepEqual(r.outputs.k.value, [5, 6, 7]);
  assert.equal(r.outputs.l.value, '[literal]');
});

test('lambda: filter, map, reduce, sort, toObject', async () => {
  const r = await run({ variables: { nums: [3, 1, 2] }, outputs: {
    f: { type: 'array', value: "[filter(variables('nums'), lambda('n', greater(lambdaVariables('n'), 1)))]" },
    m: { type: 'array', value: "[map(variables('nums'), lambda('n', mul(lambdaVariables('n'), 10)))]" },
    r: { type: 'int', value: "[reduce(variables('nums'), 0, lambda('acc', 'n', add(lambdaVariables('acc'), lambdaVariables('n'))))]" },
    s: { type: 'array', value: "[sort(variables('nums'), lambda('a', 'b', less(lambdaVariables('a'), lambdaVariables('b'))))]" },
    o: { type: 'object', value: "[toObject(createArray('a', 'b'), lambda('x', lambdaVariables('x')), lambda('x', length(lambdaVariables('x'))))]" },
  } });
  assert.deepEqual(r.outputs.f.value, [3, 2]);
  assert.deepEqual(r.outputs.m.value, [30, 10, 20]);
  assert.equal(r.outputs.r.value, 6);
  assert.deepEqual(r.outputs.s.value, [1, 2, 3]);
  assert.deepEqual(r.outputs.o.value, { a: 1, b: 1 });
});

test('resourceId e funzioni di scope', async () => {
  const r = await run({ outputs: {
    id: { type: 'string', value: "[resourceId('Microsoft.Network/virtualNetworks/subnets', 'vnet', 'sn')]" },
    sid: { type: 'string', value: "[subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'abc')]" },
    rg: { type: 'string', value: '[resourceGroup().location]' },
    cidr: { type: 'string', value: "[cidrSubnet('10.0.0.0/16', 24, 3)]" },
    u: { type: 'bool', value: "[equals(uniqueString('a'), uniqueString('a'))]" },
    g: { type: 'string', value: "[guid('x', 'y')]" },
  } });
  assert.equal(r.outputs.id.value, '/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.Network/virtualNetworks/vnet/subnets/sn');
  assert.equal(r.outputs.sid.value, '/subscriptions/sub1/providers/Microsoft.Authorization/roleDefinitions/abc');
  assert.equal(r.outputs.rg.value, 'westeurope');
  assert.equal(r.outputs.cidr.value, '10.0.3.0/24');
  assert.equal(r.outputs.u.value, true);
  assert.match(String(r.outputs.g.value), /^[0-9a-f-]{36}$/);
});

test('parametri: default, allowedValues, tipo, parametri sconosciuti', async () => {
  const tpl = { parameters: { env: { type: 'string', allowedValues: ['dev', 'prod'], defaultValue: 'dev' }, n: { type: 'int', defaultValue: 2 } }, outputs: { o: { type: 'string', value: "[format('{0}{1}', parameters('env'), parameters('n'))]" } } };
  assert.equal((await run(tpl)).outputs.o.value, 'dev2');
  await assert.rejects(run(tpl, { env: { value: 'test' } }), /not part of the allowed value/);
  await assert.rejects(run(tpl, { n: { value: 'x' } }), /Expected a value of type 'Integer'/);
  await assert.rejects(run(tpl, { zzz: { value: 1 } }), /not present in the original template/);
});

test('copy su risorse e proprietà, condition, dipendenze implicite via reference()', async () => {
  const host = fakeHost();
  const r = await run({
    resources: [
      { type: 'Microsoft.Storage/storageAccounts', apiVersion: '2023-01-01', name: "[format('st{0}', copyIndex())]", location: 'westeurope', copy: { name: 'loop', count: 3 } },
      { type: 'Microsoft.Web/sites', apiVersion: '2023-01-01', name: 'web', location: 'westeurope', properties: { dep: "[reference('st2').computed]", copy: [{ name: 'items', count: 2, input: "[copyIndex('items')]" }] } },
      { condition: false, type: 'Microsoft.Web/sites', apiVersion: '2023-01-01', name: 'skipped', location: 'westeurope' },
    ],
    outputs: { o: { type: 'string', value: "[reference('web').dep]" }, items: { type: 'array', value: "[reference('web').items]" } },
  }, {}, host);
  assert.equal(host.puts.length, 4);
  assert.equal(host.puts[3].id.endsWith('/sites/web'), true);
  assert.equal(r.outputs.o.value, 'st2');
  assert.deepEqual(r.outputs.items.value, [0, 1]);
});

test('languageVersion 2.0: nomi simbolici, existing, funzioni utente', async () => {
  const host = fakeHost();
  await host.put('/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.Storage/storageAccounts/old', '', { location: 'westeurope' });
  const r = await run({
    languageVersion: '2.0',
    functions: [{ namespace: '__bicep', members: { pref: { parameters: [{ name: 'n', type: 'string' }], output: { type: 'string', value: "[format('x-{0}', parameters('n'))]" } } } }],
    resources: {
      old: { existing: true, type: 'Microsoft.Storage/storageAccounts', apiVersion: '2023-01-01', name: 'old' },
      site: { type: 'Microsoft.Web/sites', apiVersion: '2023-01-01', name: "[__bicep.pref('app')]", location: 'westeurope', properties: { from: "[reference('old').computed]" }, dependsOn: ['old'] },
    },
    outputs: { name: { type: 'string', value: "[reference('site').from]" }, n: { type: 'string', value: "[__bicep.pref('z')]" } },
  }, {}, host);
  assert.equal(r.outputs.name.value, 'old');
  assert.equal(r.outputs.n.value, 'x-z');
});

test('deployment annidato inner con output', async () => {
  const r = await run({
    resources: [{
      type: 'Microsoft.Resources/deployments', apiVersion: '2022-09-01', name: 'mod',
      properties: { mode: 'Incremental', expressionEvaluationOptions: { scope: 'inner' }, parameters: { v: { value: 'hi' } },
        template: { $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#', contentVersion: '1.0.0.0', parameters: { v: { type: 'string' } }, outputs: { echo: { type: 'string', value: "[toUpper(parameters('v'))]" } } } },
    }],
    outputs: { o: { type: 'string', value: "[reference('mod').outputs.echo.value]" } },
  });
  assert.equal(r.outputs.o.value, 'HI');
});

test('dipendenza circolare', async () => {
  await assert.rejects(run({ resources: [
    { type: 'Microsoft.Web/sites', apiVersion: '1', name: 'a', location: 'x', dependsOn: ['b'] },
    { type: 'Microsoft.Web/sites', apiVersion: '1', name: 'b', location: 'x', dependsOn: ['a'] },
  ] }), /Circular dependency/);
});
