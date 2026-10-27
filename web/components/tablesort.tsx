'use client';

import { useEffect } from 'react';
import { compareValues, sortValue } from '@/lib/sortkey';

/**
 * Ordinamento per tutte le tabelle `.table` del portale che non lo gestiscono già:
 * un clic sull'intestazione ordina, un secondo clic inverte. L'ordine resta quando i dati si aggiornano.
 */
export function TableSorter() {
  useEffect(() => {
    const state = new WeakMap<HTMLTableElement, { col: number; desc: boolean }>();
    const observers = new WeakMap<HTMLTableElement, MutationObserver>();
    const sortable = (th: HTMLTableCellElement) => {
      const table = th.closest('table.table') as HTMLTableElement | null;
      if (!table || table.hasAttribute('data-react-sort') || table.hasAttribute('data-nosort') || th.parentElement?.parentElement?.tagName !== 'THEAD') return null;
      if (th.querySelector('button, input, select') || !th.textContent?.trim()) return null;
      return table;
    };
    const apply = (table: HTMLTableElement) => {
      const st = state.get(table);
      const tbody = table.tBodies[0];
      if (!st || !tbody) return;
      const rows = [...tbody.rows];
      const fixed = rows.filter((r) => r.classList.contains('total') || r.cells.length <= st.col);
      const movable = rows.filter((r) => !fixed.includes(r));
      const val = (r: HTMLTableRowElement) => sortValue(r.cells[st.col].dataset.sort ?? r.cells[st.col].textContent ?? '');
      const sorted = [...movable].sort((a, b) => { const c = compareValues(val(a), val(b)); return st.desc ? -c : c; });
      const target = [...sorted, ...fixed];
      if (target.every((r, i) => r === rows[i])) return;
      for (const r of target) tbody.appendChild(r);
    };
    const onClick = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent && e.key !== 'Enter' && e.key !== ' ') return;
      const th = (e.target as HTMLElement).closest('th') as HTMLTableCellElement | null;
      if (!th) return;
      const table = sortable(th);
      if (!table) return;
      e.preventDefault();
      const prev = state.get(table);
      const st = { col: th.cellIndex, desc: prev?.col === th.cellIndex ? !prev.desc : false };
      state.set(table, st);
      table.querySelectorAll('thead th[aria-sort]').forEach((x) => x.removeAttribute('aria-sort'));
      th.setAttribute('aria-sort', st.desc ? 'descending' : 'ascending');
      apply(table);
      if (!observers.has(table) && table.tBodies[0]) {
        const mo = new MutationObserver(() => apply(table));
        mo.observe(table.tBodies[0], { childList: true });
        observers.set(table, mo);
      }
    };
    // le intestazioni ordinabili diventano raggiungibili da tastiera
    const mark = () => {
      document.querySelectorAll<HTMLTableCellElement>('table.table:not([data-react-sort]):not([data-nosort]) > thead th').forEach((th) => {
        if (th.tabIndex < 0 && sortable(th)) { th.tabIndex = 0; th.classList.add('sortable'); }
      });
    };
    const mo = new MutationObserver(() => mark());
    mo.observe(document.body, { childList: true, subtree: true });
    mark();
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onClick);
    return () => { mo.disconnect(); document.removeEventListener('click', onClick); document.removeEventListener('keydown', onClick); };
  }, []);
  return null;
}
