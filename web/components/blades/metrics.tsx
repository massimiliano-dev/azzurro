'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { arm } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useI18n } from '@/i18n';
import { Button, Card, ErrorNotice, Field, Notice, Select, Skeleton } from '../ui';
import { useL } from './common';

const MON_API = '2023-10-01';
type Agg = 'Average' | 'Minimum' | 'Maximum' | 'Total' | 'Count';
interface Def { name: { value: string; localizedValue?: string }; unit: string; primaryAggregationType: Agg; supportedAggregationTypes?: string[]; metricAvailabilities?: { timeGrain: string }[]; displayDescription?: string }
interface Point { t: number; v: number | null }
type RangeKey = '1h' | '24h' | '7d' | '30d';
const RANGES: Record<RangeKey, { ms: number; grain: string }> = {
  '1h': { ms: 3600_000, grain: 'PT1M' }, '24h': { ms: 86_400_000, grain: 'PT15M' }, '7d': { ms: 7 * 86_400_000, grain: 'PT1H' }, '30d': { ms: 30 * 86_400_000, grain: 'PT6H' },
};

/** Le metriche che il portale Azure mostra per prime, per i tipi più comuni (nomi reali di Azure Monitor). */
const DEFAULTS: Record<string, string[]> = {
  'microsoft.web/sites': ['Requests', 'HttpResponseTime', 'Http5xx', 'CpuTime', 'MemoryWorkingSet'],
  'microsoft.web/serverfarms': ['CpuPercentage', 'MemoryPercentage', 'HttpQueueLength'],
  'microsoft.compute/virtualmachines': ['Percentage CPU', 'Available Memory Bytes', 'Network In Total', 'Network Out Total'],
  'microsoft.dbforpostgresql/flexibleservers': ['cpu_percent', 'memory_percent', 'active_connections', 'storage_percent'],
  'microsoft.dbformysql/flexibleservers': ['cpu_percent', 'memory_percent', 'active_connections', 'storage_percent'],
  'microsoft.sql/servers/databases': ['cpu_percent', 'storage_percent', 'connection_successful', 'deadlock'],
  'microsoft.cache/redis': ['percentProcessorTime', 'usedmemorypercentage', 'connectedclients', 'cachehits'],
  'microsoft.storage/storageaccounts': ['Transactions', 'UsedCapacity', 'Egress', 'SuccessE2ELatency'],
  'microsoft.documentdb/databaseaccounts': ['TotalRequests', 'NormalizedRUConsumption', 'ServerSideLatency'],
  'microsoft.app/containerapps': ['Requests', 'Replicas', 'WorkingSetBytes'],
  'microsoft.containerservice/managedclusters': ['node_cpu_usage_percentage', 'node_memory_working_set_percentage', 'kube_pod_status_ready'],
  'microsoft.cognitiveservices/accounts': ['TotalCalls', 'TotalErrors', 'Latency', 'GeneratedTokens'],
  'microsoft.insights/components': ['requests/count', 'requests/failed', 'requests/duration', 'availabilityResults/availabilityPercentage'],
  'microsoft.keyvault/vaults': ['ServiceApiHit', 'ServiceApiLatency', 'Availability'],
  'microsoft.servicebus/namespaces': ['IncomingMessages', 'OutgoingMessages', 'ActiveMessages', 'ServerErrors'],
  'microsoft.eventhub/namespaces': ['IncomingMessages', 'OutgoingMessages', 'ThrottledRequests'],
  'microsoft.containerregistry/registries': ['TotalPullCount', 'TotalPushCount', 'StorageUsed'],
};

const minutes = (g: string) => (/^P(\d+)D$/i.test(g) ? Number(/(\d+)D/i.exec(g)![1]) * 1440 : Number(/(\d+)H/i.exec(g)?.[1] ?? 0) * 60 + Number(/(\d+)M/i.exec(g)?.[1] ?? 0));
/** La grana richiesta, se la metrica la offre; altrimenti la più vicina più grande (es. UsedCapacity è solo oraria). */
function grainFor(def: Def, want: string): string {
  const av = (def.metricAvailabilities ?? []).map((a) => a.timeGrain).filter((g) => minutes(g) > 0).sort((a, b) => minutes(a) - minutes(b));
  return av.find((g) => minutes(g) >= minutes(want)) ?? av.at(-1) ?? want;
}
const aggsOf = (def: Def) => (def.supportedAggregationTypes ?? [def.primaryAggregationType]).filter((a): a is Agg => a !== 'None');
const isoMin = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Valore con l'unità di Azure Monitor: percentuali, byte, millisecondi, conteggi. */
export function fmtMetric(v: number, unit: string, locale: string): string {
  if (v === 0) return '0';
  const nf = (d: number) => new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { maximumFractionDigits: d });
  const scaled = (x: number, units: string[]) => { let i = 0; while (Math.abs(x) >= 1024 && i < units.length - 1) { x /= 1024; i++; } return `${nf(Math.abs(x) < 10 && i ? 1 : 0).format(x)} ${units[i]}`; };
  switch (unit.toLowerCase()) {
    case 'percent': return `${nf(1).format(v)} %`;
    case 'bytes': return scaled(v, ['B', 'KB', 'MB', 'GB', 'TB']);
    case 'bytespersecond': return scaled(v, ['B/s', 'KB/s', 'MB/s', 'GB/s']);
    case 'milliseconds': return v >= 1000 ? `${nf(2).format(v / 1000)} s` : `${nf(v < 10 ? 1 : 0).format(v)} ms`;
    case 'seconds': return v < 1 ? `${nf(0).format(v * 1000)} ms` : `${nf(v < 10 ? 2 : 0).format(v)} s`;
    case 'countpersecond': return `${new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { notation: 'compact', maximumFractionDigits: 1 }).format(v)}/s`;
    default: return new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { notation: 'compact', maximumFractionDigits: 1 }).format(v);
  }
}

function summarize(points: Point[], agg: Agg): number | null {
  const vs = points.map((p) => p.v).filter((v): v is number => v !== null);
  if (!vs.length) return null;
  if (agg === 'Total' || agg === 'Count') return vs.reduce((a, b) => a + b, 0);
  if (agg === 'Maximum') return Math.max(...vs);
  if (agg === 'Minimum') return Math.min(...vs);
  return vs.reduce((a, b) => a + b, 0) / vs.length;
}

/** Linea su un solo asse: 2px, velo al 10%, griglia sottile, mirino con il valore al passaggio. */
function MetricChart({ points, unit, from, to, height, label }: { points: Point[]; unit: string; from: number; to: number; height: number; label: string }) {
  const { locale } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = height, PL = 58, PR = 10, PT = 10, PB = 24;
  const max = useMemo(() => {
    const m = Math.max(0, ...points.map((p) => p.v ?? 0));
    // i conteggi hanno tacche intere: almeno 0–4
    const whole = /^count/i.test(unit);
    if (m === 0) return unit === 'Percent' ? 100 : whole ? 4 : 1;
    // byte: passi tondi nell'unità mostrata (KB, MB, GB sono potenze di 1024)
    const bin = /^bytes/i.test(unit) ? 1024 ** Math.max(0, Math.floor(Math.log(m) / Math.log(1024))) : 1;
    const mm = m / bin;
    const mag = 10 ** Math.floor(Math.log10(mm));
    const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s * 4 >= mm) ?? mag * 10;
    return unit === 'Percent' ? Math.min(100, step * 4) : whole ? Math.max(4, Math.ceil(step) * 4) : step * 4 * bin;
  }, [points, unit]);
  const x = (t: number) => PL + ((t - from) / Math.max(1, to - from)) * (W - PL - PR);
  const y = (v: number) => PT + (H - PT - PB) * (1 - v / max);
  // segmenti continui: i buchi (nessun dato) restano buchi
  const segs: Point[][] = [];
  for (const p of points) {
    if (p.v === null) { if (segs.at(-1)?.length) segs.push([]); continue; }
    if (!segs.length) segs.push([]);
    segs.at(-1)!.push(p);
  }
  const live = segs.filter((s) => s.length);
  const short = to - from <= 86_400_000;
  const fmtT = (t: number, long = false) => new Date(t).toLocaleString(locale === 'it' ? 'it-IT' : 'en-GB', long ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' } : short ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short' });
  const withV = points.filter((p) => p.v !== null);
  const move = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const mx = ((e.clientX - r.left) / r.width) * W;
    let best = -1, d = Infinity;
    withV.forEach((p, i) => { const dd = Math.abs(x(p.t) - mx); if (dd < d) { d = dd; best = i; } });
    setHover(best >= 0 ? best : null);
  };
  const hp = hover !== null ? withV[hover] : null;
  return (
    <div className="mchart" ref={box}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ height: H }} role="img" aria-label={label} onMouseMove={move} onMouseLeave={() => setHover(null)}>
        {[0, 1, 2, 3, 4].map((i) => {
          const v = (max / 4) * i;
          return (
            <g key={i}>
              <line x1={PL} x2={W - PR} y1={y(v)} y2={y(v)} className={i === 0 ? 'axis' : 'grid'} />
              <text x={PL - 8} y={y(v) + 4} textAnchor="end" className="tick">{fmtMetric(v, unit, locale)}</text>
            </g>
          );
        })}
        {(W < 480 ? [0, 2, 4] : [0, 1, 2, 3, 4]).map((i) => {
          const t = from + ((to - from) / 4) * i;
          return <text key={i} x={x(t)} y={H - 6} textAnchor={i === 0 ? 'start' : i === 4 ? 'end' : 'middle'} className="tick">{fmtT(t)}</text>;
        })}
        {live.map((s, i) => (
          s.length === 1
            ? <circle key={i} cx={x(s[0].t)} cy={y(s[0].v!)} r={4} className="dot" />
            : <g key={i}>
              <path d={`M${x(s[0].t)},${y(0)} ${s.map((p) => `L${x(p.t)},${y(p.v!)}`).join(' ')} L${x(s.at(-1)!.t)},${y(0)} Z`} className="area" />
              <path d={s.map((p, j) => `${j ? 'L' : 'M'}${x(p.t)},${y(p.v!)}`).join(' ')} className="line" />
            </g>
        ))}
        {hp && (
          <g>
            <line x1={x(hp.t)} x2={x(hp.t)} y1={PT} y2={H - PB} className="cross" />
            <circle cx={x(hp.t)} cy={y(hp.v!)} r={4} className="dot ring" />
          </g>
        )}
      </svg>
      {hp && (
        <div className="tip" style={{ left: `${(x(hp.t) / W) * 100}%` }} role="status">
          <span>{fmtT(hp.t, true)}</span>
          <b>{fmtMetric(hp.v!, unit, locale)}</b>
        </div>
      )}
    </div>
  );
}

/** Una metrica: titolo, riepilogo del periodo e grafico; con «table» anche i dati in tabella. */
function MetricCard({ id, def, agg, from, to, want, height, table }: { id: string; def: Def; agg: Agg; from: number; to: number; want: string; height: number; table?: boolean }) {
  const L = useL();
  const { locale } = useI18n();
  const grain = grainFor(def, want);
  const name = def.name.value;
  const data = useAsync(async () => {
    const r = await arm.get<any>(`${id}/providers/Microsoft.Insights/metrics`, MON_API, { metricnames: name, timespan: `${isoMin(from)}/${isoMin(to)}`, interval: grain, aggregation: agg });
    return ((r.value?.[0]?.timeseries?.[0]?.data ?? []) as any[]).map((p): Point => ({ t: Date.parse(p.timeStamp), v: typeof p[agg.toLowerCase()] === 'number' ? p[agg.toLowerCase()] : null }));
  }, [id, name, agg, from, to, grain]);
  const AGG_L: Record<Agg, string> = { Average: L('media', 'average'), Minimum: L('minimo', 'minimum'), Maximum: L('massimo', 'maximum'), Total: L('totale', 'total'), Count: L('conteggio', 'count') };
  const sum = data.data ? summarize(data.data, agg) : null;
  const title = def.name.localizedValue ?? name;
  return (
    <div className="mcard">
      <div className="mhead">
        <div><strong>{title}</strong><span className="small muted"> · {AGG_L[agg]}</span></div>
        <span className="mval">{sum === null ? '—' : fmtMetric(sum, def.unit, locale)}</span>
      </div>
      {data.error ? <ErrorNotice error={data.error} onRetry={data.reload} /> : !data.data ? <Skeleton rows={3} /> : !data.data.some((p) => p.v !== null)
        ? <p className="small muted" style={{ height, display: 'grid', placeItems: 'center', margin: 0 }}>{L('Nessun dato nel periodo.', 'No data in this period.')}</p>
        : <MetricChart points={data.data} unit={def.unit} from={from} to={to} height={height} label={`${title} (${AGG_L[agg]})`} />}
      {table && data.data && (
        <details className="small">
          <summary>{L('Dati in tabella', 'Data table')}</summary>
          <div className="scroll-x" style={{ maxHeight: 260 }}>
            <table className="table compact">
              <thead><tr><th>{L('Ora', 'Time')}</th><th className="num">{AGG_L[agg]}</th></tr></thead>
              <tbody>{data.data.filter((p) => p.v !== null).slice(-200).reverse().map((p) => <tr key={p.t}><td className="mono">{new Date(p.t).toLocaleString(locale === 'it' ? 'it-IT' : 'en-GB')}</td><td className="num mono">{fmtMetric(p.v!, def.unit, locale)}</td></tr>)}</tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}

/** Scheda Metriche: le metriche principali del tipo e un esploratore per tutte le altre (Azure Monitor). */
export function MetricsTab({ id, type }: { id: string; type: string }) {
  const L = useL();
  const defs = useAsync(async () => (await arm.get<{ value: Def[] }>(`${id}/providers/Microsoft.Insights/metricDefinitions`, MON_API)).value, [id]);
  const [range, setRange] = useState<RangeKey>('24h');
  const [to, setTo] = useState(() => Math.floor(Date.now() / 60_000) * 60_000);
  const [pick, setPick] = useState('');
  const [agg, setAgg] = useState<Agg | ''>('');
  const all = defs.data ?? [];
  const byName = (n: string) => all.find((d) => d.name.value.toLowerCase() === n.toLowerCase());
  const dash = ((DEFAULTS[type.toLowerCase()] ?? []).map(byName).filter(Boolean) as Def[]).slice(0, 4);
  const shown = dash.length ? dash : all.slice(0, 3);
  const sel = byName(pick) ?? shown[0];
  const selAgg = sel && agg && aggsOf(sel).includes(agg) ? agg : sel?.primaryAggregationType;
  const from = to - RANGES[range].ms;
  const now = () => setTo(Math.floor(Date.now() / 60_000) * 60_000);
  const RANGE_L: Record<RangeKey, string> = { '1h': L('1 ora', '1 hour'), '24h': L('24 ore', '24 hours'), '7d': L('7 giorni', '7 days'), '30d': L('30 giorni', '30 days') };

  if (defs.error) return <ErrorNotice error={defs.error} onRetry={defs.reload} />;
  if (!defs.data) return <Skeleton rows={6} />;
  if (!all.length) return <Notice>{L('Questa risorsa non pubblica metriche in Azure Monitor.', 'This resource publishes no metrics to Azure Monitor.')}</Notice>;
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row wrap" style={{ gap: 8 }}>
        <div className="chips" role="group" aria-label={L('Periodo', 'Time range')} style={{ margin: 0 }}>
          {(Object.keys(RANGES) as RangeKey[]).map((k) => <button key={k} type="button" className={`chip ${range === k ? 'on' : ''}`} onClick={() => { setRange(k); now(); }}>{RANGE_L[k]}</button>)}
        </div>
        <Button size="sm" variant="ghost" icon={RefreshCw} onClick={now}>{L('Aggiorna', 'Refresh')}</Button>
      </div>
      <div className="mgrid">
        {shown.map((d) => <MetricCard key={`${d.name.value}-${range}`} id={id} def={d} agg={d.primaryAggregationType} from={from} to={to} want={RANGES[range].grain} height={170} />)}
      </div>
      {sel && selAgg && (
        <Card title={L('Esplora le metriche', 'Explore metrics')}>
          <div className="grid cols-2" style={{ marginBottom: 8 }}>
            <Field label={L('Metrica', 'Metric')} htmlFor="mx-m">
              <Select id="mx-m" value={sel.name.value} onChange={(e) => { setPick(e.target.value); setAgg(''); }}>
                {all.map((d) => <option key={d.name.value} value={d.name.value}>{d.name.localizedValue ?? d.name.value}</option>)}
              </Select>
            </Field>
            <Field label={L('Aggregazione', 'Aggregation')} htmlFor="mx-a">
              <Select id="mx-a" value={selAgg} onChange={(e) => setAgg(e.target.value as Agg)}>
                {aggsOf(sel).map((a) => <option key={a} value={a}>{a}</option>)}
              </Select>
            </Field>
          </div>
          <MetricCard id={id} def={sel} agg={selAgg} from={from} to={to} want={RANGES[range].grain} height={260} table />
        </Card>
      )}
    </div>
  );
}
