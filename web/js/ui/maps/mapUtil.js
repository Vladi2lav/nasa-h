export const R_M = 1737400;
export const DEG = Math.PI / 180;
export const POLAR_HALF_WIDTH_M = 2 * R_M * Math.tan(5 * DEG);

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const isSouth = (pole) => pole === 'S' || pole === 'south' || pole === 's';

export function wrapLon(lon) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

export function latLonToEquirect(lat, lon, w, h) {
  return { x: ((wrapLon(lon) + 180) / 360) * w, y: ((90 - lat) / 180) * h };
}

export function equirectToLatLon(x, y, w, h) {
  return { lat: 90 - (y / h) * 180, lon: (x / w) * 360 - 180 };
}

export function latLonToPolar(lat, lon, pole) {
  const south = isSouth(pole);
  const colat = south ? lat + 90 : 90 - lat;
  const r = 2 * R_M * Math.tan((colat * DEG) / 2);
  const l = lon * DEG;
  return { x: r * Math.sin(l), y: (south ? 1 : -1) * r * Math.cos(l) };
}

export function polarToLatLon(x, y, pole) {
  const south = isSouth(pole);
  const r = Math.hypot(x, y);
  const colat = (2 * Math.atan(r / (2 * R_M))) / DEG;
  const lat = south ? colat - 90 : 90 - colat;
  const lon = r === 0 ? 0 : Math.atan2(x, south ? y : -y) / DEG;
  return { lat, lon };
}

export function polarRadius(lat, pole) {
  const colat = isSouth(pole) ? lat + 90 : 90 - lat;
  return 2 * R_M * Math.tan((colat * DEG) / 2);
}

export function latLonToVec(lat, lon) {
  const cl = Math.cos(lat * DEG);
  return [cl * Math.cos(lon * DEG), cl * Math.sin(lon * DEG), Math.sin(lat * DEG)];
}

export function vecToLatLon(v) {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return { lat: Math.asin(clamp(v[2] / n, -1, 1)) / DEG, lon: Math.atan2(v[1], v[0]) / DEG };
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => {
  const n = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};

export function solarElevationDeg(lat, lon, subSolar) {
  return solarElevationFromVec(latLonToVec(lat, lon), latLonToVec(subSolar.lat, subSolar.lon));
}

export function solarElevationFromVec(pointVec, sunVec) {
  return Math.asin(clamp(dot(pointVec, sunVec), -1, 1)) / DEG;
}

export function angularDistanceDeg(a, b) {
  return Math.acos(clamp(dot(latLonToVec(a.lat, a.lon), latLonToVec(b.lat, b.lon)), -1, 1)) / DEG;
}

export function greatCircle(a, b, n = 64) {
  const va = latLonToVec(a.lat, a.lon);
  const vb = latLonToVec(b.lat, b.lon);
  const omega = Math.acos(clamp(dot(va, vb), -1, 1));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    let v;
    if (omega < 1e-9) v = va;
    else {
      const s = Math.sin(omega);
      const wa = Math.sin((1 - t) * omega) / s;
      const wb = Math.sin(t * omega) / s;
      v = [wa * va[0] + wb * vb[0], wa * va[1] + wb * vb[1], wa * va[2] + wb * vb[2]];
    }
    out.push(vecToLatLon(v));
  }
  return out;
}

export function terminator(subSolar, n = 361) {
  const s = latLonToVec(subSolar.lat, subSolar.lon);
  const ref = Math.abs(s[2]) > 0.99 ? [1, 0, 0] : [0, 0, 1];
  const e1 = norm(cross(s, ref));
  const e2 = cross(s, e1);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * 2 * Math.PI;
    const c = Math.cos(t);
    const d = Math.sin(t);
    pts.push(vecToLatLon([c * e1[0] + d * e2[0], c * e1[1] + d * e2[1], c * e1[2] + d * e2[2]]));
  }
  pts.sort((p, q) => p.lon - q.lon);
  return pts;
}

const abs0 = (x, d) => {
  const f = Math.abs(x).toFixed(d);
  return f;
};

export function formatLat(lat, d = 2) {
  const f = abs0(lat, d);
  return `${f}°${Number(f) === 0 ? '' : lat < 0 ? 'S' : 'N'}`;
}

export function formatLon(lon, d = 2) {
  let w = wrapLon(lon);
  if (w === -180) w = 180;
  const f = abs0(w, d);
  return `${f}°${Number(f) === 0 || Number(f) === 180 ? '' : w < 0 ? 'W' : 'E'}`;
}

export function formatLatLon(lat, lon, d = 2) {
  return `${formatLat(lat, d)} ${formatLon(lon, d)}`;
}

export function formatUtc(ms) {
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

export function formatDate(iso) {
  if (!iso) return '';
  return String(iso).slice(0, 10);
}

const TOKEN_NAMES = ['bg', 'surface', 'surface-2', 'surface-3', 'border', 'border-strong', 'text', 'text-2', 'text-3',
  'sun', 'earth', 'both', 'dark', 'good', 'warn', 'bad', 'accent', 'accent-contrast', 'grid'];

export function readTokens() {
  const cs = getComputedStyle(document.documentElement);
  const t = {};
  for (const n of TOKEN_NAMES) t[n] = cs.getPropertyValue('--' + n).trim() || '#888';
  t.font = cs.getPropertyValue('--font').trim() || 'system-ui, sans-serif';
  t.mono = cs.getPropertyValue('--font-mono').trim() || 'monospace';
  return t;
}

export function watchTheme(fn) {
  const mo = new MutationObserver(() => fn());
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
  return () => mo.disconnect();
}

export function prefersReducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export const STATUS_STYLE = {
  landed: { token: 'good', shape: 'circle', label: 'Landed' },
  planned: { token: 'accent', shape: 'diamond', label: 'Planned' },
  candidate: { token: 'warn', shape: 'triangle', label: 'Candidate' },
  failed: { token: 'bad', shape: 'cross', label: 'Failed' },
  feature: { token: 'text-3', shape: 'square', label: 'Feature' },
};
export const statusStyle = (s) => STATUS_STYLE[s] || STATUS_STYLE.feature;

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}

const MAPS_BASE = typeof import.meta !== 'undefined' ? new URL('../../../data/maps/', import.meta.url).href : 'data/maps/';
let mapsPromise = null;

export function loadMapsMeta() {
  if (!mapsPromise) {
    mapsPromise = (async () => {
      try {
        const res = await fetch(MAPS_BASE + 'maps.json', { cache: 'no-cache' });
        if (!res.ok) throw new Error(`maps.json: HTTP ${res.status}`);
        return { base: MAPS_BASE, meta: await res.json(), error: null };
      } catch (e) {
        return { base: MAPS_BASE, meta: null, error: e };
      }
    })();
  }
  return mapsPromise;
}

export function resetMapsMeta() {
  mapsPromise = null;
}

export function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image not available: ' + url));
    img.src = url;
  });
}

function findEntry(meta, name) {
  if (!meta || typeof meta !== 'object') return null;
  for (const bag of [meta, meta.images, meta.maps, meta.basemaps]) {
    if (bag && !Array.isArray(bag) && typeof bag[name] === 'object') return bag[name];
  }
  for (const arr of [meta.images, meta.maps, meta.basemaps, meta.layers, meta.overlays]) {
    if (Array.isArray(arr)) {
      const hit = arr.find((e) => e && (e.id === name || e.name === name || e.key === name || (e.file || '').replace(/\.\w+$/, '') === name));
      if (hit) return hit;
    }
  }
  return null;
}

export function describeBasemap(maps, key) {
  const entry = findEntry(maps.meta, key);
  const polar = key.startsWith('south') || key.startsWith('north');
  const file = (entry && (entry.file || entry.path || entry.url)) || key + '.jpg';
  let extent = null;
  if (polar) {
    let hw = POLAR_HALF_WIDTH_M;
    const e = entry || {};
    if (e.extent && Array.isArray(e.extent.x_m) && Array.isArray(e.extent.y_m)) {
      extent = { xmin: e.extent.x_m[0], xmax: e.extent.x_m[1], ymin: e.extent.y_m[0], ymax: e.extent.y_m[1] };
    } else if (Array.isArray(e.extent_m) && e.extent_m.length === 4) {
      const [a, b, c, d] = e.extent_m;
      extent = { xmin: Math.min(a, b), xmax: Math.max(a, b), ymin: Math.min(c, d), ymax: Math.max(c, d) };
    } else if (e.extent_m && typeof e.extent_m === 'object') {
      const x = e.extent_m;
      extent = { xmin: x.xmin ?? x.x_min ?? -hw, xmax: x.xmax ?? x.x_max ?? hw, ymin: x.ymin ?? x.y_min ?? -hw, ymax: x.ymax ?? x.y_max ?? hw };
    } else if (e.x0_m != null && e.m_per_px != null && e.width) {
      const w = e.width * e.m_per_px;
      const h = (e.height || e.width) * e.m_per_px;
      extent = { xmin: e.x0_m, xmax: e.x0_m + w, ymax: e.y0_m, ymin: e.y0_m - h };
    } else {
      hw = e.half_width_m ?? e.halfwidth_m ?? e.half_width ?? hw;
      extent = { xmin: -hw, xmax: hw, ymin: -hw, ymax: hw };
    }
  }
  return {
    key,
    url: MAPS_BASE + file,
    projection: polar ? 'polar' : 'equirect',
    extent,
    credit: (entry && (entry.credit || entry.credits || entry.attribution)) || '',
    entry,
  };
}

export function createSubTracker(app, onChange) {
  const tracker = { sub: null, error: null, destroy() {} };
  let token = 0;
  async function update() {
    const my = ++token;
    const tMs = app.store.get().timeMs;
    try {
      await app.nav.ensure(tMs);
      if (my !== token) return;
      tracker.sub = app.nav.subPoints(tMs);
      tracker.error = null;
    } catch (e) {
      if (my !== token) return;
      tracker.sub = null;
      tracker.error = e;
    }
    onChange(tracker);
  }
  const unsub = app.store.subscribe(update, ['timeMs']);
  update();
  tracker.destroy = () => {
    token++;
    unsub();
  };
  return tracker;
}

export function scenarioPoint(sc) {
  return sc && sc.site && Number.isFinite(sc.site.lat) ? { lat: sc.site.lat, lon: sc.site.lon } : null;
}
