import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  computeLandingWindows,
  computeInstant,
  computeNextEvents,
  computeSummary,
  computeYearMap,
  defaultLandingRequirements,
} from '../../web/js/core/analysis.js';
import { makeFixture, FAKE_STATIONS, roughHorizon } from './analysis-fakes.js';

const DAY = 86400000;
const T0 = Date.UTC(2026, 0, 1);

test('landingWindows: a full year at 6 h with a 10-min base series runs in well under 1 s', () => {
  for (const fx of [
    { lat: 0.67, lon: 23.47, stations: FAKE_STATIONS },
    { lat: -89.6, lon: 30, horizon: roughHorizon(11, -0.3, 1.6), sunDecDeg: -0.2, sunDecAmpDeg: 1, stations: FAKE_STATIONS },
  ]) {
    const { env, ctx } = makeFixture(fx);
    computeLandingWindows(env, ctx, T0, T0 + 30 * DAY);
    const t = performance.now();
    const lw = computeLandingWindows(env, ctx, T0, T0 + 365 * DAY, { candidateStepS: 21600, stepS: 600 });
    const ms = performance.now() - t;
    assert.equal(lw.n, 365 * 4 + 1);
    assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms`);
  }
});

test('landingWindows: per-candidate values agree with direct evaluation', () => {
  const { env, ctx } = makeFixture({ lat: 0.67, lon: 23.47, stations: FAKE_STATIONS });
  const lw = computeLandingWindows(env, ctx, T0, T0 + 60 * DAY, { missionDays: 14 });
  assert.equal(lw.commBasis, 'link');
  for (let k = 0; k < lw.n; k += 7) {
    const t = lw.tMs[k];
    const inst = computeInstant(env, ctx, t);
    assert.ok(Math.abs(lw.sunElDeg[k] - inst.sun.elDeg) < 1e-3);
    assert.equal(lw.sunlitAtLanding[k] === 1, inst.sunlit);
    const next = computeNextEvents(env, ctx, t, t + 40 * DAY);
    const expectedH = inst.sunlit ? Math.min(14 * 24, next.hoursToSunset) : 0;
    assert.ok(Math.abs(lw.sunlitHours[k] - expectedH) <= 10 / 60 + 1e-3, `k=${k}: ${lw.sunlitHours[k]} vs ${expectedH}`);
    const s = computeSummary(env, ctx, t, 14);
    assert.ok(Math.abs(lw.commFraction[k] - s.comm.fraction) < 0.01);
    assert.ok(Math.abs(lw.earthFraction[k] - s.earth.visibleFraction) < 0.01);
    assert.ok(Math.abs(lw.sunlitFraction[k] - s.sun.sunlitFraction) < 0.01);
  }
});

test('landingWindows: feasibility and contiguous windows (equatorial: morning Sun 5–15°)', () => {
  const { env, ctx } = makeFixture({ lat: 0.67, lon: 23.47 });
  const lw = computeLandingWindows(env, ctx, T0, T0 + 365 * DAY, { candidateStepS: 3600 });
  assert.deepEqual(lw.requirements, defaultLandingRequirements(0.67));
  for (let k = 0; k < lw.n; k++) {
    const ok = lw.sunlitAtLanding[k] && lw.sunElDeg[k] >= 5 && lw.sunElDeg[k] <= 15 && lw.sunlitHours[k] >= 72 && lw.commFraction[k] >= 0.5;
    assert.equal(lw.feasible[k] === 1, Boolean(ok));
  }
  assert.ok(lw.windows.length >= 12 && lw.windows.length <= 13, `${lw.windows.length} windows`);
  let count = 0;
  for (const w of lw.windows) {
    assert.ok(w.durationHours >= 17 && w.durationHours <= 21, `${w.durationHours} h`);
    assert.equal(w.count, Math.round(w.durationHours) + 1);
    count += w.count;
    const kStart = Math.round((w.startMs - T0) / 3600000);
    assert.equal(lw.feasible[kStart], 1);
    if (kStart > 0) assert.equal(lw.feasible[kStart - 1], 0);
  }
  assert.equal(count, lw.feasibleCount);
  assert.equal(lw.firstFeasibleMs, lw.windows[0].startMs);
  const strict = computeLandingWindows(env, ctx, T0, T0 + 365 * DAY, { candidateStepS: 3600, requirements: { maxSunElDeg: 8 } });
  assert.ok(strict.feasibleCount < lw.feasibleCount);
  for (let k = 0; k < lw.n; k++) assert.ok(strict.feasible[k] <= lw.feasible[k]);
});

test('default landing requirements depend on latitude', () => {
  assert.equal(defaultLandingRequirements(10).minSunElDeg, 5);
  assert.equal(defaultLandingRequirements(10).maxSunElDeg, 15);
  assert.equal(defaultLandingRequirements(-85).minSunElDeg, null);
  assert.equal(defaultLandingRequirements(-85).maxSunElDeg, null);
});

test('yearMap: day × hour matrices and monthly aggregates', () => {
  const { env, ctx } = makeFixture({ lat: 0, lon: 0, stations: FAKE_STATIONS });
  const t = performance.now();
  const ym = computeYearMap(env, ctx, 2026);
  assert.ok(performance.now() - t < 1000);
  assert.equal(ym.days, 365);
  assert.equal(ym.sun.length, 365 * 24);
  assert.equal(ym.monthly.length, 12);
  const meanSun = ym.sun.reduce((a, b) => a + b, 0) / ym.sun.length / 255;
  assert.ok(Math.abs(meanSun - 0.5) < 0.02);
  assert.ok(ym.earth.every((v) => v === 255));
  for (let c = 0; c < ym.sun.length; c++) assert.ok(ym.both[c] <= ym.comm[c] && ym.comm[c] <= ym.earth[c]);
  for (const m of ym.monthly) {
    assert.ok(m.sunlitPercent > 35 && m.sunlitPercent < 65);
    assert.equal(m.earthPercent, 100);
    assert.ok(m.commPercent > 50 && m.commPercent <= 100);
    assert.ok(m.energyWhm2 > 0);
  }
  assert.equal(computeYearMap(env, ctx, 2028).days, 366);
  assert.throws(() => computeYearMap(env, ctx, 2026, { stepS: 700 }), RangeError);
});
