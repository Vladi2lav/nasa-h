import { LunarNav } from '../js/core/index.js';
import { browserLoader } from '../js/core/loader.js';
import { createStore } from '../js/ui/store.js';
import { mount } from '../js/ui/maps/mapView.js';

const DAY = 86400000;
const log = document.getElementById('log');
const q = new URLSearchParams(location.search);

try {
  const nav = await LunarNav.create({ loader: browserLoader('../data/') });
  const store = createStore();
  const find = (id) => nav.sites.find((s) => s.id === id);
  const t0 = q.get('t') ? Date.parse(q.get('t')) : Date.now();
  store.set({ timeMs: t0, mapMode: q.get('m') || 'globe' });
  store.addScenario(find('im-2-athena'), t0, 14);
  store.addScenario(find('apollo-11'), t0, 14);
  store.set({ activeId: store.get().scenarios[0].id });
  const app = { nav, store, ctxFor: (s) => nav.prepare(s.site || s), fmt: {}, toast: (m) => { log.textContent = m; } };
  const container = document.getElementById('map');
  container.addEventListener('pick', (e) => { log.textContent = 'pick ' + JSON.stringify(e.detail); });
  const view = mount(container, app);
  const step = (ms) => store.set({ timeMs: store.get().timeMs + ms });
  document.getElementById('prev').onclick = () => step(-DAY);
  document.getElementById('next').onclick = () => step(DAY);
  document.getElementById('now').onclick = () => store.set({ timeMs: Date.now() });
  document.getElementById('a11').onclick = () => store.set({ timeMs: Date.parse('1969-07-20T20:17:40Z') });
  document.getElementById('theme').onclick = () => {
    const r = document.documentElement;
    r.dataset.theme = r.dataset.theme === 'dark' ? 'light' : 'dark';
    store.set({ theme: r.dataset.theme });
  };
  document.getElementById('act').onclick = () => {
    const sc = store.get().scenarios;
    store.set({ activeId: sc.find((s) => s.id !== store.get().activeId).id });
  };
  window.harness = { nav, store, app, view };
} catch (e) {
  log.textContent = 'Harness failed: ' + e.message;
  console.error(e);
}
