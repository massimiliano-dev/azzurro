import { serve } from '@hono/node-server';
import { createServer as createHttpsServer } from 'node:https';
import { existsSync, readFileSync } from 'node:fs';
import { config } from './config.ts';
import { initDb } from './db/pool.ts';
import { initKeys } from './auth/keys.ts';
import { initPush } from './push.ts';
import { seed } from './seed.ts';
import { createApp } from './app.ts';
import { startJobs } from './jobs.ts';
import { tenant } from './directory.ts';

async function main() {
  try {
    await initDb(config.databaseUrl, config.dbSchema);
  } catch (e) {
    console.error(`\n✖ Impossibile connettersi a PostgreSQL (${config.databaseUrl.replace(/:[^:@/]+@/, ':***@')}).\n  Avvia il database con:  npm run db:up\n`);
    console.error((e as Error).message);
    process.exit(1);
  }
  await initKeys();
  const { created, adminUpn } = await seed();
  initPush();
  startJobs();
  await (await import('./ops/engine.ts')).recoverOperations();

  const app = createApp();
  serve({ fetch: app.fetch, port: config.port }, () => {
    console.log(`\n  \x1b[34m◆ Azzurro\x1b[0m  API su ${config.publicUrl}  ·  tenant ${tenant().id}`);
  });
  if (existsSync(config.tlsCert) && existsSync(config.tlsKey)) {
    serve({ fetch: app.fetch, port: config.httpsPort, createServer: createHttpsServer, serverOptions: { cert: readFileSync(config.tlsCert), key: readFileSync(config.tlsKey) } } as any, () => {
      console.log(`  \x1b[34m◆\x1b[0m HTTPS su https://localhost:${config.httpsPort} (per SDK e Azure CLI)`);
    });
  } else {
    console.log('  \x1b[2mHTTPS non attivo: esegui "npm run certs" per SDK e Azure CLI\x1b[0m');
  }
  if (created) {
    console.log(`\n  Primo avvio completato. Accedi al portale con:\n    utente:   ${adminUpn}\n    password: ${config.adminPassword}\n`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
