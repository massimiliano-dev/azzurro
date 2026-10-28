'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useT } from '@/i18n';
import { Button, Input } from './ui';

function useEscape(onClose: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
}

export function Panel({ open, onClose, title, subtitle, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useEscape(onClose);
  useEffect(() => {
    if (open) setTimeout(() => ref.current?.querySelector<HTMLElement>('input, select, textarea')?.focus(), 50);
  }, [open]);
  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    <>
      <div className="overlay" onClick={onClose} />
      <div className={`panel ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} ref={ref}>
        <div className="panel-head">
          <div style={{ flex: 1 }}>
            <h2>{title}</h2>
            {subtitle && <div className="sub">{subtitle}</div>}
          </div>
          <Button variant="ghost" iconOnly icon={X} onClick={onClose} aria-label={t('common.close')} />
        </div>
        <div className="panel-body">{children}</div>
        {footer && <div className="panel-foot">{footer}</div>}
      </div>
    </>,
    document.body,
  );
}

interface ConfirmOpts {
  title: string;
  text?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  /** se impostato, l'utente deve digitare questo testo */
  typeToConfirm?: string;
}

const ConfirmCtx = createContext<(o: ConfirmOpts) => Promise<boolean>>(async () => false);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const [state, setState] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const [typed, setTyped] = useState('');
  const confirm = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => { setTyped(''); setState({ ...o, resolve }); }), []);
  const close = useCallback((v: boolean) => {
    setState((s) => {
      s?.resolve(v);
      return null;
    });
  }, []);
  useEffect(() => {
    if (!state) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && close(false);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [state, close]);
  const blocked = !!state?.typeToConfirm && typed !== state.typeToConfirm;
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {state && typeof document !== 'undefined' && createPortal(
        <>
          <div className="overlay" onClick={() => close(false)} />
          <div className={`modal ${state.danger ? '' : 'neutral'}`} role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
            <div className="modal-body">
              <h2 id="confirm-title">{state.title}</h2>
              {state.text && <div style={{ color: 'var(--text-2)' }}>{state.text}</div>}
              {state.typeToConfirm && (
                <div className="field mt-16">
                  <label htmlFor="confirm-type">{t('common.typeToConfirm', { name: state.typeToConfirm })}</label>
                  <Input id="confirm-type" autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
                </div>
              )}
            </div>
            <div className="modal-foot">
              <Button onClick={() => close(false)}>{t('common.cancel')}</Button>
              <Button variant={state.danger ? 'danger-solid' : 'primary'} disabled={blocked} onClick={() => close(true)} autoFocus={!state.typeToConfirm}>
                {state.confirmLabel ?? t('common.confirm')}
              </Button>
            </div>
          </div>
        </>,
        document.body,
      )}
    </ConfirmCtx.Provider>
  );
}

export function useConfirm() {
  return useContext(ConfirmCtx);
}

interface Toast { id: number; tone: 'ok' | 'bad' | 'info'; title: string; text?: string }
const ToastCtx = createContext<(t: Omit<Toast, 'id'>) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs.slice(-3), { ...t, id }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), t.tone === 'bad' ? 9000 : 5000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`} role={t.tone === 'bad' ? 'alert' : 'status'}>
            <span className="mark" aria-hidden />
            <div>
              <div className="t">{t.title}</div>
              {t.text && <div className="d">{t.text}</div>}
            </div>
            <button className="btn ghost sm icon" onClick={() => setItems((xs) => xs.filter((x) => x.id !== t.id))} aria-label="close"><X size={14} /></button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/** Stabile tra un render e l'altro: si può usare nelle dipendenze degli effetti senza farli ripartire. */
export function useToast() {
  const push = useContext(ToastCtx);
  const t = useT();
  return useMemo(() => ({
    ok: (title: string, text?: string) => push({ tone: 'ok', title, text }),
    info: (title: string, text?: string) => push({ tone: 'info', title, text }),
    error: (e: unknown, title?: string) => {
      const err = e as { status?: number; code?: string; message?: string; details?: { message: string }[] };
      const msg = err?.status === 403 ? t('err.forbidden') : err?.status === 0 ? t('err.network') : err?.details?.[0]?.message ?? err?.message ?? String(e);
      push({ tone: 'bad', title: title ?? err?.code ?? t('common.error'), text: msg });
    },
  }), [push, t]);
}
