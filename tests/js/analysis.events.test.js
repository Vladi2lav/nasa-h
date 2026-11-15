import test from 'node:test';
import assert from 'node:assert/strict';
import { computeEvents, computeNextEvents, visibleDiscFraction, computeInstant } from '../../web/js/core/analysis.js';
import { makeFixture, roughHorizon, topo, bisectRoot, R_MOON_KM, AU_KM, SYNODIC_MS, SUN_RADIUS_KM } from './analysis-fakes.js';

const DAY = 86400000;
const T0 = Date.UTC(2026, 2, 1);

function analyticSunEvents(eph, frame, t0, t1) {
  const alpha = (Math.acos((R_MOON_KM + frame.heightM / 1000) / AU_KM) * 180) / Math.PI;
  const out = [];
  for (const [type, lon] of [['sunrise', alpha], ['sunset', -alpha]]) {
    let t = eph.refMs + ((eph.sunLon0Deg - lon) / 360) * SYNODIC_MS;
    while (t > t0) t -= SYNODIC_MS;
    for (; t < t1; t += SYNODIC_MS) if (t >= t0) out.push({ type, tMs: t });
  }
  return out.sort((a, b) => a.tMs - b.tMs);
}

test('equatorial sunrise/sunset match the analytic times to 1 s', () => {
  const { eph, env, frame, ctx } = makeFixture({ lat: 0, lon: 0 });
  const t1 = T0 + 60 * DAY;
  const res = computeEvents(env, ctx, T0, t1);
  const sunEv = res.events.filter((e) => e.type.startsWith('sun'));
  const expected = analyticSunEvents(eph, frame, T0, t1);
  assert.equal(sunEv.length, expected.length);
  assert.ok(expected.length >= 4);
  sunEv.forEach((e, i) => {
    assert.equal(e.type, expected[i].type);
    assert.ok(Math.abs(e.tMs - expected[i].tMs) <= 1000, `${e.type}: off by ${(e.tMs - expected[i].tMs) / 1000} s`);
    assert.ok(Math.abs(e.elDeg) < 1e-4);
  });
  for (const e of sunEv) assert.ok(e.type === 'sunrise' ? Math.abs(e.azDeg - 90) < 0.1 : Math.abs(e.azDeg - 270) < 0.1);
  assert.equal(res.earthVisibleAtStart, true);
  assert.equal(res.events.filter((e) => e.type.startsWith('earth')).length, 0);
});

test('Earthrise/Earthset near the limb follow the libration, refined to 1 s', () => {
  const lon = 88.5;
  const mask = 2;
  const { eph, env, frame, ctx } = makeFixture({ lat: 0, lon, earthLibLonDeg: 3 });
  const t1 = T0 + 90 * DAY;
  const res = computeEvents(env, ctx, T0, t1, { commMaskDeg: mask });
  const earthEv = res.events.filter((e) => e.type.startsWith('earth'));
  const g = (t) => topo(frame, eph.earthVec(t)).el - mask;
  const expected = [];
  for (let t = T0; t < t1; t += 60000) {
    if (Math.sign(g(t)) !== Math.sign(g(t + 60000))) {
      expected.push({ type: g(t + 60000) > 0 ? 'earthrise' : 'earthset', tMs: bisectRoot(g, t, t + 60000, 1) });
    }
  }
  assert.ok(expected.length >= 4, 'fixture must produce Earth events');
  assert.equal(earthEv.length, expected.length);
  earthEv.forEach((e, i) => {
    assert.equal(e.type, expected[i].type);
    assert.ok(Math.abs(e.tMs - expected[i].tMs) <= 1500, `off by ${(e.tMs - expected[i].tMs) / 1000} s`);
  });
});

test('polar grazing Sun behind peaks: every brute-force crossing is found and refined', () => {
  const horizon = roughHorizon(11, -0.3, 1.6);
  const { eph, env, frame, ctx } = makeFixture({ lat: -89.6, lon: 30, horizon, sunDecDeg: -0.2, sunDecAmpDeg: 1.0 });
  const t1 = T0 + 45 * DAY;
  const res = computeEvents(env, ctx, T0, t1);
  const sunEv = res.events.filter((e) => e.type.startsWith('sun'));
  const up = (t) => {
    const s = topo(frame, eph.sunVec(t));
    const r = (Math.asin(SUN_RADIUS_KM / s.dist) * 180) / Math.PI;
    return visibleDiscFraction(s.az, s.el, r, horizon) >= 0.5;
  };
  const brute = [];
  let prev = up(T0);
  for (let t = T0 + 30000; t <= t1; t += 30000) {
    const u = up(t);
    if (u !== prev) brute.push({ type: u ? 'sunrise' : 'sunset', tMs: t - 15000 });
    prev = u;
  }
  assert.ok(brute.length >= 6, `fixture must graze (got ${brute.length} crossings)`);
  const isolated = brute.filter((b, i) => (i === 0 || b.tMs - brute[i - 1].tMs > 600000) && (i === brute.length - 1 || brute[i + 1].tMs - b.tMs > 600000));
  for (const b of isolated) {
    assert.ok(sunEv.some((e) => e.type === b.type && Math.abs(e.tMs - b.tMs) <= 16000), `missed ${b.type} at ${new Date(b.tMs).toISOString()}`);
  }
  for (const e of sunEv) assert.ok(brute.some((b) => Math.abs(e.tMs - b.tMs) <= 16000), 'spurious event');
  let state = res.sunlitAtStart;
  for (const e of sunEv) {
    assert.equal(e.type, state ? 'sunset' : 'sunrise');
    state = !state;
  }
  for (const e of sunEv) assert.notEqual(up(e.tMs - 1000), up(e.tMs + 1000));
});

test('nextEvents gives countdowns, and null when the body never sets within the search', () => {
  const { eph, env, frame, ctx } = makeFixture({ lat: 0, lon: 0 });
  const expected = analyticSunEvents(eph, frame, T0, T0 + 40 * DAY);
  const next = computeNextEvents(env, ctx, T0, T0 + 400 * DAY);
  const firstSet = expected.find((e) => e.type === 'sunset').tMs;
  const firstRise = expected.find((e) => e.type === 'sunrise').tMs;
  assert.ok(Math.abs(next.sunsetMs - firstSet) <= 1000);
  assert.ok(Math.abs(next.sunriseMs - firstRise) <= 1000);
  assert.ok(Math.abs(next.hoursToSunset - (firstSet - T0) / 3600000) < 1e-3);
  assert.equal(next.earthsetMs, null);
  assert.equal(next.hoursToEarthrise, null);
  assert.equal(next.earthVisibleNow, true);

  const polar = makeFixture({ lat: 89.9, lon: 0, sunDecDeg: 5 });
  const n2 = computeNextEvents(polar.env, polar.ctx, T0, T0 + 400 * DAY);
  assert.equal(n2.sunlitNow, true);
  assert.equal(n2.sunsetMs, null);
  assert.equal(n2.sunriseMs, null);
});

test('instant reports consistent geometry, power and comm', () => {
  const { eph, env, ctx } = makeFixture({ lat: 0, lon: 0, stations: [] });
  const tNoon = eph.refMs + (eph.sunLon0Deg / 360) * SYNODIC_MS;
  const s = computeInstant(env, ctx, tNoon);
  assert.ok(s.sun.elDeg > 89.9);
  assert.equal(s.sunlit, true);
  assert.ok(Math.abs(s.power.irradianceWm2 - 1361 * (AU_KM / (AU_KM - R_MOON_KM - 0.002)) ** 2) < 1e-6);
  assert.ok(Math.abs(s.power.horizontalFactor - 1) < 1e-6);
  assert.equal(s.comm.link, null);
  assert.equal(s.comm.basis, 'dte');
  assert.equal(s.comm.available, true);
  assert.ok(Math.abs(s.sun.angularRadiusDeg - 0.2665) < 0.001);
});
