import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { Terrain, Horizon } from '../../web/js/core/terrain.js';
import { nodeLoader } from '../../web/js/core/loader.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, '..', '..', 'web', 'data');
const fixture = JSON.parse(readFileSync(path.join(here, '..', 'fixtures', 'horizon_reference.json'), 'utf8'));

function stats(a, b) {
  let ss = 0;
  let mx = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    ss += d * d;
    mx = Math.max(mx, Math.abs(d));
  }
  return { rms: Math.sqrt(ss / a.length), max: mx };
}

test('JS horizons match Python on the web grids (RMS < 0.05 deg, max < 0.3 deg)', async () => {
  const terrain = await Terrain.load(nodeLoader(dataDir));
  for (const site of fixture.sites) {
    const t0 = performance.now();
    const h = await terrain.computeHorizon(site.lat, site.lon, {
      observerHeightM: fixture.observer_height_m,
      azStepDeg: fixture.az_step_deg,
      maxRangeKm: fixture.max_range_km,
    });
    const ms = performance.now() - t0;
    const { rms, max } = stats(h.elev, site.elev_deg);
    console.log(
      `  ${site.id.padEnd(20)} rms ${rms.toFixed(4)} max ${max.toFixed(4)} deg  ` +
        `h ${h.terrainHeightM.toFixed(1)} m  ${ms.toFixed(0)} ms  [${h.source}]`,
    );
    assert.ok(Math.abs(h.terrainHeightM - site.terrain_height_m) < 0.01, `${site.id}: terrain height`);
    assert.ok(rms < 0.05, `${site.id}: RMS ${rms}`);
    assert.ok(max < 0.3, `${site.id}: max ${max}`);
  }
});

test('computeHorizon is fast enough for interactive use (< 2 s per site, 1 deg step)', async () => {
  const terrain = await Terrain.load(nodeLoader(dataDir));
  await terrain.heightAt(-89.78, -155.7);
  await terrain.heightAt(26.13, 3.63);
  for (const [lat, lon] of [[-89.78, -155.7], [-85.98, -0.26], [26.13239, 3.6333]]) {
    const t0 = performance.now();
    await terrain.computeHorizon(lat, lon);
    const ms = performance.now() - t0;
    assert.ok(ms < 2000, `horizon at ${lat},${lon} took ${ms} ms`);
  }
});

test('Horizon: interpolation, wrap-around, JSON round trip, immutability', () => {
  const elev = Array.from({ length: 360 }, (_, i) => (i === 359 ? 10 : i % 10));
  const h = new Horizon({
    lat: 1, lon: 2, terrainHeightM: 3, observerHeightM: 2, azStepDeg: 1, elev, source: 'test', maxRangeKm: 5,
  });
  assert.equal(h.elevationAt(3.5), 3.5);
  assert.equal(h.elevationAt(359.5), 5);
  assert.equal(h.elevationAt(-0.5), 5);
  assert.equal(h.elevationAt(723), 3);
  const back = Horizon.fromJSON(JSON.parse(JSON.stringify(h)));
  assert.deepEqual(Array.from(back.elev), Array.from(h.elev));
  assert.equal(back.azStepDeg, 1);
  assert.throws(() => {
    h.lat = 5;
  }, TypeError);
  const copy = h.elev;
  copy[0] = 99;
  assert.equal(h.elevationAt(0), 0);
  assert.throws(() => new Horizon({ ...h, elev: [1, 2, 3], azStepDeg: 1 }), RangeError);
});

test('precomputed horizons: load a catalog site, null for an unknown id', async () => {
  const terrain = await Terrain.load(nodeLoader(dataDir));
  assert.equal(await terrain.precomputedHorizon('no-such-site-id'), null);
  const sites = JSON.parse(readFileSync(path.join(dataDir, 'sites.json'), 'utf8')).sites;
  const h = await terrain.precomputedHorizon(sites[0].id);
  assert.ok(h instanceof Horizon);
  assert.equal(h.length, 720);
  assert.equal(h.azStepDeg, 0.5);
});

test('heightAt agrees across the polar/global grid hand-over and the antimeridian', async () => {
  const terrain = await Terrain.load(nodeLoader(dataDir));
  const a = await terrain.heightAt(10, 179.999);
  const b = await terrain.heightAt(10, -180.001);
  assert.ok(Math.abs(a - b) < 5, `antimeridian ${a} vs ${b}`);
  for (const h of [await terrain.heightAt(-89.9, 0), await terrain.heightAt(88.6, 33)]) {
    assert.ok(Number.isFinite(h) && Math.abs(h) < 11000);
  }
});
