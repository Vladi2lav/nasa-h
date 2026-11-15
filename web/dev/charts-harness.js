




import { LunarNav } from '../js/core/index.js';
import { browserLoader } from '../js/core/loader.js';
import { createStore, defaultState, makeScenario } from '../js/ui/store.js';
import { fmtUtc, fmtDuration, fmtDeg } from '../js/ui/charts/chartUtil.js';

const bust = `?v=${Date.now()}`;
const [sky, timeline, year, lw] = await Promise.all(
  ['skyPanorama', 'timeline', 'yearHeatmap', 'landingWindows'].map((m) => import(`../js/ui/charts/${m}.js${bust}`)),
);

const $ = (s) => document.querySelector(s);
const log = (m) => ($('#log').textContent = m);

const nav = await LunarNav.create({ loader: browserLoader('../data/') });
if (nav.warnings.length) console.info('LunarNav warnings:', nav.warnings);

const now = Math.round(Date.now() / 60000) * 60000;
const pole = nav.sites.find((s) => s.id === 'im-2-athena') || nav.sites.find((s) => s.region === 'south-pole');
const a11 = nav.sites.find((s) => s.id === 'apollo-11');
const st = defaultState(now);
st.scenarios = [makeScenario(pole, now, 14, 0), makeScenario(a11, now, 14, 1)];
st.activeId = st.scenarios[0].id;
const params = new URLSearchParams(location.search);
if (params.get('theme') === 'light') st.theme = 'light';
const store = createStore(st);

const ctxCache = new Map();
const app = {
  nav,
  store,
  ctxFor(scOrSite) {
    const site = scOrSite.site || scOrSite;
    const h = store.get().opts.observerHeightM;
    const key = `${site.id || ''}|${site.lat}|${site.lon}|${h}`;
    if (!ctxCache.has(key)) ctxCache.set(key, nav.prepare(site, { observerHeightM: h }));
    return ctxCache.get(key);
  },
  fmt: { utc: fmtUtc, duration: fmtDuration, deg: fmtDeg },
  toast: (m, kind) => log(`[${kind || 'info'}] ${m}`),
};
window.__charts = { nav, store, app };


const sel = $('#active');
const renderSel = () => {
  const s = store.get();
  sel.replaceChildren(...s.scenarios.map((sc) => new Option(`${sc.site.name} — ${fmtUtc(sc.t0Ms)}`, sc.id, false, sc.id === s.activeId)));
};
sel.onchange = () => store.set({ activeId: sel.value });
store.subscribe(renderSel, ['scenarios', 'activeId']);
renderSel();
const renderNow = () => ($('#now').textContent = fmtUtc(store.get().timeMs));
store.subscribe(renderNow, ['timeMs']);
renderNow();
document.querySelectorAll('[data-step]').forEach((b) => (b.onclick = () => store.set({ timeMs: store.get().timeMs + Number(b.dataset.step) })));
$('#out').onclick = () => {
  const sc = store.active();
  store.updateScenario(sc.id, { t0Ms: Date.UTC(2075, 0, 1) });
  store.set({ timeMs: Date.UTC(2075, 0, 1) });
};
const applyTheme = () => document.documentElement.setAttribute('data-theme', store.get().theme);
store.subscribe(applyTheme, ['theme']);
applyTheme();
$('#theme').onclick = () => store.set({ theme: store.get().theme === 'dark' ? 'light' : 'dark' });


let last = 0;
const tick = (ts) => {
  const s = store.get();
  if (!s.playing) return;
  if (last) store.set({ timeMs: s.timeMs + ((ts - last) / 1000) * s.speed * 1000 });
  last = ts;
  requestAnimationFrame(tick);
};
$('#play').onclick = () => {
  const p = !store.get().playing;
  store.set({ playing: p, speed: 6 * 3600 });
};
store.subscribe((s) => {
  $('#play').textContent = s.playing ? 'Pause' : 'Play';
  if (s.playing) {
    last = 0;
    requestAnimationFrame(tick);
  }
}, ['playing']);

const mounted = [
  sky.mount($('#sky'), app),
  timeline.mount($('#timeline'), app),
  timeline.mountCompare($('#compare'), app),
  year.mount($('#year'), app),
  lw.mount($('#lw'), app),
];
window.__charts.mounted = mounted;
log(`ready · coverage ${fmtUtc(nav.coverage.startMs)} … ${fmtUtc(nav.coverage.endMs)}`);
