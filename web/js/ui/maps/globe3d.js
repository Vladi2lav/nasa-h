



import * as THREE from 'three';
import { OrbitControls } from '../../../vendor/OrbitControls.js';
import {
  DEG, formatLatLon, formatUtc, formatDate, readTokens, watchTheme, statusStyle, loadMapsMeta, describeBasemap,
  createSubTracker, scenarioPoint, el, prefersReducedMotion,
} from './mapUtil.js';

const FOV = 32;
const SUN_LINE = 1.75;
const EARTH_LINE = 1.5;


export function toScene(lat, lon, r = 1, out = new THREE.Vector3()) {
  const c = Math.cos(lat * DEG);
  return out.set(r * c * Math.sin(lon * DEG), r * Math.sin(lat * DEG), r * c * Math.cos(lon * DEG));
}

export function fromScene(v) {
  const n = v.length() || 1;
  return { lat: Math.asin(Math.max(-1, Math.min(1, v.y / n))) / DEG, lon: Math.atan2(v.x, v.z) / DEG };
}

function discTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.beginPath();
  g.arc(32, 32, 28, 0, Math.PI * 2);
  g.fillStyle = '#fff';
  g.fill();
  g.lineWidth = 5;
  g.strokeStyle = 'rgba(0,0,0,0.85)';
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function moonGeometry(nLon = 128, nLat = 64) {
  const pos = [];
  const uv = [];
  const idx = [];
  for (let j = 0; j <= nLat; j++) {
    const lat = 90 - (j / nLat) * 180;
    for (let i = 0; i <= nLon; i++) {
      const lon = -180 + (i / nLon) * 360;
      const p = toScene(lat, lon);
      pos.push(p.x, p.y, p.z);
      uv.push(i / nLon, 1 - j / nLat);
    }
  }
  for (let j = 0; j < nLat; j++) {
    for (let i = 0; i < nLon; i++) {
      const a = j * (nLon + 1) + i;
      const b = a + nLon + 1;
      
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(pos.slice(), 3)); 
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}


export function mountGlobe3d(container, app, opts = {}) {
  const store = app.store;
  let tokens = readTokens();
  let destroyed = false;

  const root = el('div', { class: 'g3' });
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    if (!renderer.getContext()) throw new Error('no context');
  } catch (e) {
    const err = new Error('WebGL is not available in this browser');
    err.code = 'nowebgl';
    throw err;
  }
  renderer.setClearColor(0x000000, 0);
  const canvas = renderer.domElement;
  canvas.classList.add('g3-canvas');
  canvas.setAttribute('tabindex', '0');
  canvas.setAttribute('role', 'application');
  canvas.setAttribute('aria-label', '3D Moon globe. Drag or use arrow keys to rotate, scroll or plus and minus to zoom.');
  const labels = el('div', { class: 'g3-labels', 'aria-hidden': 'true' });
  const tip = el('div', { class: 'm2-tip', role: 'status', hidden: true });
  const note = el('div', { class: 'm2-note', hidden: true });
  const credit = el('div', { class: 'm2-credit' });
  const bar = el('div', { class: 'g3-bar', role: 'toolbar', 'aria-label': 'Globe view' });
  root.append(canvas, labels, bar, credit, note, tip);
  container.append(root);

  
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 6000);
  const sun = new THREE.DirectionalLight(0xffffff, 3.4);
  scene.add(sun, new THREE.AmbientLight(0xffffff, 0.12));

  const geo = moonGeometry();
  const moonMat = new THREE.MeshLambertMaterial({ color: 0x8a8a8a });
  const moon = new THREE.Mesh(geo, moonMat);
  scene.add(moon);

  
  const gratGeo = (() => {
    const p = [];
    for (let lat = -60; lat <= 60; lat += 30) {
      for (let lon = -180; lon < 180; lon += 4) {
        const a = toScene(lat, lon, 1.002);
        const b = toScene(lat, lon + 4, 1.002);
        p.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
    }
    for (let lon = -180; lon < 180; lon += 30) {
      for (let lat = -90; lat < 90; lat += 4) {
        const a = toScene(lat, lon, 1.002);
        const b = toScene(lat + 4, lon, 1.002);
        p.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    return g;
  })();
  const gratMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.2, depthWrite: false });
  const graticule = new THREE.LineSegments(gratGeo, gratMat);
  scene.add(graticule);

  
  const disc = discTexture();
  const sites = app.nav.sites || [];
  const sitePos = new Float32Array(sites.length * 3);
  const siteCol = new Float32Array(sites.length * 3);
  const siteGeo = new THREE.BufferGeometry();
  siteGeo.setAttribute('position', new THREE.BufferAttribute(sitePos, 3));
  siteGeo.setAttribute('color', new THREE.BufferAttribute(siteCol, 3));
  sites.forEach((s, i) => toScene(s.lat, s.lon, 1.004).toArray(sitePos, i * 3));
  const siteMat = new THREE.PointsMaterial({ size: 7, sizeAttenuation: false, map: disc, vertexColors: true, alphaTest: 0.35, transparent: true });
  const sitePoints = new THREE.Points(siteGeo, siteMat);
  scene.add(sitePoints);

  
  const bodyPos = new Float32Array(4 * 3);
  const bodyCol = new Float32Array(4 * 3);
  const bodyGeo = new THREE.BufferGeometry();
  bodyGeo.setAttribute('position', new THREE.BufferAttribute(bodyPos, 3));
  bodyGeo.setAttribute('color', new THREE.BufferAttribute(bodyCol, 3));
  const bodyMat = new THREE.PointsMaterial({ size: 13, sizeAttenuation: false, map: disc, vertexColors: true, alphaTest: 0.35, transparent: true });
  const bodyPoints = new THREE.Points(bodyGeo, bodyMat);
  bodyPoints.visible = false;
  scene.add(bodyPoints);
  const lineSun = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, 1)]), new THREE.LineBasicMaterial());
  const lineEarth = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, 1)]), new THREE.LineBasicMaterial());
  lineSun.visible = lineEarth.visible = false;
  scene.add(lineSun, lineEarth);

  
  const sunLabel = el('div', { class: 'g3-label g3-label-sun', text: 'Sun' });
  const earthLabel = el('div', { class: 'g3-label g3-label-earth', text: 'Earth' });
  sunLabel.hidden = earthLabel.hidden = true;
  labels.append(sunLabel, earthLabel);
  let scenMarks = []; 

  
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.09;
  controls.enablePan = false;
  controls.minDistance = 1.25;
  controls.maxDistance = 900;
  controls.rotateSpeed = 0.7;
  controls.zoomSpeed = 0.8;
  controls.addEventListener('change', () => schedule());
  controls.listenToKeyEvents(canvas);
  root.addEventListener('wheel', (e) => {
    if (e.ctrlKey && !e.deltaY) return;
    e.preventDefault();
    e.stopPropagation();
    flight = null;
    const px = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    const f = Math.exp(Math.max(-0.35, Math.min(0.35, px * 0.0016)));
    const d = Math.min(controls.maxDistance, Math.max(controls.minDistance, camera.position.length() * f));
    camera.position.setLength(d);
    controls.update();
    schedule(true);
  }, { capture: true, passive: false });
  controls.keys = { LEFT: 'ArrowLeft', UP: 'ArrowUp', RIGHT: 'ArrowRight', BOTTOM: 'ArrowDown' };

  let W = 300;
  let H = 200;
  let dirty = true;
  let raf = 0;
  let flight = null;
  let tracker = null;
  let hasTexture = false;
  let hoverPt = null;
  const reduced = () => prefersReducedMotion();

  function homeDistance() {
    const t = Math.tan((FOV / 2) * DEG);
    return (1.18 / t) / Math.min(1, camera.aspect || 1);
  }
  function setCamera(lat, lon, dist) {
    toScene(lat, lon, dist, camera.position);
    camera.up.set(0, 1, 0);
    controls.update();
    schedule(true);
  }
  function flyTo(lat, lon, dist) {
    const target = toScene(lat, lon, 1).normalize();
    if (reduced()) {
      setCamera(lat, lon, dist);
      return;
    }
    const from = camera.position.clone();
    flight = { t0: performance.now(), dur: 900, d0: from.length(), d1: dist, q: new THREE.Quaternion().setFromUnitVectors(from.clone().normalize(), target), dir0: from.clone().normalize() };
    schedule(true);
  }
  function stepFlight(now) {
    if (!flight) return;
    const k = Math.min(1, Math.max(0, (now - flight.t0) / flight.dur));
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    const q = new THREE.Quaternion().slerp(flight.q, e);
    const dir = flight.dir0.clone().applyQuaternion(q);
    camera.position.copy(dir.multiplyScalar(flight.d0 + (flight.d1 - flight.d0) * e));
    camera.up.set(0, 1, 0);
    controls.update();
    if (k >= 1) flight = null;
  }
  controls.addEventListener('start', () => { flight = null; });

  
  const mkBtn = (label, fn, pressed) => {
    const b = el('button', { class: 'mv-btn', type: 'button', 'aria-label': label, title: label, onclick: fn }, label);
    if (pressed !== undefined) b.setAttribute('aria-pressed', String(pressed));
    return b;
  };
  const goSiteBtn = mkBtn('Go to site', () => {
    const pt = scenarioPoint(store.active());
    if (pt) flyTo(pt.lat, pt.lon, 2.1);
  });
  const gridBtn = mkBtn('Grid', () => {
    graticule.visible = !graticule.visible;
    gridBtn.setAttribute('aria-pressed', String(graticule.visible));
    schedule(true);
  }, true);
  bar.append(
    mkBtn('View from Earth', () => {
      const se = tracker && tracker.sub ? tracker.sub.subEarth : { lat: 0, lon: 0 };
      flyTo(se.lat, se.lon, homeDistance());
    }),
    mkBtn('South pole', () => flyTo(-89, 0, 2.6)),
    mkBtn('North pole', () => flyTo(89, 0, 2.6)),
    goSiteBtn,
    mkBtn('Earth and Moon', () => {
      const se = tracker && tracker.sub ? tracker.sub.subEarth : { lat: 0, lon: 0 };
      flyTo(-se.lat + 4, se.lon + 180 + 11, 16);
    }),
    gridBtn,
  );

  
  function applyTokens() {
    const c = new THREE.Color();
    sites.forEach((s, i) => {
      c.set(tokens[statusStyle(s.status).token]).toArray(siteCol, i * 3);
    });
    siteGeo.attributes.color.needsUpdate = true;
    c.set(tokens.sun).toArray(bodyCol, 0);
    c.set(tokens.earth).toArray(bodyCol, 3);
    c.set(tokens.sun).toArray(bodyCol, 6);
    c.set(tokens.earth).toArray(bodyCol, 9);
    bodyGeo.attributes.color.needsUpdate = true;
    lineSun.material.color.set(tokens.sun);
    lineEarth.material.color.set(tokens.earth);
    gratMat.color.set(tokens.text);
    gratMat.opacity = document.documentElement.dataset.theme === 'light' ? 0.28 : 0.2;
    schedule(true);
  }

  
  (async () => {
    const maps = await loadMapsMeta();
    if (destroyed) return;
    const bm = describeBasemap(maps, 'global_color');
    new THREE.TextureLoader().load(
      bm.url,
      (tex) => {
        if (destroyed) { tex.dispose(); return; }
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
        moonMat.map = tex;
        moonMat.color.set(0xffffff);
        moonMat.needsUpdate = true;
        hasTexture = true;
        credit.textContent = bm.credit ? `Image: ${bm.credit}` : '';
        note.hidden = true;
        schedule(true);
      },
      undefined,
      () => {
        if (destroyed) return;
        note.textContent = 'Basemap not available – showing a plain Moon with graticule.';
        note.hidden = false;
      },
    );
  })();

  
  function applySub() {
    const sub = tracker && tracker.sub;
    if (!sub) {
      bodyPoints.visible = lineSun.visible = lineEarth.visible = false;
      sunLabel.hidden = earthLabel.hidden = true;
      if (tracker && tracker.error) showNote(tracker.error.message);
      schedule(true);
      return;
    }
    if (!hasTexture || note.textContent.startsWith('Time')) {  }
    const s = toScene(sub.subSolar.lat, sub.subSolar.lon, 1);
    const e = toScene(sub.subEarth.lat, sub.subEarth.lon, 1);
    sun.position.copy(s).multiplyScalar(10);
    s.clone().multiplyScalar(1.006).toArray(bodyPos, 0);
    e.clone().multiplyScalar(1.006).toArray(bodyPos, 3);
    s.clone().multiplyScalar(SUN_LINE).toArray(bodyPos, 6);
    e.clone().multiplyScalar(EARTH_LINE).toArray(bodyPos, 9);
    bodyGeo.attributes.position.needsUpdate = true;
    bodyGeo.computeBoundingSphere();
    lineSun.geometry.setFromPoints([s.clone().multiplyScalar(1.006), s.clone().multiplyScalar(SUN_LINE)]);
    lineEarth.geometry.setFromPoints([e.clone().multiplyScalar(1.006), e.clone().multiplyScalar(EARTH_LINE)]);
    bodyPoints.visible = lineSun.visible = lineEarth.visible = true;
    system.update();
    schedule(true);
  }
  function showNote(t) {
    note.textContent = t;
    note.hidden = !t;
  }

  
  function buildScenarioMarks() {
    for (const m of scenMarks) m.node.remove();
    scenMarks = [];
    const { scenarios, activeId } = store.get();
    for (const sc of scenarios) {
      const pt = scenarioPoint(sc);
      if (!pt) continue;
      const ring = el('span', { class: 'g3-ring' });
      ring.style.setProperty('--c', sc.color);
      const text = el('span', { class: 'g3-mtext', text: sc.site.name.length > 34 ? sc.site.name.slice(0, 33) + '…' : sc.site.name });
      const node = el('div', { class: 'g3-mark' + (sc.id === activeId ? ' is-active' : '') }, ring, text);
      labels.append(node);
      scenMarks.push({ sc, node, pt });
    }
    schedule(true);
  }
  const unsubStore = store.subscribe(() => { buildScenarioMarks(); updateGoBtn(); }, ['scenarios', 'activeId']);
  function updateGoBtn() { goSiteBtn.disabled = !scenarioPoint(store.active()); }

  
  const tmpV = new THREE.Vector3();
  function screenOf(lat, lon, r = 1) {
    toScene(lat, lon, r, tmpV);
    const vis = isVisible(tmpV, r);
    tmpV.project(camera);
    return { x: (tmpV.x * 0.5 + 0.5) * W, y: (-tmpV.y * 0.5 + 0.5) * H, vis };
  }
  const tmpC = new THREE.Vector3();
  const tmpD = new THREE.Vector3();
  
  function isVisible(p) {
    const c = camera.position;
    tmpD.copy(p).sub(c);
    const dd = tmpD.lengthSq();
    const t = Math.min(1, Math.max(0, -c.dot(tmpD) / dd));
    tmpC.copy(c).addScaledVector(tmpD, t);
    return tmpC.length() > 0.9985;
  }

  
  function render(now) {
    if (flight) stepFlight(now);
    
    
    const camDist = camera.position.length();
    camera.near = Math.max(0.05, (camDist - 1.05) * 0.3);
    camera.far = camDist + 400;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    renderer.render(scene, camera);
    
    for (const m of scenMarks) {
      const p = screenOf(m.pt.lat, m.pt.lon, 1.003);
      m.node.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
      m.node.style.visibility = p.vis ? 'visible' : 'hidden';
    }
    const sub = tracker && tracker.sub;
    if (sub) {
      const s = toScene(sub.subSolar.lat, sub.subSolar.lon, SUN_LINE);
      const e = toScene(sub.subEarth.lat, sub.subEarth.lon, EARTH_LINE);
      for (const [node, v] of [[sunLabel, s], [earthLabel, e]]) {
        const vis = isVisible(v);
        const p = v.clone().project(camera);
        node.hidden = false;
        node.style.transform = `translate(${((p.x * 0.5 + 0.5) * W).toFixed(1)}px, ${((-p.y * 0.5 + 0.5) * H).toFixed(1)}px)`;
        node.style.visibility = vis ? 'visible' : 'hidden';
      }
    }
    system.render();
  }
  function frame(now) {
    raf = 0;
    if (destroyed) return;
    const moved = controls.update();
    if (dirty || moved || flight) {
      dirty = false;
      render(now);
    }
    if (moved || flight) schedule();
  }
  function schedule(markDirty) {
    if (markDirty) dirty = true;
    if (!raf && !destroyed) raf = requestAnimationFrame(frame);
  }

  function resize() {
    const r = root.getBoundingClientRect();
    const w = Math.max(80, Math.round(r.width));
    const h = Math.max(80, Math.round(r.height));
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    if (w === W && h === H && camera.aspect && canvas.width) { schedule(true); return; }
    const first = !camera.userData.sized;
    W = w;
    H = h;
    renderer.setSize(W, H, false);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
    if (first) {
      camera.userData.sized = true;
      const se = tracker && tracker.sub ? tracker.sub.subEarth : { lat: 0, lon: 0 };
      if (/[?&]globe=system/.test(location.search)) setCamera(-se.lat + 4, se.lon + 191, 16);
      else setCamera(se.lat, se.lon, homeDistance());
    }
    schedule(true);
  }
  const ro = new ResizeObserver(resize);
  ro.observe(root);

  
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function rel(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function nearestSite(sx, sy, maxPx = 9) {
    camera.updateMatrixWorld();
    let best = null;
    let bd = maxPx;
    sites.forEach((s) => {
      const p = screenOf(s.lat, s.lon, 1.004);
      if (!p.vis) return;
      const d = Math.hypot(p.x - sx, p.y - sy);
      if (d < bd) { bd = d; best = s; }
    });
    return best;
  }
  function nearestScenario(sx, sy) {
    for (const m of scenMarks) {
      const p = screenOf(m.pt.lat, m.pt.lon, 1.003);
      if (p.vis && Math.hypot(p.x - sx, p.y - sy) < 14) return m.sc;
    }
    return null;
  }
  function surfacePoint(sx, sy) {
    ndc.set((sx / W) * 2 - 1, -(sy / H) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObject(moon, false)[0];
    return hit ? fromScene(hit.point) : null;
  }
  let down = null;
  canvas.addEventListener('pointerdown', (e) => { down = { ...rel(e), t: performance.now() }; tip.hidden = true; });
  canvas.addEventListener('pointerup', (e) => {
    if (!down) return;
    const p = rel(e);
    const moved = Math.hypot(p.x - down.x, p.y - down.y);
    const quick = performance.now() - down.t < 700;
    down = null;
    if (moved > 4 || !quick) return;
    const sc = nearestScenario(p.x, p.y);
    const site = sc ? null : nearestSite(p.x, p.y);
    let detail = null;
    if (sc) detail = { lat: sc.site.lat, lon: sc.site.lon, ...(sc.site.id ? { siteId: sc.site.id } : {}) };
    else if (site) detail = { lat: site.lat, lon: site.lon, siteId: site.id };
    else {
      const ll = surfacePoint(p.x, p.y);
      if (ll) detail = { lat: ll.lat, lon: ll.lon };
    }
    if (detail) root.dispatchEvent(new CustomEvent('pick', { detail, bubbles: true }));
  });
  let moveRaf = 0;
  canvas.addEventListener('pointermove', (e) => {
    if (e.buttons) { tip.hidden = true; return; }
    const p = rel(e);
    hoverPt = p;
    if (moveRaf) return;
    moveRaf = requestAnimationFrame(() => {
      moveRaf = 0;
      if (destroyed || !hoverPt) return;
      const sc = nearestScenario(hoverPt.x, hoverPt.y);
      const s = sc ? null : nearestSite(hoverPt.x, hoverPt.y);
      if (!sc && !s) { tip.hidden = true; return; }
      tip.replaceChildren();
      if (sc) tip.append(el('strong', { text: sc.site.name }), el('span', { text: `Scenario · landing ${formatUtc(sc.t0Ms)}` }), el('span', { text: formatLatLon(sc.site.lat, sc.site.lon) }));
      else tip.append(el('strong', { text: s.name }), el('span', { text: [s.agency, statusStyle(s.status).label, formatDate(s.date_utc)].filter(Boolean).join(' · ') }), el('span', { text: formatLatLon(s.lat, s.lon) }));
      tip.hidden = false;
      tip.style.left = Math.max(4, Math.min(W - tip.offsetWidth - 4, hoverPt.x + 14)) + 'px';
      tip.style.top = Math.max(4, Math.min(H - tip.offsetHeight - 4, hoverPt.y + 14)) + 'px';
    });
  });
  canvas.addEventListener('pointerleave', () => { hoverPt = null; tip.hidden = true; });
  
  canvas.addEventListener('keydown', (e) => {
    if (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_') {
      const f = e.key === '+' || e.key === '=' ? 0.85 : 1 / 0.85;
      const d = Math.min(controls.maxDistance, Math.max(controls.minDistance, camera.position.length() * f));
      camera.position.setLength(d);
      controls.update();
      schedule(true);
      e.preventDefault();
    }
  });

  const onLost = (e) => {
    e.preventDefault();
    if (opts.onFail) opts.onFail(new Error('WebGL context lost'));
  };
  canvas.addEventListener('webglcontextlost', onLost);

  const stopTheme = watchTheme(() => { tokens = readTokens(); applyTokens(); });
  const system = createSystemLayer({ app, scene, camera, labels, isVisible, schedule, size: () => [W, H], earthLabel, lineEarth });
  tracker = createSubTracker(app, () => applySub());

  applyTokens();
  buildScenarioMarks();
  updateGoBtn();
  resize();
  

  return {
    kind: 'globe3d',
    
    debug: { camera, scene, moon, toScene, flyTo, setCamera },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      cancelAnimationFrame(moveRaf);
      ro.disconnect();
      stopTheme();
      unsubStore();
      tracker.destroy();
      system.destroy();
      canvas.removeEventListener('webglcontextlost', onLost);
      controls.dispose();
      for (const o of [geo, gratGeo, gratMat, siteGeo, siteMat, bodyGeo, bodyMat, moonMat, disc, lineSun.geometry, lineSun.material, lineEarth.geometry, lineEarth.material]) o.dispose();
      if (moonMat.map) moonMat.map.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      root.remove();
    },
  };
}







const R_MOON_KM = 1737.4;
const R_EARTH_KM = 6378.137;
const HOT_CATEGORIES = new Set(['artemis']);

function createSystemLayer({ app, scene, camera, labels, isVisible, schedule, size, earthLabel, lineEarth }) {
  const { nav, store } = app;
  const tag = (cls, text) => {
    const n = document.createElement('div');
    n.className = `g3-tag ${cls}`;
    n.append(document.createElement('i'), document.createElement('span'));
    n.lastChild.textContent = text;
    labels.append(n);
    return n;
  };
  const meToScene = (x, y, z, out) => out.set(y / R_MOON_KM, z / R_MOON_KM, x / R_MOON_KM);

  
  const earthGeo = new THREE.SphereGeometry(R_EARTH_KM / R_MOON_KM, 48, 24);
  const earthMat = new THREE.MeshLambertMaterial({ color: 0x3f74c4 });
  const earth = new THREE.Mesh(earthGeo, earthMat);
  earth.visible = false;
  const linkGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, 1)]);
  const linkMat = new THREE.LineBasicMaterial({ color: 0x5b9cf5, transparent: true, opacity: 0.55 });
  const link = new THREE.Line(linkGeo, linkMat);
  link.visible = false;
  link.frustumCulled = false;
  scene.add(earth, link);
  const earthTag = tag('g3-tag-earth', 'Earth');
  const moonTag = tag('g3-tag-moon', 'Moon');

  
  let craft = [];
  const trailMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 });
  fetch('data/spacecraft.json').then((r) => (r.ok ? r.json() : null)).then((doc) => {
    if (!doc || !Array.isArray(doc.spacecraft)) return;
    craft = doc.spacecraft.map((c) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(25 * 3), 3));
      const trail = new THREE.Line(geo, trailMat);
      trail.frustumCulled = false;
      trail.visible = false;
      scene.add(trail);
      const node = tag('g3-tag-craft', c.name);
      node.dataset.source = `craft:${c.id}`;
      node.title = `${c.name} · ${c.agency}. ${c.info} Trajectory: NASA/JPL Horizons.`;
      return { c, node, trail, geo, pos: new THREE.Vector3(), on: false };
    });
    update();
    schedule(true);
  }).catch(() => {});
  function craftAt(c, tMs, out) {
    const f = (tMs - c.t0_ms) / c.step_ms;
    if (!(f >= 0 && f <= c.n - 1)) return false;
    const i = Math.min(c.n - 2, Math.floor(f));
    const u = f - i;
    const a = c.xyz_km;
    const k = i * 3;
    meToScene(a[k] + (a[k + 3] - a[k]) * u, a[k + 1] + (a[k + 4] - a[k + 1]) * u, a[k + 2] + (a[k + 5] - a[k + 2]) * u, out);
    return true;
  }

  
  const hot = nav.sites.filter((s) => HOT_CATEGORIES.has(s.category)).map((s) => ({
    node: tag('g3-tag-hot', s.name.split(/\s[—–-]\s/)[0]), v: toScene(s.lat, s.lon, 1.002),
  }));
  const hotGroup = hot.length ? tag('g3-tag-hot g3-tag-group', `${hot.length} Artemis III candidate regions`) : null;
  const hotCentre = new THREE.Vector3();
  for (const h of hot) hotCentre.add(h.v);
  if (hot.length) hotCentre.normalize().multiplyScalar(1.002);

  const tmp = new THREE.Vector3();
  const ev = [0, 0, 0];
  function update() {
    const { timeMs } = store.get();
    try {
      nav.eph.earthVec(timeMs, ev);
      meToScene(ev[0], ev[1], ev[2], earth.position);
      earth.visible = link.visible = true;
      const dir = earth.position.clone().normalize();
      linkGeo.setFromPoints([dir.clone().multiplyScalar(1.006), earth.position.clone().sub(dir.multiplyScalar(R_EARTH_KM / R_MOON_KM))]);
    } catch { earth.visible = link.visible = false; }
    for (const k of craft) {
      k.on = craftAt(k.c, timeMs, k.pos);
      k.trail.visible = k.on;
      if (!k.on) continue;
      const arr = k.geo.attributes.position.array;
      for (let j = 0; j < 25; j++) {               
        if (!craftAt(k.c, timeMs - (24 - j) * 300000, tmp)) tmp.copy(k.pos);
        tmp.toArray(arr, j * 3);
      }
      k.geo.attributes.position.needsUpdate = true;
    }
  }
  function place(node, v, show) {
    if (!show) { node.style.visibility = 'hidden'; return; }
    tmp.copy(v).project(camera);
    const [W, H] = size();
    const ok = tmp.z < 1 && Math.abs(tmp.x) < 1.1 && Math.abs(tmp.y) < 1.1;
    node.style.visibility = ok ? 'visible' : 'hidden';
    if (ok) node.style.transform = `translate(${((tmp.x * 0.5 + 0.5) * W).toFixed(1)}px, ${((-tmp.y * 0.5 + 0.5) * H).toFixed(1)}px)`;
  }
  const origin = new THREE.Vector3();
  function render() {
    const d = camera.position.length();
    const far = d > 7;                              
    labels.classList.toggle('g3-far', far);        
    
    earthLabel.style.display = 'none';
    lineEarth.visible = false;
    place(earthTag, earth.position, earth.visible && isVisible(earth.position));
    place(moonTag, origin, far);
    for (const k of craft) place(k.node, k.pos, k.on && isVisible(k.pos));
    const near = d < 4.2;
    for (const h of hot) place(h.node, h.v, near && isVisible(h.v));
    if (hotGroup) place(hotGroup, hotCentre, !near && isVisible(hotCentre));
  }
  return {
    update, render,
    destroy() {
      for (const o of [earthGeo, earthMat, linkGeo, linkMat, trailMat, ...craft.map((k) => k.geo)]) o.dispose();
    },
  };
}
