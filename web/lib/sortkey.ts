'use client';

import { isValidElement, type ReactNode } from 'react';

/** Testo visibile di un nodo React (per ordinare colonne senza una chiave dichiarata). */
export function nodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join(' ');
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode; title?: string; value?: string };
    return nodeText(props.children) || props.title || '';
  }
  return '';
}

const UNITS: Record<string, number> = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4, ms: 1, s: 1000 };

/** Valore confrontabile: numeri, importi in euro, percentuali, dimensioni, altrimenti testo. */
export function sortValue(raw: string): number | string {
  const s = raw.replace(/ /g, ' ').trim();
  if (!s || s === '—' || s === '–' || s === '-') return '';
  if (/^<\s/.test(s)) return 0.001;
  const m = /^([+-]?[\d.,]+)\s*(€|%|[a-z]{1,3})?\b/i.exec(s.replace(/^€\s*/, ''));
  if (m && /\d/.test(m[1])) {
    let n = m[1];
    // 1.234,56 (italiano) oppure 1,234.56 (inglese)
    if (/,\d{1,2}$/.test(n) || (n.includes('.') && n.includes(',') && n.lastIndexOf(',') > n.lastIndexOf('.'))) n = n.replace(/\./g, '').replace(',', '.');
    else n = n.replace(/,/g, '');
    const v = Number(n);
    if (Number.isFinite(v)) return v * (UNITS[(m[2] ?? '').toLowerCase()] ?? 1);
  }
  return s.toLowerCase();
}

export function compareValues(a: number | string, b: number | string): number {
  if (a === '' && b !== '') return 1;
  if (b === '' && a !== '') return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}
