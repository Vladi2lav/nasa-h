import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, defaultState, encodeHash, decodeHash } from '../../web/js/ui/store.js';

test('hash round-trip keeps scenarios, view, map and options', () => {
  const t = Date.UTC(2026, 10, 14, 12);
  const store = createStore(defaultState(t));
  store.addScenario({ id: 'im-2-athena', name: 'IM-2 Athena — Mons Mouton', lat: -84.7906, lon: 29.1957 }, t, 14);
  store.addScenario({ name: 'Custom, with comma & ünïcode', lat: 10.5, lon: -137.4 }, t + 7 * 86400000, 30);
  store.set({ view: 'compare', mapMode: 'south', opts: { sunMinFraction: 0.25, commMaskDeg: 5, panel: 'horizontal', observerHeightM: 3.5 } });
  const hash = encodeHash(store.get());
  const p = decodeHash(hash);
  assert.equal(p.timeMs, t);
  assert.equal(p.view, 'compare');
  assert.equal(p.mapMode, 'south');
  assert.deepEqual(p.opts, { sunMinFraction: 0.25, commMaskDeg: 5, panel: 'horizontal', observerHeightM: 3.5 });
  assert.equal(p.scenarios.length, 2);
  const [a, b] = p.scenarios;
  assert.equal(a.site.id, 'im-2-athena');
  assert.equal(a.site.name, 'IM-2 Athena — Mons Mouton');
  assert.ok(Math.abs(a.site.lat + 84.7906) < 1e-5);
  assert.equal(a.durationDays, 14);
  assert.equal(b.site.name, 'Custom, with comma & ünïcode');
  assert.equal(b.site.id, undefined);
  assert.equal(b.t0Ms, t + 7 * 86400000);
  assert.equal(b.durationDays, 30);
  assert.equal(p.activeId, b.id);
});

test('decodeHash ignores invalid parts', () => {
  assert.deepEqual(decodeHash(''), {});
  const p = decodeHash('#t=nope&s=95,10,2026-01-01T00:00Z,14,,X|1,2,bad,14,,Y&v=hack&m=zzz&o=2,x,round,-1');
  assert.equal(p.timeMs, undefined);
  assert.equal(p.scenarios, undefined);
  assert.equal(p.view, undefined);
  assert.equal(p.mapMode, undefined);
  assert.deepEqual(p.opts, {});
});

test('store notifies changed keys only', () => {
  const store = createStore(defaultState(0));
  const seen = [];
  store.subscribe((s, changed) => seen.push(changed.join(',')));
  store.set({ view: 'plan' });
  store.set({ view: 'plan' });
  store.set({ opts: { panel: 'tracking' } });
  store.set({ opts: { panel: 'horizontal' } });
  assert.deepEqual(seen, ['view', 'opts']);
});
