import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idParts, isAncestorOrSelf, parseArmPath } from '../../src/arm/path.ts';

const sub = '/subscriptions/0000/resourceGroups/rg1';

test('risorsa top-level', () => {
  const p = parseArmPath(`${sub}/providers/Microsoft.Storage/storageAccounts/acct`);
  assert.equal(p.k, 'res');
  if (p.k !== 'res') return;
  assert.deepEqual(p.types, ['storageAccounts']);
  assert.deepEqual(p.names, ['acct']);
  assert.equal(p.scope, sub);
});

test('figlio e azione', () => {
  const p = parseArmPath(`${sub}/providers/Microsoft.Storage/storageAccounts/acct/blobServices/default/containers/c1`);
  assert.ok(p.k === 'res' && p.types.length === 3 && p.names.length === 3);
  const a = parseArmPath(`${sub}/providers/Microsoft.Storage/storageAccounts/acct/listKeys`);
  assert.ok(a.k === 'res' && a.types.length === 2 && a.names.length === 1);
});

test('risorsa di estensione: lo scope diventa la risorsa', () => {
  const p = parseArmPath(`${sub}/providers/Microsoft.Storage/storageAccounts/acct/providers/Microsoft.Authorization/roleAssignments/abc`);
  assert.ok(p.k === 'res');
  if (p.k !== 'res') return;
  assert.equal(p.ns, 'Microsoft.Authorization');
  assert.equal(p.scope, `${sub}/providers/Microsoft.Storage/storageAccounts/acct`);
});

test('gruppi di risorse, sottoscrizioni, tenant', () => {
  assert.equal(parseArmPath('/subscriptions').k, 'subscriptions');
  assert.equal(parseArmPath('/subscriptions/0000/resourcegroups').k, 'resourceGroups');
  assert.equal(parseArmPath('/subscriptions/0000/resourceGroups/rg1/exportTemplate').k, 'rgAction');
  assert.equal(parseArmPath('/providers/Microsoft.Subscription/aliases/x').k, 'res');
});

test('ereditarietà degli scope', () => {
  assert.ok(isAncestorOrSelf('/', sub));
  assert.ok(isAncestorOrSelf('/subscriptions/0000', sub + '/providers/X/y/z'));
  assert.ok(!isAncestorOrSelf('/subscriptions/0000/resourceGroups/rg', sub));
  assert.deepEqual(idParts(`${sub}/providers/Microsoft.Web/sites/app`), { subscriptionId: '0000', resourceGroup: 'rg1', provider: 'Microsoft.Web', type: 'Microsoft.Web/sites', name: 'app' });
});
