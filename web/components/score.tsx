'use client';

import { useEffect, useRef, useState } from 'react';

/** Numero da tabellone: sale dal valore precedente al nuovo con un'uscita esponenziale. */
export function Score({ value, format = (n) => String(n), duration = 900 }: { value: number; format?: (n: number) => string; duration?: number }) {
  const [shown, setShown] = useState(value);
  const [flash, setFlash] = useState(0);
  const from = useRef(0);
  const first = useRef(true);
  useEffect(() => {
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { setShown(value); from.current = value; return; }
    if (!first.current && value !== from.current) setFlash((f) => f + 1);
    first.current = false;
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / duration);
      const e = 1 - Math.pow(2, -10 * p);
      setShown(Math.round(a + (value - a) * (p === 1 ? 1 : e)));
      if (p < 1) raf = requestAnimationFrame(tick);
      else from.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return flash ? <span key={flash} className="score-flash">{format(shown)}</span> : <>{format(shown)}</>;
}
