import test from 'node:test';
import assert from 'node:assert/strict';
import * as U from '../../web/js/ui/maps/mapUtil.js';

const near = (a, b, eps = 1e-9, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} vs ${b}`);

test('wrapLon', () => {
  assert.equal(U.wrapLon(0), 0);
  assert.equal(U.wrapLon(190), -170);
  assert.equal(U.wrapLon(-190), 170);
  assert.equal(U.wrapLon(180), -180);
  assert.equal(U.wrapLon(540), -180);
});

test('equirect round trip and edges', () => {
  const w = 4096, h = 2048;
  for (const [lat, lon] of [[0, 0], [45, -120], [-89.9, 179.9], [89, -179.5], [12.3, 77.7]]) {
    const p = U.latLonToEquirect(lat, lon, w, h);
    const q = U.equirectToLatLon(p.x, p.y, w, h);
    near(q.lat, lat, 1e-9);
    near(q.lon, lon, 1e-9);
  }
  const c = U.latLonToEquirect(0, 0, w, h);
  near(c.x, w / 2); near(c.y, h / 2);
  const tl = U.latLonToEquirect(90, -180, w, h);
  near(tl.x, 0); near(tl.y, 0);
  near(U.latLonToEquirect(10, 180, w, h).x, U.latLonToEquirect(10, -180, w, h).x);
});

test('polar stereographic: pole, orientation, scale, round trip', () => {
  for (const pole of ['S', 'N']) {
    const p0 = U.latLonToPolar(pole === 'S' ? -90 : 90, 123, pole);
    near(p0.x, 0, 1e-6); near(p0.y, 0, 1e-6);
    for (const lon of [-180, -135, -90, -10, 0, 45, 90, 179.5]) {
      for (const dlat of [0.1, 1, 5, 10]) {
        const lat = pole === 'S' ? -90 + dlat : 90 - dlat;
        const p = U.latLonToPolar(lat, lon, pole);
        const q = U.polarToLatLon(p.x, p.y, pole);
        near(q.lat, lat, 1e-9);
        near(U.wrapLon(q.lon - lon), 0, 1e-7, `lon ${lon}`);
      }
    }
  }
  const s0 = U.latLonToPolar(-85, 0, 'S'); assert.ok(s0.y > 0 && Math.abs(s0.x) < 1e-6);
  const s90 = U.latLonToPolar(-85, 90, 'S'); assert.ok(s90.x > 0 && Math.abs(s90.y) < 1e-6);
  const n0 = U.latLonToPolar(85, 0, 'N'); assert.ok(n0.y < 0 && Math.abs(n0.x) < 1e-6);
  const n90 = U.latLonToPolar(85, 90, 'N'); assert.ok(n90.x > 0);
  near(U.polarRadius(-85, 'S'), 2 * U.R_M * Math.tan(2.5 * U.DEG), 1e-6);
  near(U.polarRadius(-80, 'S'), U.POLAR_HALF_WIDTH_M, 1e-6);
  const a = U.latLonToPolar(-89.99, 0, 'S'), b = U.latLonToPolar(-89.98, 0, 'S');
  near(Math.hypot(a.x - b.x, a.y - b.y), U.R_M * 0.01 * U.DEG, 0.5);
});

test('unit vectors', () => {
  const v = U.latLonToVec(0, 0); near(v[0], 1); near(v[1], 0); near(v[2], 0);
  const e = U.latLonToVec(0, 90); near(e[1], 1);
  const n = U.latLonToVec(90, 33); near(n[2], 1);
  for (const [lat, lon] of [[10, 20], [-80, -170], [0, 180], [45.5, -0.25]]) {
    const q = U.vecToLatLon(U.latLonToVec(lat, lon));
    near(q.lat, lat, 1e-9);
    near(U.wrapLon(q.lon - lon), 0, 1e-9);
  }
  near(U.vecToLatLon([0, 0, 1]).lat, 90);
});

test('solar elevation', () => {
  const ss = { lat: 10, lon: 40 };
  near(U.solarElevationDeg(10, 40, ss), 90, 1e-3);
  near(U.solarElevationDeg(-10, 220, ss), -90, 1e-3);
  near(U.solarElevationDeg(0, 90, { lat: 0, lon: 0 }), 0, 1e-9);
  near(U.solarElevationDeg(0, 60, { lat: 0, lon: 0 }), 30, 1e-9);
  near(U.solarElevationDeg(-90, 0, { lat: 0, lon: 77 }), 0, 1e-9);
  near(U.solarElevationDeg(90, 0, { lat: 1.5, lon: 10 }), 1.5, 1e-9);
});

test('terminator lies 90° from the sub-solar point', () => {
  for (const ss of [{ lat: 0, lon: 0 }, { lat: 1.5, lon: -120 }, { lat: -1.2, lon: 179 }, { lat: 60, lon: 20 }, { lat: 89.9, lon: 0 }]) {
    const t = U.terminator(ss, 361);
    assert.equal(t.length, 361);
    for (const p of t) {
      near(U.solarElevationDeg(p.lat, p.lon, ss), 0, 1e-7);
      assert.ok(p.lon >= -180 && p.lon <= 180);
    }
    for (let i = 1; i < t.length; i++) assert.ok(t[i].lon >= t[i - 1].lon);
  }
  const t = U.terminator({ lat: 0, lon: 0 }, 720);
  assert.ok(t.some((p) => Math.abs(p.lon - 90) < 1 || Math.abs(p.lon + 90) < 1));
});

test('great circle', () => {
  const g = U.greatCircle({ lat: 0, lon: 0 }, { lat: 0, lon: 90 }, 9);
  assert.equal(g.length, 10);
  near(g[0].lon, 0, 1e-9); near(g[9].lon, 90, 1e-9);
  for (const p of g) near(p.lat, 0, 1e-9);
  near(g[3].lon, 30, 1e-9);
  const d = U.angularDistanceDeg({ lat: -90, lon: 0 }, { lat: 90, lon: 0 });
  near(d, 180, 1e-9);
  const same = U.greatCircle({ lat: 5, lon: 5 }, { lat: 5, lon: 5 }, 4);
  near(same[2].lat, 5, 1e-9);
});

test('formatting', () => {
  assert.equal(U.formatLat(-84.7906), '84.79°S');
  assert.equal(U.formatLon(29.1957), '29.20°E');
  assert.equal(U.formatLon(-23.4219), '23.42°W');
  assert.equal(U.formatLon(190), '170.00°W');
  assert.equal(U.formatLon(180), '180.00°');
  assert.equal(U.formatLat(0), '0.00°');
  assert.equal(U.formatLat(-0.001), '0.00°');
  assert.equal(U.formatLatLon(0.67416, 23.47314), '0.67°N 23.47°E');
  assert.equal(U.formatUtc(Date.UTC(2026, 10, 14, 16, 30)), '2026-11-14 16:30 UTC');
  assert.equal(U.formatUtc(NaN), '—');
});
