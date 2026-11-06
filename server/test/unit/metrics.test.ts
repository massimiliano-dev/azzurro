import { test } from 'node:test';
import assert from 'node:assert/strict';
// stesso ordine di caricamento dell'app (monitoring ↔ network sono ciclici)
import '../../src/arm/generic.ts';
import { metricValues } from '../../src/arm/monitoring.ts';

const site = { id: '/subscriptions/s/resourceGroups/r/providers/Microsoft.Web/sites/app', type: 'Microsoft.Web/sites', location: 'westeurope', _created: '2026-01-01T00:00:00Z', properties: { state: 'Running' } };
const q = (o: Record<string, string>) => new URLSearchParams(o);
const end = Math.floor(Date.now() / 3600_000) * 3600_000;
const span = (h: number) => `${new Date(end - h * 3600_000).toISOString()}/${new Date(end).toISOString()}`;

test('secchi, aggregazioni coerenti e deterministiche', () => {
  const r = metricValues(site, q({ metricnames: 'Requests,HttpResponseTime', timespan: span(24), interval: 'PT1H', aggregation: 'Total,Average,Maximum,Minimum,Count' }));
  assert.equal(r.value.length, 2);
  const data = r.value[0].timeseries[0].data as any[];
  assert.equal(data.length, 24);
  for (const p of data) {
    assert.ok(p.minimum <= p.average && p.average <= p.maximum, 'min ≤ media ≤ max');
    assert.equal(p.count, 60);
    assert.ok(Math.abs(p.total - p.average * 60) < 1, 'totale = media × minuti');
  }
  assert.deepEqual(metricValues(site, q({ metricnames: 'Requests', timespan: span(24), interval: 'PT1H', aggregation: 'Total' })).value[0].timeseries, metricValues(site, q({ metricnames: 'Requests', timespan: span(24), interval: 'PT1H', aggregation: 'Total' })).value[0].timeseries);
  const rt = r.value[1].timeseries[0].data as any[];
  assert.ok(rt.every((p) => p.average > 0 && p.average < 1), 'tempo di risposta in secondi');
});

test('app arrestata: zero; percentuali entro 0–100', () => {
  const stopped = { ...site, properties: { state: 'Stopped' } };
  const d = metricValues(stopped, q({ metricnames: 'Requests', timespan: span(2), interval: 'PT5M', aggregation: 'Total' })).value[0].timeseries[0].data as any[];
  assert.ok(d.every((p) => p.total === 0));
  const vm = { id: '/subscriptions/s/resourceGroups/r/providers/Microsoft.Compute/virtualMachines/vm', type: 'Microsoft.Compute/virtualMachines', _created: '2026-01-01T00:00:00Z', properties: {} };
  const cpu = metricValues(vm, q({ metricnames: 'Percentage CPU', timespan: span(48), interval: 'PT15M', aggregation: 'Maximum' })).value[0].timeseries[0].data as any[];
  assert.ok(cpu.every((p) => p.maximum >= 0 && p.maximum <= 100));
});

test('errori come Azure', () => {
  assert.throws(() => metricValues(site, q({ metricnames: 'Nope' })), /Failed to find metric configuration.*Valid metrics: Requests/);
  assert.throws(() => metricValues(site, q({ metricnames: 'Requests', interval: 'PT2M' })), /Invalid time grain/);
  assert.throws(() => metricValues(site, q({ metricnames: 'Requests', aggregation: 'Median' })), /Invalid aggregation/);
});
