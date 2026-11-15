import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSummary, computeSeries, scoreSummary, resolveOptions, DEFAULT_SCORE_WEIGHTS } from '../../web/js/core/analysis.js';
import { makeFixture, roughHorizon, FAKE_STATIONS, SYNODIC_MS } from './analysis-fakes.js';

const DAY = 86400000;
const T0 = Date.UTC(2026, 3, 10, 7, 30);

function checkIntervals(ivs, t0, t1) {
  let prev = t0;
  for (const iv of ivs) {
    assert.ok(iv.startMs >= prev && iv.endMs > iv.startMs && iv.endMs <= t1, 'sorted, disjoint, inside the window');
    assert.ok(Math.abs(iv.hours - (iv.endMs - iv.startMs) / 3600000) < 1e-9);
    prev = iv.endMs;
  }
}
const sumHours = (ivs) => ivs.reduce((a, iv) => a + iv.hours, 0);

for (const [label, fx] of [
  ['equatorial, DTE only', { lat: 0, lon: 0 }],
  ['limb site with stations', { lat: 5, lon: 88.5, earthLibLonDeg: 3, stations: FAKE_STATIONS }],
  ['polar rough horizon with stations', { lat: -89.6, lon: 30, horizon: roughHorizon(11, -0.3, 1.6), sunDecDeg: -0.2, sunDecAmpDeg: 1, stations: FAKE_STATIONS }],
]) {
  test(`summary bookkeeping: intervals sum to the totals (${label})`, () => {
    const { env, ctx } = makeFixture(fx);
    const days = 20.3;
    const s = computeSummary(env, ctx, T0, days);
    const durH = days * 24;
    assert.ok(Math.abs(s.durationHours - durH) < 1e-9);
    assert.equal(s.t1Ms, T0 + days * DAY);
    for (const key of ['sunlit', 'earthVisible', 'comm', 'both']) checkIntervals(s.intervals[key], s.t0Ms, s.t1Ms);
    assert.ok(Math.abs(sumHours(s.intervals.sunlit) - s.sun.sunlitHours) < 1e-9);
    assert.ok(Math.abs(s.sun.sunlitHours + s.sun.darkHours - durH) < 1e-9);
    assert.ok(Math.abs(s.sun.sunlitFraction - s.sun.sunlitHours / durH) < 1e-12);
    assert.ok(Math.abs(sumHours(s.intervals.earthVisible) - s.earth.visibleHours) < 1e-9);
    assert.ok(Math.abs(sumHours(s.intervals.comm) - s.comm.hours) < 1e-9);
    assert.ok(Math.abs(sumHours(s.intervals.both) - s.both.hours) < 1e-9);
    assert.ok(s.both.hours <= Math.min(s.sun.sunlitHours, s.comm.hours) + 1e-9);
    assert.ok(s.comm.hours <= s.earth.visibleHours + 1e-9, 'a link needs DTE');
    assert.ok(s.sun.longestSunlitHours <= s.sun.sunlitHours + 1e-9);
    assert.ok(s.sun.longestDarkHours <= s.sun.darkHours + 1e-6);
    assert.ok(s.comm.longestWindowHours <= s.comm.hours + 1e-9);
    assert.ok(s.sun.elevationMinDeg <= s.sun.elevationMeanDeg && s.sun.elevationMeanDeg <= s.sun.elevationMaxDeg);
    assert.equal(s.comm.basis, fx.stations ? 'link' : 'dte');
    assert.ok(s.stepS <= 600 && Math.abs((durH * 3600) / s.stepS - Math.round((durH * 3600) / s.stepS)) < 1e-6);
    const series = computeSeries(env, ctx, T0, s.t1Ms, s.stepS, {});
    const sampled = series.sunlit.reduce((a, b) => a + b, 0) / series.n;
    assert.ok(Math.abs(sampled - s.sun.sunlitFraction) < 0.01);
  });
}

test('equatorial lunation: half lit, energy = S·t for tracking and (2/π)·S·t for horizontal panels', () => {
  const { env, ctx } = makeFixture({ lat: 0, lon: 0 });
  const s = computeSummary(env, ctx, T0, SYNODIC_MS / DAY);
  assert.ok(Math.abs(s.sun.sunlitFraction - 0.5) < 1e-3);
  assert.ok(s.sun.longestSunlitHours <= SYNODIC_MS / 2 / 3600000 + 0.01);  assert.ok(Math.abs(s.power.energyTrackingWhm2 / (1361 * s.sun.sunlitHours) - 1) < 5e-3);
  assert.ok(Math.abs(s.power.energyHorizontalWhm2 / ((2 / Math.PI) * 1361 * s.sun.sunlitHours) - 1) < 5e-3);
  assert.ok(Math.abs(s.power.meanTrackingFactor - 0.5) < 5e-3);
  assert.equal(s.power.meanFactor, s.power.meanTrackingFactor);
  assert.equal(s.earth.alwaysVisibleInWindow, true);
  assert.equal(s.earth.longestGapHours, 0);
  assert.ok(s.sun.elevationMaxDeg > 89.5 && s.sun.elevationMinDeg < -89.5);
  assert.ok(s.next.sunsetMs !== null && s.next.sunriseMs !== null);
  assert.equal(s.next.earthsetMs, null);

  const h = computeSummary(env, ctx, T0, 10, { panel: 'horizontal' });
  assert.equal(h.power.meanFactor, h.power.meanHorizontalFactor);
  assert.equal(h.power.energyWhm2, h.power.energyHorizontalWhm2);
});

test('always-lit window sets the flags and has no darkness', () => {
  const { env, ctx } = makeFixture({ lat: 89.9, lon: 0, sunDecDeg: 5 });
  const s = computeSummary(env, ctx, T0, 14);
  assert.equal(s.sun.alwaysLitInWindow, true);
  assert.equal(s.sun.neverLitInWindow, false);
  assert.equal(s.sun.longestDarkHours, 0);
  assert.equal(s.sun.sunlitFraction, 1);
  assert.equal(s.next.sunsetMs, null);
  assert.deepEqual(s.intervals.sunlit.map((iv) => [iv.startMs, iv.endMs]), [[s.t0Ms, s.t1Ms]]);
});

test('score: documented formula, components exposed, weights overridable', () => {
  const { env, ctx } = makeFixture({ lat: 5, lon: 88.5, earthLibLonDeg: 3, stations: FAKE_STATIONS });
  const s = computeSummary(env, ctx, T0, 14);
  const sc = scoreSummary(s);
  assert.deepEqual(sc.weights, { ...DEFAULT_SCORE_WEIGHTS });
  let num = 0;
  let den = 0;
  for (const k of Object.keys(DEFAULT_SCORE_WEIGHTS)) {
    assert.ok(sc.components[k] >= 0 && sc.components[k] <= 1);
    num += DEFAULT_SCORE_WEIGHTS[k] * sc.components[k];
    den += DEFAULT_SCORE_WEIGHTS[k];
  }
  assert.ok(Math.abs(sc.score - (100 * num) / den) < 1e-9);
  assert.ok(sc.score >= 0 && sc.score <= 100);
  const onlySun = scoreSummary(s, { sunlight: 1, power: 0, comm: 0, night: 0, both: 0 });
  assert.ok(Math.abs(onlySun.score - 100 * s.sun.sunlitFraction) < 1e-9);
  assert.throws(() => scoreSummary(s, { sunlight: 0, power: 0, comm: 0, night: 0, both: 0 }), RangeError);
});

test('options are validated', () => {
  assert.throws(() => resolveOptions({ sunMinFraction: 0 }), RangeError);
  assert.throws(() => resolveOptions({ panel: 'tilted' }), RangeError);
  assert.throws(() => resolveOptions({ stepS: -1 }), RangeError);
  const { env, ctx } = makeFixture({ stations: FAKE_STATIONS });
  assert.throws(() => computeSummary(env, ctx, T0, 1, { stations: ['nope'] }), RangeError);
  const s = computeSummary(env, ctx, T0, 1, { stations: ['mdscc'] });
  assert.deepEqual(s.comm.stationIds, ['mdscc']);
  assert.equal(computeSummary(env, ctx, T0, 1, { stations: [] }).comm.basis, 'dte');
});
