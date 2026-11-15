import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  linearScale, niceStep, ticks, niceDomain, degStep, timeTicks, fmtUtc, fmtDuration, fmtDeg, fmtPercent,
  intervalsToPixels, interpAt, sampleIndex, runs, wrap360, wrap180, cardinal, parseColor, mixColor, withAlpha,
  LruCache, stableKey, engineOpts, scenarioKey, memo, createGate, describeError, coverageYears, createLabelPlacer,
  DAY_MS, HOUR_MS,
} from '../../web/js/ui/charts/chartUtil.js';
import { windowSentence, failures, candidateStepFor } from '../../web/js/ui/charts/landingWindows.js';
import { stepForSpan } from '../../web/js/ui/charts/timeline.js';

test('linearScale maps and inverts', () => {
  const s = linearScale(0, 10, 100, 200);
  assert.equal(s(5), 150);
  assert.equal(s.invert(175), 7.5);
  const r = linearScale(-10, 10, 300, 0);
  assert.equal(r(0), 150);
  assert.equal(r(10), 0);
  assert.equal(linearScale(3, 3, 0, 1)(3), 0);
});

test('niceStep / ticks / niceDomain', () => {
  assert.equal(niceStep(10, 5), 2);
  assert.equal(niceStep(100, 4), 25);
  assert.equal(niceStep(0.7, 7), 0.1);
  assert.deepEqual(ticks(0, 10, 5), [0, 2, 4, 6, 8, 10]);
  assert.deepEqual(ticks(-5, 90, 99, 15), [0, 15, 30, 45, 60, 75, 90]);
  assert.deepEqual(ticks(10, 0, 5), [0, 2, 4, 6, 8, 10]);
  assert.deepEqual(ticks(0.1, 0.3, 2), [0.1, 0.2, 0.3]);
  assert.deepEqual(niceDomain(-3.2, 47, 5), [-20, 60]);
  assert.deepEqual(niceDomain(-1.5, 8.2, 5), [-2, 10]);
  const [a, b] = niceDomain(5, 5);
  assert.ok(a < 5 && b > 5);
  assert.equal(degStep(95, 300), 10);
  assert.equal(degStep(20, 300), 2);
});

test('timeTicks chooses UTC-aligned steps', () => {
  const t0 = Date.UTC(2026, 10, 14, 5, 17);
  const day = timeTicks(t0, t0 + DAY_MS, 6);
  assert.ok(day.length <= 6 && day.length >= 3);
  assert.ok(day.every((t) => t.tMs % (6 * HOUR_MS) === 0));
  assert.ok(day.some((t) => t.major && t.label === 'Nov 15'));
  const month = timeTicks(t0, t0 + 30 * DAY_MS, 6);
  assert.ok(month.every((t) => t.tMs % DAY_MS === 0));
  assert.ok(month.length >= 3 && month.length <= 6);
  assert.ok(month[0].tMs > t0 && month[0].tMs - t0 <= 7 * DAY_MS);
  const year = timeTicks(Date.UTC(2026, 0, 1), Date.UTC(2027, 0, 1), 12);
  assert.equal(year.length, 13);
  assert.equal(year[0].label, '2026');
  assert.ok(year[0].major);
  assert.equal(year[1].label, 'Feb');
  const q = timeTicks(Date.UTC(2026, 1, 10), Date.UTC(2027, 3, 1), 6);
  assert.ok(q.length <= 6 && q.every((t) => new Date(t.tMs).getUTCDate() === 1));
  assert.deepEqual(timeTicks(5, 5), []);
});

test('time and value formatting', () => {
  assert.equal(fmtUtc(Date.UTC(2026, 10, 14, 16, 30)), '2026-11-14 16:30 UTC');
  assert.equal(fmtUtc(NaN), '—');
  assert.equal(fmtDuration(3 * 24 + 4), '3 d 4 h');
  assert.equal(fmtDuration(48), '2 d');
  assert.equal(fmtDuration(5 + 12 / 60), '5 h 12 min');
  assert.equal(fmtDuration(2), '2 h');
  assert.equal(fmtDuration(0.2), '12 min');
  assert.equal(fmtDuration(0.001), '< 1 min');
  assert.equal(fmtDuration(-30), '1 d 6 h');
  assert.equal(fmtDuration(null), '—');
  assert.equal(fmtDuration(23.999), '1 d');
  assert.equal(fmtDeg(-3.44), '−3.4°');
  assert.equal(fmtDeg(1.25, 1, true), '+1.3°');
  assert.equal(fmtDeg(-0.01, 1, true), '0.0°');
  assert.equal(fmtPercent(0.625), '63%');
});

test('intervalsToPixels clips, widens and merges', () => {
  const s = linearScale(0, 100, 0, 1000);
  const px = intervalsToPixels(
    [
      { startMs: -10, endMs: 5 },
      { startMs: 20, endMs: 20.01 },
      { startMs: 50, endMs: 60 },
      { startMs: 59, endMs: 70 },
      { startMs: 200, endMs: 300 },
    ],
    s,
    0,
    1000,
    2,
  );
  assert.equal(px.length, 3);
  assert.deepEqual(px[0], { x: 0, w: 50 });
  assert.ok(Math.abs(px[1].w - 2) < 1e-9);
  assert.equal(px[2].x, 500);
  assert.equal(px[2].w, 200);
  assert.deepEqual(intervalsToPixels(null, s, 0, 1000), []);
});

test('series helpers', () => {
  const arr = new Float32Array([0, 10, 20]);
  assert.equal(interpAt(arr, 0, 1, 500), 5);
  assert.equal(interpAt(arr, 0, 1, 2000), 20);
  assert.ok(Number.isNaN(interpAt(arr, 0, 1, -1)));
  assert.equal(sampleIndex(0, 1, 3, 99999), 2);
  assert.deepEqual(runs([0, 1, 1, 0, 1]), [{ i0: 1, i1: 2 }, { i0: 4, i1: 4 }]);
});

test('azimuth helpers', () => {
  assert.equal(wrap360(-10), 350);
  assert.equal(wrap180(350), -10);
  assert.equal(wrap180(170), 170);
  assert.equal(cardinal(0), 'N');
  assert.equal(cardinal(359), 'N');
  assert.equal(cardinal(135), 'SE');
  assert.equal(cardinal(260), 'W');
});

test('colours', () => {
  assert.deepEqual(parseColor('#f5a524'), [245, 165, 36, 1]);
  assert.deepEqual(parseColor('#fff'), [255, 255, 255, 1]);
  assert.deepEqual(parseColor('rgba(245, 165, 36, 0.22)'), [245, 165, 36, 0.22]);
  assert.equal(parseColor('red'), null);
  assert.deepEqual(mixColor([0, 0, 0, 1], [100, 200, 50, 1], 0.5), [50, 100, 25, 1]);
  assert.equal(withAlpha('#4da3ff', 0.5), 'rgba(77,163,255,0.5)');
  assert.equal(withAlpha('var(--x)', 0.5), 'var(--x)');
});

test('caches, keys and request gate', async () => {
  const c = new LruCache(2);
  c.set('a', 1);
  c.set('b', 2);
  c.get('a');
  c.set('c', 3);
  assert.equal(c.get('b'), undefined);
  assert.equal(c.get('a'), 1);
  assert.equal(stableKey({ b: 1, a: [1, { d: 2, c: undefined }] }), '{"a":[1,{"d":2}],"b":1}');
  assert.deepEqual(engineOpts({ sunMinFraction: 0.5, observerHeightM: 2 }), { sunMinFraction: 0.5 });
  const sc = { id: 's1', site: { lat: -84.7, lon: 29.2 }, t0Ms: 1, durationDays: 14 };
  assert.notEqual(scenarioKey(sc, {}), scenarioKey({ ...sc, t0Ms: 2 }, {}));
  assert.equal(scenarioKey(sc, { a: 1, b: 2 }), scenarioKey(sc, { b: 2, a: 1 }));
  let calls = 0;
  const m = new LruCache(4);
  const fn = async () => ++calls;
  assert.equal(await memo(m, 'k', fn), 1);
  assert.equal(await memo(m, 'k', fn), 1);
  await assert.rejects(memo(m, 'bad', async () => { throw new Error('x'); }));
  assert.equal(m.get('bad'), undefined);
  const g = createGate();
  const t1 = g.next();
  const t2 = g.next();
  assert.ok(!g.ok(t1) && g.ok(t2));
});

test('describeError / coverageYears / label placer', () => {
  const e = new RangeError('Requested time 2075-01-01T00:00:00Z … 2075-01-15T00:00:00Z is outside the ephemeris coverage 1969-01-01T00:00:00Z … 2060-01-01T00:00:00Z');
  assert.match(describeError(e), /outside the ephemeris coverage/);
  assert.match(describeError(new Error('boom')), /Could not compute/);
  assert.deepEqual(coverageYears({ startMs: Date.UTC(1969, 0, 1), endMs: Date.UTC(2060, 0, 1) }), [1969, 2059]);
  assert.deepEqual(coverageYears({ startMs: Date.UTC(1969, 0, 2), endMs: Date.UTC(2059, 5, 1) }), [1970, 2058]);
  const place = createLabelPlacer(0);
  assert.ok(place(0, 0, 10, 10));
  assert.ok(!place(5, 5, 10, 10));
  assert.ok(place(20, 0, 10, 10));
});

test('step choices', () => {
  assert.equal(stepForSpan(7 * DAY_MS), 600);
  assert.equal(stepForSpan(365 * DAY_MS), 21600);
  assert.equal(candidateStepFor(30 * DAY_MS), 3600);
  assert.equal(candidateStepFor(210 * DAY_MS), 21600);
});

function fakeLw(feasibleIdx, n = 40, stepH = 6) {
  const t0 = Date.UTC(2026, 0, 1);
  const tMs = Float64Array.from({ length: n }, (_, k) => t0 + k * stepH * HOUR_MS);
  const feasible = new Uint8Array(n);
  for (const k of feasibleIdx) feasible[k] = 1;
  const windows = [];
  for (let k = 0; k < n; k++) {
    if (!feasible[k]) continue;
    let j = k;
    while (j + 1 < n && feasible[j + 1]) j++;
    windows.push({ startMs: tMs[k], endMs: tMs[j], durationHours: (tMs[j] - tMs[k]) / HOUR_MS, count: j - k + 1 });
    k = j;
  }
  return {
    t0Ms: t0, t1Ms: tMs[n - 1], n, tMs, candidateStepS: stepH * 3600, missionDays: 14,
    requirements: { minSunElDeg: 5, maxSunElDeg: 15, minSunlitHours: 72, minCommFraction: 0.5 },
    sunElDeg: Float32Array.from(feasible, (f) => (f ? 10 : 30)),
    sunFraction: new Float32Array(n).fill(1), sunlitAtLanding: new Uint8Array(n).fill(1),
    sunlitHours: new Float32Array(n).fill(100), commFraction: new Float32Array(n).fill(0.9),
    feasible, feasibleCount: feasibleIdx.length, windows,
  };
}

test('windowSentence: next window, inside, none', () => {
  const lw = fakeLw([20, 21, 22, 23, 24]);
  const landing = lw.tMs[0];
  const s = windowSentence(lw, landing);
  assert.match(s, /^Next feasible window opens in 5 d \(2026-01-06 00:00 UTC\) and lasts 1 d\./);
  assert.match(s, /1 window in the scanned range; 5 of 40/);
  const inside = windowSentence(lw, lw.tMs[21]);
  assert.match(inside, /current landing date is feasible: its window stays open for another 18 h/);
  const after = windowSentence(lw, lw.tMs[30]);
  assert.match(after, /No feasible window after the current landing date/);
  assert.match(after, /previous window closed 1 d 12 h earlier/);
  const none = fakeLw([]);
  assert.match(windowSentence(none, none.tMs[0]), /No landing time .* meets the requirements\. Most often missed: Sun ≤ 15°/);
  assert.deepEqual(failures(none, 0), ['maxSunEl']);
  const single = fakeLw([10]);
  assert.match(windowSentence(single, single.tMs[0]), /a single candidate of the 6 h scan/);
});
