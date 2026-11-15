import {
  DAY_MS, HOUR_MS, clamp, linearScale, ticks, niceDomain, timeTicks, fmtUtc, fmtShortDate, fmtDuration, fmtDeg,
  fmtPercent, LruCache, memo, scenarioKey, engineOpts, stableKey, createGate, describeError, createLabelPlacer,
  createFrame, createSurface, legendItem, font, localPoint, withAlpha, h,
} from './chartUtil.js';

const caches = new WeakMap();
const cacheFor = (nav) => {
  if (!caches.has(nav)) caches.set(nav, new LruCache(12));
  return caches.get(nav);
};

export function candidateStepFor(rangeMs) {
  const days = rangeMs / DAY_MS;
  return days <= 45 ? 3600 : days <= 120 ? 10800 : 21600;
}

export function failures(lw, k) {
  const r = lw.requirements;
  const out = [];
  if (!lw.sunlitAtLanding[k]) out.push('sunlit');
  if (r.minSunElDeg != null && lw.sunElDeg[k] < r.minSunElDeg) out.push('minSunEl');
  if (r.maxSunElDeg != null && lw.sunElDeg[k] > r.maxSunElDeg) out.push('maxSunEl');
  if (lw.sunlitHours[k] < r.minSunlitHours) out.push('sunlitHours');
  if (lw.commFraction[k] < r.minCommFraction) out.push('comm');
  return out;
}

const FAIL_TEXT = (r) => ({
  sunlit: 'sunlit at landing',
  minSunEl: `Sun ≥ ${r.minSunElDeg}° at landing`,
  maxSunEl: `Sun ≤ ${r.maxSunElDeg}° at landing`,
  sunlitHours: `≥ ${fmtDuration(r.minSunlitHours)} of continuous sunlight`,
  comm: `≥ ${Math.round(r.minCommFraction * 100)}% Earth link over the mission`,
});

export function windowSentence(lw, landingMs) {
  const half = (lw.candidateStepS * 1000) / 2;
  const ws = lw.windows || [];
  const tail = ` ${ws.length} window${ws.length === 1 ? '' : 's'} in the scanned range; ${lw.feasibleCount} of ${lw.n} candidate landing times feasible (every ${fmtDuration(lw.candidateStepS / 3600)}).`;
  if (!ws.length) {
    const counts = {};
    for (let k = 0; k < lw.n; k++) for (const f of failures(lw, k)) counts[f] = (counts[f] || 0) + 1;
    const worst = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    const txt = FAIL_TEXT(lw.requirements);
    return (
      `No landing time between ${fmtUtc(lw.t0Ms)} and ${fmtUtc(lw.t1Ms)} meets the requirements.` +
      (worst ? ` Most often missed: ${txt[worst[0]]} (fails at ${Math.round((worst[1] / lw.n) * 100)}% of candidates).` : '')
    );
  }
  const inside = ws.find((w) => landingMs >= w.startMs - half && landingMs <= w.endMs + half);
  if (inside) {
    const left = (inside.endMs - landingMs) / HOUR_MS;
    return (
      `The current landing date is feasible: its window ${left > 0 ? `stays open for another ${fmtDuration(left)} (last feasible candidate ${fmtUtc(inside.endMs)})` : 'closes right at this candidate'}.` +
      tail
    );
  }
  const nextW = ws.find((w) => w.startMs > landingMs);
  const prevW = [...ws].reverse().find((w) => w.endMs < landingMs);
  let s = '';
  if (nextW) {
    const inH = (nextW.startMs - landingMs) / HOUR_MS;
    s +=
      nextW.durationHours > 0
        ? `Next feasible window opens in ${fmtDuration(inH)} (${fmtUtc(nextW.startMs)}) and lasts ${fmtDuration(nextW.durationHours)}.`
        : `Next feasible landing time is in ${fmtDuration(inH)} (${fmtUtc(nextW.startMs)}), a single candidate of the ${fmtDuration(lw.candidateStepS / 3600)} scan.`;
  } else {
    s += 'No feasible window after the current landing date in the scanned range.';
  }
  if (prevW) s += ` The previous window closed ${fmtDuration((landingMs - prevW.endMs) / HOUR_MS)} earlier (${fmtUtc(prevW.endMs)}).`;
  return s + tail;
}

export function mount(container, app) {
  const { nav, store } = app;
  const f = createFrame(container, { title: 'Landing windows', className: 'lc-lw' });
  let sc = null;
  let lw = null;
  let hover = null;
  let focusK = -1;
  let L = null;
  let pop = null;
  const gate = createGate();
  const range = { before: 30, after: 180 };
  const overrides = new Map();

  const num = (label, attrs, unit) => {
    const input = h('input', { type: 'number', class: 'lc-num', inputmode: 'decimal', ...attrs });
    const el = h('label', { class: 'lc-field' }, h('span', { class: 'lc-field-l', text: label }), input, unit ? h('span', { class: 'lc-field-u', text: unit }) : null);
    return { el, input };
  };
  const fBefore = num('From', { min: 0, max: 400, step: 1, value: range.before, 'aria-label': 'Days before the current landing date' }, 'd before');
  const fAfter = num('to', { min: 1, max: 730, step: 1, value: range.after, 'aria-label': 'Days after the current landing date' }, 'd after');
  f.tools.append(fBefore.el, fAfter.el);

  const rMinEl = num('Sun at landing ≥', { step: 0.5, min: -10, max: 90, placeholder: 'any', 'aria-label': 'Minimum Sun elevation at landing, degrees (empty = no limit)' }, '°');
  const rMaxEl = num('≤', { step: 0.5, min: -10, max: 90, placeholder: 'any', 'aria-label': 'Maximum Sun elevation at landing, degrees (empty = no limit)' }, '°');
  const rHours = num('Sunlight after landing ≥', { step: 6, min: 0, max: 2000, 'aria-label': 'Minimum continuous sunlight after landing, hours' }, 'h');
  const rComm = num('Earth link ≥', { step: 5, min: 0, max: 100, 'aria-label': 'Minimum Earth-link percentage over the mission' }, '%');
  const resetReq = h('button', { type: 'button', class: 'lc-btn', title: 'Back to the engine defaults for this latitude', onclick: () => { overrides.delete(sc?.id); load(); } }, 'Defaults');
  const reqBox = h('fieldset', { class: 'lc-req' }, h('legend', { text: 'Requirements' }), rMinEl.el, rMaxEl.el, rHours.el, rComm.el, resetReq);
  const verdict = h('p', { class: 'lc-verdict', 'aria-live': 'polite' });
  f.sub.append(reqBox, verdict);
  f.legend.append(
    legendItem('Feasible window', 'var(--both)', 'area'),
    legendItem('Sun elevation at landing', 'var(--sun)', 'line'),
    legendItem('Continuous sunlight after landing', 'var(--sun)', 'box'),
    legendItem('Earth link over mission', 'var(--earth)', 'box'),
    legendItem('Requirement', 'var(--text-2)', 'dash'),
    legendItem('Current landing', 'var(--accent)', 'line'),
  );

  let debounce = 0;
  const onInput = () => {
    clearTimeout(debounce);
    debounce = setTimeout(applyForm, 350);
  };
  for (const x of [fBefore, fAfter, rMinEl, rMaxEl, rHours, rComm]) x.input.addEventListener('input', onInput);

  function applyForm() {
    const b = Number(fBefore.input.value);
    const a = Number(fAfter.input.value);
    if (Number.isFinite(b) && b >= 0) range.before = Math.min(400, b);
    if (Number.isFinite(a) && a > 0) range.after = Math.min(730, a);
    if (sc) {
      const val = (inp) => (inp.value.trim() === '' ? null : Number(inp.value));
      const o = {
        minSunElDeg: val(rMinEl.input),
        maxSunElDeg: val(rMaxEl.input),
        minSunlitHours: Math.max(0, Number(rHours.input.value) || 0),
        minCommFraction: clamp((Number(rComm.input.value) || 0) / 100, 0, 1),
      };
      for (const k of ['minSunElDeg', 'maxSunElDeg']) if (o[k] != null && !Number.isFinite(o[k])) o[k] = null;
      overrides.set(sc.id, o);
    }
    load();
  }

  function fillForm(req) {
    const set = (inp, v) => {
      if (document.activeElement !== inp) inp.value = v == null ? '' : String(v);
    };
    set(rMinEl.input, req.minSunElDeg);
    set(rMaxEl.input, req.maxSunElDeg);
    set(rHours.input, req.minSunlitHours);
    set(rComm.input, Math.round(req.minCommFraction * 100));
  }

  const surface = createSurface(f.stage, draw, { minHeight: 260 });
  const canvas = surface.canvas;
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'slider');
  canvas.setAttribute('aria-roledescription', 'candidate landing date');
  canvas.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight Enter');
  const eopts = () => engineOpts(store.get().opts);

  async function load() {
    closePop();
    sc = store.active();
    const t = gate.next();
    if (!sc) {
      lw = null;
      verdict.textContent = '';
      f.setStatus('empty', 'No scenario selected.');
      return surface.invalidate();
    }
    const cov = nav.coverage;
    const t0 = Math.max(cov.startMs, sc.t0Ms - range.before * DAY_MS);
    const t1 = Math.min(cov.endMs - (sc.durationDays + 1) * DAY_MS, sc.t0Ms + range.after * DAY_MS);
    const o = {
      ...eopts(),
      missionDays: sc.durationDays,
      candidateStepS: candidateStepFor(t1 - t0),
      requirements: overrides.get(sc.id) || null,
    };
    if (!(t1 > t0)) {
      lw = null;
      verdict.textContent = '';
      f.setStatus('error', describeError(new RangeError(`The scan range around ${fmtUtc(sc.t0Ms)} is outside the ephemeris coverage`)));
      return surface.invalidate();
    }
    const key = [scenarioKey({ ...sc, t0Ms: 0 }, o, store.get().opts.observerHeightM), t0, t1].join('|');
    const cache = cacheFor(nav);
    if (!cache.get(key)) f.setStatus('loading', `Scanning ${Math.round((t1 - t0) / DAY_MS)} days of candidate landing dates…`);
    try {
      const s = sc;
      const r = await memo(cache, key, async () => nav.landingWindows(await app.ctxFor(s), t0, t1, o));
      if (!gate.ok(t)) return;
      lw = r;
      f.setStatus('ready');
      fillForm(r.requirements);
      verdict.textContent = windowSentence(r, sc.t0Ms);
      f.sr.textContent = `Landing-window scan for ${sc.site.name}, ${fmtUtc(r.t0Ms)} to ${fmtUtc(r.t1Ms)}, mission ${r.missionDays} d. ${verdict.textContent}`;
      if (focusK >= r.n) focusK = -1;
      surface.invalidate();
    } catch (e) {
      if (!gate.ok(t)) return;
      lw = null;
      verdict.textContent = '';
      f.setStatus('error', describeError(e));
      surface.invalidate();
    }
  }

  function draw(g, s) {
    const C = s.colors;
    const W = s.width;
    const H = s.height;
    const x0 = 92;
    const x1 = W - 12;
    const top = 22;
    const featH = 12;
    const axisH = 20;
    const gap = 10;
    const avail = H - top - featH - axisH - gap * 3 - 6;
    const rowH = Math.max(40, Math.floor(avail / 3));
    L = null;
    if (!lw) return;
    const xs = linearScale(lw.t0Ms, lw.t1Ms, x0, x1);
    const rowsTop = top + featH + gap;
    const r1 = [rowsTop, rowsTop + rowH];
    const r2 = [r1[1] + gap, r1[1] + gap + rowH];
    const r3 = [r2[1] + gap, r2[1] + gap + rowH];
    const bottom = r3[1];
    L = { xs, x0, x1, top, bottom };
    const n = lw.n;
    const req = lw.requirements;
    const candW = Math.max(1, (x1 - x0) / Math.max(1, n - 1));

    const tt = timeTicks(lw.t0Ms, lw.t1Ms, Math.max(2, Math.floor((x1 - x0) / 80)));
    g.strokeStyle = C.grid;
    g.lineWidth = 1;
    g.beginPath();
    for (const t of tt) {
      const x = Math.round(xs(t.tMs)) + 0.5;
      g.moveTo(x, top);
      g.lineTo(x, bottom);
    }
    g.stroke();

    g.fillStyle = withAlpha(C.both, 0.14);
    for (const w of lw.windows) {
      const a = xs(w.startMs) - candW / 2;
      const b = xs(w.endMs) + candW / 2;
      g.fillRect(clamp(a, x0, x1), top, Math.max(2, clamp(b, x0, x1) - clamp(a, x0, x1)), bottom - top);
    }
    g.fillStyle = C.surface3;
    g.fillRect(x0, top, x1 - x0, featH);
    g.fillStyle = C.both;
    for (const w of lw.windows) {
      const a = clamp(xs(w.startMs) - candW / 2, x0, x1);
      const b = clamp(xs(w.endMs) + candW / 2, x0, x1);
      g.fillRect(a, top, Math.max(2, b - a), featH);
    }

    const label = (txt, sub, y0, y1) => {
      g.textAlign = 'right';
      g.textBaseline = 'middle';
      g.font = font(C, 11, 600);
      g.fillStyle = C.text2;
      g.fillText(txt, x0 - 8, (y0 + y1) / 2 - 6);
      g.font = font(C, 10, 400);
      g.fillStyle = C.text3;
      g.fillText(sub, x0 - 8, (y0 + y1) / 2 + 7);
    };
    label('Feasible', '', top, top + featH + 12);

    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < n; k++) {
      lo = Math.min(lo, lw.sunElDeg[k]);
      hi = Math.max(hi, lw.sunElDeg[k]);
    }
    if (req.minSunElDeg != null) lo = Math.min(lo, req.minSunElDeg), hi = Math.max(hi, req.minSunElDeg);
    if (req.maxSunElDeg != null) hi = Math.max(hi, req.maxSunElDeg), lo = Math.min(lo, req.maxSunElDeg);
    lo = Math.max(lo, -15);
    const [e0, e1] = niceDomain(lo, Math.max(hi, lo + 2), 3);
    const ye = linearScale(e0, e1, r1[1], r1[0]);
    rowFrame(g, C, x0, x1, r1, ticks(e0, e1, Math.max(2, Math.floor(rowH / 18))), ye, (v) => `${v}°`);
    label('Sun el.', 'at landing', ...r1);
    if (req.minSunElDeg != null || req.maxSunElDeg != null) {
      const a = ye(req.maxSunElDeg ?? e1);
      const b = ye(req.minSunElDeg ?? e0);
      g.fillStyle = withAlpha(C.both, 0.12);
      g.fillRect(x0, clamp(a, r1[0], r1[1]), x1 - x0, clamp(b, r1[0], r1[1]) - clamp(a, r1[0], r1[1]));
      threshold(g, C, x0, x1, req.minSunElDeg != null ? ye(req.minSunElDeg) : null, r1);
      threshold(g, C, x0, x1, req.maxSunElDeg != null ? ye(req.maxSunElDeg) : null, r1);
    }
    g.save();
    g.beginPath();
    g.rect(x0, r1[0], x1 - x0, r1[1] - r1[0]);
    g.clip();
    g.strokeStyle = C.sun;
    g.lineWidth = 1.5;
    g.beginPath();
    for (let k = 0; k < n; k++) (k ? g.lineTo : g.moveTo).call(g, xs(lw.tMs[k]), ye(lw.sunElDeg[k]));
    g.stroke();
    g.restore();

    const capH = lw.missionDays * 24;
    const yh = linearScale(0, capH, r2[1], r2[0]);
    rowFrame(g, C, x0, x1, r2, ticks(0, capH, Math.max(2, Math.floor(rowH / 18)), capH > 200 ? (capH > 600 ? 168 : 72) : 24), yh, (v) => `${v} h`);
    label('Sunlight', 'after landing', ...r2);
    bars(g, lw.sunlitHours, xs, yh, r2, candW, C.sun, (k) => lw.sunlitHours[k] >= req.minSunlitHours);
    threshold(g, C, x0, x1, yh(Math.min(req.minSunlitHours, capH)), r2);

    const yc = linearScale(0, 1, r3[1], r3[0]);
    rowFrame(g, C, x0, x1, r3, [0, 0.5, 1], yc, (v) => `${Math.round(v * 100)}%`);
    label('Earth link', 'over mission', ...r3);
    bars(g, lw.commFraction, xs, yc, r3, candW, C.earth, (k) => lw.commFraction[k] >= req.minCommFraction);
    threshold(g, C, x0, x1, yc(req.minCommFraction), r3);

    g.textAlign = 'center';
    g.textBaseline = 'top';
    const place = createLabelPlacer(4);
    for (const t of tt) {
      const x = xs(t.tMs);
      g.font = font(C, 11, t.major ? 700 : 400);
      const w = g.measureText(t.label).width;
      if (x - w / 2 < x0 - 30 || x + w / 2 > x1 + 8 || !place(x - w / 2, bottom + 5, w, 12)) continue;
      g.fillStyle = t.major ? C.text : C.text2;
      g.fillText(t.label, x, bottom + 5);
    }

    const lx = xs(sc.t0Ms);
    if (lx >= x0 && lx <= x1) {
      g.strokeStyle = C.accent;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(Math.round(lx) + 0.5, top - 4);
      g.lineTo(Math.round(lx) + 0.5, bottom);
      g.stroke();
      g.font = font(C, 11, 700);
      const txt = `Current landing ${fmtShortDate(sc.t0Ms)}`;
      const w = g.measureText(txt).width + 8;
      const bx = lx + w + 4 > x1 ? lx - w - 4 : lx + 4;
      g.fillStyle = C.accent;
      g.fillRect(bx, 2, w, 16);
      g.fillStyle = C.accentContrast;
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      g.fillText(txt, bx + 4, 10.5);
    }

    const k = hover ? candidateAt(hover.x) : focusK;
    if (k >= 0) {
      const x = xs(lw.tMs[k]);
      g.strokeStyle = C.text;
      g.lineWidth = 1;
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(Math.round(x) + 0.5, top);
      g.lineTo(Math.round(x) + 0.5, bottom);
      g.stroke();
      g.setLineDash([]);
      if (hover && !pop) showCandTip(k, hover.x, hover.y);
      if (!hover) {
        canvas.setAttribute('aria-valuetext', candText(k));
        canvas.setAttribute('aria-valuenow', String(k));
      }
    } else f.hideTip();
    if (pop) positionPop();
  }

  function rowFrame(g, C, x0, x1, [y0, y1], tks, ys, fmt) {
    g.fillStyle = withAlpha(C.surface3, 0.35);
    g.fillRect(x0, y0, x1 - x0, y1 - y0);
    g.strokeStyle = C.grid;
    g.lineWidth = 1;
    g.beginPath();
    for (const v of tks) {
      const y = Math.round(ys(v)) + 0.5;
      if (y < y0 - 1 || y > y1 + 1) continue;
      g.moveTo(x0, y);
      g.lineTo(x1, y);
    }
    g.stroke();
    g.font = font(C, 10, 400, true);
    g.fillStyle = C.text3;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    for (const v of tks) {
      const y = ys(v);
      if (y < y0 + 5 || y > y1 - 4) continue;
      g.fillText(fmt(v), x0 + 3, y - 6);
    }
  }

  function bars(g, arr, xs, ys, [y0, y1], candW, color, ok) {
    const w = Math.max(1, candW * 0.9);
    for (let k = 0; k < arr.length; k++) {
      const x = xs(lw.tMs[k]) - w / 2;
      const y = clamp(ys(arr[k]), y0, y1);
      g.fillStyle = ok(k) ? color : withAlpha(color, 0.35);
      g.fillRect(x, y, w, y1 - y);
    }
  }

  function threshold(g, C, x0, x1, y, [y0, y1]) {
    if (y == null || y < y0 - 1 || y > y1 + 1) return;
    g.strokeStyle = C.text2;
    g.lineWidth = 1.25;
    g.setLineDash([5, 3]);
    g.beginPath();
    g.moveTo(x0, Math.round(y) + 0.5);
    g.lineTo(x1, Math.round(y) + 0.5);
    g.stroke();
    g.setLineDash([]);
  }

  function candidateAt(x) {
    if (!L || !lw || x < L.x0 - 4 || x > L.x1 + 4) return -1;
    const t = L.xs.invert(x);
    const step = lw.candidateStepS * 1000;
    return clamp(Math.round((t - lw.tMs[0]) / step), 0, lw.n - 1);
  }

  function candLines(k) {
    const r = lw.requirements;
    const fails = new Set(failures(lw, k));
    const mark = (bad) => (bad ? '✗' : '✓');
    const rel = (lw.tMs[k] - sc.t0Ms) / HOUR_MS;
    return {
      head: fmtUtc(lw.tMs[k]),
      rel: Math.abs(rel) < 0.5 ? 'current landing date' : `${rel > 0 ? '+' : '−'}${fmtDuration(rel)} vs current landing`,
      feasible: fails.size === 0,
      items: [
        `${mark(fails.has('sunlit'))} ${lw.sunlitAtLanding[k] ? 'Sunlit' : 'Not sunlit'} at landing (${fmtPercent(lw.sunFraction[k])} of disc)`,
        `${mark(fails.has('minSunEl') || fails.has('maxSunEl'))} Sun elevation ${fmtDeg(lw.sunElDeg[k])}${r.minSunElDeg != null || r.maxSunElDeg != null ? ` (need ${r.minSunElDeg ?? '−∞'}…${r.maxSunElDeg ?? '∞'}°)` : ''}`,
        `${mark(fails.has('sunlitHours'))} ${fmtDuration(lw.sunlitHours[k])} continuous sunlight (need ${fmtDuration(r.minSunlitHours)})`,
        `${mark(fails.has('comm'))} Earth link ${fmtPercent(lw.commFraction[k])} of mission (need ${Math.round(r.minCommFraction * 100)}%)`,
      ],
    };
  }
  function candText(k) {
    const c = candLines(k);
    return `${c.head}, ${c.rel}, ${c.feasible ? 'feasible' : 'not feasible'}. ${c.items.join('. ')}`;
  }
  function showCandTip(k, x, y) {
    const c = candLines(k);
    f.showTip(x, y, [
      h('div', { class: 'lc-tip-h', text: c.head }),
      h('div', { class: 'lc-muted', text: c.rel }),
      h('div', { class: c.feasible ? 'lc-tip-ok' : 'lc-tip-bad', text: c.feasible ? 'Feasible' : 'Not feasible' }),
      ...c.items,
      h('div', { class: 'lc-tip-hint', text: 'Click for actions' }),
    ]);
  }

  function closePop() {
    if (pop) {
      pop.el.remove();
      pop = null;
    }
  }
  function openPop(k) {
    closePop();
    if (!lw || k < 0) return;
    f.hideTip();
    const c = candLines(k);
    const tMs = lw.tMs[k];
    const s = sc;
    const moveBtn = h('button', {
      type: 'button',
      class: 'lc-btn lc-btn--primary',
      onclick: () => {
        store.updateScenario(s.id, { t0Ms: tMs });
        app.toast?.(`Landing of "${s.site.name}" moved to ${fmtUtc(tMs)}`, 'info');
        closePop();
      },
    }, 'Move landing here');
    const addBtn = h('button', {
      type: 'button',
      class: 'lc-btn',
      onclick: () => {
        store.addScenario(s.site, tMs, s.durationDays);
        app.toast?.(`Added scenario "${s.site.name}" landing ${fmtUtc(tMs)}`, 'info');
        closePop();
      },
    }, 'Add as new scenario');
    const closeBtn = h('button', { type: 'button', class: 'lc-pop-x', 'aria-label': 'Close', onclick: () => { closePop(); canvas.focus(); } }, '×');
    const el = h(
      'div',
      { class: 'lc-pop', role: 'dialog', 'aria-label': `Candidate landing ${c.head}` },
      closeBtn,
      h('div', { class: 'lc-pop-h', text: c.head }),
      h('div', { class: 'lc-muted', text: c.rel }),
      h('div', { class: c.feasible ? 'lc-tip-ok' : 'lc-tip-bad', text: c.feasible ? '✓ Meets all requirements' : '✗ Does not meet all requirements' }),
      h('ul', { class: 'lc-pop-list' }, c.items.map((t) => h('li', { text: t }))),
      h('div', { class: 'lc-pop-actions' }, moveBtn, addBtn),
    );
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closePop();
        canvas.focus();
      }
    });
    f.stage.append(el);
    pop = { el, k };
    positionPop();
    moveBtn.focus({ preventScroll: true });
  }
  function positionPop() {
    if (!pop || !L || !lw) return;
    const x = L.xs(lw.tMs[pop.k]);
    const sw = f.stage.clientWidth;
    const pw = pop.el.offsetWidth;
    let left = x + 10;
    if (left + pw > sw - 6) left = x - pw - 10;
    pop.el.style.left = clamp(left, 6, Math.max(6, sw - pw - 6)) + 'px';
    pop.el.style.top = '26px';
  }
  const onDocDown = (e) => {
    if (pop && !pop.el.contains(e.target) && e.target !== canvas) closePop();
  };
  document.addEventListener('pointerdown', onDocDown, true);

  canvas.addEventListener('pointermove', (e) => {
    hover = localPoint(e, canvas);
    surface.invalidate();
  });
  canvas.addEventListener('pointerleave', () => {
    hover = null;
    f.hideTip();
    surface.invalidate();
  });
  canvas.addEventListener('click', (e) => {
    const k = candidateAt(localPoint(e, canvas).x);
    if (k >= 0) {
      focusK = k;
      openPop(k);
      surface.invalidate();
    }
  });
  canvas.addEventListener('keydown', (e) => {
    if (!lw) return;
    if (focusK < 0) {
      focusK = clamp(Math.round((sc.t0Ms - lw.tMs[0]) / (lw.candidateStepS * 1000)), 0, lw.n - 1);
    }
    const stepK = e.shiftKey ? Math.max(1, Math.round(DAY_MS / (lw.candidateStepS * 1000))) : 1;
    if (e.key === 'ArrowLeft') focusK = Math.max(0, focusK - stepK);
    else if (e.key === 'ArrowRight') focusK = Math.min(lw.n - 1, focusK + stepK);
    else if (e.key === 'Home') focusK = 0;
    else if (e.key === 'End') focusK = lw.n - 1;
    else if (e.key === 'Enter' || e.key === ' ') {
      openPop(focusK);
    } else if (e.key === 'Escape') closePop();
    else return;
    e.preventDefault();
    hover = null;
    surface.invalidate();
  });

  const unsubs = [store.subscribe(() => load(), ['scenarios', 'activeId', 'opts'])];
  load();
  return {
    destroy() {
      unsubs.forEach((u) => u());
      gate.cancel();
      clearTimeout(debounce);
      document.removeEventListener('pointerdown', onDocDown, true);
      closePop();
      surface.destroy();
      f.root.remove();
    },
  };
}
