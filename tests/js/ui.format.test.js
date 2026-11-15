import test from 'node:test';
import assert from 'node:assert/strict';
import * as f from '../../web/js/ui/format.js';
import { verdict, bestRows, COLUMNS } from '../../web/js/ui/compareView.js';
import { seriesRows, compareRows } from '../../web/js/ui/exporter.js';

test('utc formatting', () => {
  const ms = Date.UTC(2026, 10, 14, 16, 30, 5);
  assert.equal(f.utc(ms), '2026-11-14 16:30 UTC');
  assert.equal(f.utc(ms, { seconds: true }), '2026-11-14 16:30:05 UTC');
  assert.equal(f.utcInputValue(ms), '2026-11-14T16:30');
  assert.equal(f.utc(NaN), '—');
});

test('parseUtcInput', () => {
  const ms = Date.UTC(2026, 10, 14, 16, 30);
  assert.equal(f.parseUtcInput('2026-11-14T16:30'), ms);
  assert.equal(f.parseUtcInput('2026-11-14 16:30 UTC'), ms);
  assert.equal(f.parseUtcInput('2026-11-14'), Date.UTC(2026, 10, 14));
  assert.ok(Number.isNaN(f.parseUtcInput('2026-02-31')));
  assert.ok(Number.isNaN(f.parseUtcInput('tomorrow')));
});

test('durations and countdowns', () => {
  assert.equal(f.duration(76), '3 d 4 h');
  assert.equal(f.duration(5.2), '5 h 12 min');
  assert.equal(f.duration(0.7), '42 min');
  assert.equal(f.duration(48), '2 d');
  assert.equal(f.duration(23.999), '1 d');
  assert.equal(f.duration(0.001), '< 1 min');
  assert.equal(f.duration(null), '—');
  assert.equal(f.countdown(2), 'in 2 h');
  assert.equal(f.countdown(0), 'now');
});

test('numbers, angles, coordinates', () => {
  assert.equal(f.num(-3.24, 1), '−3.2');
  assert.equal(f.num(-0.01, 1), '0.0');
  assert.equal(f.deg(12.34), '12.3°');
  assert.equal(f.signedDeg(1.5), '+1.5°');
  assert.equal(f.az(123.4), '123.4° ESE');
  assert.equal(f.az(135), '135.0° SE');
  assert.equal(f.az(-10), '350.0° N');
  assert.equal(f.latlon(-84.7906, 29.1957), '84.791° S, 29.196° E');
  assert.equal(f.latlon(10, 200), '10.000° N, 160.000° W');
  assert.equal(f.pct(0.625), '63%');
  assert.equal(f.energy(467408), '467 kWh/m²');
  assert.equal(f.energy(900), '900 Wh/m²');
  assert.equal(f.ratio(4.2, 1), '4.2×');
  assert.equal(f.int(467409), '467 409');
  assert.ok(Math.abs(f.normalizeLon(222.6) + 137.4) < 1e-9);
  assert.equal(f.normalizeLon(180), 180);
});

test('parseLatLon accepts the documented forms', () => {
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  let p = f.parseLatLon('-89.45, 222.6');
  close(p.lat, -89.45); close(p.lon, -137.4);
  p = f.parseLatLon('89.45S 137.4W');
  close(p.lat, -89.45); close(p.lon, -137.4);
  p = f.parseLatLon('89.45° S, 137.4° W');
  close(p.lat, -89.45); close(p.lon, -137.4);
  p = f.parseLatLon('137.4W 89.45S');
  close(p.lat, -89.45); close(p.lon, -137.4);
  p = f.parseLatLon('S 84.79 W 29.2');
  close(p.lat, -84.79); close(p.lon, -29.2);
  p = f.parseLatLon('lat -84.79 lon 29.2');
  close(p.lat, -84.79); close(p.lon, 29.2);
  p = f.parseLatLon('0.674 23.47');
  close(p.lat, 0.674); close(p.lon, 23.47);
});

test('parseLatLon rejects bad input with readable errors', () => {
  assert.throws(() => f.parseLatLon(''), /latitude/i);
  assert.throws(() => f.parseLatLon('95, 10'), /outside/);
  assert.throws(() => f.parseLatLon('10'), /two numbers/);
  assert.throws(() => f.parseLatLon('abc def'), /Could not read/);
  assert.throws(() => f.parseLatLon('-10S 20E'), /minus/);
  assert.throws(() => f.parseLatLon('10, 400'), /outside/);
});

test('csv quoting', () => {
  assert.equal(f.toCsv([['a', 'b,c', 'say "hi"', 1.5, null]]), 'a,"b,c","say ""hi""",1.5,\r\n');
});

function fakeRow(name, t0Ms, sunFrac, sunH, darkH, commFrac, gapH, score, src = 'sphere') {
  return {
    index: 0, rank: 0, site: { name, lat: 0, lon: name.length }, horizonSource: src, t0Ms, durationDays: 14,
    score: { score }, summary: {
      sun: { sunlitFraction: sunFrac, sunlitHours: sunH, longestDarkHours: darkH, alwaysLitInWindow: sunFrac === 1, neverLitInWindow: sunFrac === 0, elevationMinDeg: 0, elevationMaxDeg: 5 },
      power: { energyWhm2: sunH * 1300, meanFactor: sunFrac },
      comm: { basis: 'link', fraction: commFrac, longestGapHours: gapH },
      earth: { visibleFraction: commFrac, neverVisibleInWindow: commFrac === 0, elevationMinDeg: 0, elevationMaxDeg: 5 },
      both: { fraction: Math.min(sunFrac, commFrac) },
    },
  };
}

test('compare verdict and best values come from the numbers', () => {
  const a = fakeRow('Mons Mouton', 0, 1, 336, 0, 0.6, 200, 80);
  const b = fakeRow('Apollo 11', 0, 0.25, 80, 250, 1, 0, 50);
  const v = verdict([b, a]).join(' ');
  assert.match(v, /\*\*Mons Mouton\*\* ranks first/);
  assert.match(v, /4\.2× longer/);
  assert.match(v, /loses Earth contact for up to 8 d 8 h/);
  assert.match(v, /night of 10 d 10 h/);
  assert.match(v, /smooth-sphere/);
  const score = COLUMNS.find((c) => c.key === 'score');
  const dark = COLUMNS.find((c) => c.key === 'dark');
  assert.deepEqual([...bestRows([b, a], score)], [1]);
  assert.deepEqual([...bestRows([b, a], dark)], [1]);
  assert.equal(bestRows([a], score).size, 0);
});

test('export rows have consistent widths', () => {
  const rows = compareRows([fakeRow('A', Date.UTC(2026, 0, 1), 1, 336, 0, 1, 0, 70)]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].length, rows[1].length);
  const n = 2;
  const arr = (v) => new Float32Array(n).fill(v);
  const body = () => ({ azDeg: arr(1), elDeg: arr(2), horizonElDeg: arr(0), clearanceDeg: arr(2), visibleFraction: arr(1) });
  const sr = { n, tMs: [0, 3600000], sun: body(), earth: body(), sunlit: [1, 1], dte: [1, 0], comm: [1, 0], stationCount: [3, 0], irradianceWm2: arr(1361), powerFactor: arr(1) };
  const s = seriesRows(sr);
  assert.equal(s.length, 3);
  assert.equal(s[1][0], '1970-01-01T00:00:00Z');
  assert.ok(s.every((r) => r.length === s[0].length));
});
