'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '@/i18n';
import { money } from '@/lib/money';

export interface DayPoint { day: string; actual: number; forecast: number }

/** Barre giornaliere: spesa effettiva piena, previsione tratteggiata, stesso blu. */
export function CostChart({ points, today }: { points: DayPoint[]; today?: string }) {
  const { t, locale } = useI18n();
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(1000);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(320, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = 260, PL = 56, PR = 8, PT = 14, PB = 28;
  const max = useMemo(() => {
    const m = Math.max(0.01, ...points.map((p) => p.actual + p.forecast));
    const mag = 10 ** Math.floor(Math.log10(m));
    const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s * 4 >= m) ?? mag * 10;
    return step * 4;
  }, [points]);
  const n = Math.max(points.length, 1);
  const slot = (W - PL - PR) / n;
  const bw = Math.max(2, slot - 2);
  const y = (v: number) => PT + (H - PT - PB) * (1 - v / max);
  const ticks = [0, 1, 2, 3, 4].map((i) => (max / 4) * i);
  const hp = hover !== null ? points[hover] : null;
  return (
    <div className="costchart">
      <div className="legend" aria-hidden>
        <span><i className="sw actual" />{t('costs.actual')}</span>
        <span><i className="sw forecast" />{t('costs.forecastLegend')}</span>
      </div>
      <div className="plot" ref={box}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('costs.dailyChart')} onMouseLeave={() => setHover(null)}>
          <defs>
            <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" className="hatch-bg" />
              <line x1="0" y1="0" x2="0" y2="6" className="hatch-line" strokeWidth="2.4" />
            </pattern>
          </defs>
          {ticks.map((v) => (
            <g key={v}>
              <line x1={PL} x2={W - PR} y1={y(v)} y2={y(v)} className={v === 0 ? 'axis' : 'grid'} vectorEffect="non-scaling-stroke" />
              <text x={PL - 8} y={y(v) + 4} textAnchor="end" className="tick">{money(v, locale).replace(/,00|\.00/, '')}</text>
            </g>
          ))}
          {points.map((p, i) => {
            const x = PL + i * slot + 1;
            const ya = y(p.actual), yf = y(p.actual + p.forecast);
            const day = Number(p.day.slice(8));
            return (
              <g key={p.day} onMouseEnter={() => setHover(i)}>
                <rect x={PL + i * slot} y={PT} width={slot} height={H - PT - PB} className="hit" />
                {p.forecast > 0 && <rect x={x} y={yf} width={bw} height={Math.max(0, ya - yf - (p.actual > 0 ? 2 : 0))} fill="url(#hatch)" className="bar-f" />}
                {p.actual > 0 && <rect x={x} y={ya} width={bw} height={Math.max(1, y(0) - ya)} className={`bar-a ${hover === i ? 'on' : ''}`} />}
                {(day === 1 || (slot >= 22 ? true : day % 5 === 0) || p.day === today) && (
                  <text x={x + bw / 2} y={H - 9} textAnchor="middle" className={`tick ${p.day === today ? 'today' : ''}`}>{day}</text>
                )}
              </g>
            );
          })}
        </svg>
        {hp && hover !== null && (
          <div className="tip" style={{ left: `${((PL + (hover + 0.5) * slot) / W) * 100}%` }} role="status">
            <strong>{new Date(`${hp.day}T00:00:00Z`).toLocaleDateString(locale === 'it' ? 'it-IT' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}</strong>
            {hp.actual > 0 && <span><i className="sw actual" />{t('costs.actual')} <b>{money(hp.actual, locale)}</b></span>}
            {hp.forecast > 0 && <span><i className="sw forecast" />{t('costs.forecastLegend')} <b>{money(hp.forecast, locale)}</b></span>}
            {!hp.actual && !hp.forecast && <span className="muted">{t('costs.noCostDay')}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

/** Barre orizzontali di magnitudine: una tinta, etichette in inchiostro. */
export function CostBars({ items, total }: { items: { key: string; label: React.ReactNode; value: number; href?: string }[]; total: number }) {
  const { locale } = useI18n();
  const max = Math.max(0.0001, ...items.map((i) => i.value));
  return (
    <div className="costbars">
      {items.map((i) => (
        <div className="row-b" key={i.key} title={`${money(i.value, locale, { precise: true })}`}>
          <span className="lbl">{i.label}</span>
          <span className="track"><span className="fill" style={{ width: `${(i.value / max) * 100}%` }} /></span>
          <span className="val num">{money(i.value, locale)}</span>
          <span className="pct num muted">{total > 0 ? `${Math.round((i.value / total) * 100)}%` : '—'}</span>
        </div>
      ))}
    </div>
  );
}
