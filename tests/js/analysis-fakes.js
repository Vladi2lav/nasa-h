export const R_MOON_KM = 1737.4;
export const AU_KM = 149597870.7;
export const SUN_RADIUS_KM = 695700;
export const EARTH_RADIUS_KM = 6378.137;
export const SYNODIC_MS = 29.530589 * 86400000;
const DEG = Math.PI / 180;

export function fakeSiteFrame(lat, lon, heightM) {
  const f = lat * DEG;
  const l = lon * DEG;
  const up = [Math.cos(f) * Math.cos(l), Math.cos(f) * Math.sin(l), Math.sin(f)];
  const east = [-Math.sin(l), Math.cos(l), 0];
  const north = [-Math.sin(f) * Math.cos(l), -Math.sin(f) * Math.sin(l), Math.cos(f)];
  const r = R_MOON_KM + heightM / 1000;
  return { lat, lon, heightM, pos: up.map((u) => u * r), east, north, up };
}

export class FakeEphemeris {
  constructor({
    startMs = Date.UTC(2026, 0, 1),
    endMs = Date.UTC(2028, 0, 1),
    refMs = Date.UTC(2026, 0, 1),
    sunLon0Deg = 120,
    sunDecDeg = 0,
    sunDecAmpDeg = 0,
    sunDistKm = AU_KM,
    earthLibLonDeg = 1,
    earthLibLatDeg = 1,
  } = {}) {
    Object.assign(this, { startMs, endMs, refMs, sunLon0Deg, sunDecDeg, sunDecAmpDeg, sunDistKm, earthLibLonDeg, earthLibLatDeg });
    this.ensured = [];
  }

  get range() {
    return { startMs: this.startMs, endMs: this.endMs };
  }

  async ensure(t0Ms, t1Ms) {
    if (t0Ms < this.startMs || t1Ms > this.endMs) throw new RangeError('outside fake coverage');
    this.ensured.push([t0Ms, t1Ms]);
  }

  sunLonDeg(tMs) {
    return this.sunLon0Deg - (360 * (tMs - this.refMs)) / SYNODIC_MS;
  }

  sunDecAt(tMs) {
    return this.sunDecDeg + this.sunDecAmpDeg * Math.sin((2 * Math.PI * (tMs - this.refMs)) / (346.62 * 86400000));
  }

  sunVec(tMs, out = [0, 0, 0]) {
    const l = this.sunLonDeg(tMs) * DEG;
    const d = this.sunDecAt(tMs) * DEG;
    out[0] = this.sunDistKm * Math.cos(d) * Math.cos(l);
    out[1] = this.sunDistKm * Math.cos(d) * Math.sin(l);
    out[2] = this.sunDistKm * Math.sin(d);
    return out;
  }

  earthVec(tMs, out = [0, 0, 0]) {
    const dt = tMs - this.refMs;
    const l = this.earthLibLonDeg * DEG * Math.sin((2 * Math.PI * dt) / (27.55 * 86400000));
    const b = this.earthLibLatDeg * DEG * Math.sin((2 * Math.PI * dt) / (27.21 * 86400000));
    out[0] = 384400 * Math.cos(b) * Math.cos(l);
    out[1] = 384400 * Math.cos(b) * Math.sin(l);
    out[2] = 384400 * Math.sin(b);
    return out;
  }

  moonDirEarthFixed(tMs, out = [0, 0, 0]) {
    const dt = tMs - this.refMs;
    const ra = (2 * Math.PI * dt) / (27.321661 * 86400000);
    const dec = 20 * DEG * Math.sin(ra);
    const gst = (2 * Math.PI * dt) / 86164090.5;
    out[0] = Math.cos(dec) * Math.cos(ra - gst);
    out[1] = Math.cos(dec) * Math.sin(ra - gst);
    out[2] = Math.sin(dec);
    return out;
  }

  moonVecEarthFixed(tMs, out = [0, 0, 0]) {
    this.moonDirEarthFixed(tMs, out);
    out[0] *= 384400;
    out[1] *= 384400;
    out[2] *= 384400;
    return out;
  }
}

export function fakeStationElevation(station, m) {
  const f = station.lat * DEG;
  const l = station.lon * DEG;
  const n = Math.hypot(m[0], m[1], m[2]);
  const s = (Math.cos(f) * Math.cos(l) * m[0] + Math.cos(f) * Math.sin(l) * m[1] + Math.sin(f) * m[2]) / n;
  return Math.asin(Math.max(-1, Math.min(1, s))) / DEG;
}

export const FAKE_STATIONS = [
  { id: 'gds', name: 'Goldstone', network: 'NASA DSN', lat: 35.43, lon: -116.89, min_elevation_deg: 10 },
  { id: 'mdscc', name: 'Madrid', network: 'NASA DSN', lat: 40.43, lon: -4.25, min_elevation_deg: 10 },
  { id: 'cdscc', name: 'Canberra', network: 'NASA DSN', lat: -35.4, lon: 148.98, min_elevation_deg: 10 },
];

export class ArrayHorizon {
  constructor(elev, azStepDeg = 360 / elev.length, observerHeightM = 2) {
    this.elev = Float32Array.from(elev);
    this.azStepDeg = azStepDeg;
    this.observerHeightM = observerHeightM;
  }

  elevationAt(azDeg) {
    const n = this.elev.length;
    const x = ((((azDeg % 360) + 360) % 360) / this.azStepDeg) % n;
    const i = Math.floor(x);
    const f = x - i;
    return this.elev[i] * (1 - f) + this.elev[(i + 1) % n] * f;
  }
}

export class FunctionHorizon {
  constructor(fn, azStepDeg = 0.05) {
    this.fn = fn;
    this.azStepDeg = azStepDeg;
  }

  elevationAt(azDeg) {
    return this.fn((((azDeg % 360) + 360) % 360));
  }
}

export const flatHorizon = (h = 0) => new ArrayHorizon(new Array(360).fill(h), 1);

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function roughHorizon(seed = 1, base = -0.5, amp = 1.5) {
  const r = rng(seed);
  const n = 720;
  const elev = new Array(n);
  const phase = r() * 2 * Math.PI;
  for (let i = 0; i < n; i++) elev[i] = base + 0.5 * amp * Math.sin((i / n) * 6 * Math.PI + phase);
  for (let p = 0; p < 12; p++) {
    const c = Math.floor(r() * n);
    const h = amp * r();
    for (let k = -3; k <= 3; k++) elev[(c + k + n) % n] += h * (1 - Math.abs(k) / 4);
  }
  return new ArrayHorizon(elev, 0.5);
}

export function makeFixture({ lat = 0, lon = 0, horizon = flatHorizon(0), stations = [], heightM = 2, ...ephOpts } = {}) {
  const eph = new FakeEphemeris(ephOpts);
  const stationFrame = (st) => ({ lat: st.lat, lon: st.lon });
  const env = { eph, stations, stationElevation: fakeStationElevation, stationFrame, sunRadiusKm: SUN_RADIUS_KM, earthRadiusKm: EARTH_RADIUS_KM };
  const frame = fakeSiteFrame(lat, lon, heightM);
  const ctx = { site: { lat, lon }, frame, horizon, horizonSource: 'precomputed', terrainHeightM: 0, observerHeightM: heightM, warnings: [] };
  return { eph, env, frame, ctx };
}

export function topo(frame, v) {
  const d = [v[0] - frame.pos[0], v[1] - frame.pos[1], v[2] - frame.pos[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const dist = Math.sqrt(dot(d, d));
  let az = Math.atan2(dot(d, frame.east), dot(d, frame.north)) / DEG;
  if (az < 0) az += 360;
  return { az, el: Math.asin(dot(d, frame.up) / dist) / DEG, dist };
}

export function bisectRoot(fn, a, b, tol = 1) {
  let fa = fn(a);
  let lo = a;
  let hi = b;
  while (hi - lo > tol) {
    const m = 0.5 * (lo + hi);
    const fm = fn(m);
    if (Math.sign(fm) === Math.sign(fa)) {
      lo = m;
      fa = fm;
    } else hi = m;
  }
  return 0.5 * (lo + hi);
}
