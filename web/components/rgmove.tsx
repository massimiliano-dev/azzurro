'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowRightLeft } from 'lucide-react';
import { ApiError, arm } from '@/lib/api';
import { startOperation } from '@/lib/operations';
import { rgId } from '@/lib/arm';
import { useI18n } from '@/i18n';
import { Panel, useToast } from './overlay';
import { Button, Checkbox, Field, Input, Notice } from './ui';
import { ResourceGroupSelect, SubscriptionSelect, useSubscriptions } from './pickers';

const WEB = '2023-12-01';

/** Solo le risorse di primo livello si spostano: i figli (database, subnet, slot…) seguono il padre. */
const topLevel = (id: string) => id.split('/').length === 9;
const typeOf = (id: string) => id.split('/').slice(6, 8).join('/').toLowerCase();

interface Binding { siteId: string; host: string; sslState: string }
interface ManagedCert { id: string; name: string; location: string; canonicalName: string; bindings: Binding[] }

/**
 * I certificati gestiti di App Service (gratuiti, emessi da Azure) non si spostano: Azure rifiuta
 * con LinkedInvalidPropertyId su properties.keyVaultId. Qui solo si individuano per avvisare;
 * l'operazione sul server li scollega, li elimina e li ricrea nella destinazione.
 */
async function inspectCerts(ids: string[]) {
  const certIds = ids.filter((id) => typeOf(id) === 'microsoft.web/certificates');
  if (!certIds.length) return { managed: [] as ManagedCert[], blocked: [] as string[] };
  const [certs, sites] = await Promise.all([
    Promise.all(certIds.map((id) => arm.get<any>(id, WEB))),
    Promise.all(ids.filter((id) => typeOf(id) === 'microsoft.web/sites').map((id) => arm.get<any>(id, WEB).catch(() => null))),
  ]);
  const managed: ManagedCert[] = [];
  const blocked: string[] = [];
  for (const c of certs) {
    if (c.properties?.keyVaultId) continue; // legato a Key Vault: si sposta
    if (!c.properties?.canonicalName) { blocked.push(c.name); continue; } // caricato da PFX: non ricreabile
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

/**
 * Sposta le risorse di un gruppo in un altro gruppo, anche di un'altra sottoscrizione (come in
 * Azure non si sposta il gruppo, ma il suo contenuto). Il pannello controlla e avvia: lo spostamento
 * è un'operazione sul server (verifica, certificati, spostamento, pulizia) che si segue in Operazioni.
 */
export function MoveResourcesPanel({ open, onClose, sub, name, location, all, selected, onMoved }: {
  open: boolean; onClose: () => void; sub: string; name: string; location: string;
  all: string[]; selected: string[]; onMoved: () => void;
}) {
  const { locale } = useI18n();
  const L = (it: string, en: string) => (locale === 'it' ? it : en);
  const toast = useToast();
  const subs = useSubscriptions();
  const [scope, setScope] = useState<'all' | 'selected'>('all');
  const [targetSub, setTargetSub] = useState(sub);
  const [mode, setMode] = useState<'existing' | 'new'>('new');
  const [targetRg, setTargetRg] = useState('');
  const [newName, setNewName] = useState(name);
  const [cleanup, setCleanup] = useState(true);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [certs, setCerts] = useState<{ managed: ManagedCert[]; blocked: string[] } | null>(null);
  const [ackCerts, setAckCerts] = useState(false);

  useEffect(() => {
    if (!open) return;
    setScope(selected.length ? 'selected' : 'all');
    setTargetSub(sub); setMode('new'); setTargetRg(''); setNewName(name); setCleanup(true); setAckCerts(false);
    setError(null);
  }, [open, sub, name, selected.length]);

  const ids = useMemo(() => (scope === 'all' ? all : selected).filter(topLevel), [scope, all, selected]);
  useEffect(() => {
    if (!open) return;
    setCerts(null);
    let live = true;
    inspectCerts(ids).then((r) => live && setCerts(r), () => live && setCerts({ managed: [], blocked: [] }));
    return () => { live = false; };
  }, [open, ids]);

  const destName = mode === 'new' ? newName.trim() : targetRg;
  const same = targetSub.toLowerCase() === sub.toLowerCase() && destName.toLowerCase() === name.toLowerCase();
  const nameOk = mode === 'existing' ? !!targetRg : /^[-\w._()]{1,90}$/.test(destName) && !destName.endsWith('.');
  const movesAll = scope === 'all' || ids.length === all.filter(topLevel).length;
  const managed = certs?.managed ?? [];
  const blocked = certs?.blocked ?? [];
  const certsReady = certs !== null && !blocked.length && (!managed.length || ackCerts);

  const run = async () => {
    setBusy(true); setError(null);
    try {
      await startOperation({
        kind: 'move', source: rgId(sub, name), target: rgId(targetSub, destName), resources: ids,
        createTarget: mode === 'new' ? { location } : null, cleanup, movesAll,
        targetSubscriptionName: subs.data?.find((x) => x.subscriptionId === targetSub)?.displayName,
      });
      toast.ok(L('Spostamento avviato', 'Move started'), L('Prosegue da solo: lo segui in Operazioni, in alto a destra.', 'It runs on its own: follow it in Operations, top right.'));
      onMoved();
      onClose();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  };

  const domains = managed.flatMap((c) => c.bindings.map((b) => b.host));
  const err = error;

  return (
    <Panel open={open} onClose={() => !busy && onClose()} title={L('Sposta risorse', 'Move resources')} subtitle={name}
      footer={<>
        <Button variant="primary" icon={ArrowRightLeft} loading={busy} disabled={busy || !ids.length || !nameOk || same || !certsReady} onClick={run}>{L(`Sposta ${ids.length} risorse`, `Move ${ids.length} resources`)}</Button>
        <Button disabled={busy} onClick={onClose}>{L('Annulla', 'Cancel')}</Button>
      </>}>
      <Field label={L('Cosa spostare', 'What to move')}>
        <div className="seg" role="group">
          <button type="button" className={scope === 'all' ? 'on' : ''} disabled={busy} onClick={() => setScope('all')}>{L(`Tutto il gruppo (${all.filter(topLevel).length})`, `The whole group (${all.filter(topLevel).length})`)}</button>
          <button type="button" className={scope === 'selected' ? 'on' : ''} disabled={busy || !selected.length} onClick={() => setScope('selected')}>{L(`Selezionate (${selected.filter(topLevel).length})`, `Selected (${selected.filter(topLevel).length})`)}</button>
        </div>
      </Field>
      <Field label={L('Sottoscrizione di destinazione', 'Target subscription')} htmlFor="mv-sub"><SubscriptionSelect id="mv-sub" value={targetSub} onChange={(v) => { setTargetSub(v); setTargetRg(''); }} /></Field>
      <Field label={L('Gruppo di risorse di destinazione', 'Target resource group')}>
        <div className="seg" role="group">
          <button type="button" className={mode === 'new' ? 'on' : ''} disabled={busy} onClick={() => setMode('new')}>{L('Nuovo', 'New')}</button>
          <button type="button" className={mode === 'existing' ? 'on' : ''} disabled={busy} onClick={() => setMode('existing')}>{L('Esistente', 'Existing')}</button>
        </div>
      </Field>
      {mode === 'new'
        ? <Field label={L('Nome del nuovo gruppo', 'New group name')} htmlFor="mv-new" hint={L(`Creato in ${location}, la stessa area del gruppo di origine. Se esiste già viene usato quello.`, `Created in ${location}, the same region as the source group. If it already exists, that one is used.`)}><Input id="mv-new" value={newName} disabled={busy} onChange={(e) => setNewName(e.target.value)} invalid={!nameOk} /></Field>
        : <Field label={L('Gruppo esistente', 'Existing group')} htmlFor="mv-rg"><ResourceGroupSelect id="mv-rg" sub={targetSub} value={targetRg} onChange={(v) => setTargetRg(v)} /></Field>}
      {same && <Notice tone="warn">{L('La destinazione coincide con il gruppo di origine.', 'The target is the source group itself.')}</Notice>}
      {movesAll && <Checkbox checked={cleanup} disabled={busy} onChange={setCleanup} label={L(`Elimina «${name}» quando è vuoto`, `Delete «${name}» once it is empty`)} />}

      {managed.length > 0 && (
        <Notice tone="warn" title={L('Certificati gestiti di App Service', 'App Service managed certificates')}>
          <p style={{ margin: '0 0 8px' }}>{L(
            `Azure non sposta i certificati gestiti (${managed.map((c) => c.canonicalName).join(', ')}). Azzurro li scollega, li elimina, sposta il resto e li ricrea gratis nella destinazione, poi li ricollega.`,
            `Azure does not move managed certificates (${managed.map((c) => c.canonicalName).join(', ')}). Azzurro unbinds and deletes them, moves the rest, recreates them for free in the target and binds them again.`,
          )}</p>
          {domains.length > 0 && <p style={{ margin: '0 0 8px' }}><strong>{L(`${domains.join(', ')} resta senza HTTPS per qualche minuto`, `${domains.join(', ')} has no HTTPS for a few minutes`)}</strong>{L(', finché Azure non emette il nuovo certificato (di solito 2–10 minuti). HTTP e il dominio *.azurewebsites.net continuano a funzionare.', ', until Azure issues the new certificate (usually 2–10 minutes). HTTP and the *.azurewebsites.net domain keep working.')}</p>}
          <Checkbox checked={ackCerts} disabled={busy} onChange={setAckCerts} label={L('Ho capito, procedi così', 'Understood, go ahead')} />
        </Notice>
      )}
      {blocked.length > 0 && (
        <Notice tone="bad">{L(
          `Certificati caricati da file (${blocked.join(', ')}): Azure non li sposta e Azzurro non può ricrearli senza il file PFX. Eliminali (dopo averli scollegati dai domini) e ricaricali nella destinazione, oppure spostali in Key Vault.`,
          `Uploaded certificates (${blocked.join(', ')}): Azure does not move them and Azzurro cannot recreate them without the PFX file. Delete them (after unbinding them) and upload them again in the target, or move them to Key Vault.`,
        )}</Notice>
      )}

      <Notice tone="info">{L(
        'Gli ID delle risorse cambiano: script, pipeline e riferimenti che li usano vanno aggiornati. Le risorse figlie (database, subnet, slot…) seguono il padre. Su Azure la verifica e lo spostamento possono richiedere diversi minuti e le risorse restano utilizzabili, ma non modificabili, durante lo spostamento. Alcuni tipi non si spostano tra sottoscrizioni: lo dice la verifica.',
        'Resource IDs change: scripts, pipelines and references that use them must be updated. Child resources (databases, subnets, slots…) follow their parent. On Azure, validation and move can take several minutes; resources stay usable but locked for changes during the move. Some types cannot move across subscriptions: validation will say so.',
      )}</Notice>
      {err && (
        <Notice tone="bad">
          <strong>{err.message}</strong>
          {err instanceof ApiError && err.details?.length ? <ul className="small">{err.details.map((d, i) => <li key={i}><span className="mono">{d.code}</span> {d.message}{d.target ? ` (${d.target.split('/').pop()})` : ''}</li>)}</ul> : null}
        </Notice>
      )}
    </Panel>
  );
}
