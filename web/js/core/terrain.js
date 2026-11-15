const R_M = 1737400;
const H_MAX_M = 11000;
const STEP_FRACTION = 0.5;
const POLAR_TIER_MIN_ABS_LAT = 60;
const DEG = Math.PI / 180;

export class Horizon {
  #elev;

  constructor({ lat, lon, terrainHeightM, observerHeightM, azStepDeg, elev, source, maxRangeKm }) {
    const n = Math.round(360 / azStepDeg);
    if (!(azStepDeg > 0) || Math.abs(n * azStepDeg - 360) > 1e-9 || elev.length !== n) {
      throw new RangeError(`Horizon: elev must have 360/azStepDeg entries (got ${elev.length} for step ${azStepDeg})`);
    }
    this.#elev = Float32Array.from(elev);
    Object.defineProperties(this, {
      lat: { value: lat, enumerable: true },
      lon: { value: lon, enumerable: true },
      terrainHeightM: { value: terrainHeightM, enumerable: true },
      observerHeightM: { value: observerHeightM, enumerable: true },
      azStepDeg: { value: azStepDeg, enumerable: true },
      source: { value: source, enumerable: true },
      maxRangeKm: { value: maxRangeKm, enumerable: true },
    });
    Object.freeze(this);
  }

  get elev() {
    return this.#elev.slice();
  }

  get length() {
    return this.#elev.length;
  }

  elevationAt(azDeg) {
    const e = this.#elev;
    const n = e.length;
    let x = (azDeg % 360) / this.azStepDeg;
    if (x < 0) x += n;
    const i0 = Math.floor(x);
    const f = x - i0;
    const a = e[i0 % n];
    const b = e[(i0 + 1) % n];
    return a + (b - a) * f;
  }

  static fromJSON(obj) {
    return new Horizon({
      lat: obj.lat,
      lon: obj.lon,
      terrainHeightM: obj.terrain_height_m ?? obj.terrainHeightM,
      observerHeightM: obj.observer_height_m ?? obj.observerHeightM,
      azStepDeg: obj.az_step_deg ?? obj.azStepDeg,
      elev: obj.elev_deg ?? obj.elev,
      source: obj.source,
      maxRangeKm: obj.max_range_km ?? obj.maxRangeKm,
    });
  }

  toJSON() {
    return {
      format: 'lunarnav-horizon-1',
      site_id: null,
      lat: this.lat,
      lon: this.lon,
      terrain_height_m: this.terrainHeightM,
      observer_height_m: this.observerHeightM,
      az_step_deg: this.azStepDeg,
      elev_deg: Array.from(this.#elev, (v) => Math.round(v * 100) / 100),
      max_range_km: this.maxRangeKm,
      source: this.source,
    };
  }
}

class Grid {
  constructor(key, hdr, data) {
    this.key = key;
    this.hdr = hdr;
    this.data = data;
    this.w = hdr.width;
    this.h = hdr.height;
    this.nodata = hdr.nodata ?? null;
    this.polar = hdr.projection === 'polar_stereo';
    this.south = hdr.pole === 'S';
    this.ppd = hdr.ppd ?? 0;
    this.mpp = hdr.m_per_px ?? 0;
    this.x0 = hdr.x0_m ?? 0;
    this.y0 = hdr.y0_m ?? 0;
    this.radius = hdr.radius_m;
    this.wrap = !this.polar && Math.abs(this.w / this.ppd - 360) < 1e-9;
    this.resM = this.polar ? this.mpp : (this.radius * Math.PI) / 180 / this.ppd;
    this.step = STEP_FRACTION * this.resM;
    Object.freeze(this);
  }

  sample(px, py, pz) {
    const w = this.w;
    const h = this.h;
    let row;
    let col;
    if (!this.polar) {
      const lat = Math.asin(Math.min(1, Math.max(-1, pz))) / DEG;
      const lon = Math.atan2(py, px) / DEG;
      row = (90 - lat) * this.ppd - 0.5;
      let dl = (lon + 180) % 360;
      if (dl < 0) dl += 360;
      col = dl * this.ppd - 0.5;
      if (row < 0) row = 0;
      else if (row > h - 1) row = h - 1;
      if (!this.wrap && !(col >= 0 && col <= w - 1)) return NaN;
    } else {
      let x;
      let y;
      if (this.south) {
        const k = (2 * this.radius) / (1 - pz);
        x = k * py;
        y = k * px;
      } else {
        const k = (2 * this.radius) / (1 + pz);
        x = k * py;
        y = -k * px;
      }
      row = (this.y0 - y) / this.mpp;
      col = (x - this.x0) / this.mpp;
      if (!(row >= 0 && row <= h - 1 && col >= 0 && col <= w - 1)) return NaN;
    }
    let r0 = Math.floor(row);
    if (r0 > h - 2) r0 = h - 2;
    const fr = row - r0;
    const c0f = Math.floor(col);
    let fc = col - c0f;
    let c0 = c0f;
    let c1;
    if (this.wrap) {
      c0 = ((c0 % w) + w) % w;
      c1 = (c0 + 1) % w;
    } else {
      if (c0 > w - 2) {
        c0 = w - 2;
        fc = col - c0;
      }
      c1 = c0 + 1;
    }
    const d = this.data;
    const i0 = r0 * w;
    const i1 = i0 + w;
    const v00 = d[i0 + c0];
    const v01 = d[i0 + c1];
    const v10 = d[i1 + c0];
    const v11 = d[i1 + c1];
    const nd = this.nodata;
    if (nd !== null && (v00 === nd || v01 === nd || v10 === nd || v11 === nd)) return NaN;
    return (v00 * (1 - fc) + v01 * fc) * (1 - fr) + (v10 * (1 - fc) + v11 * fc) * fr;
  }
}

function unitVector(latDeg, lonDeg) {
  const p = latDeg * DEG;
  const l = lonDeg * DEG;
  return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
}

export class Terrain {
  #loader;
  #headers;
  #grids = new Map();

  constructor(loader, headers) {
    this.#loader = loader;
    this.#headers = headers;
  }

  static async load(loader) {
    const headers = {};
    for (const key of ['global', 'south', 'north']) {
      try {
        headers[key] = await loader(`dem/${key}.json`, 'json');
      } catch (e) {
        if (!(e && e.notFound) || key === 'global') throw e;
      }
    }
    return new Terrain(loader, headers);
  }

  get headers() {
    return this.#headers;
  }

  #grid(key) {
    let g = this.#grids.get(key);
    if (!g) {
      const hdr = this.#headers[key];
      g = this.#loader(`dem/${hdr.file}`, 'gz').then((buf) => {
        const data = new Int16Array(buf);
        if (data.length !== hdr.width * hdr.height) {
          throw new Error(`dem/${hdr.file}: expected ${hdr.width * hdr.height} samples, got ${data.length}`);
        }
        return new Grid(key, hdr, data);
      });
      g.catch(() => this.#grids.delete(key));
      this.#grids.set(key, g);
    }
    return g;
  }

  #polarKey(latDeg) {
    if (Math.abs(latDeg) < POLAR_TIER_MIN_ABS_LAT) return null;
    const key = latDeg < 0 ? 'south' : 'north';
    return this.#headers[key] ? key : null;
  }

  #polarSuffices(key, latDeg, lonDeg, rangeM) {
    const hdr = this.#headers[key];
    const colat = (90 - Math.abs(latDeg)) * DEG;
    const reach = rangeM / R_M;
    const scale = 1 / Math.cos((colat + reach) / 2) ** 2;
    const r = 2 * hdr.radius_m * Math.tan(colat / 2);
    const x = r * Math.sin(lonDeg * DEG);
    const y = (key === 'south' ? 1 : -1) * r * Math.cos(lonDeg * DEG);
    const half = ((hdr.width - 1) * hdr.m_per_px) / 2 - hdr.m_per_px;
    const m = rangeM * scale * 1.01;
    return Math.abs(x) + m <= half && Math.abs(y) + m <= half;
  }

  async #tiers(latDeg, lonDeg, rangeM) {
    const polar = this.#polarKey(latDeg);
    const keys = [];
    if (polar) keys.push(polar);
    if (!polar || !this.#polarSuffices(polar, latDeg, lonDeg, rangeM)) keys.push('global');
    return Promise.all(keys.map((k) => this.#grid(k)));
  }

  async heightAt(latDeg, lonDeg) {
    const tiers = await this.#tiers(latDeg, lonDeg, 0);
    const [px, py, pz] = unitVector(latDeg, lonDeg);
    for (const g of tiers) {
      const v = g.sample(px, py, pz);
      if (v === v) return v;
    }
    return NaN;
  }

  async computeHorizon(latDeg, lonDeg, { observerHeightM = 2, azStepDeg = 1, maxRangeKm = 300 } = {}) {
    const nAz = Math.round(360 / azStepDeg);
    if (!(azStepDeg > 0) || Math.abs(nAz * azStepDeg - 360) > 1e-9) {
      throw new RangeError('360 must be an integer multiple of azStepDeg');
    }
    const lon = ((((lonDeg + 180) % 360) + 360) % 360) - 180;
    const maxRange = maxRangeKm * 1000;
    const tiers = await this.#tiers(latDeg, lon, maxRange);
    const nT = tiers.length;

    const phi = latDeg * DEG;
    const lam = lon * DEG;
    const sp = Math.sin(phi);
    const cp = Math.cos(phi);
    const sl = Math.sin(lam);
    const cl = Math.cos(lam);
    const ux = cp * cl;
    const uy = cp * sl;
    const uz = sp;
    const nx = -sp * cl;
    const ny = -sp * sl;
    const nz = cp;
    const ex = -sl;
    const ey = cl;

    let hSite = NaN;
    let kSite = -1;
    for (let k = 0; k < nT; k++) {
      const v = tiers[k].sample(ux, uy, uz);
      if (v === v) {
        hSite = v;
        kSite = k;
        break;
      }
    }
    if (kSite < 0) throw new RangeError(`No elevation data at lat=${latDeg}, lon=${lonDeg}`);
    const rObs = R_M + hSite + observerHeightM;
    const rMax = R_M + H_MAX_M;
    const d0 = tiers[kSite].step;
    const lastStep = tiers[nT - 1].step;

    const elev = new Float32Array(nAz);
    const used = new Array(nT).fill(0);
    let reachMax = 0;
    for (let i = 0; i < nAz; i++) {
      const a = i * azStepDeg * DEG;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const tx = ca * nx + sa * ex;
      const ty = ca * ny + sa * ey;
      const tz = ca * nz;
      let best = -1e300;
      let d = d0;
      let last = d0;
      while (d <= maxRange) {
        const th = d / R_M;
        const ct = Math.cos(th);
        const st = Math.sin(th);
        if (rMax * ct - rObs <= best * rMax * st) break;
        const px = ct * ux + st * tx;
        const py = ct * uy + st * ty;
        const pz = ct * uz + st * tz;
        let step = lastStep;
        for (let k = 0; k < nT; k++) {
          const v = tiers[k].sample(px, py, pz);
          if (v === v) {
            const r = R_M + v;
            const t = (r * ct - rObs) / (r * st);
            if (t > best) best = t;
            used[k]++;
            step = tiers[k].step;
            break;
          }
        }
        last = d;
        d += step;
      }
      elev[i] = Math.atan(best) / DEG;
      if (last > reachMax) reachMax = last;
    }
    const source =
      'LOLA ' +
      tiers
        .filter((_, k) => used[k] > 0)
        .map((g) => `web ${g.key} ${Math.round(g.resM)} m/px`)
        .join(' + ');
    return new Horizon({
      lat: latDeg,
      lon,
      terrainHeightM: hSite,
      observerHeightM,
      azStepDeg,
      elev,
      source,
      maxRangeKm: reachMax / 1000,
    });
  }

  async precomputedHorizon(siteId) {
    try {
      return Horizon.fromJSON(await this.#loader(`horizons/${siteId}.json`, 'json'));
    } catch (e) {
      if (e && e.notFound) return null;
      throw e;
    }
  }
}
