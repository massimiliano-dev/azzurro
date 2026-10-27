'use client';

import { useState, type ReactNode } from 'react';
import { Eye, EyeOff, RefreshCw } from 'lucide-react';
import { Button, Card, CopyButton, Notice } from '../ui';
import { useConfirm, useToast } from '../overlay';
import { useL } from './common';

export interface KeyRow { key: string; label: ReactNode; value: string; regen?: () => Promise<unknown> }

/** Chiavi e stringhe di connessione nascoste finché non si chiede di vederle, con rigenerazione. */
export function KeysCard({ title, load, disabled, note }: { title: ReactNode; load: () => Promise<KeyRow[]>; disabled?: ReactNode; note?: ReactNode }) {
  const L = useL();
  const toast = useToast();
  const confirm = useConfirm();
  const [rows, setRows] = useState<KeyRow[] | null>(null);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const fetchKeys = async () => {
    setBusy(true);
    try { setRows(await load()); setShow(true); }
    catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  const regen = async (row: KeyRow) => {
    if (!(await confirm({ title: L('Rigenerare questa chiave?', 'Regenerate this key?'), text: L('Le app che la usano smettono di connettersi finché non la aggiorni.', 'Apps using it stop connecting until you update them.'), danger: true, confirmLabel: L('Rigenera', 'Regenerate') }))) return;
    try { await row.regen!(); setRows(await load()); toast.ok(L('Chiave rigenerata', 'Key regenerated')); } catch (e) { toast.error(e); }
  };
  return (
    <Card title={title} actions={rows ? <Button size="sm" variant="ghost" icon={show ? EyeOff : Eye} onClick={() => setShow(!show)}>{show ? L('Nascondi', 'Hide') : L('Mostra', 'Show')}</Button> : null}>
      {disabled ? <Notice>{disabled}</Notice> : !rows ? (
        <Button icon={Eye} loading={busy} onClick={() => void fetchKeys()}>{L('Mostra le chiavi', 'Show keys')}</Button>
      ) : (
        <div className="stack" style={{ gap: 10 }}>
          {rows.map((r) => (
            <div className="kv-edit" key={r.key}>
              <span>{r.label}</span>
              <span className="secret"><span>{show ? r.value : '•'.repeat(24)}</span><CopyButton value={r.value} /></span>
              {r.regen ? <Button size="sm" icon={RefreshCw} onClick={() => void regen(r)}>{L('Rigenera', 'Regenerate')}</Button> : <span />}
            </div>
          ))}
        </div>
      )}
      {note && <p className="small muted" style={{ marginBottom: 0 }}>{note}</p>}
    </Card>
  );
}
