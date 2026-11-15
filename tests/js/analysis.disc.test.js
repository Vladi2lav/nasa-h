import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleDiscFraction, clearance } from '../../web/js/core/analysis.js';
import { ArrayHorizon, FunctionHorizon, flatHorizon, roughHorizon, rng } from './analysis-fakes.js';

const segmentAbove = (d) => (d >= 1 ? 0 : d <= -1 ? 1 : (Math.acos(d) - d * Math.sqrt(1 - d * d)) / Math.PI);

test('flat horizon: fraction equals the circular segment above the chord', () => {
  const r = 0.2666;
  const el = 3;
  for (const d of [-0.999, -0.75, -0.5, -0.2, 0, 0.1, 0.33, 0.5, 0.9, 0.999]) {
    const h = flatHorizon(el + d * r);
    const dStored = (h.elevationAt(0) - el) / r;
    const f = visibleDiscFraction(123.4, el, r, h);
    assert.ok(Math.abs(f - segmentAbove(dStored)) < 1e-9, `d=${d}: ${f} vs ${segmentAbove(dStored)}`);
  }
});

test('disc centred on a flat horizon is exactly half visible', () => {
  assert.ok(Math.abs(visibleDiscFraction(10, 0, 0.95, flatHorizon(0)) - 0.5) < 1e-12);
});

test('fully above and fully below give exactly 1 and 0', () => {
  const h = flatHorizon(1);
  assert.equal(visibleDiscFraction(0, 1.3, 0.25, h), 1);
  assert.equal(visibleDiscFraction(0, 0.7, 0.25, h), 0);
  assert.equal(visibleDiscFraction(0, 45, 0.25, roughHorizon(3)), 1);
  assert.equal(visibleDiscFraction(0, -10, 0.25, roughHorizon(3)), 0);
});

test('point source (radius 0) is visible iff above the horizon', () => {
  assert.equal(visibleDiscFraction(50, 0.01, 0, flatHorizon(0)), 1);
  assert.equal(visibleDiscFraction(50, -0.01, 0, flatHorizon(0)), 0);
});

test('step horizon through the disc centre hides exactly half', () => {
  const step = new FunctionHorizon((az) => (az < 180 ? 30 : -30));
  assert.ok(Math.abs(visibleDiscFraction(180, 0, 0.27, step) - 0.5) < 1e-12);
});

test('azimuth is compressed by cos(el): a step offset in azimuth becomes cos(el) times smaller on the sky', () => {
  const el = 60;
  const r = 0.25;
  const dAz = 0.2;
  const az0 = 100;
  const step = new FunctionHorizon((az) => (az < az0 + dAz ? 89 : -89));
  const f = visibleDiscFraction(az0, el, r, step, 1000);
  const expected = segmentAbove((dAz * Math.cos((el * Math.PI) / 180)) / r);
  assert.ok(Math.abs(f - expected) < 2e-3, `${f} vs ${expected}`);
  assert.ok(Math.abs(f - segmentAbove(dAz / r)) > 0.1, 'must differ from the uncompressed result');
});

test('wrap at 0/360: a disc straddling north is clipped on both sides', () => {
  const h = new FunctionHorizon((az) => (az >= 180 ? 30 : -30));
  for (const az of [0, 360, -720]) {
    assert.ok(Math.abs(visibleDiscFraction(az, 0, 0.27, h) - 0.5) < 1e-12, `az=${az}`);
  }
  const fWest = visibleDiscFraction(359.9, 0, 0.27, h, 2000);
  assert.ok(Math.abs(fWest - segmentAbove(0.1 / 0.27)) < 2e-3);
});

test('rough horizon: agrees with brute-force area sampling (and the skip tests are consistent)', () => {
  const h = roughHorizon(7);
  const rand = rng(42);
  const brute = (az, el, r) => {
    const N = 300;
    let inDisc = 0;
    let vis = 0;
    const c = Math.cos((el * Math.PI) / 180);
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const x = -r + ((i + 0.5) / N) * 2 * r;
        const y = -r + ((j + 0.5) / N) * 2 * r;
        if (x * x + y * y > r * r) continue;
        inDisc++;
        if (el + y >= h.elevationAt(az + x / c)) vis++;
      }
    }
    return vis / inDisc;
  };
  for (let k = 0; k < 40; k++) {
    const az = rand() * 360;
    const el = h.elevationAt(az) + (rand() - 0.5) * 3;
    const r = rand() < 0.5 ? 0.27 : 0.95;
    const f = visibleDiscFraction(az, el, r, h, 64);
    assert.ok(Math.abs(f - brute(az, el, r)) < 0.01, `az=${az} el=${el} r=${r}`);
  }
});

test('clearance is elevation minus horizon at the same azimuth', () => {
  const h = new ArrayHorizon([0, 2, 4, 6], 90);
  assert.equal(clearance(45, 5, h), 4);
  assert.equal(clearance(405, 5, h), 4);
  assert.equal(clearance(315, 5, h), 2);
});
