'use client';

import { compareValues, nodeText, sortValue } from '@/lib/sortkey';
import { useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Search } from 'lucide-react';
import { useT } from '@/i18n';
import { Empty, ErrorNotice, Skeleton } from './ui';
import type { LucideIcon } from 'lucide-react';

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  sort?: (row: T) => string | number | null | undefined;
  /** false per le colonne che non ha senso ordinare (azioni, caselle) */
  sortable?: boolean;
  width?: number | string;
  className?: string;
}

export function DataTable<T>({
  rows, columns, loading, error, onRetry, rowKey, search, searchPlaceholder, empty, emptyIcon, filters, selectable, selected, onSelect, initialSort,
}: {
  rows: T[] | undefined;
  columns: Column<T>[];
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  rowKey: (row: T) => string;
  search?: (row: T) => string;
  searchPlaceholder?: string;
  empty?: ReactNode;
  emptyIcon?: LucideIcon;
  filters?: ReactNode;
  selectable?: boolean;
  selected?: Set<string>;
  onSelect?: (s: Set<string>) => void;
  initialSort?: { key: string; desc?: boolean };
}) {
  const t = useT();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState(initialSort);
  const view = useMemo(() => {
    let out = rows ?? [];
    if (q && search) {
      const s = q.toLowerCase();
      out = out.filter((r) => search(r).toLowerCase().includes(s));
    }
    if (sort) {
      const col = columns.find((c) => c.key === sort.key);
      if (col) {
        // colonne senza chiave dichiarata: si ordina sul testo visibile della cella
        const key = (r: any) => (col.sort ? col.sort(r) ?? '' : sortValue(nodeText(col.render(r))));
        out = [...out].sort((a, b) => {
          const x = key(a);
          const y = key(b);
          const c = typeof x === 'number' && typeof y === 'number' ? x - y : compareValues(typeof x === 'number' ? x : String(x).toLowerCase(), typeof y === 'number' ? y : String(y).toLowerCase());
          return sort.desc ? -c : c;
        });
      }
    }
    return out;
  }, [rows, q, search, sort, columns]);

  const allSelected = !!selected && view.length > 0 && view.every((r) => selected.has(rowKey(r)));

  return (
    <div>
      {(search || filters) && (
        <div className="table-filter">
          {search && (
            <div style={{ position: 'relative', flex: '0 1 320px' }}>
              <Search size={15} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--muted)' }} aria-hidden />
              <input className="input" style={{ paddingLeft: 32 }} placeholder={searchPlaceholder ?? t('common.filter')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('common.filter')} />
            </div>
          )}
          {filters}
        </div>
      )}
      {error ? (
        <ErrorNotice error={error} onRetry={onRetry} />
      ) : loading && !rows ? (
        <div className="card card-body"><Skeleton rows={5} /></div>
      ) : !view.length ? (
        <div className="card"><Empty icon={emptyIcon} title={q ? t('common.noResults') : empty ?? t('common.noResults')} /></div>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table" data-react-sort="">
              <thead>
                <tr>
                  {selectable && (
                    <th className="w-check">
                      <input type="checkbox" aria-label={t('common.all')} checked={allSelected} onChange={(e) => onSelect?.(new Set(e.target.checked ? view.map(rowKey) : []))} />
                    </th>
                  )}
                  {columns.map((c) => (
                    <th key={c.key} className={c.className?.split(' ').includes('num') ? 'num' : undefined} style={c.width ? { width: c.width } : undefined} aria-sort={sort?.key === c.key ? (sort.desc ? 'descending' : 'ascending') : undefined}>
                      {c.header && c.sortable !== false ? (
                        <button onClick={() => setSort((s) => (s?.key === c.key ? { key: c.key, desc: !s.desc } : { key: c.key }))}>
                          {c.header}
                          {sort?.key === c.key && (sort.desc ? <ArrowDown size={12} /> : <ArrowUp size={12} />)}
                        </button>
                      ) : c.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {view.map((r) => {
                  const k = rowKey(r);
                  return (
                    <tr key={k}>
                      {selectable && (
                        <td className="w-check">
                          <input type="checkbox" aria-label={k} checked={!!selected?.has(k)} onChange={(e) => {
                            const s = new Set(selected);
                            if (e.target.checked) s.add(k); else s.delete(k);
                            onSelect?.(s);
                          }} />
                        </td>
                      )}
                      {columns.map((c) => <td key={c.key} className={c.className}>{c.render(r)}</td>)}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="table-foot"><span>{t('common.items', { n: view.length })}</span>{loading && <span className="spinner" aria-hidden />}</div>
        </>
      )}
    </div>
  );
}
