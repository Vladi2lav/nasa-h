import {
  R_M, DEG, wrapLon, latLonToPolar, polarToLatLon, polarRadius, latLonToVec, solarElevationFromVec, terminator,
  formatLatLon, formatLat, formatLon, formatUtc, formatDate, readTokens, watchTheme, statusStyle, STATUS_STYLE,
  loadMapsMeta, describeBasemap, loadImage, createSubTracker, scenarioPoint, el, POLAR_HALF_WIDTH_M,
} from './mapUtil.js';

const SHADE_ALPHA = 0.62;
const POLAR_SHADE_N = 384;

export function mountMap2d(container, app, opts = {}) {
  let mode = opts.mode || 'global';
  const store = app.store;
  let tokens = readTokens();
  let destroyed = false;

  const root = el('div', { class: 'm2' });
  const canvas = el('canvas', {
    class: 'm2-canvas', tabindex: '0', role: 'application',
    'aria-label': 'Moon map. Drag or use arrow keys to pan, mouse wheel or plus and minus to zoom, click to pick a point.',
  });
  const ctx = canvas.getContext('2d');
  const tip = el('div', { class: 'm2-tip', role: 'status', hidden: true });
  const readout = el('div', { class: 'm2-readout' });
  const credit = el('div', { class: 'm2-credit' });
  const note = el('div', { class: 'm2-note', hidden: true });
  const btn = (label, text, fn) => el('button', { class: 'mv-btn m2-zbtn', type: 'button', 'aria-label': label, title: label, onclick: fn }, text);
  const ctrls = el('div', { class: 'm2-ctrls' },
    btn('Zoom in', '+', () => zoomBy(1.6)), btn('Zoom out', '−', () => zoomBy(1 / 1.6)), btn('Reset view', '⌂', () => fit(true)));
  const panel = el('details', { class: 'm2-panel', open: true });
  root.append(canvas, ctrls, panel, readout, credit, note, tip);
  container.append(root);
  if (opts.note) showNote(opts.note);

  function showNote(text) {
    note.textContent = text;
    note.hidden = !text;
  }

  const layersOn = { shade: true, grid: true, sites: true, terminator: true };
  let globalBase = 'global_color';
  let maps = null;
  let basemap = null;
  let baseImg = null;
  let baseState = 'loading';
  let overlays = [];
  let bounds = { xmin: -180, xmax: 180, ymin: -90, ymax: 90 };
  let view = { cx: 0, cy: 0, scale: 1 };
  let W = 300;
  let H = 200;
  let dpr = 1;
  let userMoved = false;
  let hits = [];
  let hover = null;
  let tracker = null;
  let shade = null;
  let raf = 0;

  const pole = () => (mode === 'south' ? 'S' : 'N');
  const isPolar = () => mode !== 'global';

  function setBounds() {
    if (!isPolar()) bounds = { xmin: -180, xmax: 180, ymin: -90, ymax: 90 };
    else if (basemap && basemap.extent) bounds = basemap.extent;
    else bounds = { xmin: -POLAR_HALF_WIDTH_M, xmax: POLAR_HALF_WIDTH_M, ymin: -POLAR_HALF_WIDTH_M, ymax: POLAR_HALF_WIDTH_M };
  }
  const fitScale = () => Math.min(W / (bounds.xmax - bounds.xmin), H / (bounds.ymax - bounds.ymin));
  const maxScale = () => fitScale() * (isPolar() ? 120 : 90);
  function fit(force) {
    if (!force && userMoved) return;
    view = { cx: (bounds.xmin + bounds.xmax) / 2, cy: (bounds.ymin + bounds.ymax) / 2, scale: fitScale() * 0.98 };
    if (force) userMoved = false;
    invalidate();
  }
  function clampView() {
    view.scale = Math.min(maxScale(), Math.max(fitScale() * 0.5, view.scale));
    view.cx = Math.min(bounds.xmax, Math.max(bounds.xmin, view.cx));
    view.cy = Math.min(bounds.ymax, Math.max(bounds.ymin, view.cy));
  }
  const wx2sx = (wx) => W / 2 + (wx - view.cx) * view.scale;
  const wy2sy = (wy) => H / 2 - (wy - view.cy) * view.scale;
  const sx2wx = (sx) => view.cx + (sx - W / 2) / view.scale;
  const sy2wy = (sy) => view.cy - (sy - H / 2) / view.scale;

  function project(lat, lon) {
    let wx;
    let wy;
    if (!isPolar()) {
      wx = wrapLon(lon);
      if (wx === -180 && lon > 0) wx = 180;
      wy = lat;
    } else {
      const p = latLonToPolar(lat, lon, pole());
      wx = p.x;
      wy = p.y;
    }
    return { x: wx2sx(wx), y: wy2sy(wy), wx, wy };
  }
  const inBounds = (wx, wy, m = 0) => wx >= bounds.xmin - m && wx <= bounds.xmax + m && wy >= bounds.ymin - m && wy <= bounds.ymax + m;

  function unproject(sx, sy) {
    const wx = sx2wx(sx);
    const wy = sy2wy(sy);
    if (!inBounds(wx, wy)) return null;
    if (!isPolar()) return { lat: wy, lon: wx };
    const ll = polarToLatLon(wx, wy, pole());
    if ((pole() === 'S' && ll.lat > -60) || (pole() === 'N' && ll.lat < 60)) return null;
    return ll;
  }

  async function loadBase() {
    baseState = 'loading';
    baseImg = null;
    const my = ++loadToken;
    if (!maps) maps = await loadMapsMeta();
    if (destroyed || my !== loadToken) return;
    const key = isPolar() ? `${mode}_shade` : globalBase;
    basemap = describeBasemap(maps, key);
    setBounds();
    fit(false);
    clampView();
    credit.textContent = '';
    try {
      const img = await loadImage(basemap.url);
      if (destroyed || my !== loadToken) return;
      baseImg = img;
      baseState = 'ok';
      showNote(opts.note || '');
    } catch {
      if (destroyed || my !== loadToken) return;
      baseState = 'missing';
      showNote((opts.note ? opts.note + ' ' : '') + 'Basemap not available – showing graticule only.');
    }
    loadOverlays(my);
    shade = null;
    buildPanel();
    invalidate();
  }
  let loadToken = 0;

  function loadOverlays(my) {
    overlays = [];
    const meta = maps && maps.meta;
    if (!meta || !meta.maps) return;
    const base = new Set(['global_color', 'global_shade', 'south_shade', 'north_shade']);
    for (const [key, e] of Object.entries(meta.maps)) {
      if (base.has(key) || !e || !e.file) continue;
      const isEq = e.projection === 'equirect';
      const matches = isPolar() ? !isEq && String(e.pole).toUpperCase() === pole() : isEq;
      if (!matches) continue;
      const d = describeBasemap(maps, key);
      const nice = { south_avg_sun: 'Average Sun visibility', south_avg_earth: 'Average Earth visibility' };
      const ov = {
        id: key, name: nice[key] || String(e.content || key).split(':')[0], url: d.url, extent: d.extent, img: null, state: 'loading',
        visible: false, opacity: 0.8, legend: e.legend || null, credit: e.credit || '', content: e.content || '',
      };
      overlays.push(ov);
      loadImage(ov.url).then((img) => { ov.img = img; ov.state = 'ok'; if (!destroyed && my === loadToken) { buildPanel(); invalidate(); } })
        .catch(() => { ov.state = 'missing'; if (!destroyed && my === loadToken) buildPanel(); });
    }
  }

  function computeShade(sub) {
    const s = latLonToVec(sub.subSolar.lat, sub.subSolar.lon);
    const polar = isPolar();
    const gw = polar ? POLAR_SHADE_N : 360;
    const gh = polar ? POLAR_SHADE_N : 180;
    if (!shade || shade.canvas.width !== gw || shade.canvas.height !== gh) {
      const c = document.createElement('canvas');
      c.width = gw;
      c.height = gh;
      shade = { canvas: c, key: null, img: new ImageData(gw, gh) };
    }
    const buf = new Uint32Array(shade.img.data.buffer);
    const soft = polar ? 1.0 : 4.0;
    const rgb = (2) | (4 << 8) | (14 << 16);
    const sinSolar = (nx, ny, nz) => nx * s[0] + ny * s[1] + nz * s[2];
    let k = 0;
    if (!polar) {
      const sl = new Float64Array(gw);
      const cl = new Float64Array(gw);
      for (let i = 0; i < gw; i++) {
        const lon = (-180 + (i + 0.5)) * DEG;
        cl[i] = Math.cos(lon);
        sl[i] = Math.sin(lon);
      }
      for (let j = 0; j < gh; j++) {
        const lat = (90 - (j + 0.5)) * DEG;
        const c = Math.cos(lat);
        const z = Math.sin(lat);
        for (let i = 0; i < gw; i++, k++) buf[k] = alphaPx(sinSolar(c * cl[i], c * sl[i], z), soft, rgb);
      }
    } else {
      const { xmin, xmax, ymin, ymax } = bounds;
      const south = pole() === 'S';
      for (let j = 0; j < gh; j++) {
        const y = ymax - ((j + 0.5) / gh) * (ymax - ymin);
        for (let i = 0; i < gw; i++, k++) {
          const x = xmin + ((i + 0.5) / gw) * (xmax - xmin);
          const r = Math.hypot(x, y);
          const colat = 2 * Math.atan(r / (2 * R_M));
          const lat = south ? colat - Math.PI / 2 : Math.PI / 2 - colat;
          const lon = r === 0 ? 0 : Math.atan2(x, south ? y : -y);
          const c = Math.cos(lat);
          buf[k] = alphaPx(sinSolar(c * Math.cos(lon), c * Math.sin(lon), Math.sin(lat)), soft, rgb);
        }
      }
    }
    shade.canvas.getContext('2d').putImageData(shade.img, 0, 0);
    shade.key = { mode, s };
  }
  function alphaPx(sinEl, softDeg, rgb) {
    const el = Math.asin(Math.max(-1, Math.min(1, sinEl))) / DEG;
    let t = (el + softDeg) / (2 * softDeg);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const day = t * t * (3 - 2 * t);
    const a = Math.round(255 * SHADE_ALPHA * (1 - day));
    return (a << 24) | rgb;
  }
  function shadeStale(sub) {
    if (!shade || !shade.key || shade.key.mode !== mode) return true;
    const s = latLonToVec(sub.subSolar.lat, sub.subSolar.lon);
    const d = shade.key.s;
    return Math.hypot(s[0] - d[0], s[1] - d[1], s[2] - d[2]) > 0.05 * DEG;
  }

  function invalidate() {
    if (raf || destroyed) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (!destroyed) draw();
    });
  }

  function halo(text, x, y, color = tokens.text, size = 11, align = 'left', weight = '600') {
    ctx.font = `${weight} ${size}px ${tokens.font}`;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = tokens.bg;
    ctx.globalAlpha = 0.85;
    ctx.strokeText(text, x, y);
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  function shape(kind, x, y, r) {
    ctx.beginPath();
    switch (kind) {
      case 'diamond': ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); break;
      case 'triangle': ctx.moveTo(x, y - r); ctx.lineTo(x + r, y + r * 0.8); ctx.lineTo(x - r, y + r * 0.8); ctx.closePath(); break;
      case 'square': ctx.rect(x - r * 0.8, y - r * 0.8, r * 1.6, r * 1.6); break;
      case 'cross': ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); break;
      default: ctx.arc(x, y, r, 0, Math.PI * 2);
    }
  }

  function draw() {
    const sub = tracker && tracker.sub;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = tokens.bg;
    ctx.fillRect(0, 0, W, H);
    hits = [];

    const x0 = wx2sx(bounds.xmin);
    const x1 = wx2sx(bounds.xmax);
    const y0 = wy2sy(bounds.ymax);
    const y1 = wy2sy(bounds.ymin);

    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (baseImg) ctx.drawImage(baseImg, x0, y0, x1 - x0, y1 - y0);
    else {
      ctx.fillStyle = tokens['surface-3'];
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
    for (const ov of overlays) {
      if (!ov.visible || !ov.img) continue;
      const e = ov.extent || bounds;
      const ex0 = wx2sx(isPolar() ? e.xmin : -180);
      const ex1 = wx2sx(isPolar() ? e.xmax : 180);
      const ey0 = wy2sy(isPolar() ? e.ymax : 90);
      const ey1 = wy2sy(isPolar() ? e.ymin : -90);
      ctx.globalAlpha = ov.opacity;
      ctx.drawImage(ov.img, ex0, ey0, ex1 - ex0, ey1 - ey0);
      ctx.globalAlpha = 1;
    }
    if (layersOn.shade && sub) {
      if (shadeStale(sub)) computeShade(sub);
      ctx.drawImage(shade.canvas, x0, y0, x1 - x0, y1 - y0);
    }
    if (layersOn.grid) (isPolar() ? gratPolar : gratGlobal)();
    if (layersOn.terminator && sub && !isPolar()) drawTerminator(sub);
    ctx.restore();

    ctx.strokeStyle = tokens['border-strong'];
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, Math.round(x1 - x0), Math.round(y1 - y0));

    if (layersOn.sites) drawSites();
    drawScenarios();
    if (sub) drawBodies(sub);
    if (baseState === 'missing') {
      halo('Basemap not available', (x0 + x1) / 2, Math.min(H - 40, Math.max(40, (y0 + y1) / 2)), tokens['text-2'], 13, 'center', '500');
    }
    updateReadout();
  }

  function visibleWorld() {
    return {
      l: Math.max(bounds.xmin, sx2wx(0)), r: Math.min(bounds.xmax, sx2wx(W)),
      b: Math.max(bounds.ymin, sy2wy(H)), t: Math.min(bounds.ymax, sy2wy(0)),
    };
  }
  function niceStep(pxPerDeg, minPx, steps = [0.5, 1, 2, 5, 10, 15, 30, 45, 90]) {
    return steps.find((s) => s * pxPerDeg >= minPx) || steps[steps.length - 1];
  }

  function gratGlobal() {
    const v = visibleWorld();
    const stepLon = niceStep(view.scale, 70);
    const stepLat = niceStep(view.scale, 50);
    ctx.lineWidth = 1;
    ctx.strokeStyle = tokens.grid;
    ctx.beginPath();
    for (let lon = Math.ceil(v.l / stepLon) * stepLon; lon <= v.r; lon += stepLon) {
      const x = Math.round(wx2sx(lon)) + 0.5;
      ctx.moveTo(x, wy2sy(v.t)); ctx.lineTo(x, wy2sy(v.b));
    }
    for (let lat = Math.ceil(v.b / stepLat) * stepLat; lat <= v.t; lat += stepLat) {
      const y = Math.round(wy2sy(lat)) + 0.5;
      ctx.moveTo(wx2sx(v.l), y); ctx.lineTo(wx2sx(v.r), y);
    }
    ctx.stroke();
    ctx.strokeStyle = tokens['border-strong'];
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.moveTo(wx2sx(v.l), Math.round(wy2sy(0)) + 0.5); ctx.lineTo(wx2sx(v.r), Math.round(wy2sy(0)) + 0.5);
    ctx.moveTo(Math.round(wx2sx(0)) + 0.5, wy2sy(v.t)); ctx.lineTo(Math.round(wx2sx(0)) + 0.5, wy2sy(v.b));
    ctx.stroke();
    ctx.globalAlpha = 1;
    const xl = Math.max(wx2sx(v.l), 0) + 4;
    const yl = Math.max(wy2sy(v.t), 0) + 9;
    for (let lat = Math.ceil(v.b / stepLat) * stepLat; lat <= v.t; lat += stepLat) {
      const y = wy2sy(lat);
      if (y > 14 && y < H - 8) halo(formatLat(lat, 0).replace(/°$/, '°'), xl, y - 7, tokens['text-2'], 10, 'left', '500');
    }
    for (let lon = Math.ceil(v.l / stepLon) * stepLon; lon <= v.r; lon += stepLon) {
      const x = wx2sx(lon);
      if (x > 30 && x < W - 30) halo(formatLon(lon, 0), x + 3, yl, tokens['text-2'], 10, 'left', '500');
    }
  }

  function gratPolar() {
    const south = pole() === 'S';
    const pxPerDeg = view.scale * (R_M * DEG);
    const stepLat = niceStep(pxPerDeg, 46, [0.25, 0.5, 1, 2, 5, 10]);
    const stepLon = view.scale > fitScale() * 5 ? 10 : 30;
    const maxColat = 12;
    const ox = wx2sx(0);
    const oy = wy2sy(0);
    ctx.strokeStyle = tokens.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let c = stepLat; c <= maxColat; c += stepLat) {
      const rr = 2 * R_M * Math.tan((c * DEG) / 2) * view.scale;
      ctx.moveTo(ox + rr, oy);
      ctx.arc(ox, oy, rr, 0, Math.PI * 2);
    }
    const reach = bounds.xmax * 1.5 * view.scale;
    for (let lon = -180; lon < 180; lon += stepLon) {
      const dx = Math.sin(lon * DEG);
      const dy = (south ? 1 : -1) * Math.cos(lon * DEG);
      ctx.moveTo(ox, oy);
      ctx.lineTo(ox + dx * reach, oy - dy * reach);
    }
    ctx.stroke();
    for (let c = stepLat; c <= maxColat; c += stepLat) {
      const lat = south ? -90 + c : 90 - c;
      const p = project(lat, 45);
      if (p.x > 8 && p.x < W - 8 && p.y > 8 && p.y < H - 8 && inBounds(p.wx, p.wy)) {
        halo(formatLat(lat, stepLat < 1 ? 2 : 0), p.x + 3, p.y - 6, tokens['text-2'], 10, 'left', '500');
      }
    }
    for (let lon = -180; lon < 180; lon += stepLon) {
      if (lon % (stepLon === 10 ? 30 : 30) !== 0 && view.scale < fitScale() * 12) continue;
      let rr = bounds.xmax * 0.97;
      for (let k = 0; k < 40; k++, rr *= 0.9) {
        const sx = ox + Math.sin(lon * DEG) * rr * view.scale;
        const sy = oy - (south ? 1 : -1) * Math.cos(lon * DEG) * rr * view.scale;
        if (sx > 18 && sx < W - 18 && sy > 14 && sy < H - 14) {
          halo(formatLon(lon, 0), sx, sy, tokens['text-2'], 10, 'center', '600');
          break;
        }
      }
    }
  }

  function drawTerminator(sub) {
    const pts = terminator(sub.subSolar, 361);
    ctx.strokeStyle = tokens.sun;
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = wx2sx(p.lon);
      const y = wy2sy(p.lat);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  function drawSites() {
    const sites = app.nav.sites || [];
    for (const s of sites) {
      const p = project(s.lat, s.lon);
      if (!inBounds(p.wx, p.wy) || p.x < -10 || p.y < -10 || p.x > W + 10 || p.y > H + 10) continue;
      const st = statusStyle(s.status);
      const col = tokens[st.token];
      const r = 3.6;
      shape(st.shape, p.x, p.y, r);
      if (st.shape === 'cross') {
        ctx.strokeStyle = col;
        ctx.lineWidth = 2;
        ctx.stroke();
      } else {
        ctx.fillStyle = col;
        ctx.fill();
        ctx.strokeStyle = tokens.bg;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      hits.push({ x: p.x, y: p.y, r: 8, kind: 'site', site: s });
    }
  }

  function drawScenarios() {
    const { scenarios, activeId } = store.get();
    const order = scenarios.slice().sort((a, b) => (a.id === activeId) - (b.id === activeId));
    for (const sc of order) {
      const pt = scenarioPoint(sc);
      if (!pt) continue;
      const p = project(pt.lat, pt.lon);
      if (!inBounds(p.wx, p.wy) || p.x < -20 || p.y < -20 || p.x > W + 20 || p.y > H + 20) continue;
      const active = sc.id === activeId;
      const r = active ? 11 : 8;
      if (active) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 5, 0, Math.PI * 2);
        ctx.strokeStyle = sc.color;
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fill();
      ctx.lineWidth = active ? 3.5 : 2.5;
      ctx.strokeStyle = sc.color;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.6, 0, Math.PI * 2);
      ctx.fillStyle = sc.color;
      ctx.fill();
      const name = sc.site.name.length > 34 ? sc.site.name.slice(0, 33) + '…' : sc.site.name;
      halo(name, p.x + r + 6, p.y, active ? tokens.text : tokens['text-2'], active ? 12 : 11, 'left', active ? '700' : '600');
      hits.push({ x: p.x, y: p.y, r: r + 4, kind: 'scenario', scenario: sc });
    }
  }

  function drawBodies(sub) {
    drawBody(sub.subSolar, 'sun', 'Sun', tokens.sun);
    drawBody(sub.subEarth, 'earth', 'Earth', tokens.earth);
  }

  function drawBody(pt, kind, label, color) {
    const p = project(pt.lat, pt.lon);
    const onMap = inBounds(p.wx, p.wy) && p.x > 12 && p.x < W - 12 && p.y > 12 && p.y < H - 12;
    if (onMap) {
      drawBodyIcon(kind, p.x, p.y, color);
      halo(`Sub-${label === 'Sun' ? 'solar' : 'Earth'}`, p.x + 13, p.y + 12, color, 11, 'left', '700');
      hits.push({ x: p.x, y: p.y, r: 12, kind: 'body', body: kind, pt });
      return;
    }
    let dx = p.x - W / 2;
    let dy = p.y - H / 2;
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) { dx = 1; dy = 0; }
    const inset = 26;
    const t = Math.min((W / 2 - inset) / Math.max(1e-9, Math.abs(dx)), (H / 2 - inset) / Math.max(1e-9, Math.abs(dy)));
    const m = Math.hypot(dx, dy);
    const ex = W / 2 + (dx / m) * Math.min(t * m, 1e9);
    const ey = H / 2 + (dy / m) * Math.min(t * m, 1e9);
    const ang = Math.atan2(dy, dx);
    ctx.save();
    ctx.translate(ex, ey);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.moveTo(14, 0); ctx.lineTo(-8, -9); ctx.lineTo(-8, 9); ctx.closePath();
    ctx.fillStyle = color;
    ctx.strokeStyle = tokens.bg;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fill();
    ctx.restore();
    const lx = ex - Math.cos(ang) * 22;
    const ly = ey - Math.sin(ang) * 22;
    const align = Math.cos(ang) > 0.4 ? 'right' : Math.cos(ang) < -0.4 ? 'left' : 'center';
    halo(`to ${label}`, lx, ly, color, 11, align, '700');
    hits.push({ x: ex, y: ey, r: 16, kind: 'body', body: kind, pt, edge: true });
  }

  function drawBodyIcon(kind, x, y, color) {
    ctx.save();
    ctx.translate(x, y);
    if (kind === 'sun') {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4;
        ctx.moveTo(Math.cos(a) * 8, Math.sin(a) * 8);
        ctx.lineTo(Math.cos(a) * 12, Math.sin(a) * 12);
      }
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, 5.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = tokens.bg;
      ctx.lineWidth = 1;
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(0, 0, 7, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = tokens.bg;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, 11, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();
  }

  function updateReadout() {
    const sub = tracker && tracker.sub;
    let text = '';
    if (hover) {
      const ll = unproject(hover.sx, hover.sy);
      if (ll) {
        text = formatLatLon(ll.lat, ll.lon, 3);
        if (sub) {
          const el = solarElevationFromVec(latLonToVec(ll.lat, ll.lon), latLonToVec(sub.subSolar.lat, sub.subSolar.lon));
          text += `  ·  Sun ${el >= 0 ? '+' : '−'}${Math.abs(el).toFixed(1)}° (smooth sphere)`;
        }
      }
    }
    readout.textContent = text || (tracker && tracker.error ? tracker.error.message : '');
    readout.hidden = !readout.textContent;
    readout.classList.toggle('is-error', !text && !!(tracker && tracker.error));
  }

  function nearestHit(sx, sy) {
    let best = null;
    let bd = Infinity;
    for (const h of hits) {
      const d = Math.hypot(h.x - sx, h.y - sy);
      if (d <= h.r && (d < bd || (h.kind === 'scenario' && bd - d < 3))) {
        bd = d;
        best = h;
      }
    }
    return best;
  }

  function showTip(h, sx, sy) {
    if (!h) { tip.hidden = true; return; }
    tip.replaceChildren();
    if (h.kind === 'site') {
      const s = h.site;
      const st = statusStyle(s.status);
      tip.append(el('strong', { text: s.name }),
        el('span', { text: [s.agency, st.label, formatDate(s.date_utc)].filter(Boolean).join(' · ') }),
        el('span', { text: formatLatLon(s.lat, s.lon) }));
    } else if (h.kind === 'scenario') {
      const sc = h.scenario;
      tip.append(el('strong', { text: sc.site.name }), el('span', { text: `Scenario · landing ${formatUtc(sc.t0Ms)}` }),
        el('span', { text: formatLatLon(sc.site.lat, sc.site.lon) }));
    } else {
      tip.append(el('strong', { text: h.body === 'sun' ? 'Sub-solar point' : 'Sub-Earth point' }), el('span', { text: formatLatLon(h.pt.lat, h.pt.lon) }));
    }
    tip.hidden = false;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    tip.style.left = Math.max(4, Math.min(W - tw - 4, sx + 14)) + 'px';
    tip.style.top = Math.max(4, Math.min(H - th - 4, sy + 14)) + 'px';
  }

  const pointers = new Map();
  let drag = null;
  let pinch = null;
  let lastClick = { t: 0, timer: 0 };

  function rel(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function zoomAt(factor, sx, sy) {
    const wx = sx2wx(sx);
    const wy = sy2wy(sy);
    view.scale *= factor;
    view.scale = Math.min(maxScale(), Math.max(fitScale() * 0.5, view.scale));
    view.cx = wx - (sx - W / 2) / view.scale;
    view.cy = wy + (sy - H / 2) / view.scale;
    clampView();
    userMoved = true;
    invalidate();
  }
  function zoomBy(f) { zoomAt(f, W / 2, H / 2); }

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    const p = rel(e);
    pointers.set(e.pointerId, p);
    if (pointers.size === 1) drag = { x: p.x, y: p.y, cx: view.cx, cy: view.cy, moved: 0, t: performance.now() };
    else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), scale: view.scale };
      drag = null;
    }
    tip.hidden = true;
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = rel(e);
    hover = p;
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      zoomAt((pinch.scale * (d / pinch.d)) / view.scale, mx, my);
    } else if (drag && pointers.has(e.pointerId)) {
      const dx = p.x - drag.x;
      const dy = p.y - drag.y;
      drag.moved = Math.max(drag.moved, Math.hypot(dx, dy));
      if (drag.moved > 4) {
        view.cx = drag.cx - dx / view.scale;
        view.cy = drag.cy + dy / view.scale;
        clampView();
        userMoved = true;
        canvas.classList.add('is-dragging');
      }
    } else {
      showTip(nearestHit(p.x, p.y), p.x, p.y);
    }
    invalidate();
  });
  const endPointer = (e) => {
    const p = rel(e);
    const wasDrag = drag;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    canvas.classList.remove('is-dragging');
    if (e.type === 'pointerup' && wasDrag && wasDrag.moved <= 4 && performance.now() - wasDrag.t < 600 && pointers.size === 0) click(p);
    if (pointers.size === 0) drag = null;
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('pointerleave', () => { hover = null; tip.hidden = true; invalidate(); });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = rel(e);
    zoomAt(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0016)), p.x, p.y);
  }, { passive: false });
  canvas.addEventListener('keydown', (e) => {
    const step = 60 / view.scale;
    let h = true;
    if (e.key === 'ArrowLeft') view.cx -= step;
    else if (e.key === 'ArrowRight') view.cx += step;
    else if (e.key === 'ArrowUp') view.cy += step;
    else if (e.key === 'ArrowDown') view.cy -= step;
    else if (e.key === '+' || e.key === '=') zoomBy(1.4);
    else if (e.key === '-' || e.key === '_') zoomBy(1 / 1.4);
    else if (e.key === '0') fit(true);
    else h = false;
    if (h) { e.preventDefault(); userMoved = true; clampView(); invalidate(); }
  });

  function click(p) {
    const now = performance.now();
    if (lastClick.timer && now - lastClick.t < 320) {
      clearTimeout(lastClick.timer);
      lastClick.timer = 0;
      zoomAt(2, p.x, p.y);
      return;
    }
    lastClick.t = now;
    lastClick.timer = setTimeout(() => {
      lastClick.timer = 0;
      if (destroyed) return;
      const h = nearestHit(p.x, p.y);
      if (h && h.kind === 'site') {
        root.dispatchEvent(new CustomEvent('pick', { detail: { lat: h.site.lat, lon: h.site.lon, siteId: h.site.id }, bubbles: true }));
      } else if (h && h.kind === 'scenario') {
        root.dispatchEvent(new CustomEvent('pick', { detail: { lat: h.scenario.site.lat, lon: h.scenario.site.lon, ...(h.scenario.site.id ? { siteId: h.scenario.site.id } : {}) }, bubbles: true }));
      } else {
        const ll = unproject(p.x, p.y);
        if (ll) root.dispatchEvent(new CustomEvent('pick', { detail: { lat: ll.lat, lon: ll.lon }, bubbles: true }));
      }
    }, 280);
  }

  function buildPanel() {
    const open = panel.open;
    updateCredit();
    panel.replaceChildren(el('summary', { text: 'Layers & legend' }));
    const body = el('div', { class: 'm2-panel-body' });
    const check = (label, key, obj = layersOn) => {
      const id = `m2-${Math.random().toString(36).slice(2, 8)}`;
      const cb = el('input', { type: 'checkbox', id });
      cb.checked = !!obj[key];
      cb.addEventListener('change', () => { obj[key] = cb.checked; invalidate(); });
      return el('label', { class: 'm2-check', for: id }, cb, el('span', { text: label }));
    };
    if (!isPolar()) {
      const sel = el('select', { 'aria-label': 'Basemap', class: 'm2-select' },
        el('option', { value: 'global_color', text: 'Colour mosaic' }), el('option', { value: 'global_shade', text: 'Shaded relief' }));
      sel.value = globalBase;
      sel.addEventListener('change', () => { globalBase = sel.value; loadBase(); });
      body.append(el('label', { class: 'm2-row' }, el('span', { text: 'Basemap' }), sel));
    }
    body.append(check('Night shading', 'shade'), check('Graticule', 'grid'), check('Catalog sites', 'sites'));
    if (!isPolar()) body.append(check('Terminator', 'terminator'));
    for (const ov of overlays) {
      const id = `m2-${Math.random().toString(36).slice(2, 8)}`;
      const cb = el('input', { type: 'checkbox', id });
      cb.checked = ov.visible;
      cb.disabled = ov.state === 'missing';
      cb.addEventListener('change', () => { ov.visible = cb.checked; buildPanel(); invalidate(); });
      body.append(el('label', { class: 'm2-check', for: id }, cb, el('span', { text: ov.name + (ov.state === 'missing' ? ' (not available)' : '') })));
      if (ov.visible && ov.legend) body.append(legendFor(ov));
    }
    const leg = el('div', { class: 'm2-legend', 'aria-label': 'Site status legend' });
    for (const [k, st] of Object.entries(STATUS_STYLE)) {
      const sw = el('span', { class: `m2-sw m2-sw-${st.shape}`, style: `--c: var(--${st.token})`, 'aria-hidden': 'true' });
      leg.append(el('span', { class: 'm2-leg-item' }, sw, st.label));
    }
    body.append(leg);
    panel.append(body);
    panel.open = open;
  }
  function updateCredit() {
    const parts = [];
    if (baseState === 'ok' && basemap && basemap.credit) parts.push(basemap.credit);
    for (const ov of overlays) if (ov.visible && ov.credit && !parts.includes(ov.credit)) parts.push(ov.credit);
    credit.textContent = parts.length ? 'Image: ' + parts.join(' | ') : '';
    credit.title = credit.textContent;
  }
  function legendFor(ov) {
    const box = el('div', { class: 'm2-ovlegend' });
    const L = ov.legend;
    if (!L) return box;
    if (Array.isArray(L.stops) && L.stops.length) {
      const grad = `linear-gradient(90deg, ${L.stops.map((s) => s[1]).join(',')})`;
      const first = L.stops[0][0];
      const last = L.stops[L.stops.length - 1][0];
      const fmt = (v) => (Math.abs(v) >= 100 ? Math.round(v) : +Number(v).toFixed(2));
      box.append(el('span', { class: 'm2-ramp', style: `background:${grad}`, role: 'img', 'aria-label': `${L.quantity || ''} from ${fmt(first)} to ${fmt(last)}` }),
        el('span', { class: 'm2-ramp-lab', text: `${fmt(first)} … ${fmt(last)} ${L.unit === '1' ? '(fraction of time)' : L.unit || ''}`.trim() }));
      if (L.never_visible_color) {
        box.append(el('span', { class: 'm2-leg-item' }, el('span', { class: 'm2-sw m2-sw-square', style: `--c: ${L.never_visible_color}` }), 'never visible'));
      }
    }
    return box;
  }

  function resize() {
    const r = root.getBoundingClientRect();
    const w = Math.max(80, Math.round(r.width));
    const h = Math.max(80, Math.round(r.height));
    const d = Math.min(2, window.devicePixelRatio || 1);
    if (w === W && h === H && d === dpr) return;
    const first = !canvas.width || canvas.width === 300;
    W = w; H = h; dpr = d;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    if (!userMoved || first) fit(false);
    clampView();
    invalidate();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(root);
  const stopTheme = watchTheme(() => { tokens = readTokens(); invalidate(); });
  const unsub = store.subscribe(() => invalidate(), ['scenarios', 'activeId']);
  tracker = createSubTracker(app, () => invalidate());

  setBounds();
  panel.open = container.clientWidth >= 640 && container.clientHeight >= 420;
  buildPanel();
  resize();
  fit(true);
  loadBase();

  return {
    kind: 'map2d',
    destroy() {
      destroyed = true;
      ro.disconnect();
      stopTheme();
      unsub();
      tracker.destroy();
      clearTimeout(lastClick.timer);
      if (raf) cancelAnimationFrame(raf);
      root.remove();
    },
  };
}
