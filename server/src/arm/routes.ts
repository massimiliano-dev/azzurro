import type { Hono } from 'hono';
import { config } from '../config.ts';
import { originOf, readJson } from '../http.ts';
import { authenticate } from '../auth/middleware.ts';
import { uuid } from '../ids.ts';
import type { AppEnv } from '../types.ts';
import { armRequest } from './dispatch.ts';
import type { ArmCtx } from './context.ts';

export function cloudMetadata(origin: string) {
  return {
    portal: config.portalUrl,
    authentication: { loginEndpoint: `${origin}/`, audiences: ['https://management.core.windows.net/', 'https://management.azure.com/'], tenant: 'common', identityProvider: 'AAD' },
    media: 'https://rest.media.azure.net',
    graphAudience: 'https://graph.windows.net/',
    graph: 'https://graph.windows.net/',
    name: 'Azzurro',
    suffixes: {
      azureDataLakeStoreFileSystem: 'azuredatalakestore.net', acrLoginServer: 'azurecr.io', sqlServerHostname: 'database.windows.net', azureDataLakeAnalyticsCatalogAndJob: 'azuredatalakeanalytics.net',
      keyVaultDns: 'vault.azure.net', storage: 'core.windows.net', azureFrontDoorEndpointSuffix: 'azurefd.net', storageSyncEndpointSuffix: 'afs.azure.net', mhsmDns: 'managedhsm.azure.net',
      mysqlServerEndpoint: 'mysql.database.azure.com', postgresqlServerEndpoint: 'postgres.database.azure.com', mariadbServerEndpoint: 'mariadb.database.azure.com', synapseAnalytics: 'dev.azuresynapse.net', attestationEndpoint: 'attest.azure.net',
    },
    batch: 'https://batch.core.windows.net/',
    resourceManager: `${origin}/`,
    vmImageAliasDoc: 'https://raw.githubusercontent.com/Azure/azure-rest-api-specs/main/arm-compute/quickstart-templates/aliases.json',
    activeDirectoryDataLake: 'https://datalake.azure.net/',
    sqlManagement: 'https://management.core.windows.net:8443/',
    microsoftGraphResourceId: `${origin}/`,
    appInsightsResourceId: 'https://api.applicationinsights.io',
    appInsightsTelemetryChannelResourceId: 'https://dc.applicationinsights.azure.com/v2/track',
    attestationResourceId: 'https://attest.azure.net',
    synapseAnalyticsResourceId: 'https://dev.azuresynapse.net',
    logAnalyticsResourceId: 'https://api.loganalytics.io',
    ossrDbmsResourceId: 'https://ossrdbms-aad.database.windows.net',
  };
}

export function armRoutes(app: Hono<AppEnv>): void {
  app.get('/metadata/endpoints', (c) => {
    const v = c.req.query('api-version') ?? '2022-09-01';
    const meta = cloudMetadata(originOf(c));
    return c.json(v >= '2019-05-01' ? [meta] : meta);
  });

  const auth = authenticate('arm');
  for (const p of ['/subscriptions', '/subscriptions/*', '/providers', '/providers/*', '/tenants']) app.use(p, auth);

  const handler = async (c: any) => {
    const url = new URL(c.req.url);
    const method = c.req.method as string;
    const correlationId = c.req.header('x-ms-correlation-request-id') ?? uuid();
    const ctx: ArmCtx = { principal: c.get('principal'), origin: originOf(c), correlationId };
    const body = ['PUT', 'PATCH', 'POST'].includes(method) ? await readJson(c) : undefined;
    const res = await armRequest(ctx, method, url.pathname, url.searchParams, body);
    const headers: Record<string, string> = {
      'x-ms-request-id': uuid(),
      'x-ms-correlation-request-id': correlationId,
      [method === 'GET' || method === 'HEAD' ? 'x-ms-ratelimit-remaining-subscription-reads' : 'x-ms-ratelimit-remaining-subscription-writes']: method === 'GET' || method === 'HEAD' ? '11999' : '1199',
      ...(res.headers ?? {}),
    };
    if (res.body === undefined || method === 'HEAD' || res.status === 204) return c.body(null, res.status, headers);
    if (typeof res.body === 'string') return c.text(res.body, res.status, { ...headers, 'Content-Type': 'application/xml' });
    return c.json(res.body, res.status, headers);
  };
  app.all('/subscriptions', handler);
  app.all('/subscriptions/*', handler);
  app.all('/providers', handler);
  app.all('/providers/*', handler);
  app.all('/tenants', handler);
}
