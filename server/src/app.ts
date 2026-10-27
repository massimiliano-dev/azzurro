import { installRetirement } from './costs/engine.ts';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { config } from './config.ts';
import { HttpError } from './errors.ts';
import { uuid } from './ids.ts';
import { identityRoutes } from './auth/routes.ts';
import { graphRoutes } from './graph/routes.ts';
import { armRoutes } from './arm/routes.ts';
import { portalRoutes } from './portal/routes.ts';
import { realProxy } from './real/proxy.ts';
import { TemplateError } from './arm/templates.ts';
import { tenant } from './directory.ts';
import type { AppEnv } from './types.ts';

type Family = 'graph' | 'oauth' | 'portal' | 'arm';

function familyOf(path: string): Family {
  if (path.startsWith('/v1.0') || path.startsWith('/beta') || path.startsWith('/oidc/')) return 'graph';
  if (path.startsWith('/_portal')) return 'portal';
  if (/\/oauth2\//.test(path) || path.startsWith('/devicelogin') || path.startsWith('/metadata/identity') || path.startsWith('/msi/')) return 'oauth';
  return 'arm';
}

export function createApp(): Hono<AppEnv> {
  installRetirement();
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.set('requestId', uuid());
    const started = Date.now();
    await next();
    if (!config.quiet) {
      const ms = Date.now() - started;
      const status = c.res.status;
      const color = status >= 500 ? 31 : status >= 400 ? 33 : 32;
      console.log(`\x1b[2m${new Date().toISOString().slice(11, 19)}\x1b[0m ${c.req.method.padEnd(6)} \x1b[${color}m${status}\x1b[0m ${new URL(c.req.url).pathname}${ms > 200 ? ` \x1b[2m${ms}ms\x1b[0m` : ''}`);
    }
  });

  app.use('/_portal/*', cors({ origin: (o) => (o === config.portalUrl ? o : config.portalUrl), credentials: true, allowHeaders: ['Content-Type', 'X-Azzurro-Portal', 'Authorization'], allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] }));
  app.use('*', async (c, next) => {
    if (new URL(c.req.url).pathname.startsWith('/_portal')) return next();
    return cors({
      origin: (o) => o || '*',
      allowHeaders: ['Authorization', 'Content-Type', 'client-request-id', 'return-client-request-id', 'x-ms-client-request-id', 'x-ms-correlation-request-id', 'ConsistencyLevel', 'Prefer', 'x-client-SKU', 'x-client-VER', 'x-client-OS', 'x-client-CPU', 'x-ms-lib-capability', 'x-client-current-telemetry', 'x-client-last-telemetry', 'X-AnchorMailbox'],
      exposeHeaders: ['Location', 'Azure-AsyncOperation', 'Retry-After', 'x-ms-request-id', 'x-ms-correlation-request-id', 'request-id', 'client-request-id', 'WWW-Authenticate'],
      allowMethods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
      maxAge: 86400,
    })(c, next);
  });

  app.get('/', (c) =>
    c.json({
      name: 'Azzurro',
      description: 'Emulatore locale di Azure Resource Manager, Microsoft Graph e Microsoft Entra ID',
      tenantId: tenant().id,
      endpoints: {
        resourceManager: '/',
        microsoftGraph: '/v1.0',
        login: `/${tenant().id}/oauth2/v2.0/token`,
        openidConfiguration: `/${tenant().id}/v2.0/.well-known/openid-configuration`,
        cloudMetadata: '/metadata/endpoints?api-version=2022-09-01',
        managedIdentity: '/metadata/identity/oauth2/token',
      },
    }),
  );
  app.get('/health', (c) => c.json({ status: 'ok' }));

  identityRoutes(app);
  // directory reale attiva nella sessione: ARM e Graph vanno ad Azure con i token dell'utente
  app.use('*', realProxy);
  portalRoutes(app);
  graphRoutes(app);
  armRoutes(app);

  app.notFound((c) => {
    const fam = familyOf(new URL(c.req.url).pathname);
    if (fam === 'graph') return c.json({ error: { code: 'BadRequest', message: 'Resource not found for the segment.' } }, 404);
    return c.json({ error: { code: 'NotFound', message: `No HTTP resource was found that matches the request URI '${c.req.url}'.` } }, 404);
  });

  app.onError((err, c) => {
    const path = new URL(c.req.url).pathname;
    const fam = familyOf(path);
    let e: HttpError;
    if (err instanceof HttpError) e = err;
    else if (err instanceof TemplateError) e = new HttpError(400, err.code, err.message, { details: err.details });
    else {
      console.error('[errore]', err);
      e = new HttpError(500, 'InternalServerError', `Encountered internal server error. Diagnostic information: ${(err as Error).message}`);
    }
    for (const [k, v] of Object.entries(e.headers ?? {})) c.header(k, v);
    const requestId = c.get('requestId') ?? uuid();
    const status = e.status as any;
    if (fam === 'oauth' && e.aadsts) {
      const ts = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
      return c.json({
        error: e.code,
        error_description: `${e.message}\r\nTrace ID: ${requestId}\r\nCorrelation ID: ${uuid()}\r\nTimestamp: ${ts}`,
        error_codes: [e.aadsts],
        timestamp: ts,
        trace_id: requestId,
        correlation_id: uuid(),
        error_uri: `${new URL(c.req.url).origin}/error?code=${e.aadsts}`,
      }, status);
    }
    if (fam === 'graph') {
      return c.json({ error: { code: e.code, message: e.message, innerError: { date: new Date().toISOString().replace(/\.\d+Z$/, ''), 'request-id': requestId, 'client-request-id': c.req.header('client-request-id') ?? requestId } } }, status);
    }
    const body: any = { error: { code: e.code, message: e.message } };
    if (e.target) body.error.target = e.target;
    if (e.details?.length) body.error.details = e.details;
    if (c.req.method === 'HEAD') return c.body(null, status);
    return c.json(body, status);
  });

  return app;
}
