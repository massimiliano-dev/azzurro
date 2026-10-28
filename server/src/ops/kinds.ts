/** Tipi di operazione: spostamento di risorse (anche tra sottoscrizioni) ed eliminazioni. */
import type { Lang, OpCtx } from './engine.ts';

const WEB = '2023-12-01';
const RG = '2021-04-01';
const typeOf = (id: string) => id.split('/').slice(6, 8).join('/').toLowerCase();
const nameOf = (id: string) => decodeURIComponent(id.split('/').pop() ?? id);

interface Binding { siteId: string; host: string; sslState: string }
interface ManagedCert { id: string; name: string; location: string; canonicalName: string; bindings: Binding[] }

/**
 * Certificati gestiti di App Service (gratuiti, emessi da Azure): Azure non li sposta
 * (LinkedInvalidPropertyId su properties.keyVaultId). Si staccano, si eliminano, si sposta il resto
 * e si ricreano nella destinazione sul piano spostato. Quelli caricati da PFX non si possono ricreare.
 */
async function inspectCerts(ctx: OpCtx, ids: string[]): Promise<{ managed: ManagedCert[]; blocked: string[] }> {
  const certIds = ids.filter((id) => typeOf(id) === 'microsoft.web/certificates');
  if (!certIds.length) return { managed: [], blocked: [] };
  const certs = await Promise.all(certIds.map(async (id) => (await ctx.arm('GET', id, WEB)).json));
  const sites = await Promise.all(ids.filter((id) => typeOf(id) === 'microsoft.web/sites').map(async (id) => (await ctx.arm('GET', id, WEB).catch(() => null))?.json));
  const managed: ManagedCert[] = [];
  const blocked: string[] = [];
  for (const c of certs) {
    if (c.properties?.keyVaultId) continue;
    if (!c.properties?.canonicalName) { blocked.push(c.name); continue; }
    const thumb = String(c.properties.thumbprint ?? '').toUpperCase();
    const bindings: Binding[] = [];
    for (const s of sites) {
      for (const h of s?.properties?.hostNameSslStates ?? []) {
        if (h.sslState && h.sslState !== 'Disabled' && String(h.thumbprint ?? '').toUpperCase() === thumb) bindings.push({ siteId: s.id, host: h.name, sslState: h.sslState });
      }
    }
    managed.push({ id: c.id, name: c.name, location: c.location, canonicalName: c.properties.canonicalName, bindings });
  }
  return { managed, blocked };
}

async function setBinding(ctx: OpCtx, siteId: string, host: string, sslState: string, thumbprint?: string) {
  const path = `${siteId}/hostNameBindings/${host}`;
  const b = (await ctx.arm('GET', path, WEB)).json;
  const keep = ['siteName', 'hostNameType', 'customHostNameDnsRecordType', 'azureResourceType', 'azureResourceName'];
  const properties: Record<string, unknown> = Object.fromEntries(keep.filter((k) => b.properties?.[k] != null).map((k) => [k, b.properties[k]]));
  properties.sslState = sslState;
  if (thumbprint) properties.thumbprint = thumbprint;
  await ctx.arm('PUT', path, WEB, { properties });
}

async function recreateCert(ctx: OpCtx, cert: ManagedCert, sourceRg: string, rg: string) {
  const sites = cert.bindings.map((b) => ({ ...b, siteId: rg + b.siteId.slice(sourceRg.length) }));
  if (!sites.length) return;
  const site = (await ctx.arm('GET', sites[0].siteId, WEB)).json;
  const id = `${rg}/providers/Microsoft.Web/certificates/${cert.name}`;
  await ctx.armLongRunning('PUT', id, WEB, { location: cert.location, properties: { canonicalName: cert.canonicalName, serverFarmId: site.properties.serverFarmId } });
  // Azure emette il certificato in qualche minuto: si aspetta l'impronta prima di collegarlo
  const started = Date.now();
  let thumb = '';
  for (;;) {
    thumb = String((await ctx.arm('GET', id, WEB)).json?.properties?.thumbprint ?? '');
    if (thumb) break;
    if (Date.now() - started > 20 * 60_000) throw new Error(`The certificate for ${cert.canonicalName} was not issued within 20 minutes.`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
  for (const b of sites) await setBinding(ctx, b.siteId, b.host, b.sslState, thumb);
}

export interface MoveParams { source: string; target: string; createTarget?: { location: string } | null; resources: string[]; cleanup?: boolean; movesAll?: boolean }

export const MOVE_STEPS: { key: string; label: Lang }[] = [
  { key: 'create', label: { it: 'Gruppo di destinazione', en: 'Target resource group' } },
  { key: 'precheck', label: { it: 'Verifica preliminare, senza toccare i certificati', en: 'Preliminary validation, certificates untouched' } },
  { key: 'certsOut', label: { it: 'Certificati gestiti: scollegati ed eliminati', en: 'Managed certificates: unbound and deleted' } },
  { key: 'validate', label: { it: 'Verifica di Azure', en: 'Azure validation' } },
  { key: 'move', label: { it: 'Spostamento', en: 'Move' } },
  { key: 'certsIn', label: { it: 'Certificati gestiti: ricreati e ricollegati', en: 'Managed certificates: recreated and rebound' } },
  { key: 'cleanup', label: { it: 'Eliminazione del gruppo vuoto', en: 'Delete the empty group' } },
];

export async function runMove(ctx: OpCtx, p: MoveParams): Promise<{ href: string; note?: Lang }> {
  const { managed, blocked } = await inspectCerts(ctx, p.resources);
  if (blocked.length) throw Object.assign(new Error(`Uploaded certificates cannot be moved or recreated without their PFX file: ${blocked.join(', ')}. Delete them and upload them again in the target, or keep them in Key Vault.`), { code: 'UploadedCertificates' });
  const toMove = p.resources.filter((id) => !managed.some((c) => c.id.toLowerCase() === id.toLowerCase()));
  let certsRemoved = false;
  let moved = false;
  try {
    await ctx.step('create', async () => {
      if (!p.createTarget) return 'skip';
      const exists = await ctx.arm('GET', p.target, RG).then(() => true, (e) => (e.status === 404 ? false : Promise.reject(e)));
      if (!exists) await ctx.arm('PUT', p.target, RG, { location: p.createTarget.location });
    });
    // prima di togliere i certificati (e l'HTTPS) si chiede ad Azure se il resto si può spostare:
    // se il no dipende da altro (tipo non spostabile, provider non registrato…) ci si ferma qui
    await ctx.step('precheck', async () => {
      if (!managed.length) return 'skip';
      try {
        await ctx.armLongRunning('POST', `${p.source}/validateMoveResources`, RG, { resources: toMove, targetResourceGroup: p.target });
      } catch (e) {
        const x = e as Error & { details?: unknown };
        const text = `${x.message} ${JSON.stringify(x.details ?? '')}`;
        if (!/certificat|thumbprint|ssl|hostnamebinding|keyVaultId/i.test(text)) throw e;
      }
    });
    await ctx.step('certsOut', async () => {
      if (!managed.length) return 'skip';
      for (const c of managed) {
        for (const b of c.bindings) await setBinding(ctx, b.siteId, b.host, 'Disabled');
        await ctx.arm('DELETE', c.id, WEB);
      }
      certsRemoved = true;
    });
    await ctx.step('validate', () => ctx.armLongRunning('POST', `${p.source}/validateMoveResources`, RG, { resources: toMove, targetResourceGroup: p.target }));
    await ctx.step('move', () => ctx.armLongRunning('POST', `${p.source}/moveResources`, RG, { resources: toMove, targetResourceGroup: p.target }));
    moved = true;
    await ctx.step('certsIn', async () => {
      if (!managed.length) return 'skip';
      for (const c of managed) await recreateCert(ctx, c, p.source, p.target);
    });
    await ctx.step('cleanup', async () => {
      if (!p.cleanup || !p.movesAll) return 'skip';
      const left = (await ctx.arm('GET', `${p.source}/resources`, RG)).json?.value ?? [];
      if (left.length) return 'skip';
      await ctx.armLongRunning('DELETE', p.source, RG);
    });
  } catch (e) {
    // non spostato dopo aver tolto i certificati: si rimettono dov'erano
    if (certsRemoved && !moved) {
      try {
        for (const c of managed) await recreateCert(ctx, c, p.source, p.source);
        throw Object.assign(e as Error, { note: { it: 'I certificati gestiti sono stati ricreati e ricollegati nel gruppo di origine: tutto è com\'era.', en: 'The managed certificates were recreated and rebound in the source group: everything is as before.' } });
      } catch (re) {
        if (re === e) throw e;
        throw Object.assign(e as Error, { note: { it: `Ricreare i certificati nell'origine non è riuscito (${(re as Error).message}): ricreali da Domini personalizzati del sito.`, en: `Recreating the certificates in the source failed (${(re as Error).message}): recreate them from the site's Custom domains.` } });
      }
    }
    throw e;
  }
  const [, , sub, , rg] = p.target.split('/');
  return { href: `/resource-groups/${sub}/${encodeURIComponent(rg)}` };
}

export async function runDeleteGroup(ctx: OpCtx, id: string): Promise<{ href: string }> {
  await ctx.step('delete', () => ctx.armLongRunning('DELETE', id, RG));
  return { href: '/resource-groups' };
}

export async function runDeleteResources(ctx: OpCtx, items: { id: string; apiVersion: string }[]): Promise<void> {
  await ctx.step('delete', async () => {
    const failed: string[] = [];
    for (const it of items) {
      ctx.checkCancel();
      try { await ctx.armLongRunning('DELETE', it.id, it.apiVersion); } catch (e) { failed.push(`${nameOf(it.id)}: ${(e as Error).message}`); }
    }
    if (failed.length) throw Object.assign(new Error(failed.join(' · ')), { code: 'SomeDeletesFailed' });
  });
}
