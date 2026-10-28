'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRightLeft, Check, CircleAlert, Loader2 } from 'lucide-react';
import { ApiError, arm, armLongRunning } from '@/lib/api';
import { invalidateAll } from '@/lib/cache';
import { rgId } from '@/lib/arm';
import { useI18n } from '@/i18n';
import { Panel, useToast } from './overlay';
import { Button, Checkbox, Field, Input, Notice, Select } from './ui';
import { ResourceGroupSelect, SubscriptionSelect } from './pickers';

type Step = 'validate' | 'create' | 'move' | 'cleanup';
type StepState = 'todo' | 'run' | 'ok' | 'error' | 'skip';

/** Solo le risorse di primo livello si spostano: i figli (database, subnet, slot…) seguono il padre. */
const topLevel = (id: string) => id.split('/').length === 9;

/**
 * Sposta le risorse di un gruppo in un altro gruppo, anche di un'altra sottoscrizione (come in
 * Azure non si sposta il gruppo, ma il suo contenuto): verifica, spostamento e, se il gruppo
 * resta vuoto, eliminazione dell'origine.
 */
export function MoveResourcesPanel({ open, onClose, sub, name, location, all, selected, onMoved }: {
  open: boolean; onClose: () => void; sub: string; name: string; location: string;
  all: string[]; selected: string[]; onMoved: () => void;
}) {
  const { locale } = useI18n();
  const L = (it: string, en: string) => (locale === 'it' ? it : en);
  const toast = useToast();
  const router = useRouter();
  const [scope, setScope] = useState<'all' | 'selected'>('all');
  const [targetSub, setTargetSub] = useState(sub);
  const [mode, setMode] = useState<'existing' | 'new'>('new');
  const [targetRg, setTargetRg] = useState('');
  const [newName, setNewName] = useState(name);
  const [cleanup, setCleanup] = useState(true);
  const [steps, setSteps] = useState<Record<Step, StepState>>({ validate: 'todo', create: 'todo', move: 'todo', cleanup: 'todo' });
  const [waited, setWaited] = useState(0);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setScope(selected.length ? 'selected' : 'all');
    setTargetSub(sub); setMode('new'); setTargetRg(''); setNewName(name); setCleanup(true);
    setSteps({ validate: 'todo', create: 'todo', move: 'todo', cleanup: 'todo' }); setError(null); setWaited(0);
  }, [open, sub, name, selected.length]);

  const ids = (scope === 'all' ? all : selected).filter(topLevel);
  const destName = mode === 'new' ? newName.trim() : targetRg;
  const same = targetSub.toLowerCase() === sub.toLowerCase() && destName.toLowerCase() === name.toLowerCase();
  const nameOk = mode === 'existing' ? !!targetRg : /^[-\w._()]{1,90}$/.test(destName) && !destName.endsWith('.');
  const movesAll = scope === 'all' || ids.length === all.filter(topLevel).length;
  const set = (k: Step, v: StepState) => setSteps((s) => ({ ...s, [k]: v }));

  const run = async () => {
    setBusy(true); setError(null); setWaited(0);
    const source = rgId(sub, name);
    const dest = rgId(targetSub, destName);
    let step: Step = 'create';
    try {
      // 1. gruppo di destinazione (va creato prima: Azure verifica lo spostamento verso un gruppo esistente)
      if (mode === 'new') {
        set('create', 'run');
        const exists = await arm.get(dest, '2021-04-01').then(() => true, (e) => (e instanceof ApiError && e.status === 404 ? false : Promise.reject(e)));
        if (!exists) await arm.put(dest, { location }, '2021-04-01');
        set('create', 'ok');
      } else set('create', 'skip');
      // 2. verifica di Azure: dipendenze, tipi spostabili, provider registrati nella destinazione
      step = 'validate'; set('validate', 'run');
      await armLongRunning('POST', `${source}/validateMoveResources`, { resources: ids, targetResourceGroup: dest }, '2021-04-01', setWaited);
      set('validate', 'ok');
      // 3. spostamento vero e proprio (gli ID delle risorse cambiano)
      step = 'move'; set('move', 'run'); setWaited(0);
      await armLongRunning('POST', `${source}/moveResources`, { resources: ids, targetResourceGroup: dest }, '2021-04-01', setWaited);
      set('move', 'ok');
      // 4. il gruppo di origine, se è rimasto vuoto
      step = 'cleanup';
      if (cleanup && movesAll) {
        set('cleanup', 'run'); setWaited(0);
        const left = (await arm.get<{ value: unknown[] }>(`${source}/resources`, '2021-04-01')).value;
        if (!left.length) { await armLongRunning('DELETE', source, undefined, '2021-04-01', setWaited); set('cleanup', 'ok'); } else set('cleanup', 'skip');
      } else set('cleanup', 'skip');
      invalidateAll();
      toast.ok(L(`Spostate ${ids.length} risorse in ${destName}`, `Moved ${ids.length} resources to ${destName}`));
      onMoved();
      onClose();
      router.push(`/resource-groups/${targetSub}/${encodeURIComponent(destName)}`);
    } catch (e) {
      set(step, 'error');
      setError(e as Error);
      invalidateAll();
    } finally {
      setBusy(false);
    }
  };

  const STEP_LABEL: Record<Step, string> = {
    create: L('Gruppo di destinazione', 'Target resource group'),
    validate: L('Verifica di Azure', 'Azure validation'),
    move: L('Spostamento', 'Move'),
    cleanup: L('Eliminazione del gruppo vuoto', 'Delete the empty group'),
  };
  const icon = (s: StepState) => s === 'run' ? <Loader2 size={15} className="spin" aria-hidden /> : s === 'ok' ? <Check size={15} aria-hidden /> : s === 'error' ? <CircleAlert size={15} aria-hidden /> : <span className="dot" aria-hidden />;
  const started = Object.values(steps).some((s) => s !== 'todo');

  return (
    <Panel open={open} onClose={() => !busy && onClose()} title={L('Sposta risorse', 'Move resources')} subtitle={name}
      footer={<>
        <Button variant="primary" icon={ArrowRightLeft} loading={busy} disabled={busy || !ids.length || !nameOk || same} onClick={run}>{L(`Sposta ${ids.length} risorse`, `Move ${ids.length} resources`)}</Button>
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
      <Notice tone="info">{L(
        'Gli ID delle risorse cambiano: script, pipeline e riferimenti che li usano vanno aggiornati. Le risorse figlie (database, subnet, slot…) seguono il padre. Su Azure la verifica e lo spostamento possono richiedere diversi minuti e le risorse restano utilizzabili, ma non modificabili, durante lo spostamento. Alcuni tipi non si spostano tra sottoscrizioni: lo dice la verifica.',
        'Resource IDs change: scripts, pipelines and references that use them must be updated. Child resources (databases, subnets, slots…) follow their parent. On Azure, validation and move can take several minutes; resources stay usable but locked for changes during the move. Some types cannot move across subscriptions: validation will say so.',
      )}</Notice>
      {started && (
        <ol className="move-steps" aria-live="polite">
          {(['create', 'validate', 'move', 'cleanup'] as Step[]).filter((k) => steps[k] !== 'skip').map((k) => (
            <li key={k} className={steps[k]}>{icon(steps[k])}<span>{STEP_LABEL[k]}</span>{steps[k] === 'run' && waited > 0 && <span className="mono small muted">{waited}s</span>}</li>
          ))}
        </ol>
      )}
      {error && (
        <Notice tone="bad">
          <strong>{error.message}</strong>
          {error instanceof ApiError && error.details?.length ? <ul className="small">{error.details.map((d, i) => <li key={i}><span className="mono">{d.code}</span> {d.message}{d.target ? ` (${d.target.split('/').pop()})` : ''}</li>)}</ul> : null}
        </Notice>
      )}
    </Panel>
  );
}
