import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const core = path.join(root, 'web', 'js', 'core');
const data = path.join(root, 'web', 'data');
const haveEngine =
  existsSync(path.join(core, 'ephemeris.js')) &&
  existsSync(path.join(core, 'geometry.js')) &&
  existsSync(path.join(data, 'ephem', 'index.json'));
const haveTerrain =
  existsSync(path.join(core, 'terrain.js')) &&
  existsSync(path.join(data, 'dem')) &&
  readdirSync(path.join(data, 'dem')).some((f) => f.endsWith('.json'));
const skip = haveEngine ? false : 'real ephemeris modules/data not available';

const DAY = 86400000;
let navPromise;
async function setup() {
  if (!navPromise) {
    navPromise = (async () => {
      const { LunarNav } = await import('../../web/js/core/index.js');
      const { nodeLoader } = await import('../../web/js/core/loader.js');
      const geometry = await import('../../web/js/core/geometry.js');
      return { nav: await LunarNav.create({ loader: nodeLoader(data) }), geometry };
    })();
  }
  return navPromise;
}

test('facade loads catalogue, stations and coverage', { skip }, async () => {
  const { nav } = await setup();
  assert.ok(nav.sites.length > 0);
  assert.ok(nav.stations.length > 0);
  assert.ok(nav.coverage.startMs <= Date.UTC(1969, 6, 1) && nav.coverage.endMs >= Date.UTC(2059, 0, 1));
  if (!haveTerrain) assert.ok(nav.warnings.some((w) => w.includes('terrain')));
});

test('Apollo 11 landing: Sun ≈ 10.8° high; inline topocentric equals geometry.topocentric', { skip }, async () => {
  const { nav, geometry } = await setup();
  const ctx = await nav.prepare('apollo-11');
  assert.equal(ctx.horizonSource === 'sphere', !haveTerrain);
  const t = Date.parse('1969-07-20T20:17:40Z');
  const s = await nav.instant(ctx, t);
  assert.ok(Math.abs(s.sun.elDeg - 10.8) < 0.5, `Sun elevation ${s.sun.elDeg}`);
  assert.equal(s.sunlit, true);
  const ref = geometry.topocentric(ctx.frame, nav.eph.sunVec(t), geometry.SUN_RADIUS_KM);
  assert.ok(Math.abs(ref.el - s.sun.elDeg) < 1e-9 && Math.abs(ref.az - s.sun.azDeg) < 1e-9);
  assert.ok(Math.abs(ref.angularRadiusDeg - s.sun.angularRadiusDeg) < 1e-12);
  const e = geometry.topocentric(ctx.frame, nav.eph.earthVec(t), geometry.EARTH_RADIUS_KM);
  assert.ok(Math.abs(e.el - s.earth.elDeg) < 1e-9);
  const m = nav.eph.moonVecEarthFixed(t);
  for (const st of s.comm.stations) {
    const rec = nav.stations.find((x) => x.id === st.id);
    assert.ok(Math.abs(geometry.stationElevation(rec, m) - st.moonElevationDeg) < 1e-9);
  }
  assert.ok(s.power.irradianceWm2 > 1300 && s.power.irradianceWm2 < 1420);
  assert.ok(Math.abs(s.subSolar.lat) < 2);
});

test('equatorial lunar day: successive sunrises ≈ 29.53 d apart; Earth never sets at Apollo 11', { skip }, async () => {
  const { nav } = await setup();
  const ctx = await nav.prepare('apollo-11');
  const t0 = Date.UTC(2026, 0, 1);
  const ev = await nav.events(ctx, t0, t0 + 90 * DAY);
  const rises = ev.events.filter((e) => e.type === 'sunrise');
  assert.ok(rises.length >= 2);
  for (let i = 1; i < rises.length; i++) {
    const d = (rises[i].tMs - rises[i - 1].tMs) / DAY;
    assert.ok(Math.abs(d - 29.53) < 0.6, `lunar day ${d} d`);
  }
  assert.equal(ev.events.filter((e) => e.type.startsWith('earth')).length, 0);
});

test('summary, landing windows (< 1 s for a year with all stations), year map and compare', { skip }, async () => {
  const { nav } = await setup();
  const eq = await nav.prepare('apollo-11');
  const pole = await nav.prepare('artemis-mons-mouton');
  const t0 = Date.UTC(2026, 10, 14);
  await nav.ensure(t0, t0 + 400 * DAY);

  const s = await nav.summary(pole, t0, 14);
  assert.equal(s.comm.basis, 'link');
  assert.equal(s.comm.stationIds.length, nav.stations.length);
  assert.ok(s.score.score >= 0 && s.score.score <= 100);
  const sum = s.intervals.sunlit.reduce((a, iv) => a + iv.hours, 0);
  assert.ok(Math.abs(sum - s.sun.sunlitHours) < 1e-9);
  assert.ok(s.sun.elevationMaxDeg < 7 && s.sun.elevationMinDeg > -7);

  const t = performance.now();
  const lw = await nav.landingWindows(eq, t0, t0 + 365 * DAY);
  const ms = performance.now() - t;
  assert.ok(ms < 1000, `landingWindows took ${ms.toFixed(0)} ms`);
  assert.ok(lw.windows.length >= 10, `${lw.windows.length} feasible windows at Apollo 11`);

  const ym = await nav.yearMap(pole, 2027);
  assert.equal(ym.sun.length, 365 * 24);

  const rows = await nav.compare([
    { site: 'apollo-11', t0Ms: t0, durationDays: 14 },
    { site: pole, t0Ms: t0, durationDays: 14 },
    { site: { name: 'custom', lat: 10, lon: -20 }, t0Ms: t0 + 7 * DAY, durationDays: 14 },
  ]);
  assert.deepEqual(rows.map((r) => r.rank).sort(), [1, 2, 3]);
  for (const r of rows) assert.equal(r.score, r.summary.score);
});

test('ranges outside the coverage throw a RangeError; concurrent calls are safe', { skip }, async () => {
  const { nav } = await setup();
  const ctx = await nav.prepare('apollo-11');
  await assert.rejects(nav.instant(ctx, Date.UTC(1950, 0, 1)), RangeError);
  await assert.rejects(nav.series(ctx, Date.UTC(2059, 11, 1), Date.UTC(2061, 0, 1), 3600), RangeError);
  const t0 = Date.UTC(2030, 0, 1);
  const [a, b, c] = await Promise.all([
    nav.summary(ctx, t0, 14),
    nav.summary(ctx, t0, 14),
    nav.prepare({ lat: 0.67416, lon: 23.47314 }).then((x) => nav.summary(x, t0, 14)),
  ]);
  assert.equal(a.sun.sunlitHours, b.sun.sunlitHours);
  assert.equal(a.sun.sunlitHours, c.sun.sunlitHours);
  const p1 = nav.prepare({ lat: 12.5, lon: 200 });
  const p2 = nav.prepare({ lat: 12.5, lon: -160 });
  assert.equal(p1, p2, 'same place → one shared cached context');
  assert.equal((await p1).site.lon, -160);
});
