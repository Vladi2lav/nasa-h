export const DASH = '—';
const MINUS = '−';
const HOUR_MS = 3600000;
export const LUNAR_DAY_DAYS = 29.530589;

const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const pad2 = (n) => String(n).padStart(2, '0');

export function num(x, digits = 1) {
  if (!finite(x)) return DASH;
  let s = x.toFixed(digits);
  if (/^-0(\.0+)?$/.test(s)) s = s.slice(1);
  return s.startsWith('-') ? MINUS + s.slice(1) : s;
}

export function int(x) {
  if (!finite(x)) return DASH;
  const s = Math.round(Math.abs(x)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return (x < -0.5 ? MINUS : '') + s;
}

export function utc(ms, { seconds = false, suffix = true } = {}) {
  if (!finite(ms)) return DASH;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return DASH;
  let s = `${utcDate(ms)} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  if (seconds) s += `:${pad2(d.getUTCSeconds())}`;
  return suffix ? `${s} UTC` : s;
}

export function utcDate(ms) {
  if (!finite(ms)) return DASH;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return DASH;
  return d.toISOString().slice(0, 10);
}

export function utcInputValue(ms) {
  if (!finite(ms)) return '';
  return new Date(ms).toISOString().slice(0, 16);
}

export function parseUtcInput(str) {
  if (typeof str !== 'string') return NaN;
  const s = str.trim().replace(/\s*(UTC|Z|GMT)$/i, '');
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/.exec(s);
  if (!m) return NaN;
  const [y, mo, d, h = '0', mi = '0', se = '0'] = m.slice(1);
  const Y = Number(y), M = Number(mo), D = Number(d), H = Number(h), Mi = Number(mi), S = Number(se);
  if (M < 1 || M > 12 || D < 1 || D > 31 || H > 23 || Mi > 59 || S > 59) return NaN;
  const ms = Date.UTC(Y, M - 1, D, H, Mi, S);
  if (new Date(ms).getUTCDate() !== D) return NaN;
  return ms;
}

export function duration(hours) {
  if (!finite(hours)) return DASH;
  if (hours < 0) return MINUS + duration(-hours);
  const totalMin = Math.round(hours * 60);
  if (totalMin < 1) return hours > 0 ? '< 1 min' : '0 min';
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d >= 1) {
    let hh = Math.round((totalMin - d * 1440) / 60);
    let dd = d;
    if (hh === 24) { dd += 1; hh = 0; }
    return hh ? `${dd} d ${hh} h` : `${dd} d`;
  }
  if (h >= 1) return m ? `${h} h ${m} min` : `${h} h`;
  return `${m} min`;
}

export function durationMs(ms) {
  return finite(ms) ? duration(ms / HOUR_MS) : DASH;
}

export function countdown(hours) {
  if (!finite(hours)) return DASH;
  if (hours <= 1 / 120) return 'now';
  return `in ${duration(hours)}`;
}

export function deg(x, digits = 1) {
  return finite(x) ? `${num(x, digits)}°` : DASH;
}

export function signedDeg(x, digits = 1) {
  if (!finite(x)) return DASH;
  const s = num(x, digits);
  return (x > 0 && !/^0(\.0+)?$/.test(s) ? '+' : '') + s + '°';
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export function compass(azDeg) {
  if (!finite(azDeg)) return '';
  const a = ((azDeg % 360) + 360) % 360;
  return COMPASS[Math.round(a / 22.5) % 16];
}

export function az(azDeg, digits = 1) {
  if (!finite(azDeg)) return DASH;
  const a = ((azDeg % 360) + 360) % 360;
  return `${num(a, digits)}° ${compass(a)}`;
}

export function latlon(lat, lon, digits = 3) {
  if (!finite(lat) || !finite(lon)) return DASH;
  const L = normalizeLon(lon);
  const ns = lat < 0 ? 'S' : 'N';
  const ew = L < 0 ? 'W' : 'E';
  return `${Math.abs(lat).toFixed(digits)}° ${ns}, ${Math.abs(L).toFixed(digits)}° ${ew}`;
}

export function pct(fraction, digits = 0) {
  if (!finite(fraction)) return DASH;
  return `${num(fraction * 100, digits)}%`;
}

export function energy(whm2) {
  if (!finite(whm2)) return DASH;
  if (Math.abs(whm2) < 10000) return `${int(whm2)} Wh/m²`;
  return `${int(whm2 / 1000)} kWh/m²`;
}

export function km(x) {
  return finite(x) ? `${int(x)} km` : DASH;
}

export function metres(x) {
  if (!finite(x)) return DASH;
  return Math.abs(x) < 10 ? `${num(x, 1)} m` : `${int(x)} m`;
}

export function score(x) {
  return finite(x) ? num(x, 0) : DASH;
}

export function ratio(a, b) {
  if (!finite(a) || !finite(b)) return DASH;
  if (b === 0) return a === 0 ? '1×' : '∞';
  const r = a / b;
  return `${num(r, r >= 10 ? 0 : 1)}×`;
}

export function normalizeLon(lon) {
  if (!finite(lon)) return NaN;
  const l = ((((lon + 180) % 360) + 360) % 360) - 180;
  return l === -180 && lon > 0 ? 180 : l;
}

export function parseLatLon(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('Enter a latitude and longitude, e.g. "-89.45, 222.6" or "89.45S 137.4W".');
  const s = input
    .trim()
    .toUpperCase()
    .replace(/[−–]/g, '-')
    .replace(/\b(LAT(ITUDE)?|LON(GITUDE)?|LNG)\b\s*[:=]?/g, ' ')
    .replace(/[°º]/g, ' ');
  const re = /([NSEW])?\s*([+-]?\d+(?:\.\d+)?)\s*([NSEW])?/g;
  const parts = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    parts.push({ hemiBefore: m[1] || null, value: Number(m[2]), hemiAfter: m[3] || null });
  }
  const leftovers = s.replace(re, ' ').replace(/[\s,;/]+/g, '');
  if (leftovers) throw new Error(`Could not read "${input.trim()}". Use e.g. "-89.45, 222.6" or "89.45S 137.4W".`);
  if (parts.length !== 2) throw new Error('Enter exactly two numbers: latitude and longitude.');
  const [a, b] = parts;
  if (a.hemiBefore && a.hemiAfter && !b.hemiBefore) {
    b.hemiBefore = a.hemiAfter;
    a.hemiAfter = null;
  }
  const hemiA = a.hemiBefore || a.hemiAfter;
  const hemiB = b.hemiBefore || b.hemiAfter;
  let latTok = a, lonTok = b, latHemi = hemiA, lonHemi = hemiB;
  if ((hemiA === 'E' || hemiA === 'W') || (hemiB === 'N' || hemiB === 'S')) {
    latTok = b; lonTok = a; latHemi = hemiB; lonHemi = hemiA;
  }
  if (latHemi && !'NS'.includes(latHemi)) throw new Error('Latitude hemisphere must be N or S.');
  if (lonHemi && !'EW'.includes(lonHemi)) throw new Error('Longitude hemisphere must be E or W.');
  let lat = latTok.value;
  let lon = lonTok.value;
  if (latHemi) {
    if (lat < 0) throw new Error('Use either a minus sign or N/S for latitude, not both.');
    if (latHemi === 'S') lat = -lat;
  }
  if (lonHemi) {
    if (lon < 0) throw new Error('Use either a minus sign or E/W for longitude, not both.');
    if (lonHemi === 'W') lon = -lon;
  }
  if (!(Math.abs(lat) <= 90)) throw new Error(`Latitude ${num(lat, 3)}° is outside −90…90°.`);
  if (!(lon >= -360 && lon <= 360)) throw new Error(`Longitude ${num(lon, 3)}° is outside −180…360°.`);
  return { lat, lon: normalizeLon(lon) };
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function shortName(name, max = 28) {
  const n = String(name || 'Custom site');
  if (n.length <= max) return n;
  const head = n.split(' — ')[0];
  return head.length <= max ? head : n.slice(0, max - 1) + '…';
}

export function roundToHour(ms) {
  return Math.round(ms / HOUR_MS) * HOUR_MS;
}

export function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows) {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export const fmt = {
  num, int, utc, utcDate, utcInputValue, parseUtcInput, duration, durationMs, countdown,
  deg, signedDeg, az, compass, latlon, pct, energy, km, metres, score, ratio,
  normalizeLon, parseLatLon, escapeHtml, shortName, roundToHour, csvCell, toCsv, DASH,
};
export default fmt;
