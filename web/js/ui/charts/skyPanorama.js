import {
  DAY_MS, HOUR_MS, LUNAR_DAY_MS, clamp, linearScale, ticks, degStep, wrap360, wrap180, cardinal,
  fmtUtc, fmtShortDate, fmtDuration, fmtDeg, fmtPercent, LruCache, memo, stableKey, engineOpts,
  createGate, describeError, createLabelPlacer, createFrame, createSurface, segmented, legendItem,
  font, localPoint, withAlpha, parseColor, mixColor, rgba, h,
} from './chartUtil.js';

const TRACK_STEP_S = 1800;
const caches = new WeakMap();
const cacheFor = (nav) => {
  if (!caches.has(nav)) caches.set(nav, new LruCache(12));
  return caches.get(nav);
};

const PRESETS = {
  full: { min: -5, max: 90, label: 'Full sky', title: 'Elevation −5° … 90°' },
  horizon: { min: -10, max: 10, label: 'Horizon ±10°', title: 'Elevation −10° … +10°: the polar view' },
};

const SOURCE_TEXT = {
  precomputed: 'precomputed high-resolution LOLA horizon',
  computed: 'horizon ray-cast in the browser from the web LOLA DEM',
  sphere: 'no terrain data: smooth-sphere horizon (geometric dip only)',
};

export function mount(container, app) {
  const { nav, store } = app;
  const f = createFrame(container, { title: 'Sky panorama', className: 'lc-sky' });

  let sc = null;
  let ctx = null;
  let siteKey = '';
  let track = null;
  let trackKey = '';
  let inst = null;
  let next = null;
  let error = null;
  let preset = 'full';
  let centreMode = 'sun';
  let centreAz = 180;
  let spanDeg = 360;
  let hover = null;
  let drag = null;
  let layout = null;
  const siteGate = createGate();
  const trackGate = createGate();

  const presetSeg = segmented(
    Object.entries(PRESETS).map(([value, p]) => ({ value, label: p.label, title: p.title })),
    preset,
    (v) => {
      preset = v;
      presetSeg.set(v);
      surface.invalidate();
    },
    'Elevation range',
  );
  const centreSel = h(
    'select',
    { class: 'lc-select', 'aria-label': 'Centre the panorama on', onchange: () => setCentre(centreSel.value) },
    h('option', { value: 'sun', text: 'Centre: Sun' }),
    h('option', { value: 'earth', text: 'Centre: Earth' }),
    h('option', { value: '0', text: 'Centre: North' }),
    h('option', { value: '90', text: 'Centre: East' }),
    h('option', { value: '180', text: 'Centre: South' }),
    h('option', { value: '270', text: 'Centre: West' }),
    h('option', { value: 'free', text: 'Centre: free (dragged)', hidden: true }),
  );
  const zoomOut = h('button', { type: 'button', class: 'lc-btn lc-btn--icon', title: 'Zoom out (azimuth)', 'aria-label': 'Zoom out in azimuth', onclick: () => zoomBy(1.5) }, '−');
  const zoomIn = h('button', { type: 'button', class: 'lc-btn lc-btn--icon', title: 'Zoom in (azimuth)', 'aria-label': 'Zoom in in azimuth', onclick: () => zoomBy(1 / 1.5) }, '+');
  const resetBtn = h('button', { type: 'button', class: 'lc-btn', title: 'Show all 360° centred on the Sun (key 0)', onclick: resetView }, '360°');
  f.tools.append(presetSeg.el, centreSel, h('div', { class: 'lc-seg' }, zoomOut, zoomIn, resetBtn));

  const sunPill = h('div', { class: 'lc-pill lc-pill--sun' });
  const earthPill = h('div', { class: 'lc-pill lc-pill--earth' });
  f.sub.append(sunPill, earthPill);

  f.legend.append(
    legendItem('Sun', 'var(--sun)', 'dot'),
    legendItem('Earth', 'var(--earth)', 'dot'),
    legendItem('Track, next lunar day (dots = days)', 'var(--text-2)', 'line'),
    legendItem('Behind terrain', 'var(--text-2)', 'dash'),
    legendItem('Terrain horizon', 'var(--terrain)', 'box'),
  );
  const scaleNote = h('span', { class: 'lc-leg lc-leg--note' });
  f.legend.append(scaleNote);

  const surface = createSurface(f.stage, draw, { minHeight: 200 });
  const canvas = surface.canvas;
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-roledescription', 'sky panorama');
  canvas.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight + - 0');

  const eopts = () => engineOpts(store.get().opts);

  async function loadSite() {
    sc = store.active();
    const t = siteGate.next();
    trackGate.cancel();
    if (!sc) {
      ctx = null;
      track = null;
      inst = null;
      f.setStatus('empty', 'No scenario selected.');
      surface.invalidate();
      return;
    }
    const key = `${sc.site.lat},${sc.site.lon},${store.get().opts.observerHeightM}`;
    if (key !== siteKey) {
      ctx = null;
      track = null;
      inst = null;
      next = null;
      trackKey = '';
      f.setStatus('loading', 'Preparing terrain horizon…');
      preset = Math.abs(sc.site.lat) > 75 ? 'horizon' : 'full';
      presetSeg.set(preset);
    }
    try {
      const c = await app.ctxFor(sc);
      if (!siteGate.ok(t)) return;
      ctx = c;
      siteKey = key;
      next = null;
      renderCaption();
      refreshTime();
    } catch (e) {
      if (!siteGate.ok(t)) return;
      error = e;
      f.setStatus('error', describeError(e));
    }
  }

  function refreshTime() {
    if (!ctx) return;
    ensureTrack();
    refreshInstant();
    refreshNext();
    surface.invalidate();
  }

  async function ensureTrack() {
    const t = store.get().timeMs;
    const cov = nav.coverage;
    let anchor = Math.floor(t / DAY_MS) * DAY_MS;
    const key = `${siteKey}|${stableKey(eopts())}|${anchor}`;
    if (key === trackKey) return;
    trackKey = key;
    const g = trackGate.next();
    const t0 = Math.max(anchor, cov.startMs);
    const t1 = Math.min(anchor + LUNAR_DAY_MS + DAY_MS, cov.endMs);
    if (!(t1 > t0)) {
      track = null;
      return;
    }
    if (!track) f.setStatus('loading', 'Computing Sun and Earth tracks…');
    try {
      const c = ctx;
      const s = await memo(cacheFor(nav), `${key}|${t0}|${t1}`, () => nav.series(c, t0, t1, TRACK_STEP_S, eopts()));
      if (!trackGate.ok(g)) return;
      track = s;
      if (!error) f.setStatus('ready');
      surface.invalidate();
    } catch (e) {
      if (!trackGate.ok(g)) return;
      track = null;
      trackKey = '';
      error = e;
      f.setStatus('error', describeError(e));
    }
  }

  let instBusy = false;
  let instAgain = false;
  async function refreshInstant() {
    if (instBusy) {
      instAgain = true;
      return;
    }
    instBusy = true;
    try {
      do {
        instAgain = false;
        const c = ctx;
        const t = store.get().timeMs;
        try {
          const r = await nav.instant(c, t, eopts());
          if (c === ctx) {
            inst = r;
            if (error) {
              error = null;
              f.setStatus(track ? 'ready' : 'loading');
            }
          }
        } catch (e) {
          if (c === ctx) {
            inst = null;
            error = e;
            f.setStatus('error', describeError(e));
          }
        }
        surface.invalidate();
        renderStatus();
      } while (instAgain && ctx);
    } finally {
      instBusy = false;
    }
  }

  const nextValid = (t) => {
    if (!next || t < next.fromMs) return false;
    const evs = [next.sunsetMs, next.sunriseMs, next.earthsetMs, next.earthriseMs, next.searchEndMs].filter((x) => x != null);
    return t < Math.min(...evs);
  };
  let nextBusy = false;
  let nextAgain = false;
  async function refreshNext() {
    if (nextValid(store.get().timeMs)) return renderStatus();
    if (nextBusy) {
      nextAgain = true;
      return;
    }
    nextBusy = true;
    try {
      do {
        nextAgain = false;
        const c = ctx;
        const t = store.get().timeMs;
        try {
          const r = await nav.nextEvents(c, t, eopts());
          if (c === ctx) next = r;
        } catch {
          if (c === ctx) next = null;
        }
        renderStatus();
        surface.invalidate();
      } while (nextAgain && ctx && !nextValid(store.get().timeMs));
    } finally {
      nextBusy = false;
    }
  }

  function countdown(body) {
    const t = store.get().timeMs;
    if (!nextValid(t)) return null;
    const up = body === 'sun' ? next.sunlitNow : next.earthVisibleNow;
    const ms = body === 'sun' ? (up ? next.sunsetMs : next.sunriseMs) : up ? next.earthsetMs : next.earthriseMs;
    const verb = body === 'sun' ? (up ? 'sets' : 'rises') : up ? 'sets' : 'rises';
    if (ms == null) return { up, text: up ? `no ${body === 'sun' ? 'sunset' : 'Earthset'} within ${Math.round((next.searchEndMs - t) / DAY_MS)} d` : `no ${body === 'sun' ? 'sunrise' : 'Earthrise'} within ${Math.round((next.searchEndMs - t) / DAY_MS)} d`, short: up ? 'stays up' : 'stays down' };
    const hrs = (ms - t) / HOUR_MS;
    return { up, text: `${verb} in ${fmtDuration(hrs)} (${fmtUtc(ms)})`, short: `${verb} in ${fmtDuration(hrs)}`, ms };
  }

  function bodyStatus(body) {
    const b = inst?.[body];
    if (!b) return null;
    const name = body === 'sun' ? 'Sun' : 'Earth';
    const cd = countdown(body);
    let state;
    if (body === 'sun') state = inst.sunlit ? `Sunlit, ${fmtPercent(b.visibleFraction)} of disc` : b.visibleFraction > 0 ? `Mostly hidden, ${fmtPercent(b.visibleFraction)} of disc` : 'Behind terrain';
    else state = b.clearanceDeg >= (store.get().opts.commMaskDeg ?? 2) ? 'In view' : b.clearanceDeg >= 0 ? 'Low, below comm mask' : 'Behind terrain';
    return { name, state, clearance: `${fmtDeg(b.clearanceDeg, 1, true)} vs terrain`, cd, b };
  }

  function renderStatus() {
    for (const [pill, body] of [[sunPill, 'sun'], [earthPill, 'earth']]) {
      const s = bodyStatus(body);
      pill.replaceChildren();
      if (!s) {
        pill.append(h('i', { class: 'lc-pill-icon', 'aria-hidden': 'true' }), h('b', { text: body === 'sun' ? 'Sun' : 'Earth' }), ' —');
        continue;
      }
      pill.dataset.up = String(body === 'sun' ? inst.sunlit : s.b.clearanceDeg >= 0);
      pill.append(
        h('i', { class: 'lc-pill-icon', 'aria-hidden': 'true' }),
        h('b', { text: s.name }),
        h('span', { class: 'lc-pill-state', text: s.state }),
        h('span', { class: 'lc-pill-num', text: s.clearance }),
        s.cd ? h('span', { class: 'lc-pill-cd', text: s.cd.short, title: s.cd.text }) : null,
      );
    }
    renderSr();
  }

  function renderCaption() {
    if (!ctx) return;
    const src = ctx.horizonSource;
    f.caption.replaceChildren(
      h('span', { class: `lc-src lc-src--${src}`, text: src === 'sphere' ? 'Warning: ' : '' }),
      `Horizon data: ${SOURCE_TEXT[src] || src}`,
      ctx.horizon?.source ? ` — ${ctx.horizon.source}` : '',
      ctx.horizon?.maxRangeKm && src !== 'sphere' ? ` (rays to ${Math.round(ctx.horizon.maxRangeKm)} km)` : '',
      '.',
    );
    f.caption.dataset.source = src;
  }

  function renderSr() {
    if (!sc) return (f.sr.textContent = '');
    const parts = [`Sky panorama for ${sc.site.name} at ${fmtUtc(store.get().timeMs)}.`];
    for (const body of ['sun', 'earth']) {
      const s = bodyStatus(body);
      if (!s) continue;
      parts.push(
        `${s.name}: azimuth ${s.b.azDeg.toFixed(0)}° (${cardinal(s.b.azDeg)}), elevation ${fmtDeg(s.b.elDeg)}, ` +
          `${fmtDeg(Math.abs(s.b.clearanceDeg))} ${s.b.clearanceDeg >= 0 ? 'above' : 'below'} the terrain horizon, ` +
          `${fmtPercent(s.b.visibleFraction)} of the disc visible${s.cd ? `; ${s.cd.text}` : ''}.`,
      );
    }
    if (ctx) parts.push(`Horizon data: ${SOURCE_TEXT[ctx.horizonSource] || ctx.horizonSource}.`);
    f.sr.textContent = parts.join(' ');
    canvas.setAttribute('aria-label', parts.slice(0, 3).join(' '));
  }

  function currentCentre() {
    if (centreMode === 'sun' && inst) return inst.sun.azDeg;
    if (centreMode === 'earth' && inst) return inst.earth.azDeg;
    return centreAz;
  }
  function setCentre(v) {
    if (v === 'sun' || v === 'earth') centreMode = v;
    else if (v !== 'free') {
      centreMode = 'fixed';
      centreAz = Number(v);
    }
    centreSel.value = v;
    surface.invalidate();
  }
  function goFree() {
    if (centreMode !== 'free') {
      centreAz = currentCentre();
      centreMode = 'free';
      centreSel.value = 'free';
    }
  }
  function zoomBy(k, anchorX = null) {
    const L = layout;
    const old = spanDeg;
    spanDeg = clamp(spanDeg * k, 8, 360);
    if (L && anchorX != null && centreMode === 'free') {
      const u = (anchorX - L.px0) / L.pw - 0.5;
      centreAz = centreAz + u * old - u * spanDeg;
    }
    surface.invalidate();
  }
  function resetView() {
    spanDeg = 360;
    setCentre('sun');
  }

  function draw(g, s) {
    const C = s.colors;
    const W = s.width;
    const H = s.height;
    const P = PRESETS[preset];
    const px0 = 36;
    const px1 = W - 8;
    const py0 = 10;
    const py1 = H - 24;
    const pw = px1 - px0;
    const ph = py1 - py0;
    const c = currentCentre();
    const S = spanDeg;
    const ys = linearScale(P.min, P.max, py1, py0);
    const pxPerDegY = Math.abs(ys.k);
    const dAz = (az) => wrap180(az - c);
    const xOfD = (d) => px0 + (d / S + 0.5) * pw;
    const xs = (az) => xOfD(dAz(az));
    const azAt = (x) => c + ((x - px0) / pw - 0.5) * S;
    layout = { px0, px1, py0, py1, pw, ph, c, S, ys, xs, azAt };

    g.fillStyle = C.surface;
    g.fillRect(px0, py0, pw, ph);

    g.save();
    g.beginPath();
    g.rect(px0, py0, pw, ph);
    g.clip();

    const eStep = degStep(P.max - P.min, ph);
    const eTicks = ticks(P.min, P.max, 99, eStep);
    g.lineWidth = 1;
    g.strokeStyle = C.grid;
    g.beginPath();
    for (const e of eTicks) {
      const y = Math.round(ys(e)) + 0.5;
      g.moveTo(px0, y);
      g.lineTo(px1, y);
    }
    const aStep = [1, 2, 5, 10, 15, 30, 45, 90].find((st) => (st / S) * pw >= 46) || 90;
    const aTicks = ticks(c - S / 2, c + S / 2, 999, aStep);
    for (const a of aTicks) {
      const x = Math.round(xOfD(a - c)) + 0.5;
      g.moveTo(x, py0);
      g.lineTo(x, py1);
    }
    g.stroke();
    g.setLineDash([2, 4]);
    g.strokeStyle = C.text3;
    g.beginPath();
    const y0 = Math.round(ys(0)) + 0.5;
    g.moveTo(px0, y0);
    g.lineTo(px1, y0);
    g.stroke();
    g.setLineDash([]);

    const nowMs = store.get().timeMs;
    const bodies = [
      { key: 'sun', name: 'Sun', color: C.sun },
      { key: 'earth', name: 'Earth', color: C.earth },
    ];

    const trackPts = [];
    if (track) for (const b of bodies) drawTrack(g, b, xOfD, dAz, ys, nowMs, false, trackPts);

    const drawn = {};
    if (inst) {
      for (const b of bodies) {
        const bi = inst[b.key];
        const rPx = bi.angularRadiusDeg * pxPerDegY;
        const d = dAz(bi.azDeg);
        const x = xOfD(d);
        const y = ys(bi.elDeg);
        const onX = Math.abs(d) <= S / 2;
        const onY = bi.elDeg >= P.min - bi.angularRadiusDeg && bi.elDeg <= P.max + bi.angularRadiusDeg;
        drawn[b.key] = { x, y, rPx, onX, onY, toScale: rPx >= 2.5, bi, ...b };
        if (!onX || !onY) continue;
        if (rPx >= 2.5) disc(g, x, y, rPx, b);
      }
    }

    const hz = ctx?.horizon;
    if (hz) {
      let maxE = -90;
      const pts = [];
      for (let x = px0; x <= px1 + 1; x += 1) {
        const e = hz.elevationAt(wrap360(azAt(x)));
        if (e > maxE) maxE = e;
        pts.push(x, clamp(ys(e), py0 - 2, py1 + 2));
      }
      void maxE;
      g.beginPath();
      g.moveTo(px0, py1 + 2);
      for (let i = 0; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
      g.lineTo(px1 + 1, py1 + 2);
      g.closePath();
      g.fillStyle = C.terrainFill;
      g.fill();
      g.beginPath();
      for (let i = 0; i < pts.length; i += 2) (i ? g.lineTo : g.moveTo).call(g, pts[i], pts[i + 1]);
      g.lineWidth = 1.5;
      g.strokeStyle = C.terrain;
      g.stroke();
    }

    const place = createLabelPlacer(3);
    if (track) {
      for (const b of bodies) drawTrack(g, b, xOfD, dAz, ys, nowMs, true, trackPts);
    }

    const labelQueue = [];
    for (const b of bodies) {
      const d = drawn[b.key];
      if (!d) continue;
      const { x, y, rPx, onX, onY, bi } = d;
      if (onX && onY) {
        if (d.toScale) {
          if (bi.visibleFraction < 0.999) {
            g.setLineDash([3, 2]);
            g.strokeStyle = b.color;
            g.lineWidth = 1.25;
            g.beginPath();
            g.arc(x, y, rPx, 0, Math.PI * 2);
            g.stroke();
            g.setLineDash([]);
          }
        } else icon(g, x, y, b, bi.clearanceDeg >= 0, C);
        labelQueue.push({ d, x, y, r: d.toScale ? rPx : 8 });
      } else {
        edgeMarker(g, C, d, P, px0, px1, py0, py1, place);
      }
    }
    for (const q of labelQueue) bodyLabel(g, C, q, px0, px1, py0, py1, place);
    if (track) dayTicks(g, C, bodies, xOfD, dAz, ys, S, place, py1);

    if (hover && hover.x >= px0 && hover.x <= px1 && hover.y >= py0 && hover.y <= py1) {
      g.strokeStyle = withAlpha(C.text2, 0.45);
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(Math.round(hover.x) + 0.5, py0);
      g.lineTo(Math.round(hover.x) + 0.5, py1);
      g.moveTo(px0, Math.round(hover.y) + 0.5);
      g.lineTo(px1, Math.round(hover.y) + 0.5);
      g.stroke();
    }
    g.restore();

    g.strokeStyle = C.border;
    g.lineWidth = 1;
    g.strokeRect(px0 + 0.5, py0 + 0.5, pw - 1, ph - 1);
    g.fillStyle = C.text2;
    g.font = font(C, 11, 400, true);
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    for (const e of eTicks) {
      const y = ys(e);
      if (y < py0 + 4 || y > py1 - 2) continue;
      g.fillText(`${e}°`, px0 - 4, y);
    }
    g.textAlign = 'center';
    g.textBaseline = 'top';
    const azPlace = createLabelPlacer(4);
    const sorted = [...aTicks].sort((a, b) => (wrap360(a) % 45 === 0 ? 0 : 1) - (wrap360(b) % 45 === 0 ? 0 : 1));
    for (const a of sorted) {
      const x = xOfD(a - c);
      const w = wrap360(Math.round(a * 100) / 100);
      const isCard = w % 45 === 0;
      const label = isCard ? `${cardinal(w)}${S <= 120 ? ' ' + w + '°' : ''}` : `${w}°`;
      g.font = font(C, isCard ? 12 : 11, isCard ? 700 : 400, !isCard);
      const tw = g.measureText(label).width;
      if (x - tw / 2 < 2 || x + tw / 2 > W - 2) continue;
      if (!azPlace(x - tw / 2, py1 + 5, tw, 13)) continue;
      g.fillStyle = isCard ? C.text : C.text2;
      g.fillText(label, x, py1 + 5);
    }

    const anyToScale = Object.values(drawn).some((d) => d.toScale && d.onX && d.onY);
    scaleNote.textContent = anyToScale ? 'Discs drawn to true angular size (vertical scale)' : 'Sun/Earth drawn as icons (too small at this scale)';

    updateTip();
  }

  function drawTrack(g, b, xOfD, dAz, ys, nowMs, hiddenPass, hitPts) {
    const arr = track[b.key];
    const n = track.n;
    const az = arr.azDeg;
    const el = arr.elDeg;
    const clr = arr.clearanceDeg;
    const tArr = track.tMs;
    g.lineWidth = hiddenPass ? 1.25 : 1.5;
    g.setLineDash(hiddenPass ? [4, 3] : []);
    let open = false;
    let prevD = 0;
    let prevPast = null;
    const stroke = () => {
      if (open) g.stroke();
      open = false;
    };
    for (let i = 0; i < n; i++) {
      const d = dAz(az[i]);
      const hidden = clr[i] < 0;
      const past = tArr[i] < nowMs;
      const x = xOfD(d);
      const y = ys(el[i]);
      if (!hiddenPass && i % 2 === 0) hitPts.push({ x, y, i, body: b.key });
      const want = hidden === hiddenPass;
      const jump = Math.abs(d - prevD) > 90;
      if (!want || jump || past !== prevPast) {
        if (open && want && !jump) g.lineTo(x, y);
        stroke();
      }
      if (want) {
        if (!open) {
          g.beginPath();
          g.strokeStyle = withAlpha(b.color, past ? 0.3 : hiddenPass ? 0.8 : 0.95);
          if (i > 0 && !jump) g.moveTo(xOfD(prevD), ys(el[i - 1]));
          else g.moveTo(x, y);
          open = true;
        }
        g.lineTo(x, y);
      }
      prevD = d;
      prevPast = past;
    }
    stroke();
    g.setLineDash([]);
  }

  function dayTicks(g, C, bodies, xOfD, dAz, ys, S, place, py1) {
    const perDay = Math.round(DAY_MS / (track.stepS * 1000));
    g.font = font(C, 10, 500);
    g.textAlign = 'left';
    g.textBaseline = 'bottom';
    for (const b of bodies) {
      const arr = track[b.key];
      for (let i = perDay; i < track.n; i += perDay) {
        const d = dAz(arr.azDeg[i]);
        if (Math.abs(d) > S / 2) continue;
        const x = xOfD(d);
        const y = ys(arr.elDeg[i]);
        if (y < 0 || y > py1) continue;
        g.fillStyle = withAlpha(b.color, arr.clearanceDeg[i] < 0 ? 0.6 : 1);
        g.beginPath();
        g.arc(x, y, 2.2, 0, Math.PI * 2);
        g.fill();
        const label = fmtShortDate(track.tMs[i]);
        const tw = g.measureText(label).width;
        if (place(x + 4, y - 15, tw, 11)) {
          g.fillStyle = withAlpha(C.text2, 0.9);
          g.fillText(label, x + 4, y - 4);
        }
      }
    }
  }

  function disc(g, x, y, r, b) {
    g.fillStyle = b.color;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }

  function icon(g, x, y, b, visible, C) {
    g.lineWidth = 1.5;
    if (!visible) g.setLineDash([2, 2]);
    if (b.key === 'sun') {
      g.strokeStyle = C.sun;
      g.fillStyle = visible ? C.sun : withAlpha(C.sun, 0.15);
      g.beginPath();
      g.arc(x, y, 5, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.beginPath();
      for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4;
        g.moveTo(x + Math.cos(a) * 7.5, y + Math.sin(a) * 7.5);
        g.lineTo(x + Math.cos(a) * 10.5, y + Math.sin(a) * 10.5);
      }
      g.stroke();
    } else {
      g.strokeStyle = C.earth;
      g.fillStyle = visible ? C.earth : withAlpha(C.earth, 0.15);
      g.beginPath();
      g.arc(x, y, 6, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.beginPath();
      g.arc(x, y, 9.5, 0, Math.PI * 2);
      g.lineWidth = 1;
      g.stroke();
    }
    g.setLineDash([]);
  }

  function bodyLabel(g, C, q, px0, px1, py0, py1, place) {
    const { d, x, y, r } = q;
    const bi = d.bi;
    const cd = countdown(d.key);
    const l1 = `${d.name} ${fmtDeg(bi.clearanceDeg, 1, true)}${bi.clearanceDeg < 0 ? ' (hidden)' : ''}`;
    const l2 = cd ? cd.short : '';
    g.font = font(C, 12, 700);
    const w1 = g.measureText(l1).width;
    g.font = font(C, 11, 500);
    const w2 = l2 ? g.measureText(l2).width : 0;
    const w = Math.max(w1, w2) + 10;
    const hh = l2 ? 32 : 18;
    const off = r + 8;
    const cands = [
      [x + off, y - hh - 2],
      [x - off - w, y - hh - 2],
      [x + off, y + 4],
      [x - off - w, y + 4],
      [x - w / 2, y - off - hh],
      [x - w / 2, y + off],
    ];
    let pos = cands.find(([lx, ly]) => lx >= px0 + 2 && lx + w <= px1 - 2 && ly >= py0 + 2 && ly + hh <= py1 - 2 && place(lx, ly, w, hh));
    if (!pos) pos = [clamp(x + off, px0 + 2, px1 - w - 2), clamp(y - hh - 2, py0 + 2, py1 - hh - 2)];
    const [lx, ly] = pos;
    g.fillStyle = withAlpha(C.surface, 0.82);
    roundRect(g, lx, ly, w, hh, 5);
    g.fill();
    g.strokeStyle = C.border;
    g.lineWidth = 1;
    g.stroke();
    g.fillStyle = d.color;
    g.fillRect(lx, ly + 4, 2, hh - 8);
    g.textAlign = 'left';
    g.textBaseline = 'top';
    g.font = font(C, 12, 700);
    g.fillStyle = C.text;
    g.fillText(l1, lx + 5, ly + 3);
    if (l2) {
      g.font = font(C, 11, 500);
      g.fillStyle = C.text2;
      g.fillText(l2, lx + 5, ly + 18);
    }
  }

  function edgeMarker(g, C, d, P, px0, px1, py0, py1, place) {
    const { bi } = d;
    let x = clamp(d.x, px0 + 12, px1 - 12);
    let y;
    let arrow;
    if (!d.onX) {
      const left = wrap180(bi.azDeg - currentCentre()) < 0;
      x = left ? px0 + 12 : px1 - 12;
      y = clamp(d.y, py0 + 14, py1 - 14);
      arrow = left ? '◀' : '▶';
    } else {
      y = bi.elDeg < P.min ? py1 - 12 : py0 + 12;
      arrow = bi.elDeg < P.min ? '▼' : '▲';
    }
    const label = `${arrow} ${d.name} ${fmtDeg(bi.elDeg)}`;
    g.font = font(C, 11, 700);
    const w = g.measureText(label).width + 10;
    let lx = clamp(x - w / 2, px0 + 2, px1 - w - 2);
    if (!d.onX) lx = x < (px0 + px1) / 2 ? px0 + 4 : px1 - w - 4;
    const ly = clamp(y - 9, py0 + 2, py1 - 20);
    place(lx, ly, w, 18);
    g.fillStyle = withAlpha(C.surface, 0.85);
    roundRect(g, lx, ly, w, 18, 5);
    g.fill();
    g.strokeStyle = d.color;
    g.stroke();
    g.fillStyle = d.color;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillText(label, lx + 5, ly + 9.5);
  }

  function roundRect(g, x, y, w, hh, r) {
    g.beginPath();
    if (g.roundRect) g.roundRect(x, y, w, hh, r);
    else g.rect(x, y, w, hh);
  }

  function nearestTrackPoint(x, y) {
    if (!track || !layout) return null;
    let best = null;
    let bd = 64;
    const { xs, ys } = layout;
    for (const body of ['sun', 'earth']) {
      const arr = track[body];
      for (let i = 0; i < track.n; i++) {
        const dx = xs(arr.azDeg[i]) - x;
        if (dx > 8 || dx < -8) continue;
        const dy = ys(arr.elDeg[i]) - y;
        const dd = dx * dx + dy * dy;
        if (dd < bd) {
          bd = dd;
          best = { body, i };
        }
      }
    }
    return best;
  }

  function updateTip() {
    if (!hover || !layout || !ctx || drag?.moved) return f.hideTip();
    const L = layout;
    if (hover.x < L.px0 || hover.x > L.px1 || hover.y < L.py0 || hover.y > L.py1) return f.hideTip();
    const az = wrap360(L.azAt(hover.x));
    const el = L.ys.invert(hover.y);
    const hz = ctx.horizon.elevationAt(az);
    const lines = [
      h('div', { class: 'lc-tip-h', text: `Az ${az.toFixed(1)}° (${cardinal(az)}) · El ${fmtDeg(el)}` }),
      `Terrain horizon here: ${fmtDeg(hz, 2)}`,
      `Pointer is ${fmtDeg(Math.abs(el - hz))} ${el >= hz ? 'above' : 'below'} the skyline`,
    ];
    if (document.activeElement !== canvas) lines.push(h('div', { class: 'lc-tip-hint', text: 'Drag to pan · click, then wheel to zoom' }));
    const near = nearestTrackPoint(hover.x, hover.y);
    if (near) {
      const arr = track[near.body];
      const i = near.i;
      lines.push(
        h('div', { class: `lc-tip-${near.body}`, text: `${near.body === 'sun' ? 'Sun' : 'Earth'} at ${fmtUtc(track.tMs[i])}` }),
        `el ${fmtDeg(arr.elDeg[i], 2)}, ${fmtDeg(arr.clearanceDeg[i], 2, true)} vs terrain${arr.clearanceDeg[i] < 0 ? ' (hidden)' : ''}`,
        h('div', { class: 'lc-tip-hint', text: 'Click to move the time cursor here' }),
      );
    }
    f.showTip(hover.x, hover.y, lines);
  }

  canvas.addEventListener('pointermove', (e) => {
    const p = localPoint(e, canvas);
    if (drag) {
      const dx = p.x - drag.x;
      if (!drag.moved && Math.abs(dx) > 3) {
        drag.moved = true;
        goFree();
        drag.c0 = centreAz;
      }
      if (drag.moved && layout) {
        centreAz = drag.c0 - (dx / layout.pw) * spanDeg;
      }
    }
    hover = p;
    surface.invalidate();
  });
  canvas.addEventListener('pointerleave', () => {
    if (!drag) hover = null;
    f.hideTip();
    surface.invalidate();
  });
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    canvas.focus({ preventScroll: true });
    const p = localPoint(e, canvas);
    drag ={ x: p.x, c0: currentCentre(), moved: false };
  });
  const endDrag = (e) => {
    if (!drag) return;
    const wasMoved = drag.moved;
    drag = null;
    if (e.type === 'pointercancel') return;
    if (!wasMoved) {
      const p = localPoint(e, canvas);
      const near = nearestTrackPoint(p.x, p.y);
      if (near) store.set({ timeMs: track.tMs[near.i], playing: false });
    }
    surface.invalidate();
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener(
    'wheel',
    (e) => {
      if (!layout || (document.activeElement !== canvas && !e.ctrlKey && !e.metaKey)) return;
      e.preventDefault();
      const p = localPoint(e, canvas);
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        goFree();
        centreAz += ((e.deltaX || e.deltaY) / layout.pw) * spanDeg;
        surface.invalidate();
      } else {
        if (centreMode !== 'sun' && centreMode !== 'earth') goFree();
        zoomBy(Math.exp(e.deltaY * 0.0015), p.x);
      }
    },
    { passive: false },
  );
  canvas.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      goFree();
      centreAz += (k === 'ArrowLeft' ? -1 : 1) * spanDeg * (e.shiftKey ? 0.25 : 0.08);
    } else if (k === '+' || k === '=') zoomBy(1 / 1.25);
    else if (k === '-' || k === '_') zoomBy(1.25);
    else if (k === '0' || k === 'Home') resetView();
    else if (k === 'ArrowUp' || k === 'ArrowDown') {
      preset = k === 'ArrowUp' ? 'full' : 'horizon';
      presetSeg.set(preset);
    } else return;
    e.preventDefault();
    surface.invalidate();
  });

  const unsubs = [
    store.subscribe(() => loadSite(), ['scenarios', 'activeId', 'opts']),
    store.subscribe(() => refreshTime(), ['timeMs']),
  ];
  loadSite();

  return {
    destroy() {
      unsubs.forEach((u) => u());
      siteGate.cancel();
      trackGate.cancel();
      ctx = null;
      surface.destroy();
      f.root.remove();
    },
  };
}
