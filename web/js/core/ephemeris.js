const FORMAT = 'lunarnav-ephem-1';
const NFIELDS = 9;
const F_SUN = 0, F_EARTH = 3, F_MEF = 6;
const UNIX_J2000_UTC_S = 946728000;
const TT_MINUS_TAI_S = 32.184;

const LEAP_TABLE = [
  [1972, 1, 10], [1972, 7, 11], [1973, 1, 12], [1974, 1, 13], [1975, 1, 14], [1976, 1, 15],
  [1977, 1, 16], [1978, 1, 17], [1979, 1, 18], [1980, 1, 19], [1981, 7, 20], [1982, 7, 21],
  [1983, 7, 22], [1985, 7, 23], [1988, 1, 24], [1990, 1, 25], [1991, 1, 26], [1992, 7, 27],
  [1993, 7, 28], [1994, 7, 29], [1996, 1, 30], [1997, 7, 31], [1999, 1, 32], [2006, 1, 33],
  [2009, 1, 34], [2012, 7, 35], [2015, 7, 36], [2017, 1, 37],
];
const LEAP_MS = Float64Array.from(LEAP_TABLE, ([y, m]) => Date.UTC(y, m - 1, 1));
const LEAP_VAL = Float64Array.from(LEAP_TABLE, (r) => r[2]);
const LAST_LEAP_MS = LEAP_MS[LEAP_MS.length - 1];
const PRE_1972_TAI_MINUS_UTC = 9;

export function taiMinusUtc(tMs) {
  if (tMs >= LAST_LEAP_MS) return LEAP_VAL[LEAP_VAL.length - 1];
  for (let i = LEAP_MS.length - 2; i >= 0; i--) if (tMs >= LEAP_MS[i]) return LEAP_VAL[i];
  return PRE_1972_TAI_MINUS_UTC;
}

export function utcMsToEt(tMs) {
  return tMs / 1000 - UNIX_J2000_UTC_S + TT_MINUS_TAI_S + taiMinusUtc(tMs);
}

export class Ephemeris {
  constructor(index, loader) {
    if (index.format !== FORMAT) throw new Error(`Unsupported ephemeris format: ${index.format}`);
    if (index.fields.length !== NFIELDS || index.pad < 2) throw new Error('Unexpected ephemeris layout');
    this.index = index;
    this._loader = loader;
    this._t0 = index.t0_et;
    this._step = index.step_s;
    this._len = index.chunk_len;
    this._pad = index.pad;
    this._first = index.first_chunk;
    this._last = index.last_chunk;
    this._chunks = new Array(this._last - this._first + 1).fill(null);
    this._pending = new Map();
    this._range = {
      startMs: Date.parse(`${index.coverage_utc[0]}T00:00:00Z`),
      endMs: Date.parse(`${index.coverage_utc[1]}T00:00:00Z`),
    };
  }

  static async load(loader) {
    return new Ephemeris(await loader('ephem/index.json', 'json'), loader);
  }

  get range() {
    return { startMs: this._range.startMs, endMs: this._range.endMs };
  }

  _chunkOf(tMs) {
    const k = Math.floor((utcMsToEt(tMs) - this._t0) / this._step);
    return Math.floor(k / this._len);
  }

  async ensure(t0Ms, t1Ms = t0Ms) {
    const { startMs, endMs } = this._range;
    if (!(t0Ms >= startMs && t1Ms <= endMs && t0Ms <= t1Ms)) {
      throw new RangeError(`Ephemeris covers ${new Date(startMs).toISOString()} .. ` +
        `${new Date(endMs).toISOString()}; requested ${new Date(t0Ms).toISOString()} .. ` +
        `${new Date(t1Ms).toISOString()}`);
    }
    const k0 = Math.max(this._first, this._chunkOf(t0Ms));
    const k1 = Math.min(this._last, this._chunkOf(t1Ms));
    const jobs = [];
    for (let K = k0; K <= k1; K++) if (!this._chunks[K - this._first]) jobs.push(this._loadChunk(K));
    await Promise.all(jobs);
  }

  _loadChunk(K) {
    let p = this._pending.get(K);
    if (!p) {
      p = this._loader(`ephem/c${K}.bin`, 'bin').then((buf) => {
        const arr = new Float32Array(buf);
        if (arr.length !== (this._len + 2 * this._pad) * NFIELDS) {
          throw new Error(`ephem/c${K}.bin has unexpected size`);
        }
        this._chunks[K - this._first] = arr;
        this._pending.delete(K);
      }, (err) => { this._pending.delete(K); throw err; });
      this._pending.set(K, p);
    }
    return p;
  }

  _interp(tMs, field, out, o) {
    const x = (utcMsToEt(tMs) - this._t0) / this._step;
    const k = Math.floor(x);
    const s = x - k;
    const K = Math.floor(k / this._len);
    const data = this._chunks[K - this._first];
    if (!data) {
      if (tMs >= this._range.startMs && tMs <= this._range.endMs) {
        throw new Error(`Ephemeris data for ${new Date(tMs).toISOString()} not loaded; await ensure() first`);
      }
      throw new RangeError(`${new Date(tMs).toISOString()} is outside the ephemeris coverage`);
    }
    const sm1 = s - 1, sm2 = s - 2, sp1 = s + 1;
    const w0 = -s * sm1 * sm2 / 6;
    const w1 = sp1 * sm1 * sm2 / 2;
    const w2 = -sp1 * s * sm2 / 2;
    const w3 = sp1 * s * sm1 / 6;
    let b = (k - K * this._len + this._pad - 1) * NFIELDS + field;
    for (let c = 0; c < 3; c++, b++) {
      out[o + c] = w0 * data[b] + w1 * data[b + NFIELDS] + w2 * data[b + 2 * NFIELDS] +
        w3 * data[b + 3 * NFIELDS];
    }
    return out;
  }

  sunVec(tMs, out = new Float64Array(3)) {
    return this._interp(tMs, F_SUN, out, 0);
  }

  earthVec(tMs, out = new Float64Array(3)) {
    return this._interp(tMs, F_EARTH, out, 0);
  }

  moonDirEarthFixed(tMs, out = new Float64Array(3)) {
    this._interp(tMs, F_MEF, out, 0);
    const n = Math.hypot(out[0], out[1], out[2]);
    out[0] /= n; out[1] /= n; out[2] /= n;
    return out;
  }

  moonVecEarthFixed(tMs, out = new Float64Array(3)) {
    const e = this._interp(tMs, F_EARTH, SCRATCH, 0);
    const d = Math.hypot(e[0], e[1], e[2]);
    this.moonDirEarthFixed(tMs, out);
    out[0] *= d; out[1] *= d; out[2] *= d;
    return out;
  }
}

const SCRATCH = new Float64Array(3);

export async function sampleVectors(eph, t0Ms, stepMs, n) {
  await eph.ensure(t0Ms, t0Ms + (n - 1) * stepMs);
  const tMs = new Float64Array(n);
  const sun = new Float64Array(3 * n), earth = new Float64Array(3 * n), mef = new Float64Array(3 * n);
  for (let i = 0, o = 0; i < n; i++, o += 3) {
    const t = t0Ms + i * stepMs;
    tMs[i] = t;
    eph._interp(t, F_SUN, sun, o);
    eph._interp(t, F_EARTH, earth, o);
    eph._interp(t, F_MEF, mef, o);
    const m = Math.hypot(mef[o], mef[o + 1], mef[o + 2]);
    mef[o] /= m; mef[o + 1] /= m; mef[o + 2] /= m;
  }
  return { tMs, sun, earth, mef };
}
