'use client';

/** Importi in euro: due decimali, «< 0,01 €» per i valori minimi che non sono zero. */
export function money(v: number | null | undefined, locale: string, opts: { precise?: boolean } = {}): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const f = (n: number, d: number) => new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-IE', { style: 'currency', currency: 'EUR', minimumFractionDigits: d, maximumFractionDigits: d }).format(n);
  if (v > 0 && v < 0.01) return opts.precise ? f(v, 4) : `< ${f(0.01, 2)}`;
  return f(v, opts.precise && v < 1 ? 4 : 2);
}

export function unitPrice(v: number, locale: string): string {
  const d = v === 0 ? 2 : v < 0.001 ? 7 : v < 0.01 ? 5 : v < 1 ? 4 : 2;
  return new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-IE', { style: 'currency', currency: 'EUR', minimumFractionDigits: Math.min(d, 2), maximumFractionDigits: d }).format(v);
}

export type CostTable = { properties: { columns: { name: string }[]; rows: any[][] } };

/** Righe della risposta Cost Management come oggetti per nome di colonna. */
export function rowsOf(r: CostTable | undefined): Record<string, any>[] {
  if (!r) return [];
  const cols = r.properties.columns.map((c) => c.name);
  return r.properties.rows.map((row) => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

/** Intervallo esplicito di un mese (0 = corrente, -1 = scorso): Azure reale non accetta TheLastMonth. */
export function monthRange(offset = 0): { from: string; to: string } {
  const n = new Date();
  const from = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + offset, 1));
  const to = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + offset + 1, 0, 23, 59, 59));
  return { from: from.toISOString(), to: to.toISOString() };
}
