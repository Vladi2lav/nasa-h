const DEG = Math.PI / 180;
const MS_PER_S = 1000;
const MS_PER_H = 3600 * MS_PER_S;
const MS_PER_DAY = 24 * MS_PER_H;

export const AU_KM = 149597870.7;
export const SOLAR_CONSTANT_W_M2 = 1361;
export const LUNAR_NIGHT_HOURS = (29.530589 * 24) / 2;

export const SUN_SKY_RATE_DEG_PER_H = 0.6;
export const EARTH_SKY_RATE_DEG_PER_H = 0.2;

export const DEFAULT_OPTIONS = Object.freeze({
  sunMinFraction: 0.5,
  commMaskDeg: 2,
  panel: 'tracking',
  stations: null,
  stepS: 600,
  discStrips: 16,
  scanMinStepS: 600,
  scanMaxStepS: 21600,
  refineS: 1,
  nextEventSearchDays: 400,
  candidateStepS: 21600,
  missionDays: 14,
  requirements: null,
  scoreWeights: null,
});

export const DEFAULT_SCORE_WEIGHTS = Object.freeze({
  sunlight: 0.3,
  power: 0.15,
  comm: 0.3,
  night: 0.15,
  both: 0.1,
});

const PANELS = new Set(['tracking', 'horizontal']);

export function resolveOptions(opts = {}) {
  const o = { ...DEFAULT_OPTIONS };
  for (const key of Object.keys(opts)) {
    if (opts[key] !== undefined) o[key] = opts[key];
  }
  if (!(o.sunMinFraction > 0 && o.sunMinFraction <= 1)) {
    throw new RangeError(`sunMinFraction must be in (0, 1], got ${o.sunMinFraction}`);
  }
  if (!Number.isFinite(o.commMaskDeg)) throw new RangeError('commMaskDeg must be a finite number');
  if (!PANELS.has(o.panel)) throw new RangeError(`panel must be 'tracking' or 'horizontal', got ${o.panel}`);
  if (o.stations !== null && !Array.isArray(o.stations)) throw new TypeError('stations must be an array of ids');
  for (const key of ['stepS', 'scanMinStepS', 'scanMaxStepS', 'refineS', 'candidateStepS', 'missionDays', 'nextEventSearchDays']) {
    if (!(o[key] > 0)) throw new RangeError(`${key} must be > 0, got ${o[key]}`);
  }
  if (!(Number.isInteger(o.discStrips) && o.discStrips >= 2)) throw new RangeError('discStrips must be an integer >= 2');
  if (o.scanMaxStepS < o.scanMinStepS) throw new RangeError('scanMaxStepS must be >= scanMinStepS');
  return o;
}

const ENVELOPE_BINS = 360;
const ENVELOPE_SAMPLE_DEG = 0.1;
const envelopeCache = new WeakMap();

function horizonEnvelope(horizon) {
  let env = envelopeCache.get(horizon);
  if (env) return env;
  const binMin = new Float64Array(ENVELOPE_BINS).fill(Infinity);
  const binMax = new Float64Array(ENVELOPE_BINS).fill(-Infinity);
  const put = (bin, v) => {
    const b = ((bin % ENVELOPE_BINS) + ENVELOPE_BINS) % ENVELOPE_BINS;
    if (v < binMin[b]) binMin[b] = v;
    if (v > binMax[b]) binMax[b] = v;
  };
  const step = horizon.azStepDeg > 0 ? horizon.azStepDeg : ENVELOPE_SAMPLE_DEG;
  const nodes = Math.ceil(360 / step - 1e-9);
  for (let k = 0; k < nodes; k++) {
    const az = k * step;
    put(Math.floor(az), horizon.elevationAt(az));
  }
  for (let b = 0; b < ENVELOPE_BINS; b++) {
    const v = horizon.elevationAt(b);
    put(b, v);
    put(b - 1, v);
  }
  let min = Infinity;
  let max = -Infinity;
  for (let b = 0; b < ENVELOPE_BINS; b++) {
    if (binMin[b] < min) min = binMin[b];
    if (binMax[b] > max) max = binMax[b];
  }
  env = { binMin, binMax, min, max };
  envelopeCache.set(horizon, env);
  return env;
}

function envelopeRange(env, az, half, out) {
  if (!(half < 180)) {
    out[0] = env.min;
    out[1] = env.max;
    return out;
  }
  const b0 = Math.floor(az - half);
  const b1 = Math.floor(az + half);
  let lo = Infinity;
  let hi = -Infinity;
  for (let b = b0; b <= b1; b++) {
    const i = ((b % ENVELOPE_BINS) + ENVELOPE_BINS) % ENVELOPE_BINS;
    if (env.binMin[i] < lo) lo = env.binMin[i];
    if (env.binMax[i] > hi) hi = env.binMax[i];
  }
  out[0] = lo;
  out[1] = hi;
  return out;
}

const wrap360 = (az) => {
  const a = az % 360;
  return a < 0 ? a + 360 : a;
};

function segmentPrimitive(x, r) {
  const xc = x > r ? r : x < -r ? -r : x;
  const s = Math.sqrt(Math.max(0, r * r - xc * xc));
  return 0.5 * (xc * s + r * r * Math.asin(xc / r));
}

function stripVisibleArea(xa, xb, c, r) {
  if (c >= r) return 0;
  const full = 2 * (segmentPrimitive(xb, r) - segmentPrimitive(xa, r));
  if (c <= -r) return full;
  const xc = Math.sqrt(r * r - c * c);
  const lo = xa > -xc ? xa : -xc;
  const hi = xb < xc ? xb : xc;
  const inner = hi > lo ? segmentPrimitive(hi, r) - segmentPrimitive(lo, r) : 0;
  const width = hi > lo ? hi - lo : 0;
  return c >= 0 ? inner - c * width : full - (inner + c * width);
}

const scratchRange = new Float64Array(2);

function discFraction(az, el, r, horizon, env, strips) {
  if (!(r > 0)) return el >= horizon.elevationAt(wrap360(az)) ? 1 : 0;
  if (el - r >= env.max) return 1;
  if (el + r <= env.min) return 0;
  const cosEl = Math.max(Math.cos(el * DEG), 1e-9);
  const rg = envelopeRange(env, az, r / cosEl, scratchRange);
  if (el - r >= rg[1]) return 1;
  if (el + r <= rg[0]) return 0;
  const w = (2 * r) / strips;
  let area = 0;
  for (let i = 0; i < strips; i++) {
    const xa = -r + i * w;
    const c = horizon.elevationAt(wrap360(az + (xa + 0.5 * w) / cosEl)) - el;
    area += stripVisibleArea(xa, xa + w, c, r);
  }
  const f = area / (Math.PI * r * r);
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

export function visibleDiscFraction(azDeg, elDeg, angularRadiusDeg, horizon, strips = DEFAULT_OPTIONS.discStrips) {
  return discFraction(wrap360(azDeg), elDeg, angularRadiusDeg, horizon, horizonEnvelope(horizon), strips);
}

export function clearance(azDeg, elDeg, horizon) {
  return elDeg - horizon.elevationAt(wrap360(azDeg));
}

const AZ = 0;
const EL = 1;
const RAD = 2;
const DIST = 3;
const HZ = 4;
const FRAC = 5;

function bodyState(frame, horizon, env, v, radiusKm, strips, withFraction, out) {
  const p = frame.pos;
  const e = frame.east;
  const n = frame.north;
  const u = frame.up;
  const dx = v[0] - p[0];
  const dy = v[1] - p[1];
  const dz = v[2] - p[2];
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const de = dx * e[0] + dy * e[1] + dz * e[2];
  const dn = dx * n[0] + dy * n[1] + dz * n[2];
  const du = dx * u[0] + dy * u[1] + dz * u[2];
  let az = Math.atan2(de, dn) / DEG;
  if (az < 0) az += 360;
  const sinEl = du / dist;
  const el = Math.asin(sinEl > 1 ? 1 : sinEl < -1 ? -1 : sinEl) / DEG;
  const rad = Math.asin(Math.min(1, radiusKm / dist)) / DEG;
  out[AZ] = az;
  out[EL] = el;
  out[RAD] = rad;
  out[DIST] = dist;
  out[HZ] = horizon.elevationAt(az);
  out[FRAC] = withFraction ? discFraction(az, el, rad, horizon, env, strips) : NaN;
  return out;
}

function selectStations(env, o) {
  const all = env.stations || [];
  if (o.stations === null) return all;
  return o.stations.map((id) => {
    const st = all.find((s) => s.id === id);
    if (!st) throw new RangeError(`Unknown ground station id: ${id}`);
    return st;
  });
}

const stationMask = (st) => (Number.isFinite(st.min_elevation_deg) ? st.min_elevation_deg : 10);

function makeProbe(env, ctx, o) {
  const { eph } = env;
  const { frame, horizon } = ctx;
  const hEnv = horizonEnvelope(horizon);
  const vSun = [0, 0, 0];
  const vEarth = [0, 0, 0];
  const vMoon = [0, 0, 0];
  const sun = new Float64Array(6);
  const earth = new Float64Array(6);
  const stations = selectStations(env, o);
  const masks = Float64Array.from(stations, stationMask);
  const targets = env.stationFrame ? stations.map(env.stationFrame) : stations;
  const probe = {
    stations,
    hEnv,
    sunAt(t) {
      return bodyState(frame, horizon, hEnv, eph.sunVec(t, vSun), env.sunRadiusKm, o.discStrips, true, sun);
    },
    earthAt(t, withFraction = false) {
      return bodyState(frame, horizon, hEnv, eph.earthVec(t, vEarth), env.earthRadiusKm, o.discStrips, withFraction, earth);
    },
    sunUp(t) {
      return probe.sunAt(t)[FRAC] >= o.sunMinFraction;
    },
    earthUp(t) {
      const s = probe.earthAt(t);
      return s[EL] - s[HZ] >= o.commMaskDeg;
    },
    stationsUp(t, elOut) {
      const m = eph.moonVecEarthFixed(t, vMoon);
      let count = 0;
      for (let s = 0; s < stations.length; s++) {
        const el = env.stationElevation(targets[s], m);
        if (elOut) elOut[s] = el;
        if (el >= masks[s]) count++;
      }
      return count;
    },
    linkUp(t) {
      return probe.earthUp(t) && probe.stationsUp(t) > 0;
    },
  };
  return probe;
}

const irradianceAt = (distKm) => SOLAR_CONSTANT_W_M2 * (AU_KM / distKm) ** 2;

function bodyInstant(s) {
  return {
    azDeg: s[AZ],
    elDeg: s[EL],
    horizonElDeg: s[HZ],
    clearanceDeg: s[EL] - s[HZ],
    visibleFraction: s[FRAC],
    angularRadiusDeg: s[RAD],
    distanceKm: s[DIST],
  };
}

export function computeInstant(env, ctx, tMs, opts) {
  const o = resolveOptions(opts);
  const probe = makeProbe(env, ctx, o);
  const sun = bodyInstant(probe.sunAt(tMs));
  const earth = bodyInstant(probe.earthAt(tMs, true));
  const irr = irradianceAt(sun.distanceKm);
  const tracking = sun.visibleFraction;
  const horizontal = sun.visibleFraction * Math.max(0, Math.sin(sun.elDeg * DEG));
  const dte = earth.clearanceDeg >= o.commMaskDeg;
  const els = new Float64Array(probe.stations.length);
  const nUp = probe.stations.length ? probe.stationsUp(tMs, els) : 0;
  const stations = probe.stations.map((st, i) => ({
    id: st.id,
    name: st.name,
    network: st.network,
    moonElevationDeg: els[i],
    minElevationDeg: stationMask(st),
    visible: els[i] >= stationMask(st),
  }));
  const link = probe.stations.length ? dte && nUp > 0 : null;
  return {
    tMs,
    sun,
    earth,
    sunlit: sun.visibleFraction >= o.sunMinFraction,
    power: {
      irradianceWm2: irr,
      trackingFactor: tracking,
      horizontalFactor: horizontal,
      factor: o.panel === 'tracking' ? tracking : horizontal,
      trackingWm2: irr * tracking,
      horizontalWm2: irr * horizontal,
    },
    comm: {
      dte,
      link,
      available: link === null ? dte : link,
      basis: link === null ? 'dte' : 'link',
      stations,
    },
  };
}

function buildSeries(env, ctx, t0Ms, stepMs, n, o) {
  const probe = makeProbe(env, ctx, o);
  const S = probe.stations.length;
  const tMs = new Float64Array(n);
  const mk = () => ({
    azDeg: new Float32Array(n),
    elDeg: new Float32Array(n),
    horizonElDeg: new Float32Array(n),
    clearanceDeg: new Float32Array(n),
    visibleFraction: new Float32Array(n),
    angularRadiusDeg: new Float32Array(n),
    distanceKm: new Float64Array(n),
  });
  const sun = mk();
  const earth = mk();
  const irradianceWm2 = new Float32Array(n);
  const powerTracking = new Float32Array(n);
  const powerHorizontal = new Float32Array(n);
  const sunlit = new Uint8Array(n);
  const dte = new Uint8Array(n);
  const link = S ? new Uint8Array(n) : null;
  const stationCount = new Uint8Array(n);
  const stationVisible = probe.stations.map(() => new Uint8Array(n));
  const masks = Float64Array.from(probe.stations, stationMask);
  const stEl = new Float64Array(S);

  const put = (b, s, i) => {
    b.azDeg[i] = s[AZ];
    b.elDeg[i] = s[EL];
    b.horizonElDeg[i] = s[HZ];
    b.clearanceDeg[i] = s[EL] - s[HZ];
    b.visibleFraction[i] = s[FRAC];
    b.angularRadiusDeg[i] = s[RAD];
    b.distanceKm[i] = s[DIST];
  };

  for (let i = 0; i < n; i++) {
    const t = t0Ms + i * stepMs;
    tMs[i] = t;
    const s = probe.sunAt(t);
    put(sun, s, i);
    const frac = s[FRAC];
    irradianceWm2[i] = irradianceAt(s[DIST]);
    powerTracking[i] = frac;
    powerHorizontal[i] = s[EL] > 0 ? frac * Math.sin(s[EL] * DEG) : 0;
    sunlit[i] = frac >= o.sunMinFraction ? 1 : 0;
    const e = probe.earthAt(t, true);
    put(earth, e, i);
    const d = e[EL] - e[HZ] >= o.commMaskDeg ? 1 : 0;
    dte[i] = d;
    if (S) {
      const c = probe.stationsUp(t, stEl);
      stationCount[i] = c;
      for (let k = 0; k < S; k++) stationVisible[k][i] = stEl[k] >= masks[k] ? 1 : 0;
      link[i] = d && c > 0 ? 1 : 0;
    }
  }
  return {
    t0Ms,
    stepS: stepMs / MS_PER_S,
    n,
    tMs,
    sun,
    earth,
    irradianceWm2,
    powerTracking,
    powerHorizontal,
    powerFactor: o.panel === 'tracking' ? powerTracking : powerHorizontal,
    sunlit,
    dte,
    link,
    comm: link || dte,
    commBasis: link ? 'link' : 'dte',
    stationIds: probe.stations.map((st) => st.id),
    stationVisible,
    stationCount,
    options: o,
  };
}

export function computeSeries(env, ctx, t0Ms, t1Ms, stepS, opts) {
  const o = resolveOptions(opts);
  if (!(stepS > 0)) throw new RangeError('stepS must be > 0');
  if (!(t1Ms >= t0Ms)) throw new RangeError('t1Ms must be >= t0Ms');
  const stepMs = stepS * MS_PER_S;
  const n = Math.floor((t1Ms - t0Ms) / stepMs + 1e-9) + 1;
  return buildSeries(env, ctx, t0Ms, stepMs, n, o);
}

function refineTransition(upAt, ta, tb, upA, refineMs) {
  let a = ta;
  let b = tb;
  while (b - a > refineMs) {
    const m = 0.5 * (a + b);
    if (upAt(m) === upA) a = m;
    else b = m;
  }
  return 0.5 * (a + b);
}

function safeStepMs(state, isSun, o, hEnv) {
  const rate = (isSun ? SUN_SKY_RATE_DEG_PER_H : EARTH_SKY_RATE_DEG_PER_H) / MS_PER_H;
  const r = isSun ? state[RAD] : 0;
  const upPad = isSun ? r : o.commMaskDeg;
  const downPad = isSun ? r : -o.commMaskDeg;
  const el = state[EL];
  const minDt = o.scanMinStepS * MS_PER_S;
  const rg = scratchRange;
  for (let dt = o.scanMaxStepS * MS_PER_S; dt > minDt; dt *= 0.5) {
    const a = rate * dt;
    const elMax = Math.min(89.999, Math.abs(el) + a + r);
    envelopeRange(hEnv, state[AZ], (a + r) / Math.cos(elMax * DEG), rg);
    if (el - a - upPad >= rg[1] || el + a + downPad < rg[0]) return dt;
  }
  return minDt;
}

function scanBody(probe, isSun, t0, t1, o, out, untilBoth) {
  const upAt = isSun ? probe.sunUp : probe.earthUp;
  const stateAt = isSun ? probe.sunAt : probe.earthAt;
  const isUp = isSun ? (s) => s[FRAC] >= o.sunMinFraction : (s) => s[EL] - s[HZ] >= o.commMaskDeg;
  const [riseType, setType] = isSun ? ['sunrise', 'sunset'] : ['earthrise', 'earthset'];
  const refineMs = o.refineS * MS_PER_S;
  let t = t0;
  let state = stateAt(t);
  let up = isUp(state);
  const upAtStart = up;
  let rises = 0;
  let sets = 0;
  while (t < t1) {
    const tn = t + Math.min(safeStepMs(state, isSun, o, probe.hEnv), t1 - t);
    state = stateAt(tn);
    const upN = isUp(state);
    if (upN !== up) {
      const te = refineTransition(upAt, t, tn, up, refineMs);
      const s = stateAt(te);
      out.push({ type: upN ? riseType : setType, tMs: te, azDeg: s[AZ], elDeg: s[EL] });
      if (upN) rises++;
      else sets++;
      if (untilBoth && rises > 0 && sets > 0) break;
      state = stateAt(tn);
    }
    t = tn;
    up = upN;
  }
  return upAtStart;
}

export function computeEvents(env, ctx, t0Ms, t1Ms, opts) {
  const o = resolveOptions(opts);
  if (!(t1Ms >= t0Ms)) throw new RangeError('t1Ms must be >= t0Ms');
  const probe = makeProbe(env, ctx, o);
  const events = [];
  const sunlitAtStart = scanBody(probe, true, t0Ms, t1Ms, o, events, false);
  const earthVisibleAtStart = scanBody(probe, false, t0Ms, t1Ms, o, events, false);
  events.sort((a, b) => a.tMs - b.tMs);
  return { t0Ms, t1Ms, sunlitAtStart, earthVisibleAtStart, events };
}

export function computeNextEvents(env, ctx, tMs, searchEndMs, opts) {
  const o = resolveOptions(opts);
  const probe = makeProbe(env, ctx, o);
  const sunEv = [];
  const earthEv = [];
  const sunlitNow = scanBody(probe, true, tMs, searchEndMs, o, sunEv, true);
  const earthVisibleNow = scanBody(probe, false, tMs, searchEndMs, o, earthEv, true);
  const first = (list, type) => {
    const ev = list.find((e) => e.type === type);
    return ev ? ev.tMs : null;
  };
  const hoursTo = (t) => (t === null ? null : (t - tMs) / MS_PER_H);
  const sunsetMs = first(sunEv, 'sunset');
  const sunriseMs = first(sunEv, 'sunrise');
  const earthsetMs = first(earthEv, 'earthset');
  const earthriseMs = first(earthEv, 'earthrise');
  return {
    fromMs: tMs,
    searchEndMs,
    sunlitNow,
    earthVisibleNow,
    sunsetMs,
    sunriseMs,
    earthsetMs,
    earthriseMs,
    hoursToSunset: hoursTo(sunsetMs),
    hoursToSunrise: hoursTo(sunriseMs),
    hoursToEarthset: hoursTo(earthsetMs),
    hoursToEarthrise: hoursTo(earthriseMs),
  };
}

const interval = (startMs, endMs) => ({ startMs, endMs, hours: (endMs - startMs) / MS_PER_H });

function flagIntervals(flags, tMs, upAt, refineMs, endMs) {
  const out = [];
  const n = flags.length;
  let start = tMs[0];
  for (let i = 1; i < n; i++) {
    if (flags[i] !== flags[i - 1]) {
      const te = refineTransition(upAt, tMs[i - 1], tMs[i], flags[i - 1] === 1, refineMs);
      if (flags[i]) start = te;
      else out.push(interval(start, te));
    }
  }
  if (flags[n - 1]) out.push(interval(start, endMs));
  return out;
}

function intersectIntervals(a, b) {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const s = Math.max(a[i].startMs, b[j].startMs);
    const e = Math.min(a[i].endMs, b[j].endMs);
    if (e > s) out.push(interval(s, e));
    if (a[i].endMs < b[j].endMs) i++;
    else j++;
  }
  return out;
}

const totalHours = (ivs) => ivs.reduce((acc, iv) => acc + iv.hours, 0);
const longestHours = (ivs) => ivs.reduce((acc, iv) => Math.max(acc, iv.hours), 0);

function longestGapHours(ivs, t0, t1) {
  let prev = t0;
  let longest = 0;
  for (const iv of ivs) {
    longest = Math.max(longest, iv.startMs - prev);
    prev = iv.endMs;
  }
  return Math.max(longest, t1 - prev) / MS_PER_H;
}

function trapzMean(arr) {
  const n = arr.length;
  if (n === 1) return arr[0];
  let acc = 0.5 * (arr[0] + arr[n - 1]);
  for (let i = 1; i < n - 1; i++) acc += arr[i];
  return acc / (n - 1);
}

function trapzMeanProduct(a, b) {
  const n = a.length;
  if (n === 1) return a[0] * b[0];
  let acc = 0.5 * (a[0] * b[0] + a[n - 1] * b[n - 1]);
  for (let i = 1; i < n - 1; i++) acc += a[i] * b[i];
  return acc / (n - 1);
}

function minMax(arr) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] < lo) lo = arr[i];
    if (arr[i] > hi) hi = arr[i];
  }
  return [lo, hi];
}

export function computeSummary(env, ctx, t0Ms, durationDays, opts) {
  const o = resolveOptions(opts);
  if (!(durationDays > 0)) throw new RangeError('durationDays must be > 0');
  const durMs = durationDays * MS_PER_DAY;
  const t1Ms = t0Ms + durMs;
  const nSteps = Math.ceil(durMs / (o.stepS * MS_PER_S) - 1e-9);
  const stepMs = durMs / nSteps;
  const series = buildSeries(env, ctx, t0Ms, stepMs, nSteps + 1, o);
  const probe = makeProbe(env, ctx, o);
  const refineMs = o.refineS * MS_PER_S;

  const sunlitIv = flagIntervals(series.sunlit, series.tMs, probe.sunUp, refineMs, t1Ms);
  const earthIv = flagIntervals(series.dte, series.tMs, probe.earthUp, refineMs, t1Ms);
  const commIv = series.link ? flagIntervals(series.link, series.tMs, probe.linkUp, refineMs, t1Ms) : earthIv;
  const bothIv = intersectIntervals(sunlitIv, commIv);
  const durH = durMs / MS_PER_H;

  const sunlitH = totalHours(sunlitIv);
  const earthH = totalHours(earthIv);
  const commH = totalHours(commIv);
  const bothH = totalHours(bothIv);
  const [sunElMin, sunElMax] = minMax(series.sun.elDeg);
  const [earthElMin, earthElMax] = minMax(series.earth.elDeg);
  const meanTracking = trapzMean(series.powerTracking);
  const meanHorizontal = trapzMean(series.powerHorizontal);
  const energyTracking = trapzMeanProduct(series.irradianceWm2, series.powerTracking) * durH;
  const energyHorizontal = trapzMeanProduct(series.irradianceWm2, series.powerHorizontal) * durH;
  const tracking = o.panel === 'tracking';

  const searchEndMs = Math.min(t0Ms + o.nextEventSearchDays * MS_PER_DAY, env.eph.range.endMs);
  const next = computeNextEvents(env, ctx, t0Ms, Math.max(searchEndMs, t1Ms), o);

  return {
    t0Ms,
    t1Ms,
    durationDays,
    durationHours: durH,
    stepS: stepMs / MS_PER_S,
    options: o,
    sun: {
      sunlitFraction: sunlitH / durH,
      sunlitHours: sunlitH,
      darkHours: durH - sunlitH,
      longestSunlitHours: longestHours(sunlitIv),
      longestDarkHours: longestGapHours(sunlitIv, t0Ms, t1Ms),
      elevationMinDeg: sunElMin,
      elevationMeanDeg: trapzMean(series.sun.elDeg),
      elevationMaxDeg: sunElMax,
      alwaysLitInWindow: sunlitIv.length === 1 && sunlitIv[0].startMs === t0Ms && sunlitIv[0].endMs === t1Ms,
      neverLitInWindow: sunlitIv.length === 0,
    },
    power: {
      meanIrradianceWm2: trapzMean(series.irradianceWm2),
      meanTrackingFactor: meanTracking,
      meanHorizontalFactor: meanHorizontal,
      energyTrackingWhm2: energyTracking,
      energyHorizontalWhm2: energyHorizontal,
      meanFactor: tracking ? meanTracking : meanHorizontal,
      energyWhm2: tracking ? energyTracking : energyHorizontal,
    },
    earth: {
      visibleFraction: earthH / durH,
      visibleHours: earthH,
      longestWindowHours: longestHours(earthIv),
      longestGapHours: longestGapHours(earthIv, t0Ms, t1Ms),
      elevationMinDeg: earthElMin,
      elevationMeanDeg: trapzMean(series.earth.elDeg),
      elevationMaxDeg: earthElMax,
      alwaysVisibleInWindow: earthIv.length === 1 && earthIv[0].startMs === t0Ms && earthIv[0].endMs === t1Ms,
      neverVisibleInWindow: earthIv.length === 0,
    },
    comm: {
      basis: series.commBasis,
      stationIds: series.stationIds,
      fraction: commH / durH,
      hours: commH,
      longestWindowHours: longestHours(commIv),
      longestGapHours: longestGapHours(commIv, t0Ms, t1Ms),
    },
    both: { fraction: bothH / durH, hours: bothH },
    next,
    intervals: { sunlit: sunlitIv, earthVisible: earthIv, comm: commIv, both: bothIv },
  };
}

export function defaultLandingRequirements(latDeg) {
  const polar = Math.abs(latDeg) >= 70;
  return {
    minSunElDeg: polar ? null : 5,
    maxSunElDeg: polar ? null : 15,
    minSunlitHours: 72,
    minCommFraction: 0.5,
  };
}

function prefixSum(arr) {
  const p = new Float64Array(arr.length + 1);
  for (let i = 0; i < arr.length; i++) p[i + 1] = p[i] + arr[i];
  return p;
}

export function computeLandingWindows(env, ctx, t0Ms, t1Ms, opts) {
  const o = resolveOptions(opts);
  if (!(t1Ms >= t0Ms)) throw new RangeError('t1Ms must be >= t0Ms');
  const req = { ...defaultLandingRequirements(ctx.frame.lat), ...(o.requirements || {}) };
  const baseMs = o.stepS * MS_PER_S;
  const missionMs = o.missionDays * MS_PER_DAY;
  const missionSteps = Math.max(1, Math.round(missionMs / baseMs));
  const nCandRaw = Math.floor((t1Ms - t0Ms) / (o.candidateStepS * MS_PER_S) + 1e-9) + 1;
  const lastIdx = Math.round(((nCandRaw - 1) * o.candidateStepS * MS_PER_S) / baseMs);
  const series = buildSeries(env, ctx, t0Ms, baseMs, lastIdx + missionSteps + 1, o);
  const n = series.n;

  const runEnd = new Int32Array(n + 1);
  runEnd[n] = n;
  for (let i = n - 1; i >= 0; i--) runEnd[i] = series.sunlit[i] ? runEnd[i + 1] : i;
  const pSun = prefixSum(series.sunlit);
  const pDte = prefixSum(series.dte);
  const pComm = prefixSum(series.comm);
  const pPow = prefixSum(series.powerFactor);

  const tMs = new Float64Array(nCandRaw);
  const sunElDeg = new Float32Array(nCandRaw);
  const sunFraction = new Float32Array(nCandRaw);
  const sunlitAtLanding = new Uint8Array(nCandRaw);
  const sunlitHours = new Float32Array(nCandRaw);
  const sunlitFraction = new Float32Array(nCandRaw);
  const earthFraction = new Float32Array(nCandRaw);
  const commFraction = new Float32Array(nCandRaw);
  const meanPowerFactor = new Float32Array(nCandRaw);
  const feasible = new Uint8Array(nCandRaw);
  const capH = (missionSteps * baseMs) / MS_PER_H;
  const windows = [];
  let open = -1;

  for (let k = 0; k < nCandRaw; k++) {
    const i = Math.round((k * o.candidateStepS * MS_PER_S) / baseMs);
    const j = i + missionSteps;
    tMs[k] = series.tMs[i];
    const el = series.sun.elDeg[i];
    sunElDeg[k] = el;
    sunFraction[k] = series.sun.visibleFraction[i];
    sunlitAtLanding[k] = series.sunlit[i];
    sunlitHours[k] = Math.min(capH, ((runEnd[i] - i) * baseMs) / MS_PER_H);
    sunlitFraction[k] = (pSun[j] - pSun[i]) / missionSteps;
    earthFraction[k] = (pDte[j] - pDte[i]) / missionSteps;
    commFraction[k] = (pComm[j] - pComm[i]) / missionSteps;
    meanPowerFactor[k] = (pPow[j] - pPow[i]) / missionSteps;
    const ok =
      series.sunlit[i] === 1 &&
      (req.minSunElDeg === null || el >= req.minSunElDeg) &&
      (req.maxSunElDeg === null || el <= req.maxSunElDeg) &&
      sunlitHours[k] >= req.minSunlitHours &&
      commFraction[k] >= req.minCommFraction;
    feasible[k] = ok ? 1 : 0;
    if (ok && open < 0) open = k;
    if (open >= 0 && (!ok || k === nCandRaw - 1)) {
      const last = ok ? k : k - 1;
      windows.push({
        startMs: tMs[open],
        endMs: tMs[last],
        durationHours: (tMs[last] - tMs[open]) / MS_PER_H,
        count: last - open + 1,
      });
      open = -1;
    }
  }
  return {
    t0Ms,
    t1Ms,
    candidateStepS: o.candidateStepS,
    baseStepS: o.stepS,
    missionDays: o.missionDays,
    requirements: req,
    options: o,
    commBasis: series.commBasis,
    n: nCandRaw,
    tMs,
    sunElDeg,
    sunFraction,
    sunlitAtLanding,
    sunlitHours,
    sunlitFraction,
    earthFraction,
    commFraction,
    meanPowerFactor,
    feasible,
    feasibleCount: windows.reduce((acc, w) => acc + w.count, 0),
    firstFeasibleMs: windows.length ? windows[0].startMs : null,
    windows,
  };
}

export function computeYearMap(env, ctx, year, opts) {
  const o = resolveOptions(opts);
  if (!Number.isInteger(year)) throw new RangeError('year must be an integer');
  if (3600 % o.stepS !== 0) throw new RangeError('yearMap stepS must divide 3600');
  const startMs = Date.UTC(year, 0, 1);
  const endMs = Date.UTC(year + 1, 0, 1);
  const days = Math.round((endMs - startMs) / MS_PER_DAY);
  const perHour = 3600 / o.stepS;
  const cells = days * 24;
  const series = buildSeries(env, ctx, startMs, o.stepS * MS_PER_S, cells * perHour, o);
  const sun = new Uint8Array(cells);
  const earth = new Uint8Array(cells);
  const comm = new Uint8Array(cells);
  const both = new Uint8Array(cells);
  const toByte = (x) => Math.round((x / perHour) * 255);
  for (let c = 0; c < cells; c++) {
    let fs = 0;
    let fe = 0;
    let fc = 0;
    let fb = 0;
    for (let k = c * perHour, end = k + perHour; k < end; k++) {
      fs += series.sun.visibleFraction[k];
      fe += series.dte[k];
      fc += series.comm[k];
      fb += series.sunlit[k] & series.comm[k];
    }
    sun[c] = toByte(fs);
    earth[c] = toByte(fe);
    comm[c] = toByte(fc);
    both[c] = toByte(fb);
  }
  const monthly = [];
  for (let m = 0; m < 12; m++) {
    const a = Math.round((Date.UTC(year, m, 1) - startMs) / (o.stepS * MS_PER_S));
    const b = Math.round((Date.UTC(year, m + 1, 1) - startMs) / (o.stepS * MS_PER_S));
    let sl = 0;
    let ev = 0;
    let cm = 0;
    let bt = 0;
    let el = 0;
    let energy = 0;
    for (let k = a; k < b; k++) {
      sl += series.sunlit[k];
      ev += series.dte[k];
      cm += series.comm[k];
      bt += series.sunlit[k] & series.comm[k];
      el += series.sun.elDeg[k];
      energy += series.irradianceWm2[k] * series.powerFactor[k];
    }
    const cnt = b - a;
    monthly.push({
      month: m + 1,
      startMs: Date.UTC(year, m, 1),
      sunlitPercent: (100 * sl) / cnt,
      earthPercent: (100 * ev) / cnt,
      commPercent: (100 * cm) / cnt,
      bothPercent: (100 * bt) / cnt,
      meanSunElDeg: el / cnt,
      energyWhm2: (energy * o.stepS) / 3600,
    });
  }
  return { year, startMs, days, hours: 24, stepS: o.stepS, commBasis: series.commBasis, sun, earth, comm, both, monthly, options: o };
}

export function scoreSummary(summary, weights) {
  const w = { ...DEFAULT_SCORE_WEIGHTS, ...(weights || {}) };
  const components = {
    sunlight: summary.sun.sunlitFraction,
    power: summary.power.meanFactor,
    comm: summary.comm.fraction,
    night: 1 - Math.min(1, summary.sun.longestDarkHours / LUNAR_NIGHT_HOURS),
    both: summary.both.fraction,
  };
  let num = 0;
  let den = 0;
  for (const key of Object.keys(DEFAULT_SCORE_WEIGHTS)) {
    const wi = w[key];
    if (!(wi >= 0)) throw new RangeError(`score weight ${key} must be >= 0`);
    num += wi * components[key];
    den += wi;
  }
  if (!(den > 0)) throw new RangeError('score weights must not all be zero');
  return { score: (100 * num) / den, components, weights: w };
}
