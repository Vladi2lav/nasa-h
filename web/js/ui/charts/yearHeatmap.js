import {
  DAY_MS, HOUR_MS, clamp, fmtUtc, fmtPercent, monthName, LruCache, memo, stableKey, engineOpts, coverageYears,
  createGate, describeError, createFrame, createSurface, segmented, legendItem, font, localPoint, withAlpha,
  parseColor, mixColor, h,
} from './chartUtil.js';

const caches = new WeakMap();
const cacheFor = (nav) => {
  if (!caches.has(nav)) caches.set(nav, new LruCache(8));
  return caches.get(nav);
};

const LAYERS = {
  sun: { label: 'Sun', matrix: 'sun', pct: 'sunlitPercent', color: 'sun', what: 'mean visible fraction of the solar disc' },
  comm: { label: 'Earth link', matrix: 'comm', pct: 'commPercent', color: 'earth', what: 'fraction of the hour with an Earth link' },
  both: { label: 'Both', matrix: 'both', pct: 'bothPercent', color: 'both', what: 'fraction of the hour sunlit and with a link' },
};

export function mount(container, app) {
  const { nav, store } = app;
  const f = createFrame(container, { title: 'Year at a glance', className: 'lc-year' });
  const [yMin, yMax] = coverageYears(nav.coverage);
  let layer = 'sun';
  let follow = true;
  let year = clamp(new Date(store.get().timeMs).getUTCFullYear(), yMin, yMax);
  let sc = null;
  let ym = null;
  let image = null;
  let imageKey = '';
  let hover = null;
  let L = null;
  const gate = createGate();

  const layerSeg = segmented(
    Object.entries(LAYERS).map(([value, l]) => ({ value, label: l.label, title: l.what })),
    layer,
    (v) => {
      layer = v;
      layerSeg.set(v);
      renderLegend();
      renderSr();
      surface.invalidate();
    },
    'Heatmap layer',
  );
  const prevBtn = h('button', { type: 'button', class: 'lc-btn lc-btn--icon', 'aria-label': 'Previous year', title: 'Previous year', onclick: () => stepYear(-1) }, '◀');
  const nextBtn = h('button', { type: 'button', class: 'lc-btn lc-btn--icon', 'aria-label': 'Next year', title: 'Next year', onclick: () => stepYear(1) }, '▶');
  const yearLbl = h('span', { class: 'lc-year-label', 'aria-live': 'polite' });
  const followBtn = h('button', { type: 'button', class: 'lc-btn', title: 'Show the year of the time cursor', onclick: () => { follow = true; syncYear(); } }, 'Cursor year');
  f.tools.append(layerSeg.el, h('div', { class: 'lc-seg lc-stepper', role: 'group', 'aria-label': 'Year' }, prevBtn, yearLbl, nextBtn), followBtn);
  const readout = h('div', { class: 'lc-readout' });
  f.sub.append(readout);

  const surface = createSurface(f.stage, draw, { minHeight: 230 });
  surface.onTheme = () => (imageKey = '');
  const canvas = surface.canvas;
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'slider');
  canvas.setAttribute('aria-roledescription', 'year heatmap');
  canvas.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight ArrowUp ArrowDown');
  const eopts = () => engineOpts(store.get().opts);

  function stepYear(d) {
    follow = false;
    year = clamp(year + d, yMin, yMax);
    load();
  }
  function syncYear() {
    const y = clamp(new Date(store.get().timeMs).getUTCFullYear(), yMin, yMax);
    if (y !== year) {
      year = y;
      load();
    } else surface.invalidate();
  }

  function renderLegend() {
    const l = LAYERS[layer];
    const basis = ym?.commBasis === 'link' ? 'Earth link = Earth ≥ comm mask above terrain and a ground station sees the Moon' : 'Earth link = Earth ≥ comm mask above terrain (direct-to-Earth geometry)';
    f.legend.replaceChildren(
      h('span', { class: 'lc-leg' }, h('i', { class: 'lc-ramp', style: `--c:var(--${l.color})`, 'aria-hidden': 'true' }), `0 → 100 % ${l.what}`),
      h('span', { class: 'lc-leg lc-leg--note', text: layer === 'sun' ? 'Hours UTC, top = 00:00' : basis }),
    );
  }

  async function load() {
    yearLbl.textContent = String(year);
    prevBtn.disabled = year <= yMin;
    nextBtn.disabled = year >= yMax;
    sc = store.active();
    const t = gate.next();
    if (!sc) {
      ym = null;
      f.setStatus('empty', 'No scenario selected.');
      return surface.invalidate();
    }
    const o = eopts();
    const s = sc;
    const key = [s.site.lat.toFixed(5), s.site.lon.toFixed(5), store.get().opts.observerHeightM, year, stableKey(o)].join('|');
    if (!cacheFor(nav).get(key)) f.setStatus('loading', `Computing ${year}: 8 760 hours of Sun and Earth visibility…`);
    try {
      const r = await memo(cacheFor(nav), key, async () => nav.yearMap(await app.ctxFor(s), year, o));
      if (!gate.ok(t)) return;
      ym = r;
      imageKey = '';
      f.setStatus('ready');
      renderLegend();
      renderSr();
      surface.invalidate();
    } catch (e) {
      if (!gate.ok(t)) return;
      ym = null;
      f.setStatus('error', describeError(e));
      surface.invalidate();
    }
  }

  function annual(key) {
    const m = ym[key];
    let s = 0;
    for (let i = 0; i < m.length; i++) s += m[i];
    return s / (m.length * 255);
  }

  function renderSr() {
    if (!ym || !sc) return;
    const l = LAYERS[layer];
    const months = ym.monthly.map((m) => ({ m: m.month, v: m[l.pct] }));
    const best = months.reduce((a, b) => (b.v > a.v ? b : a));
    const worst = months.reduce((a, b) => (b.v < a.v ? b : a));
    f.sr.textContent =
      `Year ${ym.year} at ${sc.site.name}. Sun: ${fmtPercent(annual('sun'))} mean disc visibility; Earth link ${fmtPercent(annual('comm'))}; both ${fmtPercent(annual('both'))}. ` +
      `${l.label} layer: best month ${monthName(best.m - 1)} ${best.v.toFixed(0)}%, worst ${monthName(worst.m - 1)} ${worst.v.toFixed(0)}%.`;
    canvas.setAttribute('aria-label', f.sr.textContent);
  }

  function buildImage(C) {
    const key = `${layer}|${C.theme}|${ym.year}|${ym.startMs}`;
    if (key === imageKey && image) return image;
    const days = ym.days;
    const off = document.createElement('canvas');
    off.width = days;
    off.height = 24;
    const g = off.getContext('2d');
    const img = g.createImageData(days, 24);
    const lo = parseColor(C.surface3) || [30, 40, 60, 1];
    const hi = parseColor(C[LAYERS[layer].color]) || [245, 165, 36, 1];
    const lut = new Uint8ClampedArray(256 * 3);
    for (let v = 0; v < 256; v++) {
      const c = mixColor(lo, hi, Math.pow(v / 255, 0.8));
      lut[v * 3] = c[0];
      lut[v * 3 + 1] = c[1];
      lut[v * 3 + 2] = c[2];
    }
    const m = ym[LAYERS[layer].matrix];
    for (let d = 0; d < days; d++) {
      for (let hr = 0; hr < 24; hr++) {
        const v = m[d * 24 + hr];
        const p = (hr * days + d) * 4;
        img.data[p] = lut[v * 3];
        img.data[p + 1] = lut[v * 3 + 1];
        img.data[p + 2] = lut[v * 3 + 2];
        img.data[p + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    image = off;
    imageKey = key;
    return off;
  }

  function draw(g, s) {
    const C = s.colors;
    const W = s.width;
    const H = s.height;
    const x0 = 44;
    const x1 = W - 10;
    const pw = x1 - x0;
    const barsH = clamp(Math.round(H * 0.24), 44, 80);
    const top = 6;
    const monthRow = 16;
    const heatH = Math.max(72, H - top - monthRow - barsH - 22);
    const heatB = top + heatH;
    L = null;
    renderReadout();
    if (!ym) return;
    const days = ym.days;
    const dx = pw / days;
    const dy = heatH / 24;
    L = { x0, x1, top, heatB, dx, dy, days };

    g.imageSmoothingEnabled = false;
    g.drawImage(buildImage(C), 0, 0, days, 24, x0, top, pw, heatH);

    const monthX = [];
    for (let m = 0; m <= 12; m++) monthX.push(x0 + ((Date.UTC(ym.year, m, 1) - ym.startMs) / DAY_MS) * dx);
    g.strokeStyle = withAlpha(C.bg, 0.8);
    g.lineWidth = 1;
    g.beginPath();
    for (let m = 1; m < 12; m++) {
      const x = Math.round(monthX[m]) + 0.5;
      g.moveTo(x, top);
      g.lineTo(x, heatB);
    }
    g.stroke();
    g.strokeStyle = C.border;
    g.strokeRect(x0 - 0.5, top - 0.5, pw + 1, heatH + 1);
    const narrow = monthX[1] - monthX[0] < 26;
    g.font = font(C, 11, 500);
    g.fillStyle = C.text2;
    g.textAlign = 'center';
    g.textBaseline = 'top';
    for (let m = 0; m < 12; m++) g.fillText(narrow ? monthName(m)[0] : monthName(m), (monthX[m] + monthX[m + 1]) / 2, heatB + 3);

    g.textAlign = 'right';
    g.textBaseline = 'middle';
    g.font = font(C, 11, 400, true);
    const hStep = heatH < 120 ? 12 : 6;
    for (let hr = 0; hr <= 24; hr += hStep) g.fillText(`${String(hr).padStart(2, '0')}h`, x0 - 5, clamp(top + hr * dy, top + 5, heatB - 5));

    const l = LAYERS[layer];
    const bTop = heatB + monthRow + 14;
    const bBot = H - 4;
    const bh = bBot - bTop;
    g.strokeStyle = C.grid;
    g.beginPath();
    g.moveTo(x0, Math.round(bTop) + 0.5);
    g.lineTo(x1, Math.round(bTop) + 0.5);
    g.moveTo(x0, Math.round(bBot) + 0.5);
    g.lineTo(x1, Math.round(bBot) + 0.5);
    g.stroke();
    g.fillStyle = C.text3;
    g.font = font(C, 10, 500);
    g.textAlign = 'right';
    g.fillText('100%', x0 - 5, bTop + 1);
    g.fillText('0', x0 - 5, bBot - 2);
    for (const mo of ym.monthly) {
      const m = mo.month - 1;
      const v = mo[l.pct];
      const bx = monthX[m] + 2;
      const bw = monthX[m + 1] - monthX[m] - 4;
      const hgt = (v / 100) * bh;
      g.fillStyle = C[l.color];
      g.fillRect(bx, bBot - hgt, bw, hgt);
      if (bw >= 24) {
        g.font = font(C, 10.5, 600);
        g.textAlign = 'center';
        g.textBaseline = 'bottom';
        const inside = hgt > 16;
        g.fillStyle = inside ? C.accentContrast : C.text2;
        g.fillText(`${Math.round(v)}%`, bx + bw / 2, inside ? bBot - hgt + 14 : bBot - hgt - 1);
      }
    }

    const tNow = store.get().timeMs;
    if (tNow >= ym.startMs && tNow < ym.startMs + days * DAY_MS) {
      const d = Math.floor((tNow - ym.startMs) / DAY_MS);
      const hr = new Date(tNow).getUTCHours();
      const cx = x0 + d * dx;
      const cy = top + hr * dy;
      const cw = Math.max(dx, 4);
      const ch = Math.max(dy, 4);
      g.strokeStyle = withAlpha(C.accent, 0.5);
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(Math.round(cx + dx / 2) + 0.5, top);
      g.lineTo(Math.round(cx + dx / 2) + 0.5, heatB);
      g.stroke();
      g.strokeStyle = C.accent;
      g.lineWidth = 2;
      g.strokeRect(cx + dx / 2 - cw / 2 - 1, cy + dy / 2 - ch / 2 - 1, cw + 2, ch + 2);
    }

    const cell = hover && cellAt(hover.x, hover.y);
    if (cell) {
      g.strokeStyle = C.text;
      g.lineWidth = 1;
      g.strokeRect(x0 + cell.d * dx - 0.5, top + cell.hr * dy - 0.5, Math.max(dx, 2) + 1, Math.max(dy, 2) + 1);
      const t = ym.startMs + cell.d * DAY_MS + cell.hr * HOUR_MS;
      const i = cell.d * 24 + cell.hr;
      f.showTip(hover.x, hover.y, [
        h('div', { class: 'lc-tip-h', text: `${fmtUtc(t)} + 1 h` }),
        h('div', { class: 'lc-tip-sun', text: `Sun: ${fmtPercent(ym.sun[i] / 255)} of disc visible (mean)` }),
        h('div', { class: 'lc-tip-earth', text: `Earth link: ${fmtPercent(ym.comm[i] / 255)} of the hour` }),
        h('div', { class: 'lc-tip-both', text: `Both: ${fmtPercent(ym.both[i] / 255)} of the hour` }),
        h('div', { class: 'lc-tip-hint', text: 'Click to move the time cursor here' }),
      ]);
    } else f.hideTip();
  }

  function renderReadout() {
    const t = store.get().timeMs;
    readout.replaceChildren(h('b', { text: fmtUtc(t) }));
    if (!ym) return;
    if (t < ym.startMs || t >= ym.startMs + ym.days * DAY_MS) {
      readout.append(h('span', { class: 'lc-muted', text: ` · cursor is outside ${ym.year}` }));
      return;
    }
    const i = Math.floor((t - ym.startMs) / HOUR_MS);
    readout.append(
      h('span', { class: 'lc-r-sun', text: ` · Sun ${fmtPercent(ym.sun[i] / 255)}` }),
      h('span', { class: 'lc-r-earth', text: ` · link ${fmtPercent(ym.comm[i] / 255)}` }),
      h('span', { class: 'lc-r-both', text: ` · both ${fmtPercent(ym.both[i] / 255)}` }),
      h('span', { class: 'lc-muted', text: ' this hour' }),
    );
    canvas.setAttribute('aria-valuetext', fmtUtc(t));
  }

  function cellAt(x, y) {
    if (!L || x < L.x0 || x >= L.x1 || y < L.top || y >= L.heatB) return null;
    return { d: clamp(Math.floor((x - L.x0) / L.dx), 0, L.days - 1), hr: clamp(Math.floor((y - L.top) / L.dy), 0, 23) };
  }

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
    const p = localPoint(e, canvas);
    const c = cellAt(p.x, p.y);
    if (!c || !ym) return;
    store.set({ timeMs: ym.startMs + c.d * DAY_MS + c.hr * HOUR_MS + HOUR_MS / 2, playing: false });
  });
  canvas.addEventListener('keydown', (e) => {
    if (!ym) return;
    const t = store.get().timeMs;
    const map = { ArrowLeft: -DAY_MS, ArrowRight: DAY_MS, ArrowUp: -HOUR_MS, ArrowDown: HOUR_MS };
    const d = map[e.key] * (e.shiftKey ? 7 : 1);
    if (!d) return;
    e.preventDefault();
    const cov = nav.coverage;
    store.set({ timeMs: clamp(t + d, cov.startMs, cov.endMs) });
  });

  const unsubs = [
    store.subscribe(() => load(), ['scenarios', 'activeId', 'opts']),
    store.subscribe(() => (follow ? syncYear() : surface.invalidate()), ['timeMs']),
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
