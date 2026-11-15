import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { nodeLoader } from '../../web/js/core/loader.js';
import { Ephemeris, utcMsToEt, sampleVectors } from '../../web/js/core/ephemeris.js';
import {
  siteFrame, topocentric, topocentricInto, elevationDeg, subPoint, stationElevation,
  SUN_RADIUS_KM, EARTH_RADIUS_KM, MOON_RADIUS_KM,
} from '../../web/js/core/geometry.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = JSON.parse(await readFile(path.join(root, 'tests/fixtures/ephem_reference.json'), 'utf8'));
const eph = await Ephemeris.load(nodeLoader(path.join(root, 'web/data')));

const ANGLE_TOL = 0.005;
const STATION_TOL = 0.05;
const wrap = (d) => ((d + 540) % 360) - 180;
const angleBetween = (a, b) => {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return Math.acos(Math.min(1, d / Math.hypot(...a) / Math.hypot(...b))) * 180 / Math.PI;
};

test('utcMsToEt matches SPICE including leap seconds (|d| < 5 ms)', () => {
  for (const e of fixture.epochs) {
    assert.ok(Math.abs(utcMsToEt(e.tMs) - e.et) < 5e-3, `${e.utc}: ${utcMsToEt(e.tMs) - e.et}`);
  }
});

test('range and RangeError outside coverage', async () => {
  const { startMs, endMs } = eph.range;
  assert.equal(new Date(startMs).toISOString(), '1969-01-01T00:00:00.000Z');
  assert.equal(new Date(endMs).toISOString(), '2060-01-01T00:00:00.000Z');
  await assert.rejects(eph.ensure(startMs - 1), RangeError);
  await assert.rejects(eph.ensure(endMs, endMs + 3600e3), RangeError);
  assert.throws(() => eph.sunVec(endMs + 400 * 86400e3), RangeError);
});

test('Sun / Earth vectors, sub-points and site az/el match SPICE', async () => {
  let maxVec = 0, maxAzEl = 0, maxSub = 0, maxAng = 0, maxRangeRel = 0;
  const sun = new Float64Array(3), earth = new Float64Array(3), tmp = new Float64Array(4);
  const frames = fixture.sites.map((s) => siteFrame(s.lat, s.lon, s.heightM));
  fixture.sites.forEach((s, j) => {
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(frames[j].pos[c] - s.pos[c]) < 1e-9);
  });
  for (const [i, e] of fixture.epochs.entries()) {
    await eph.ensure(e.tMs);
    eph.sunVec(e.tMs, sun);
    eph.earthVec(e.tMs, earth);
    maxVec = Math.max(maxVec, angleBetween(sun, e.sun), angleBetween(earth, e.earth));
    maxRangeRel = Math.max(maxRangeRel, Math.abs(Math.hypot(...earth) / Math.hypot(...e.earth) - 1));
    for (const [p, ref] of [[subPoint(sun), e.subSolar], [subPoint(earth), e.subEarth]]) {
      maxSub = Math.max(maxSub, Math.abs(p.lat - ref.lat),
        Math.abs(wrap(p.lon - ref.lon)) * Math.cos(ref.lat * Math.PI / 180));
    }
    fixture.sites.forEach((s, j) => {
      for (const [body, v, r] of [['sun', sun, SUN_RADIUS_KM], ['earth', earth, EARTH_RADIUS_KM]]) {
        const t = topocentric(frames[j], v, r);
        const ref = s[body];
        const dEl = Math.abs(t.el - ref.el[i]);
        const dAz = Math.abs(wrap(t.az - ref.az[i])) * Math.cos(ref.el[i] * Math.PI / 180);
        maxAzEl = Math.max(maxAzEl, dEl, dAz);
        maxAng = Math.max(maxAng, Math.abs(t.angularRadiusDeg - ref.angularRadiusDeg[i]));
        assert.ok(Math.abs(t.rangeKm / ref.rangeKm[i] - 1) < 1e-6);
        topocentricInto(frames[j], v, r, tmp);
        assert.equal(tmp[1], t.el);
        assert.ok(Math.abs(elevationDeg(frames[j], v) - t.el) < 1e-12);
      }
    });
  }
  console.log(`max vector angle ${maxVec.toExponential(2)} deg, az/el ${maxAzEl.toExponential(2)} deg, ` +
    `sub-point ${maxSub.toExponential(2)} deg, Earth range rel ${maxRangeRel.toExponential(2)}`);
  assert.ok(maxAzEl < ANGLE_TOL, `az/el ${maxAzEl}`);
  assert.ok(maxVec < ANGLE_TOL);
  assert.ok(maxSub < ANGLE_TOL);
  assert.ok(maxAng < 1e-5);
});

test('Moon elevation at DSN stations matches SPICE', async () => {
  let max = 0;
  const v = new Float64Array(3), dir = new Float64Array(3);
  for (const e of fixture.epochs) {
    await eph.ensure(e.tMs);
    eph.moonVecEarthFixed(e.tMs, v);
    eph.moonDirEarthFixed(e.tMs, dir);
    assert.ok(Math.abs(Math.hypot(...dir) - 1) < 1e-12);
    for (const [id, st] of Object.entries(fixture.stations)) {
      max = Math.max(max, Math.abs(stationElevation(st, v) - e.stationElevationDeg[id]));
    }
  }
  console.log(`max station elevation difference ${max.toExponential(2)} deg`);
  assert.ok(max < STATION_TOL, `station ${max}`);
});

test('sampleVectors equals the per-call accessors', async () => {
  const t0 = Date.UTC(2024, 1, 22, 23, 23);
  const n = 500, step = 600e3;
  const s = await sampleVectors(eph, t0, step, n);
  const a = new Float64Array(3);
  for (const i of [0, 137, n - 1]) {
    eph.sunVec(t0 + i * step, a);
    assert.deepEqual(Array.from(s.sun.subarray(3 * i, 3 * i + 3)), Array.from(a));
    eph.moonDirEarthFixed(t0 + i * step, a);
    assert.deepEqual(Array.from(s.mef.subarray(3 * i, 3 * i + 3)), Array.from(a));
  }
});

test('sanity: Apollo 11 landing Sun elevation ~10.7 deg, south pole Earth within +-7 deg', async () => {
  const t = Date.parse('1969-07-20T20:17:40Z');
  await eph.ensure(t);
  const f = siteFrame(0.67416, 23.47314, 0);
  const el = topocentric(f, eph.sunVec(t), SUN_RADIUS_KM).el;
  assert.ok(Math.abs(el - 10.7) < 0.3, `Apollo 11 Sun elevation ${el}`);

  const pole = siteFrame(-90, 0, 0);
  const s = await sampleVectors(eph, Date.UTC(2024, 0, 1), 6 * 3600e3, 4 * 365);
  let lo = 90, hi = -90;
  for (let i = 0; i < s.tMs.length; i++) {
    const e = elevationDeg(pole, s.earth.subarray(3 * i, 3 * i + 3));
    lo = Math.min(lo, e); hi = Math.max(hi, e);
  }
  assert.ok(lo > -7.5 && hi < 7.5 && hi - lo > 10, `pole Earth elevation ${lo}..${hi}`);
  assert.equal(MOON_RADIUS_KM, 1737.4);
});

test('per-call speed: 1e6 sunVec+earthVec calls', async () => {
  const t0 = Date.UTC(2030, 0, 1);
  await eph.ensure(t0, t0 + 30 * 86400e3);
  const a = new Float64Array(3), f = siteFrame(-89.45, -137.31, 2);
  let acc = 0;
  const start = performance.now();
  for (let i = 0; i < 1e6; i++) {
    const t = t0 + i * 2500;
    eph.sunVec(t, a); acc += elevationDeg(f, a);
    eph.earthVec(t, a); acc += elevationDeg(f, a);
  }
  const ms = performance.now() - start;
  console.log(`1e6 x (sunVec + earthVec + 2 elevations): ${ms.toFixed(0)} ms`);
  assert.ok(Number.isFinite(acc));
});
