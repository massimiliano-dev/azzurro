import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFilter, applyOrderBy, parseFilter } from '../../src/odata.ts';

const apps = [
  { displayName: 'Contoso API', appId: '11111111-1111-1111-1111-111111111111', identifierUris: ['api://contoso'], web: { redirectUris: ['https://a'] } },
  { displayName: 'beta tool', appId: '22222222-2222-2222-2222-222222222222', identifierUris: [], web: { redirectUris: [] } },
];

test('eq è case-insensitive sulle stringhe', () => {
  assert.equal(applyFilter(apps, "displayName eq 'contoso api'").length, 1);
});

test('startswith, and/or, not', () => {
  assert.equal(applyFilter(apps, "startswith(displayName,'beta') or displayName eq 'x'").length, 1);
  assert.equal(applyFilter(apps, "not startswith(displayName,'beta')").length, 1);
});

test('guid non quotato e lambda any()', () => {
  assert.equal(applyFilter(apps, 'appId eq 22222222-2222-2222-2222-222222222222').length, 1);
  assert.equal(applyFilter(apps, "identifierUris/any(x:x eq 'api://contoso')").length, 1);
  assert.equal(applyFilter(apps, "web/redirectUris/any(u:startswith(u,'https'))").length, 1);
});

test('in (...) e substringof ARM', () => {
  assert.equal(applyFilter(apps, "displayName in ('beta tool','nope')").length, 1);
  assert.equal(applyFilter(apps, "substringof('ontoso', displayName)").length, 1);
});

test('orderby desc', () => {
  assert.deepEqual(applyOrderBy(apps, 'displayName desc').map((a) => a.displayName), ['Contoso API', 'beta tool'].sort((a, b) => b.localeCompare(a, undefined, { sensitivity: 'base' })));
});

test('filtro malformato produce errore', () => {
  assert.throws(() => parseFilter("displayName eq 'x"));
});
