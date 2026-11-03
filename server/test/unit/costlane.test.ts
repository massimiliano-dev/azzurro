import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costFetch } from '../../src/real/proxy.ts';

const res = (status: number, retry?: number) => new Response('{}', { status, headers: retry ? { 'retry-after': String(retry) } : {} });

test('una query alla volta per scope; il 429 ferma tutta la coda', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  const times: number[] = [];
  const t0 = Date.now();
  const run = async () => {
    calls++;
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight--;
    times.push(Date.now() - t0);
    return calls === 1 ? res(429, 1) : res(200);
  };
  const out = await Promise.all([costFetch('t|/subscriptions/a', run), costFetch('t|/subscriptions/a', run), costFetch('t|/subscriptions/a', run)]);
  assert.equal(maxInFlight, 1, 'mai due insieme sullo stesso scope');
  assert.deepEqual(out.map((r) => r.status), [200, 200, 200], 'il primo ritenta dopo il 429');
  assert.equal(calls, 4);
  assert.ok(times[1] >= 1000, `dopo il 429 si aspetta il retry-after (${times[1]}ms)`);
});

test('scope diversi in parallelo', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const run = async () => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise((r) => setTimeout(r, 30)); inFlight--; return res(200); };
  await Promise.all([costFetch('t|/subscriptions/x', run), costFetch('t|/subscriptions/y', run)]);
  assert.equal(maxInFlight, 2);
});

test('oltre il tempo massimo restituisce il 429', async () => {
  const r = await costFetch('t|/subscriptions/z', async () => res(429, 5), 1000);
  assert.equal(r.status, 429);
});
