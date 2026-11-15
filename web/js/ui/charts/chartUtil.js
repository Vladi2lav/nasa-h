export const HOUR_MS = 3600000;
export const DAY_MS = 86400000;
export const LUNAR_DAY_MS = 29.530589 * DAY_MS;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

export function linearScale(d0, d1, r0, r1) {
  const k = (r1 - r0) / (d1 - d0 || 1);
  const f = (v) => r0 + (v - d0) * k;
  f.invert = (p) => d0 + (p - r0) / k;
  f.domain = [d0, d1];
  f.range = [r0, r1];
  f.k = k;
  return f;
}

export function niceStep(span, maxTicks = 5) {
  const raw = Math.abs(span) / Math.max(1, maxTicks);
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return m * mag;
}

export function ticks(d0, d1, maxTicks = 5, step = niceStep(d1 - d0, maxTicks)) {
  const lo = Math.min(d0, d1);
  const hi = Math.max(d0, d1);
  const out = [];
  const k0 = Math.ceil(lo / step - 1e-9);
  const k1 = Math.floor(hi / step + 1e-9);
  for (let k = k0; k <= k1 && out.length < 1000; k++) out.push(Number((k * step).toFixed(10)) || 0);
  return out;
}

export function niceDomain(lo, hi, maxTicks = 5) {
  if (!(hi > lo)) {
    lo -= 1;
    hi += 1;
  }
  const step = niceStep(hi - lo, maxTicks);
  return [Math.floor(lo / step + 1e-9) * step, Math.ceil(hi / step - 1e-9) * step];
}

export function degStep(spanDeg, px, minPx = 28) {
  const ladder = [0.5, 1, 2, 5, 10, 15, 30, 45, 90];
  for (const s of ladder) if ((s / spanDeg) * px >= minPx) return s;
  return 90;
}

const pad2 = (n) => String(n).padStart(2, '0');

export function fmtUtc(ms, { seconds = false, suffix = true } = {}) {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const s = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}${seconds ? ':' + pad2(d.getUTCSeconds()) : ''}`;
  return suffix ? s + ' UTC' : s;
}

export function fmtDate(ms) {
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toISOString().slice(0, 10);
}

export function fmtShortDate(ms) {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export const monthName = (m0) => MONTHS[m0];

export function fmtDuration(hours) {
  if (hours == null || !Number.isFinite(hours)) return '—';
  const totalMin = Math.round(Math.abs(hours) * 60);
  if (totalMin < 1) return '< 1 min';
  if (totalMin < 60) return `${totalMin} min`;
  const totalH = Math.round(totalMin / 60);
  if (totalMin >= 1440) {
    const d = Math.floor(totalH / 24);
    const h = totalH - d * 24;
    return h ? `${d} d ${h} h` : `${d} d`;
  }
  const h = Math.floor(totalMin / 60);
  const m = totalMin - h * 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function fmtDeg(x, digits = 1, signed = false) {
  if (x == null || !Number.isFinite(x)) return '—';
  const v = Math.abs(x) < 0.5 * 10 ** -digits ? 0 : x;
  const s = Math.abs(v).toFixed(digits);
  const sign = v < 0 ? '−' : signed && v > 0 ? '+' : '';
  return `${sign}${s}°`;
}

export const fmtPercent = (fraction, digits = 0) =>
  fraction == null || !Number.isFinite(fraction) ? '—' : `${(fraction * 100).toFixed(digits)}%`;

export function timeTicks(t0Ms, t1Ms, maxTicks = 6) {
  const span = t1Ms - t0Ms;
  if (!(span > 0)) return [];
  const fixed = [1, 2, 3, 6, 12].map((h) => h * HOUR_MS).concat([1, 2, 5, 7, 14].map((d) => d * DAY_MS));
  const step = fixed.find((s) => span / s <= maxTicks);
  const out = [];
  if (step) {
    for (let t = Math.ceil(t0Ms / step) * step; t <= t1Ms; t += step) {
      const d = new Date(t);
      const midnight = d.getUTCHours() === 0 && d.getUTCMinutes() === 0;
      if (step < DAY_MS) {
        out.push({ tMs: t, label: midnight ? fmtShortDate(t) : `${pad2(d.getUTCHours())}:00`, major: midnight });
      } else {
        out.push({ tMs: t, label: fmtShortDate(t), major: d.getUTCDate() === 1 });
      }
    }
    return out;
  }
  const monthsSpan = span / (30.44 * DAY_MS);
  const mStep = [1, 2, 3, 6, 12].find((m) => monthsSpan / m <= maxTicks) || Math.ceil(monthsSpan / maxTicks / 12) * 12;
  const d0 = new Date(t0Ms);
  let y = d0.getUTCFullYear();
  let m = Math.ceil((d0.getUTCMonth() + (Date.UTC(y, d0.getUTCMonth(), 1) < t0Ms ? 1 : 0)) / mStep) * mStep;
  for (let guard = 0; guard < 500; guard++) {
    const t = Date.UTC(y, m, 1);
    if (t > t1Ms) break;
    if (t >= t0Ms) {
      const dt = new Date(t);
      const jan = dt.getUTCMonth() === 0;
      out.push({ tMs: t, label: jan ? String(dt.getUTCFullYear()) : MONTHS[dt.getUTCMonth()], major: jan });
    }
    m += mStep;
  }
  return out;
}

export function intervalsToPixels(intervals, scale, xMin, xMax, minW = 1) {
  const out = [];
  for (const iv of intervals || []) {
    let a = scale(iv.startMs);
    let b = scale(iv.endMs);
    if (b < a) [a, b] = [b, a];
    if (b < xMin || a > xMax) continue;
    a = Math.max(a, xMin);
    b = Math.min(b, xMax);
    if (b - a < minW) {
      const c = (a + b) / 2;
      a = Math.max(xMin, c - minW / 2);
      b = Math.min(xMax, a + minW);
    }
    const last = out[out.length - 1];
    if (last && a <= last.x + last.w) last.w = Math.max(last.w, b - last.x);
    else out.push({ x: a, w: b - a });
  }
  return out;
}

export function sampleIndex(t0Ms, stepS, n, tMs) {
  return clamp(Math.round((tMs - t0Ms) / (stepS * 1000)), 0, Math.max(0, n - 1));
}

export function interpAt(arr, t0Ms, stepS, tMs) {
  const x = (tMs - t0Ms) / (stepS * 1000);
  if (!(x >= 0) || x > arr.length - 1) return NaN;
  const i = Math.min(Math.floor(x), arr.length - 2);
  if (i < 0) return arr[0];
  const f = x - i;
  return arr[i] + (arr[i + 1] - arr[i]) * f;
}

export function runs(arr) {
  const out = [];
  let start = -1;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] && start < 0) start = i;
    else if (!arr[i] && start >= 0) {
      out.push({ i0: start, i1: i - 1 });
      start = -1;
    }
  }
  if (start >= 0) out.push({ i0: start, i1: arr.length - 1 });
  return out;
}

export const wrap360 = (a) => ((a % 360) + 360) % 360;
export const wrap180 = (a) => wrap360(a + 180) - 180;
const CARD16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const cardinal = (az) => CARD16[Math.round(wrap360(az) / 22.5) % 16];

export function parseColor(str) {
  const s = String(str || '').trim();
  let m = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (p.length < 3 || p.slice(0, 3).some((v) => !Number.isFinite(v))) return null;
    return [p[0], p[1], p[2], Number.isFinite(p[3]) ? p[3] : 1];
  }
  return null;
}

export function mixColor(a, b, t) {
  return [0, 1, 2, 3].map((i) => a[i] + (b[i] - a[i]) * t);
}

export const rgba = (c, alpha = c[3]) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${alpha})`;

export function withAlpha(css, alpha) {
  const c = parseColor(css);
  return c ? rgba(c, alpha) : css;
}

export class LruCache {
  constructor(max = 16) {
    this.max = max;
    this.map = new Map();
  }
  get(key) {
    if (!this.map.has(key)) return undefined;
    const v = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }
  set(key, value) {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    return value;
  }
  delete(key) {
    this.map.delete(key);
  }
}

export function stableKey(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableKey).join(',')}]`;
  return `{${Object.keys(v)
    .filter((k) => v[k] !== undefined)
    .sort()
    .map((k) => JSON.stringify(k) + ':' + stableKey(v[k]))
    .join(',')}}`;
}

export function engineOpts(storeOpts = {}) {
  const { observerHeightM, ...rest } = storeOpts || {};
  return rest;
}

export function scenarioKey(sc, opts, ...extra) {
  const s = sc?.site || {};
  return [sc?.id, s.id || '', Number(s.lat).toFixed(5), Number(s.lon).toFixed(5), sc?.t0Ms, sc?.durationDays, stableKey(opts), ...extra].join('|');
}

export function memo(cache, key, fn) {
  let p = cache.get(key);
  if (!p) {
    p = Promise.resolve().then(fn);
    cache.set(key, p);
    p.catch(() => cache.delete(key));
  }
  return p;
}

export function createGate() {
  let n = 0;
  return { next: () => ++n, ok: (t) => t === n, cancel: () => ++n };
}

export function describeError(e) {
  const msg = e?.message || String(e);
  if (e instanceof RangeError || e?.name === 'RangeError') {
    if (/coverage/i.test(msg)) {
      return `This date is outside the ephemeris coverage. ${msg.replace(/^Requested time/, 'Requested')}. Pick a date inside the covered range.`;
    }
    return `Invalid input: ${msg}`;
  }
  return `Could not compute this chart: ${msg}`;
}

export function coverageYears(coverage) {
  if (!coverage) return [1969, 2059];
  const s = new Date(coverage.startMs);
  let first = s.getUTCFullYear();
  if (Date.UTC(first, 0, 1) < coverage.startMs) first += 1;
  let last = new Date(coverage.endMs).getUTCFullYear();
  if (Date.UTC(last + 1, 0, 1) > coverage.endMs) last -= 1;
  return [first, last];
}

export function createLabelPlacer(padding = 2) {
  const boxes = [];
  return (x, y, w, h) => {
    const b = { x0: x - padding, y0: y - padding, x1: x + w + padding, y1: y + h + padding };
    for (const o of boxes) if (b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0) return false;
    boxes.push(b);
    return true;
  };
}

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

const TOKEN_NAMES = [
  'bg', 'surface', 'surface-2', 'surface-3', 'border', 'border-strong', 'text', 'text-2', 'text-3',
  'sun', 'sun-soft', 'earth', 'earth-soft', 'both', 'dark', 'terrain', 'terrain-fill',
  'good', 'warn', 'bad', 'accent', 'accent-contrast', 'grid', 'font', 'font-mono',
];

export function readTokens() {
  const cs = getComputedStyle(document.documentElement);
  const out = {};
  for (const n of TOKEN_NAMES) {
    const key = n.replace(/-(\w)/g, (_, c) => c.toUpperCase());
    out[key] = cs.getPropertyValue('--' + n).trim();
  }
  out.font = out.font || 'system-ui, sans-serif';
  out.fontMono = out.fontMono || 'ui-monospace, monospace';
  out.theme = document.documentElement.getAttribute('data-theme') || 'dark';
  return out;
}

export const prefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function createSurface(host, draw, { minHeight = 120 } = {}) {
  const canvas = h('canvas', { class: 'lc-canvas' });
  host.prepend(canvas);
  const g = canvas.getContext('2d');
  const s = { canvas, ctx: g, width: 0, height: 0, dpr: 1, colors: readTokens(), invalidate, destroy, onTheme: null };
  let raf = 0;
  let dead = false;

  function resize() {
    const r = host.getBoundingClientRect();
    const w = Math.max(10, Math.floor(r.width));
    const hgt = Math.max(minHeight, Math.floor(r.height));
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    if (w === s.width && hgt === s.height && dpr === s.dpr) return false;
    s.width = w;
    s.height = hgt;
    s.dpr = dpr;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hgt * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = hgt + 'px';
    return true;
  }
  function frame() {
    raf = 0;
    if (dead) return;
    resize();
    g.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
    g.clearRect(0, 0, s.width, s.height);
    try {
      draw(g, s);
    } catch (e) {
      console.error('chart draw failed', e);
    }
  }
  function invalidate() {
    if (!raf && !dead) raf = requestAnimationFrame(frame);
  }
  const ro = new ResizeObserver(() => {
    if (resize()) invalidate();
  });
  ro.observe(host);
  const mo = new MutationObserver(() => {
    s.colors = readTokens();
    s.onTheme?.();
    invalidate();
  });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
  let mq = null;
  const onDpr = () => {
    invalidate();
    watchDpr();
  };
  function watchDpr() {
    mq?.removeEventListener?.('change', onDpr);
    mq = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    mq.addEventListener?.('change', onDpr);
  }
  watchDpr();
  function destroy() {
    dead = true;
    if (raf) cancelAnimationFrame(raf);
    ro.disconnect();
    mo.disconnect();
    mq?.removeEventListener?.('change', onDpr);
    canvas.remove();
  }
  resize();
  invalidate();
  return s;
}

export function createFrame(container, { title, className = '', stageClass = '' } = {}) {
  const tools = h('div', { class: 'lc-tools' });
  const head = h('header', { class: 'lc-head' }, h('h3', { class: 'lc-title', text: title }), tools);
  const sub = h('div', { class: 'lc-sub' });
  const overlay = h('div', { class: 'lc-overlay', hidden: true });
  const tip = h('div', { class: 'lc-tip', hidden: true, 'aria-hidden': 'true' });
  const stage = h('div', { class: `lc-stage ${stageClass}` }, tip, overlay);
  const legend = h('div', { class: 'lc-legend' });
  const caption = h('div', { class: 'lc-caption' });
  const sr = h('p', { class: 'lc-sr', 'aria-live': 'polite' });
  const root = h('section', { class: `lc-chart ${className}`, 'aria-label': title }, head, sub, stage, legend, caption, sr);
  container.append(root);

  function setStatus(kind, message = '') {
    root.dataset.state = kind;
    if (kind === 'ready') {
      overlay.hidden = true;
      overlay.textContent = '';
      return;
    }
    overlay.hidden = false;
    overlay.className = `lc-overlay lc-overlay--${kind}`;
    overlay.replaceChildren();
    if (kind === 'loading') {
      overlay.append(h('div', { class: 'lc-skeleton', 'aria-hidden': 'true' }), h('span', { class: 'lc-overlay-text', text: message || 'Computing…' }));
      overlay.setAttribute('role', 'status');
    } else {
      overlay.append(h('span', { class: 'lc-overlay-text', text: message }));
      overlay.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    }
  }

  function showTip(x, y, lines) {
    if (!lines || !lines.length) {
      tip.hidden = true;
      return;
    }
    tip.replaceChildren(...lines.map((l) => (typeof l === 'string' ? h('div', { text: l }) : l)));
    tip.hidden = false;
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let left = x + 14;
    if (left + tw > sw - 4) left = x - tw - 14;
    let top = y + 14;
    if (top + th > sh - 4) top = y - th - 10;
    tip.style.left = clamp(left, 4, Math.max(4, sw - tw - 4)) + 'px';
    tip.style.top = clamp(top, 4, Math.max(4, sh - th - 4)) + 'px';
  }

  return { root, head, tools, sub, stage, overlay, tip, legend, caption, sr, setStatus, showTip, hideTip: () => (tip.hidden = true) };
}

export function segmented(items, value, onChange, ariaLabel) {
  const el = h('div', { class: 'lc-seg', role: 'group', 'aria-label': ariaLabel });
  const buttons = items.map((it) =>
    h('button', { type: 'button', class: 'lc-btn', title: it.title || null, 'data-value': String(it.value), onclick: () => onChange(it.value) }, it.label),
  );
  el.append(...buttons);
  const set = (v) => {
    for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.value === String(v)));
  };
  set(value);
  return { el, set };
}

export function legendItem(label, color, kind = 'box') {
  return h('span', { class: 'lc-leg' }, h('i', { class: `lc-sw lc-sw--${kind}`, style: `--c:${color}`, 'aria-hidden': 'true' }), label);
}

export const font = (colors, px, weight = 400, mono = false) => `${weight} ${px}px ${mono ? colors.fontMono : colors.font}`;

export function localPoint(e, el) {
  const r = el.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
