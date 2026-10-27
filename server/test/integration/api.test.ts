import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

process.env.AZZURRO_DB_SCHEMA = 'azzurro_test';
process.env.AZZURRO_QUIET = '1';

let app: any;
let closeDb: () => Promise<void>;
let tid: string;
let sub: string;
let armToken: string;
let graphToken: string;
const B = 'http://localhost:4000';
const CLI = '04b07795-8ddb-461a-bbee-02f9e1bf7b46';

async function req(method: string, path: string, opts: { token?: string; body?: any; form?: Record<string, string> } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let body: string | undefined;
  if (opts.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(opts.form).toString();
  } else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await app.request(`${B}${path}`, { method, headers, body });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, headers: res.headers };
}

async function token(scope: string, user = 'admin@azzurro.local', password = 'Azzurro123!') {
  const r = await req('POST', `/${tid}/oauth2/v2.0/token`, { form: { grant_type: 'password', client_id: CLI, username: user, password, scope } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.access_token as string;
}

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
  tid = (await import('../../src/directory.ts')).tenant().id;
  armToken = await token('https://management.core.windows.net//.default');
  graphToken = await token('https://graph.microsoft.com/.default');
  const subs = await req('GET', '/subscriptions?api-version=2022-12-01', { token: armToken });
  sub = subs.json.value[0].subscriptionId;
});

after(async () => {
  await new Promise((r) => setTimeout(r, 300));
  await closeDb?.();
});

test('discovery OIDC e metadata del cloud', async () => {
  const oidc = await req('GET', `/${tid}/v2.0/.well-known/openid-configuration`);
  assert.equal(oidc.json.issuer, `${B}/${tid}/v2.0`);
  const keys = await req('GET', `/${tid}/discovery/v2.0/keys`);
  assert.equal(keys.json.keys[0].kty, 'RSA');
  const meta = await req('GET', '/metadata/endpoints?api-version=2022-09-01');
  assert.equal(meta.json[0].resourceManager, `${B}/`);
});

test('credenziali errate e richieste senza token', async () => {
  const bad = await req('POST', `/${tid}/oauth2/v2.0/token`, { form: { grant_type: 'password', client_id: CLI, username: 'admin@azzurro.local', password: 'x', scope: 'openid' } });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.json.error_codes, [50126]);
  const anon = await req('GET', '/subscriptions?api-version=2022-12-01');
  assert.equal(anon.status, 401);
  assert.equal(anon.json.error.code, 'AuthenticationFailed');
});

test('gruppo di risorse e risorsa: CRUD, tag, lock, cascata', async () => {
  const rg = `/subscriptions/${sub}/resourceGroups/it-rg`;
  assert.equal((await req('PUT', `${rg}?api-version=2021-04-01`, { token: armToken, body: { location: 'West Europe' } })).status, 201);
  assert.equal((await req('PUT', `${rg}?api-version=2021-04-01`, { token: armToken, body: { location: 'northeurope' } })).status, 409);
  const st = `${rg}/providers/Microsoft.Storage/storageAccounts/itstorage01`;
  const created = await req('PUT', `${st}?api-version=2023-01-01`, { token: armToken, body: { location: 'westeurope', sku: { name: 'Standard_GRS' } } });
  assert.equal(created.status, 201);
  assert.equal(created.json.properties.primaryEndpoints.blob, 'https://itstorage01.blob.core.windows.net/');
  assert.equal(created.json.properties.secondaryLocation, 'northeurope');
  const upper = await req('GET', `/subscriptions/${sub}/RESOURCEGROUPS/IT-RG/providers/microsoft.storage/STORAGEACCOUNTS/ITSTORAGE01?api-version=2023-01-01`, { token: armToken });
  assert.equal(upper.json.name, 'itstorage01', 'gli id ARM sono case-insensitive');
  const invalidName = await req('PUT', `${rg}/providers/Microsoft.Storage/storageAccounts/Bad_Name?api-version=2023-01-01`, { token: armToken, body: { location: 'westeurope' } });
  assert.equal(invalidName.json.error.code, 'AccountNameInvalid');
  const container = await req('PUT', `${st}/blobServices/default/containers/data?api-version=2023-01-01`, { token: armToken, body: { properties: {} } });
  assert.equal(container.status, 201);
  const keys = await req('POST', `${st}/listKeys?api-version=2023-01-01`, { token: armToken });
  assert.equal(keys.json.keys.length, 2);
  const tags = await req('PATCH', `${st}/providers/Microsoft.Resources/tags/default?api-version=2021-04-01`, { token: armToken, body: { operation: 'Merge', properties: { tags: { team: 'core' } } } });
  assert.deepEqual(tags.json.properties.tags, { team: 'core' });
  const filtered = await req('GET', `/subscriptions/${sub}/resources?api-version=2021-04-01&$filter=tagName eq 'team' and tagValue eq 'core'`, { token: armToken });
  assert.deepEqual(filtered.json.value.map((r: any) => r.name), ['itstorage01']);
  assert.equal((await req('PUT', `${rg}/providers/Microsoft.Authorization/locks/ro?api-version=2020-05-01`, { token: armToken, body: { properties: { level: 'ReadOnly' } } })).status, 201);
  const blocked = await req('PUT', `${st}?api-version=2023-01-01`, { token: armToken, body: { location: 'westeurope' } });
  assert.equal(blocked.json.error.code, 'ScopeLocked');
  await req('DELETE', `${rg}/providers/Microsoft.Authorization/locks/ro?api-version=2020-05-01`, { token: armToken });
  assert.equal((await req('DELETE', `${rg}?api-version=2021-04-01`, { token: armToken })).status, 200);
  assert.equal((await req('GET', `${st}?api-version=2023-01-01`, { token: armToken })).status, 404);
});

test('registrazione app, segreto, service principal, RBAC applicato', async () => {
  const app1 = await req('POST', '/v1.0/applications', { token: graphToken, body: { displayName: 'it-app', identifierUris: ['api://it-app'] } });
  assert.equal(app1.status, 201);
  const sp = await req('POST', '/v1.0/servicePrincipals', { token: graphToken, body: { appId: app1.json.appId } });
  assert.equal(sp.status, 201);
  const pw = await req('POST', `/v1.0/applications/${app1.json.id}/addPassword`, { token: graphToken, body: { passwordCredential: { displayName: 'test' } } });
  assert.match(pw.json.secretText, /Q~/);
  const cc = await req('POST', `/${tid}/oauth2/v2.0/token`, { form: { grant_type: 'client_credentials', client_id: app1.json.appId, client_secret: pw.json.secretText, scope: 'https://management.azure.com/.default' } });
  assert.equal(cc.status, 200);
  const spToken = cc.json.access_token;
  const rg = `/subscriptions/${sub}/resourceGroups/rbac-rg`;
  await req('PUT', `${rg}?api-version=2021-04-01`, { token: armToken, body: { location: 'italynorth' } });
  assert.equal((await req('PUT', `${rg}/providers/Microsoft.Web/serverfarms/p1?api-version=2023-01-01`, { token: spToken, body: { location: 'italynorth' } })).status, 403);
  const ra = await req('PUT', `${rg}/providers/Microsoft.Authorization/roleAssignments/2d3f2f1e-7a52-4c6f-9a0f-0b7c1f2d3e4f?api-version=2022-04-01`, { token: armToken, body: { properties: { roleDefinitionId: `/subscriptions/${sub}/providers/Microsoft.Authorization/roleDefinitions/b24988ac-6180-42a0-ab88-20f7382dd24c`, principalId: sp.json.id } } });
  assert.equal(ra.status, 201);
  const dup = await req('PUT', `${rg}/providers/Microsoft.Authorization/roleAssignments/3d3f2f1e-7a52-4c6f-9a0f-0b7c1f2d3e4f?api-version=2022-04-01`, { token: armToken, body: { properties: { roleDefinitionId: `/subscriptions/${sub}/providers/Microsoft.Authorization/roleDefinitions/b24988ac-6180-42a0-ab88-20f7382dd24c`, principalId: sp.json.id } } });
  assert.equal(dup.json.error.code, 'RoleAssignmentExists');
  assert.equal((await req('PUT', `${rg}/providers/Microsoft.Web/serverfarms/p1?api-version=2023-01-01`, { token: spToken, body: { location: 'italynorth' } })).status, 201);
  // Contributor non può assegnare ruoli
  const denied = await req('PUT', `${rg}/providers/Microsoft.Authorization/roleAssignments/4d3f2f1e-7a52-4c6f-9a0f-0b7c1f2d3e4f?api-version=2022-04-01`, { token: spToken, body: { properties: { roleDefinitionId: `/subscriptions/${sub}/providers/Microsoft.Authorization/roleDefinitions/acdd72a7-3385-48ef-bd42-f606fba81ae7`, principalId: sp.json.id } } });
  assert.equal(denied.status, 403);
  // l'app senza ruoli Graph non può leggere gli utenti
  const graphCc = await req('POST', `/${tid}/oauth2/v2.0/token`, { form: { grant_type: 'client_credentials', client_id: app1.json.appId, client_secret: pw.json.secretText, scope: 'https://graph.microsoft.com/.default' } });
  assert.equal((await req('GET', '/v1.0/users', { token: graphCc.json.access_token })).status, 403);
  // consenso amministratore per User.Read.All (ruolo applicativo)
  const graphSp = await req('GET', "/v1.0/servicePrincipals(appId='00000003-0000-0000-c000-000000000000')", { token: graphToken });
  const role = graphSp.json.appRoles.find((r: any) => r.value === 'User.Read.All');
  assert.equal((await req('POST', `/v1.0/servicePrincipals/${sp.json.id}/appRoleAssignments`, { token: graphToken, body: { principalId: sp.json.id, resourceId: graphSp.json.id, appRoleId: role.id } })).status, 201);
  const graphCc2 = await req('POST', `/${tid}/oauth2/v2.0/token`, { form: { grant_type: 'client_credentials', client_id: app1.json.appId, client_secret: pw.json.secretText, scope: 'https://graph.microsoft.com/.default' } });
  assert.equal((await req('GET', '/v1.0/users', { token: graphCc2.json.access_token })).status, 200);
});

test('utenti e gruppi: creazione, appartenenza, cambio password forzato', async () => {
  const u = await req('POST', '/v1.0/users', { token: graphToken, body: { accountEnabled: true, displayName: 'Mario Rossi', mailNickname: 'mario', userPrincipalName: 'mario@azzurro.local', passwordProfile: { password: 'Temp1234!', forceChangePasswordNextSignIn: true } } });
  assert.equal(u.status, 201);
  const g = await req('POST', '/v1.0/groups', { token: graphToken, body: { displayName: 'Dev', mailEnabled: false, mailNickname: 'dev', securityEnabled: true } });
  assert.equal((await req('POST', `/v1.0/groups/${g.json.id}/members/$ref`, { token: graphToken, body: { '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${u.json.id}` } })).status, 204);
  const memberOf = await req('GET', `/v1.0/users/${u.json.id}/memberOf`, { token: graphToken });
  assert.deepEqual(memberOf.json.value.map((x: any) => x.displayName), ['Dev']);
  const ropc = await req('POST', `/${tid}/oauth2/v2.0/token`, { form: { grant_type: 'password', client_id: CLI, username: 'mario@azzurro.local', password: 'Temp1234!', scope: 'openid' } });
  assert.deepEqual(ropc.json.error_codes, [50055]);
  const weak = await req('POST', '/v1.0/users', { token: graphToken, body: { accountEnabled: true, displayName: 'X', mailNickname: 'x', userPrincipalName: 'x@azzurro.local', passwordProfile: { password: 'short' } } });
  assert.equal(weak.status, 400);
  const otherDomain = await req('POST', '/v1.0/users', { token: graphToken, body: { accountEnabled: true, displayName: 'X', mailNickname: 'x', userPrincipalName: 'x@contoso.com', passwordProfile: { password: 'Temp1234!' } } });
  assert.equal(otherDomain.status, 400);
});

test('deployment di template asincrono con output e activity log', async () => {
  const rg = `/subscriptions/${sub}/resourceGroups/dep-rg`;
  await req('PUT', `${rg}?api-version=2021-04-01`, { token: armToken, body: { location: 'westeurope' } });
  const template = {
    $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#', contentVersion: '1.0.0.0',
    parameters: { name: { type: 'string' } },
    resources: [{ type: 'Microsoft.KeyVault/vaults', apiVersion: '2023-07-01', name: "[parameters('name')]", location: '[resourceGroup().location]', properties: {} }],
    outputs: { uri: { type: 'string', value: "[reference(parameters('name')).vaultUri]" } },
  };
  const put = await req('PUT', `${rg}/providers/Microsoft.Resources/deployments/dep1?api-version=2022-09-01`, { token: armToken, body: { properties: { mode: 'Incremental', template, parameters: { name: { value: 'it-kv-001' } } } } });
  assert.equal(put.status, 201);
  assert.ok(put.headers.get('azure-asyncoperation'));
  let state = '';
  for (let i = 0; i < 40 && !['Succeeded', 'Failed'].includes(state); i++) {
    await new Promise((r) => setTimeout(r, 100));
    state = (await req('GET', `${rg}/providers/Microsoft.Resources/deployments/dep1?api-version=2022-09-01`, { token: armToken })).json.properties.provisioningState;
  }
  const d = await req('GET', `${rg}/providers/Microsoft.Resources/deployments/dep1?api-version=2022-09-01`, { token: armToken });
  assert.equal(d.json.properties.provisioningState, 'Succeeded', JSON.stringify(d.json.properties.error));
  assert.equal(d.json.properties.outputs.uri.value, 'https://it-kv-001.vault.azure.net/');
  const invalid = await req('PUT', `${rg}/providers/Microsoft.Resources/deployments/dep2?api-version=2022-09-01`, { token: armToken, body: { properties: { mode: 'Incremental', template, parameters: {} } } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error.code, 'InvalidTemplate');
  const log = await req('GET', `/subscriptions/${sub}/providers/Microsoft.Insights/eventtypes/management/values?api-version=2015-04-01&$filter=resourceGroupName eq 'dep-rg'`, { token: armToken });
  assert.ok(log.json.value.some((e: any) => e.operationName.value === 'Microsoft.KeyVault/vaults/write'));
});

test('identità gestita assegnata dal sistema crea e rimuove il service principal', async () => {
  const rg = `/subscriptions/${sub}/resourceGroups/mi-rg`;
  await req('PUT', `${rg}?api-version=2021-04-01`, { token: armToken, body: { location: 'westeurope' } });
  const site = await req('PUT', `${rg}/providers/Microsoft.Web/sites/mi-site-01?api-version=2023-01-01`, { token: armToken, body: { location: 'westeurope', identity: { type: 'SystemAssigned' } } });
  const pid = site.json.identity.principalId;
  assert.equal((await req('GET', `/v1.0/servicePrincipals/${pid}`, { token: graphToken })).json.servicePrincipalType, 'ManagedIdentity');
  await req('DELETE', `${rg}/providers/Microsoft.Web/sites/mi-site-01?api-version=2023-01-01`, { token: armToken });
  assert.equal((await req('GET', `/v1.0/servicePrincipals/${pid}`, { token: graphToken })).status, 404);
});
