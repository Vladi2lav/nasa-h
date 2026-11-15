import {
  DAY_MS, HOUR_MS, clamp, linearScale, ticks, niceDomain, timeTicks, intervalsToPixels, interpAt,
  fmtUtc, fmtShortDate, fmtDuration, fmtDeg, fmtPercent, LruCache, memo, scenarioKey, engineOpts,
  createGate, describeError, createLabelPlacer, createFrame, createSurface, segmented, legendItem,
  font, localPoint, withAlpha, h,
} from './chartUtil.js';

const SPANS = [7, 30, 90, 365];
const caches = new WeakMap();
const cacheFor = (nav) => {
  if (!caches.has(nav)) caches.set(nav, new LruCache(16));
  return caches.get(nav);
};

export function stepForSpan(spanMs) {
  return [600, 900, 1800, 3600, 7200, 10800, 21600].find((s) => spanMs / (s * 1000) <= 2000) || 21600;
}

const EVENT_LABEL = { sunrise: 'Sunrise', sunset: 'Sunset', earthrise: 'Earthrise', earthset: 'Earthset' };

function keyTime(e, t, lo, hi) {
  const step = e.shiftKey ? DAY_MS : HOUR_MS;
  switch (e.key) {
    case 'ArrowLeft':
    case 'ArrowDown':
      return t - step;
    case 'ArrowRight':
    case 'ArrowUp':
      return t + step;
    case 'PageDown':
      return t - DAY_MS;
    case 'PageUp':
      return t + DAY_MS;
    case 'Home':
      return lo;
    case 'End':
      return hi;
    default:
      return null;
  }
}

function drawCursor(g, C, x, top, bottom, label) {
  g.strokeStyle = C.accent;
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(Math.round(x) + 0.5, top);
  g.lineTo(Math.round(x) + 0.5, bottom);
  g.stroke();
  g.fillStyle = C.accent;
  g.beginPath();
  g.moveTo(x - 5, top - 1);
  g.lineTo(x + 5, top - 1);
  g.lineTo(x, top + 5);
  g.closePath();
  g.fill();
  if (label) {
    g.font = font(C, 11, 600, true);
    const w = g.measureText(label).width + 8;
    const lx = x + 6;
    g.fillStyle = C.accent;
    g.fillRect(lx, top, w, 15);
    g.fillStyle = C.accentContrast;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillText(label, lx + 4, top + 8);
  }
}

function drawTimeAxis(g, C, xs, t0, t1, x0, x1, yTop, yBottom, yLabel) {
  const maxTicks = Math.max(2, Math.floor((x1 - x0) / 78));
  const tt = timeTicks(t0, t1, maxTicks);
  g.strokeStyle = C.grid;
  g.lineWidth = 1;
  g.beginPath();
  for (const t of tt) {
    const x = Math.round(xs(t.tMs)) + 0.5;
    g.moveTo(x, yTop);
    g.lineTo(x, yBottom);
  }
  g.stroke();
  g.textAlign = 'center';
  g.textBaseline = 'top';
  const place = createLabelPlacer(4);
  for (const t of tt) {
    const x = xs(t.tMs);
    g.font = font(C, 11, t.major ? 700 : 400);
    const w = g.measureText(t.label).width;
    if (x - w / 2 < x0 - 20 || x + w / 2 > x1 + 8) continue;
    if (!place(x - w / 2, yLabel, w, 12)) continue;
    g.fillStyle = t.major ? C.text : C.text2;
    g.fillText(t.label, x, yLabel);
  }
}

export function mount(container, app) {
  const { nav, store } = app;
  const f = createFrame(container, { title: 'Timeline', className: 'lc-timeline' });
  let sc = null;
  let data = null;
  let dataKey = '';
  let hover = null;
  let dragging = false;
  let L = null;
  const gate = createGate();

  const spanSeg = segmented(
    SPANS.map((d) => ({ value: d, label: `${d} d`, title: `Show ${d} days from the landing` })),
    store.get().timelineDays,
    (v) => store.set({ timelineDays: v }),
    'Timeline span',
  );
  f.tools.append(spanSeg.el);
  const readout = h('div', { class: 'lc-readout' });
  f.sub.append(readout);
  f.legend.append(
    legendItem('Sun above terrain', 'var(--sun)', 'line'),
    legendItem('Earth above terrain', 'var(--earth)', 'line'),
    legendItem('Sunlit', 'var(--sun)', 'box'),
    legendItem('Earth link', 'var(--earth)', 'box'),
    legendItem('Both', 'var(--both)', 'box'),
    legendItem('Mission window', 'var(--accent)', 'area'),
    h('span', { class: 'lc-leg' }, h('b', { class: 'lc-tri', 'aria-hidden': 'true', text: '▲▼' }), ' rise / set'),
  );

  const surface = createSurface(f.stage, draw, { minHeight: 190 });
  const canvas = surface.canvas;
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'slider');
  canvas.setAttribute('aria-label', 'Time cursor on the timeline');
  canvas.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Home End');
  const eopts = () => engineOpts(store.get().opts);

  async function load() {
    sc = store.active();
    const t = gate.next();
    if (!sc) {
      data = null;
      f.setStatus('empty', 'No scenario selected.');
      surface.invalidate();
      return;
    }
    const days = store.get().timelineDays;
    spanSeg.set(days);
    const o = eopts();
    const key = scenarioKey(sc, o, days, store.get().opts.observerHeightM);
    if (key === dataKey && data) return;
    if (!data || data.scId !== sc.id) data = null;
    if (!cacheFor(nav).get(key)) f.setStatus('loading', `Computing ${days} days of Sun and Earth visibility…`);
    try {
      const s = sc;
      const result = await memo(cacheFor(nav), key, async () => {
        const ctx = await app.ctxFor(s);
        const t0 = s.t0Ms;
        const t1 = t0 + days * DAY_MS;
        const [series, summary, events] = await Promise.all([
          nav.series(ctx, t0, t1, stepForSpan(t1 - t0), o),
          nav.summary(ctx, t0, days, o),
          nav.events(ctx, t0, t1, o),
        ]);
        return { series, summary, events, t0, t1, ctx, scId: s.id };
      });
      if (!gate.ok(t)) return;
      data = result;
      dataKey = key;
      f.setStatus('ready');
      renderSr();
      surface.invalidate();
    } catch (e) {
      if (!gate.ok(t)) return;
      data = null;
      dataKey = '';
      f.setStatus('error', describeError(e));
      surface.invalidate();
    }
  }

  function renderReadout() {
    const t = store.get().timeMs;
    readout.replaceChildren(h('b', { text: fmtUtc(t) }));
    if (!data) return;
    const s = data.series;
    if (t < data.t0 || t > data.t1) {
      readout.append(h('span', { class: 'lc-muted', text: ` · cursor is outside this ${store.get().timelineDays}-day span` }));
      return;
    }
    const sunC = interpAt(s.sun.clearanceDeg, s.t0Ms, s.stepS, t);
    const earthC = interpAt(s.earth.clearanceDeg, s.t0Ms, s.stepS, t);
    readout.append(
      h('span', { class: 'lc-r-sun', text: ` · Sun ${fmtDeg(sunC, 1, true)}` }),
      h('span', { class: 'lc-r-earth', text: ` · Earth ${fmtDeg(earthC, 1, true)}` }),
      h('span', { class: 'lc-muted', text: ' above terrain' }),
      h('span', { class: 'lc-muted', text: ` · day ${((t - data.t0) / DAY_MS).toFixed(1)} after landing` }),
    );
  }

  function renderSr() {
    if (!data || !sc) return;
    const sm = data.summary;
    const evs = data.events.events;
    const evText = evs
      .slice(0, 8)
      .map((e) => `${EVENT_LABEL[e.type]} ${fmtUtc(e.tMs)}`)
      .join('; ');
    f.sr.textContent =
      `Timeline for ${sc.site.name}, ${fmtUtc(data.t0)} plus ${store.get().timelineDays} days. ` +
      `Sunlit ${fmtPercent(sm.sun.sunlitFraction)}, longest darkness ${fmtDuration(sm.sun.longestDarkHours)}; ` +
      `Earth link ${fmtPercent(sm.comm.fraction)}, longest gap ${fmtDuration(sm.comm.longestGapHours)}; ` +
      `both ${fmtPercent(sm.both.fraction)}. ${evs.length} horizon events${evs.length ? ': ' + evText : ''}${evs.length > 8 ? ' …' : ''}.`;
  }

  function updateAria() {
    const t = store.get().timeMs;
    if (data) {
      canvas.setAttribute('aria-valuemin', String(data.t0));
      canvas.setAttribute('aria-valuemax', String(data.t1));
    }
    canvas.setAttribute('aria-valuenow', String(t));
    canvas.setAttribute('aria-valuetext', fmtUtc(t));
  }

  function draw(g, s) {
    const C = s.colors;
    const W = s.width;
    const H = s.height;
    const x0 = 62;
    const x1 = W - 12;
    const bandH = 11;
    const bandGap = 3;
    const axisH = 20;
    const bandsTop = H - axisH - 3 * bandH - 2 * bandGap - 4;
    const py0 = 22;
    const py1 = bandsTop - 8;
    L = null;
    renderReadout();
    updateAria();
    if (!data) return;
    const { series: se, summary: sm, events: ev, t0, t1 } = data;
    const xs = linearScale(t0, t1, x0, x1);
    L = { xs, x0, x1, py0, py1, t0, t1, bandsTop, H, axisH };

    let lo = Infinity;
    let hi = -Infinity;
    for (const arr of [se.sun.clearanceDeg, se.earth.clearanceDeg]) {
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    lo = Math.max(Math.min(lo, -2), -30);
    hi = Math.max(hi, 3);
    const [d0, d1] = niceDomain(lo, hi, Math.max(2, Math.floor((py1 - py0) / 30)));
    const ys = linearScale(d0, d1, py1, py0);
    L.ys = ys;

    const mEnd = sc.t0Ms + sc.durationDays * DAY_MS;
    const mx0 = clamp(xs(sc.t0Ms), x0, x1);
    const mx1 = clamp(xs(mEnd), x0, x1);
    if (mx1 > mx0) {
      g.fillStyle = withAlpha(C.accent, 0.08);
      g.fillRect(mx0, py0 - 14, mx1 - mx0, bandsTop + 3 * bandH + 2 * bandGap - py0 + 14);
      g.strokeStyle = withAlpha(C.accent, 0.6);
      g.setLineDash([4, 3]);
      g.beginPath();
      if (mEnd < t1) {
        g.moveTo(Math.round(mx1) + 0.5, py0 - 14);
        g.lineTo(Math.round(mx1) + 0.5, bandsTop + 3 * bandH + 2 * bandGap);
      }
      g.stroke();
      g.setLineDash([]);
      g.font = font(C, 11, 600);
      g.fillStyle = C.text2;
      g.textAlign = 'left';
      g.textBaseline = 'top';
      const lbl = `Mission window · ${sc.durationDays} d`;
      const w = g.measureText(lbl).width;
      if (mx1 - mx0 > w + 8) g.fillText(lbl, mx0 + 4, py0 - 13);
      else if (mx1 + w + 8 < x1) g.fillText(lbl, mx1 + 4, py0 - 13);
    }

    const yt = ticks(d0, d1, Math.max(2, Math.floor((py1 - py0) / 30)));
    g.strokeStyle = C.grid;
    g.lineWidth = 1;
    g.beginPath();
    for (const v of yt) {
      const y = Math.round(ys(v)) + 0.5;
      g.moveTo(x0, y);
      g.lineTo(x1, y);
    }
    g.stroke();
    g.font = font(C, 11, 400, true);
    g.fillStyle = C.text2;
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    for (const v of yt) g.fillText(`${v}°`, x0 - 6, ys(v));
    g.save();
    g.translate(11, (py0 + py1) / 2);
    g.rotate(-Math.PI / 2);
    g.textAlign = 'center';
    g.font = font(C, 10, 500);
    g.fillStyle = C.text3;
    g.fillText('above terrain', 0, 0);
    g.restore();

    drawTimeAxis(g, C, xs, t0, t1, x0, x1, py0, bandsTop + 3 * bandH + 2 * bandGap, H - axisH + 4);

    g.strokeStyle = C.terrain;
    g.lineWidth = 1.25;
    g.beginPath();
    g.moveTo(x0, Math.round(ys(0)) + 0.5);
    g.lineTo(x1, Math.round(ys(0)) + 0.5);
    g.stroke();
    const mask = store.get().opts.commMaskDeg ?? 2;
    if (mask > d0 && mask < d1) {
      g.strokeStyle = withAlpha(C.earth, 0.45);
      g.setLineDash([2, 3]);
      g.beginPath();
      g.moveTo(x0, Math.round(ys(mask)) + 0.5);
      g.lineTo(x1, Math.round(ys(mask)) + 0.5);
      g.stroke();
      g.setLineDash([]);
    }

    g.save();
    g.beginPath();
    g.rect(x0, py0, x1 - x0, py1 - py0);
    g.clip();
    for (const [arr, color] of [[se.earth.clearanceDeg, C.earth], [se.sun.clearanceDeg, C.sun]]) {
      const n = arr.length;
      const xAt = (i) => xs(se.t0Ms + i * se.stepS * 1000);
      g.beginPath();
      g.moveTo(xAt(0), ys(0));
      for (let i = 0; i < n; i++) g.lineTo(xAt(i), ys(Math.max(0, arr[i])));
      g.lineTo(xAt(n - 1), ys(0));
      g.closePath();
      g.fillStyle = withAlpha(color, 0.12);
      g.fill();
      g.beginPath();
      for (let i = 0; i < n; i++) (i ? g.lineTo : g.moveTo).call(g, xAt(i), ys(arr[i]));
      g.strokeStyle = color;
      g.lineWidth = 1.5;
      g.stroke();
    }
    g.restore();

    const yz = clamp(ys(0), py0 + 6, py1 - 6);
    for (const e of ev.events) {
      const x = xs(e.tMs);
      if (x < x0 - 1 || x > x1 + 1) continue;
      const rise = e.type.endsWith('rise');
      g.fillStyle = e.type.startsWith('sun') ? C.sun : C.earth;
      g.strokeStyle = C.surface;
      g.lineWidth = 1;
      g.beginPath();
      if (rise) {
        g.moveTo(x, yz - 7);
        g.lineTo(x + 5, yz + 1);
        g.lineTo(x - 5, yz + 1);
      } else {
        g.moveTo(x, yz + 7);
        g.lineTo(x + 5, yz - 1);
        g.lineTo(x - 5, yz - 1);
      }
      g.closePath();
      g.fill();
      g.stroke();
    }

    const rows = [
      ['Sunlit', sm.intervals.sunlit, C.sun],
      ['Link', sm.intervals.comm, C.earth],
      ['Both', sm.intervals.both, C.both],
    ];
    g.font = font(C, 11, 600);
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    rows.forEach(([label, ivs, color], k) => {
      const y = bandsTop + k * (bandH + bandGap);
      g.fillStyle = C.surface3;
      g.fillRect(x0, y, x1 - x0, bandH);
      g.fillStyle = color;
      for (const p of intervalsToPixels(ivs, xs, x0, x1)) g.fillRect(p.x, y, p.w, bandH);
      g.fillStyle = C.text2;
      g.fillText(label, x0 - 6, y + bandH / 2 + 0.5);
    });
    L.bandRows = rows.map((r, k) => ({ label: r[0], ivs: r[1], y: bandsTop + k * (bandH + bandGap), h: bandH }));

    const t = store.get().timeMs;
    const cx = xs(t);
    const bottom = bandsTop + 3 * bandH + 2 * bandGap + 2;
    if (cx >= x0 && cx <= x1) {
      const d = new Date(t);
      const lab = `${fmtShortDate(t)} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
      g.font = font(C, 11, 600, true);
      const w = g.measureText(lab).width + 8;
      drawCursor(g, C, cx, 4, bottom, null);
      const lx = cx + 6 + w > x1 ? cx - 6 - w : cx + 6;
      g.fillStyle = C.accent;
      g.fillRect(lx, 4, w, 15);
      g.fillStyle = C.accentContrast;
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      g.fillText(lab, lx + 4, 12);
    } else {
      const left = cx < x0;
      g.font = font(C, 11, 600);
      const lab = left ? `◀ cursor ${fmtShortDate(t)}` : `cursor ${fmtShortDate(t)} ▶`;
      const w = g.measureText(lab).width;
      g.fillStyle = C.accent;
      g.textAlign = left ? 'left' : 'right';
      g.textBaseline = 'top';
      g.fillText(lab, left ? x0 + 2 : x1 - 2, 4);
      void w;
    }

    if (hover && !dragging && hover.x >= x0 && hover.x <= x1 && hover.y <= bottom) {
      g.strokeStyle = withAlpha(C.text2, 0.5);
      g.lineWidth = 1;
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(Math.round(hover.x) + 0.5, py0);
      g.lineTo(Math.round(hover.x) + 0.5, bottom);
      g.stroke();
      g.setLineDash([]);
      showHoverTip();
    } else f.hideTip();
  }

  function showHoverTip() {
    if (!L || !data) return;
    const t = L.xs.invert(hover.x);
    const se = data.series;
    const sunC = interpAt(se.sun.clearanceDeg, se.t0Ms, se.stepS, t);
    const earthC = interpAt(se.earth.clearanceDeg, se.t0Ms, se.stepS, t);
    const inIv = (ivs) => ivs.some((iv) => t >= iv.startMs && t <= iv.endMs);
    const sm = data.summary;
    const lines = [
      h('div', { class: 'lc-tip-h', text: fmtUtc(t) }),
      h('div', { class: 'lc-tip-sun', text: `Sun ${fmtDeg(sunC, 1, true)} vs terrain · ${inIv(sm.intervals.sunlit) ? 'sunlit' : 'dark'}` }),
      h('div', { class: 'lc-tip-earth', text: `Earth ${fmtDeg(earthC, 1, true)} vs terrain · ${inIv(sm.intervals.comm) ? 'link' : 'no link'}` }),
    ];
    const near = data.events.events.filter((e) => Math.abs(L.xs(e.tMs) - hover.x) <= 6);
    for (const e of near.slice(0, 3)) lines.push(h('div', { class: 'lc-tip-ev', text: `${EVENT_LABEL[e.type]} ${fmtUtc(e.tMs)}` }));
    lines.push(h('div', { class: 'lc-tip-hint', text: 'Click or drag to move the time cursor' }));
    f.showTip(hover.x, hover.y, lines);
  }

  function setTimeFromX(x) {
    if (!L) return;
    const t = clamp(L.xs.invert(x), L.t0, L.t1);
    store.set({ timeMs: Math.round(t / 60000) * 60000 });
  }
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !L) return;
    canvas.setPointerCapture(e.pointerId);
    dragging = true;
    if (store.get().playing) store.set({ playing: false });
    setTimeFromX(localPoint(e, canvas).x);
    f.hideTip();
  });
  canvas.addEventListener('pointermove', (e) => {
    hover = localPoint(e, canvas);
    if (dragging) setTimeFromX(hover.x);
    surface.invalidate();
  });
  const stop = () => {
    dragging = false;
    surface.invalidate();
  };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  canvas.addEventListener('pointerleave', () => {
    hover = null;
    f.hideTip();
    surface.invalidate();
  });
  canvas.addEventListener('keydown', (e) => {
    if (!data) return;
    const nt = keyTime(e, store.get().timeMs, data.t0, data.t1);
    if (nt == null) return;
    e.preventDefault();
    store.set({ timeMs: nt });
  });

  const unsubs = [
    store.subscribe(() => load(), ['scenarios', 'activeId', 'opts', 'timelineDays']),
    store.subscribe(() => surface.invalidate(), ['timeMs']),
  ];
  load();
  return {
    destroy() {
      unsubs.forEach((u) => u());
      gate.cancel();
      surface.destroy();
      f.root.remove();
    },
  };
}

export function mountCompare(container, app) {
  const { nav, store } = app;
  const f = createFrame(container, { title: 'Mission windows compared (days after landing)', className: 'lc-timeline lc-compare' });
  let rows = [];
  let L = null;
  let hover = null;
  let dragRow = null;
  const gate = createGate();
  const readout = h('div', { class: 'lc-readout' });
  f.sub.append(readout);
  f.legend.append(legendItem('Sunlit', 'var(--sun)', 'box'), legendItem('Earth link', 'var(--earth)', 'box'), legendItem('Both', 'var(--both)', 'box'), legendItem('Time cursor', 'var(--accent)', 'line'));
  const ROW_H = 46;
  const AXIS_H = 24;
  const surface = createSurface(f.stage, draw, { minHeight: 80 });
  const canvas = surface.canvas;
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'slider');
  canvas.setAttribute('aria-label', 'Time cursor, compared scenarios');
  const eopts = () => engineOpts(store.get().opts);

  async function load() {
    const t = gate.next();
    const st = store.get();
    const scs = st.scenarios;
    f.stage.style.height = `${Math.max(1, scs.length) * ROW_H + AXIS_H + 8}px`;
    if (!scs.length) {
      rows = [];
      f.setStatus('empty', 'No scenarios to compare.');
      surface.invalidate();
      return;
    }
    const prev = new Map(rows.map((r) => [r.key, r]));
    const o = eopts();
    rows = scs.map((sc) => {
      const key = scenarioKey(sc, o, st.opts.observerHeightM);
      return prev.get(key) || { sc, key, summary: null, error: null };
    });
    if (rows.some((r) => !r.summary && !r.error)) f.setStatus('loading', 'Computing mission windows…');
    surface.invalidate();
    await Promise.all(
      rows.map(async (r) => {
        if (r.summary || r.error) return;
        try {
          const s = r.sc;
          r.summary = await memo(cacheFor(nav), 'cmp|' + r.key, async () => nav.summary(await app.ctxFor(s), s.t0Ms, s.durationDays, o));
        } catch (e) {
          r.error = e;
        }
      }),
    );
    if (!gate.ok(t)) return;
    f.setStatus('ready');
    f.sr.textContent = rows
      .map((r) =>
        r.summary
          ? `${r.sc.site.name}, landing ${fmtUtc(r.sc.t0Ms)}, ${r.sc.durationDays} d: sunlit ${fmtPercent(r.summary.sun.sunlitFraction)}, Earth link ${fmtPercent(r.summary.comm.fraction)}, both ${fmtPercent(r.summary.both.fraction)}.`
          : `${r.sc.site.name}: ${describeError(r.error)}`,
      )
      .join(' ');
    surface.invalidate();
  }

  function draw(g, s) {
    const C = s.colors;
    const W = s.width;
    const x0 = Math.min(190, Math.max(120, W * 0.28));
    const x1 = W - 12;
    const maxDays = Math.max(1, ...rows.map((r) => r.sc.durationDays));
    const xs = linearScale(0, maxDays * DAY_MS, x0, x1);
    L = { xs, x0, x1, maxDays };
    const tNow = store.get().timeMs;
    const top = 6;
    const bottom = top + rows.length * ROW_H;

    const step = [1, 2, 5, 7, 10, 14, 30, 60, 90].find((d) => (maxDays / d) * 60 <= x1 - x0) || 90;
    g.strokeStyle = C.grid;
    g.lineWidth = 1;
    g.beginPath();
    for (let d = 0; d <= maxDays + 1e-9; d += step) {
      const x = Math.round(xs(d * DAY_MS)) + 0.5;
      g.moveTo(x, top);
      g.lineTo(x, bottom);
    }
    g.stroke();
    g.font = font(C, 11, 400);
    g.fillStyle = C.text2;
    g.textAlign = 'center';
    g.textBaseline = 'top';
    for (let d = 0; d <= maxDays + 1e-9; d += step) g.fillText(d === 0 ? 'landing' : `+${d} d`, clamp(xs(d * DAY_MS), x0 + 20, x1 - 14), bottom + 6);

    rows.forEach((r, k) => {
      const y = top + k * ROW_H;
      const sc = r.sc;
      const active = sc.id === store.get().activeId;
      g.fillStyle = sc.color;
      g.fillRect(6, y + 6, 4, ROW_H - 14);
      g.textAlign = 'left';
      g.textBaseline = 'top';
      g.font = font(C, 12, active ? 700 : 600);
      g.fillStyle = C.text;
      let name = sc.site.name;
      while (name.length > 4 && g.measureText(name).width > x0 - 26) name = name.slice(0, -2);
      if (name !== sc.site.name) name = name.trimEnd() + '…';
      g.fillText(name, 16, y + 5);
      g.font = font(C, 11, 400);
      g.fillStyle = C.text2;
      const sm = r.summary;
      g.fillText(sm ? `sunlit ${fmtPercent(sm.sun.sunlitFraction)} · link ${fmtPercent(sm.comm.fraction)} · both ${fmtPercent(sm.both.fraction)}` : r.error ? 'error' : 'computing…', 16, y + 21);
      const bx1 = xs(sc.durationDays * DAY_MS);
      const bh = 8;
      const by = y + 6;
      if (r.error) {
        g.fillStyle = C.bad;
        g.font = font(C, 11, 500);
        g.fillText(describeError(r.error).slice(0, 90), x0 + 4, by + 4);
        return;
      }
      const shift = (ivs) => (ivs || []).map((iv) => ({ startMs: iv.startMs - sc.t0Ms, endMs: iv.endMs - sc.t0Ms }));
      [[sm?.intervals.sunlit, C.sun], [sm?.intervals.comm, C.earth], [sm?.intervals.both, C.both]].forEach(([ivs, color], j) => {
        const yy = by + j * (bh + 3);
        g.fillStyle = C.surface3;
        g.fillRect(x0, yy, bx1 - x0, bh);
        if (!sm) return;
        g.fillStyle = color;
        for (const p of intervalsToPixels(shift(ivs), xs, x0, bx1)) g.fillRect(p.x, yy, p.w, bh);
      });
      const rel = tNow - sc.t0Ms;
      if (rel >= 0 && rel <= sc.durationDays * DAY_MS) {
        const x = Math.round(xs(rel)) + 0.5;
        g.strokeStyle = C.accent;
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(x, by - 3);
        g.lineTo(x, by + 3 * bh + 9);
        g.stroke();
      }
      if (k < rows.length - 1) {
        g.strokeStyle = C.border;
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(6, y + ROW_H - 0.5);
        g.lineTo(x1, y + ROW_H - 0.5);
        g.stroke();
      }
    });
    L.top = top;
    const act = store.active();
    readout.replaceChildren(h('b', { text: fmtUtc(tNow) }), act ? h('span', { class: 'lc-muted', text: ` · ${((tNow - act.t0Ms) / DAY_MS).toFixed(1)} d after the active scenario's landing` }) : '');
    canvas.setAttribute('aria-valuetext', fmtUtc(tNow));

    if (hover && hover.x >= x0 && hover.x <= x1) {
      const k = Math.floor((hover.y - top) / ROW_H);
      const r = rows[k];
      if (r && r.summary) {
        const rel = xs.invert(hover.x);
        const t = r.sc.t0Ms + rel;
        const inIv = (ivs) => ivs.some((iv) => t >= iv.startMs && t <= iv.endMs);
        const I = r.summary.intervals;
        f.showTip(hover.x, hover.y, [
          h('div', { class: 'lc-tip-h', text: `${r.sc.site.name} · +${fmtDuration(rel / HOUR_MS)}` }),
          fmtUtc(t),
          `${inIv(I.sunlit) ? 'sunlit' : 'dark'} · ${inIv(I.comm) ? 'Earth link' : 'no link'}`,
          h('div', { class: 'lc-tip-hint', text: 'Click to move the time cursor here' }),
        ]);
      } else f.hideTip();
    } else f.hideTip();
  }

  function rowAt(y) {
    return rows[Math.floor((y - (L?.top ?? 6)) / ROW_H)] || null;
  }
  function setFrom(p, r) {
    if (!L || !r) return;
    const rel = clamp(L.xs.invert(p.x), 0, r.sc.durationDays * DAY_MS);
    store.set({ timeMs: Math.round((r.sc.t0Ms + rel) / 60000) * 60000 });
  }
  canvas.addEventListener('pointerdown', (e) => {
    const p = localPoint(e, canvas);
    const r = rowAt(p.y);
    if (!r || !L || p.x < L.x0) return;
    canvas.setPointerCapture(e.pointerId);
    dragRow = r;
    if (store.get().playing) store.set({ playing: false });
    setFrom(p, r);
  });
  canvas.addEventListener('pointermove', (e) => {
    hover = localPoint(e, canvas);
    if (dragRow) setFrom(hover, dragRow);
    surface.invalidate();
  });
  canvas.addEventListener('pointerup', () => (dragRow = null));
  canvas.addEventListener('pointercancel', () => (dragRow = null));
  canvas.addEventListener('pointerleave', () => {
    hover = null;
    f.hideTip();
    surface.invalidate();
  });
  canvas.addEventListener('keydown', (e) => {
    const act = store.active();
    if (!act) return;
    const nt = keyTime(e, store.get().timeMs, act.t0Ms, act.t0Ms + act.durationDays * DAY_MS);
    if (nt == null) return;
    e.preventDefault();
    store.set({ timeMs: nt });
  });

  const unsubs = [store.subscribe(() => load(), ['scenarios', 'opts']), store.subscribe(() => surface.invalidate(), ['timeMs', 'activeId'])];
  load();
  return {
    destroy() {
      unsubs.forEach((u) => u());
      gate.cancel();
      surface.destroy();
      f.root.remove();
    },
  };
}
