import { Ephemeris } from './ephemeris.js';
import {
  siteFrame,
  stationFrame,
  stationElevation,
  subPoint,
  SUN_RADIUS_KM,
  EARTH_RADIUS_KM,
  MOON_RADIUS_KM,
} from './geometry.js';
import {
  resolveOptions,
  computeInstant,
  computeSeries,
  computeEvents,
  computeNextEvents,
  computeSummary,
  computeLandingWindows,
  computeYearMap,
  scoreSummary,
} from './analysis.js';

const MS_PER_DAY = 86400000;
const PRECOMPUTED_MATCH_DEG = 1e-3;
const isoDate = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');

function normalizeLon(lon) {
  const l = ((((lon + 180) % 360) + 360) % 360) - 180;
  return l === -180 && lon > 0 ? 180 : l;
}

async function loadCatalog(loader, path, key, warnings) {
  try {
    const obj = await loader(path, 'json');
    if (!Array.isArray(obj?.[key])) throw new Error(`no "${key}" array`);
    return obj[key];
  } catch (e) {
    warnings.push(`${path} unavailable (${e.message}); continuing with an empty list`);
    return [];
  }
}

function sphereHorizon(lat, lon, terrainHeightM, observerHeightM) {
  const rKm = MOON_RADIUS_KM + terrainHeightM / 1000;
  const hKm = observerHeightM / 1000;
  const dipDeg = (Math.acos(rKm / (rKm + hKm)) * 180) / Math.PI;
  const fields = {
    lat,
    lon,
    terrainHeightM,
    observerHeightM,
    azStepDeg: 1,
    source: 'smooth sphere (no terrain data): geometric horizon dip',
    maxRangeKm: Math.sqrt(2 * rKm * hKm + hKm * hKm),
  };
  const elev = new Float32Array(360).fill(-dipDeg);
  return Object.freeze({
    ...fields,
    elev,
    elevationAt: () => -dipDeg,
    toJSON: () => ({
      format: 'lunarnav-horizon-1',
      site_id: null,
      lat,
      lon,
      terrain_height_m: terrainHeightM,
      observer_height_m: observerHeightM,
      az_step_deg: fields.azStepDeg,
      elev_deg: Array.from(elev, (v) => Math.round(v * 100) / 100),
      max_range_km: fields.maxRangeKm,
      source: fields.source,
    }),
  });
}

async function loadTerrain(loader, warnings) {
  try {
    const { Terrain } = await import('./terrain.js');
    return await Terrain.load(loader);
  } catch (e) {
    warnings.push(`terrain unavailable (${e.message}); horizons use a smooth sphere`);
    return null;
  }
}

export class LunarNav {
  static async create({ loader }) {
    if (typeof loader !== 'function') throw new TypeError('LunarNav.create needs a loader function');
    const warnings = [];
    const [sites, stations, eph, terrain] = await Promise.all([
      loadCatalog(loader, 'sites.json', 'sites', warnings),
      loadCatalog(loader, 'stations.json', 'stations', warnings),
      Ephemeris.load(loader),
      loadTerrain(loader, warnings),
    ]);
    return new LunarNav(sites, stations, eph, terrain, warnings);
  }

  constructor(sites, stations, eph, terrain, warnings) {
    this.sites = sites;
    this.stations = stations;
    this.warnings = warnings;
    this.eph = eph;
    this.terrain = terrain;
    this.env = Object.freeze({
      eph,
      stations,
      stationElevation,
      stationFrame,
      sunRadiusKm: SUN_RADIUS_KM,
      earthRadiusKm: EARTH_RADIUS_KM,
    });
    this.contexts = new Map();
  }

  get coverage() {
    return this.eph.range;
  }

  async ensure(t0Ms, t1Ms = t0Ms) {
    const { startMs, endMs } = this.eph.range;
    if (!Number.isFinite(t0Ms) || !Number.isFinite(t1Ms)) throw new RangeError('time must be a finite UTC ms value');
    if (t0Ms < startMs || t1Ms > endMs) {
      throw new RangeError(
        `Requested time ${isoDate(t0Ms)} … ${isoDate(t1Ms)} is outside the ephemeris coverage ` +
          `${isoDate(startMs)} … ${isoDate(endMs)}`,
      );
    }
    await this.eph.ensure(t0Ms, t1Ms);
  }

  prepare(site, { observerHeightM = 2 } = {}) {
    let s = site;
    if (typeof site === 'string') {
      s = this.sites.find((x) => x.id === site);
      if (!s) return Promise.reject(new RangeError(`Unknown site id: ${site}`));
    }
    if (!s || !Number.isFinite(s.lat) || !Number.isFinite(s.lon) || Math.abs(s.lat) > 90) {
      return Promise.reject(new RangeError('site needs a finite lat (−90…90) and lon, deg'));
    }
    if (!(observerHeightM >= 0)) return Promise.reject(new RangeError('observerHeightM must be >= 0'));
    const norm = { ...s, lon: normalizeLon(s.lon) };
    const key = `${norm.lat.toFixed(6)},${norm.lon.toFixed(6)},${observerHeightM}`;
    let p = this.contexts.get(key);
    if (!p) {
      p = this.#buildContext(norm, observerHeightM);
      this.contexts.set(key, p);
      p.catch(() => this.contexts.delete(key));
    }
    return p;
  }

  async #buildContext(site, observerHeightM) {
    const { lat, lon } = site;
    const warnings = [];
    let terrainHeightM = 0;
    let horizon = null;
    let horizonSource = 'sphere';
    if (this.terrain) {
      try {
        const h = await this.terrain.heightAt(lat, lon);
        if (Number.isFinite(h)) terrainHeightM = h;
        else warnings.push('no terrain height at this point; using the reference sphere');
      } catch (e) {
        warnings.push(`terrain height unavailable (${e.message})`);
      }
      if (site.id) {
        try {
          const pre = await this.terrain.precomputedHorizon(site.id);
          if (pre) {
            const sameObserver = !Number.isFinite(pre.observerHeightM) || Math.abs(pre.observerHeightM - observerHeightM) < 1e-6;
            const samePlace =
              !Number.isFinite(pre.lat) ||
              (Math.abs(pre.lat - lat) < PRECOMPUTED_MATCH_DEG && Math.abs(normalizeLon(pre.lon - lon)) < PRECOMPUTED_MATCH_DEG);
            if (sameObserver && samePlace) {
              horizon = pre;
              horizonSource = 'precomputed';
            } else {
              warnings.push('precomputed horizon does not match this observer height / position; computing one');
            }
          }
        } catch (e) {
          warnings.push(`precomputed horizon unavailable (${e.message})`);
        }
      }
      if (!horizon) {
        try {
          horizon = await this.terrain.computeHorizon(lat, lon, { observerHeightM });
          horizonSource = 'computed';
        } catch (e) {
          warnings.push(`horizon computation failed (${e.message}); using a smooth sphere`);
        }
      }
    }
    if (!horizon) horizon = sphereHorizon(lat, lon, terrainHeightM, observerHeightM);
    const frame = siteFrame(lat, lon, terrainHeightM + observerHeightM);
    return Object.freeze({ site, frame, horizon, horizonSource, terrainHeightM, observerHeightM, warnings });
  }

  async instant(ctx, tMs, opts) {
    await this.ensure(tMs);
    const result = computeInstant(this.env, ctx, tMs, opts);
    const sp = this.subPoints(tMs);
    result.subSolar = sp.subSolar;
    result.subEarth = sp.subEarth;
    return result;
  }

  async series(ctx, t0Ms, t1Ms, stepS, opts) {
    await this.ensure(t0Ms, t1Ms);
    return computeSeries(this.env, ctx, t0Ms, t1Ms, stepS, opts);
  }

  async events(ctx, t0Ms, t1Ms, opts) {
    await this.ensure(t0Ms, t1Ms);
    return computeEvents(this.env, ctx, t0Ms, t1Ms, opts);
  }

  async nextEvents(ctx, tMs, opts) {
    const o = resolveOptions(opts);
    const endMs = this.#searchEnd(tMs, o, tMs);
    await this.ensure(tMs, endMs);
    return computeNextEvents(this.env, ctx, tMs, endMs, o);
  }

  #searchEnd(t0Ms, o, minEndMs) {
    return Math.max(minEndMs, Math.min(t0Ms + o.nextEventSearchDays * MS_PER_DAY, this.eph.range.endMs));
  }

  async summary(ctx, t0Ms, durationDays, opts) {
    const o = resolveOptions(opts);
    const t1Ms = t0Ms + durationDays * MS_PER_DAY;
    await this.ensure(t0Ms, t1Ms);
    await this.eph.ensure(t0Ms, this.#searchEnd(t0Ms, o, t1Ms));
    const summary = computeSummary(this.env, ctx, t0Ms, durationDays, o);
    summary.score = scoreSummary(summary, o.scoreWeights);
    return summary;
  }

  async landingWindows(ctx, t0Ms, t1Ms, opts) {
    const o = resolveOptions(opts);
    await this.ensure(t0Ms, t1Ms + o.missionDays * MS_PER_DAY + o.stepS * 1000);
    return computeLandingWindows(this.env, ctx, t0Ms, t1Ms, o);
  }

  async yearMap(ctx, year, opts) {
    await this.ensure(Date.UTC(year, 0, 1), Date.UTC(year + 1, 0, 1));
    return computeYearMap(this.env, ctx, year, opts);
  }

  async compare(scenarios, opts = {}) {
    const { observerHeightM, ...shared } = opts;
    const rows = await Promise.all(
      scenarios.map(async (sc, index) => {
        const ctx = sc.site && sc.site.frame && sc.site.horizon ? sc.site : await this.prepare(sc.site, { observerHeightM });
        const o = { ...shared, ...(sc.opts || {}) };
        const summary = await this.summary(ctx, sc.t0Ms, sc.durationDays, o);
        return {
          index,
          site: ctx.site,
          horizonSource: ctx.horizonSource,
          t0Ms: sc.t0Ms,
          durationDays: sc.durationDays,
          summary,
          score: summary.score,
          rank: 0,
        };
      }),
    );
    const order = rows.map((r) => r.index).sort((a, b) => rows[b].score.score - rows[a].score.score);
    order.forEach((idx, k) => {
      rows[idx].rank = k + 1;
    });
    return rows;
  }

  subPoints(tMs) {
    return { tMs, subSolar: subPoint(this.eph.sunVec(tMs)), subEarth: subPoint(this.eph.earthVec(tMs)) };
  }
}
