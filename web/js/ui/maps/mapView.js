import { mountMap2d } from './map2d.js';
import { mountGlobe3d } from './globe3d.js';
import { el, formatUtc, formatLatLon, createSubTracker, scenarioPoint } from './mapUtil.js';

const MODES = [
  ['globe', 'Globe'],
  ['global', 'Global map'],
  ['south', 'South pole'],
  ['north', 'North pole'],
];
const POLAR_LAT = 80;

export function mount(container, app) {
  const store = app.store;
  container.classList.add('mv-root');
  const tabs = el('div', { class: 'mv-tabs', role: 'tablist', 'aria-label': 'Map type' });
  const tabBtns = {};
  for (const [id, label] of MODES) {
    const b = el('button', { class: 'mv-tab', type: 'button', role: 'tab', id: `mv-tab-${id}-${uid}`, 'aria-selected': 'false', tabindex: '-1', onclick: () => choose(id) }, label);
    tabBtns[id] = b;
    tabs.append(b);
  }
  tabs.addEventListener('keydown', (e) => {
    const ids = MODES.map((m) => m[0]);
    const i = ids.indexOf(store.get().mapMode);
    let n = -1;
    if (e.key === 'ArrowRight') n = (i + 1) % ids.length;
    else if (e.key === 'ArrowLeft') n = (i + ids.length - 1) % ids.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = ids.length - 1;
    if (n >= 0) { e.preventDefault(); choose(ids[n]); tabBtns[ids[n]].focus(); }
  });
  const suggest = el('div', { class: 'mv-suggest', hidden: true });
  const toolbar = el('div', { class: 'mv-toolbar' }, tabs, suggest);
  const stage = el('div', { class: 'mv-stage', role: 'tabpanel' });
  const caption = el('div', { class: 'mv-caption' });
  const capTime = el('span', { class: 'mv-cap-time' });
  const capSun = el('span', { class: 'mv-cap-text' });
  const capEarth = el('span', { class: 'mv-cap-text' });
  const sunDot = el('span', { class: 'mv-dot mv-dot-sun', 'aria-hidden': 'true' });
  const earthDot = el('span', { class: 'mv-dot mv-dot-earth', 'aria-hidden': 'true' });
  caption.append(capTime, el('span', { class: 'mv-cap-item' }, sunDot, capSun), el('span', { class: 'mv-cap-item' }, earthDot, capEarth));
  container.append(toolbar, stage, caption);

  let child = null;
  let childMode = null;
  let destroyed = false;
  const dismissed = new Set();

  function choose(id) {
    store.set({ mapMode: id });
  }

  function mountMode(mode) {
    if (child) { child.destroy(); child = null; }
    stage.replaceChildren();
    childMode = mode;
    stage.setAttribute('aria-labelledby', `mv-tab-${mode}-${uid}`);
    for (const [id] of MODES) {
      const on = id === mode;
      tabBtns[id].setAttribute('aria-selected', String(on));
      tabBtns[id].tabIndex = on ? 0 : -1;
    }
    try {
      if (mode === 'globe') {
        try {
          child = mountGlobe3d(stage, app, {
            onFail: (e) => fallback(e),
          });
        } catch (e) {
          if (e && e.code === 'nowebgl') child = mountMap2d(stage, app, { mode: 'global', note: '3D globe unavailable (WebGL is not supported) – showing the flat map.' });
          else throw e;
        }
      } else {
        child = mountMap2d(stage, app, { mode });
      }
    } catch (e) {
      stage.append(el('div', { class: 'mv-error', role: 'alert', text: `The map could not be started: ${e.message}` }));
    }
    updateSuggest();
  }
  function fallback(e) {
    if (destroyed || childMode !== 'globe') return;
    if (child) child.destroy();
    stage.replaceChildren();
    child = mountMap2d(stage, app, { mode: 'global', note: '3D globe stopped (' + e.message + ') – showing the flat map.' });
  }

  function updateSuggest() {
    suggest.replaceChildren();
    suggest.hidden = true;
    const sc = store.active();
    const pt = scenarioPoint(sc);
    const mode = store.get().mapMode;
    if (!pt || dismissed.has(sc.id + mode)) return;
    let target = null;
    let text = '';
    if (pt.lat <= -POLAR_LAT && mode !== 'south') { target = 'south'; text = `${sc.site.name} is near the south pole.`; }
    else if (pt.lat >= POLAR_LAT && mode !== 'north') { target = 'north'; text = `${sc.site.name} is near the north pole.`; }
    else if (Math.abs(pt.lat) < POLAR_LAT - 5 && (mode === 'south' || mode === 'north')) { target = 'global'; text = `${sc.site.name} is not on this polar map.`; }
    if (!target) return;
    const label = MODES.find((m) => m[0] === target)[1];
    suggest.append(
      el('span', { class: 'mv-suggest-text', text }),
      el('button', { class: 'mv-btn mv-btn-accent', type: 'button', onclick: () => choose(target) }, `Show ${label}`),
      el('button', { class: 'mv-btn mv-btn-quiet', type: 'button', 'aria-label': 'Dismiss suggestion', onclick: () => { dismissed.add(sc.id + mode); updateSuggest(); } }, '×'),
    );
    suggest.hidden = false;
  }

  function updateCaption(tracker) {
    capTime.textContent = formatUtc(store.get().timeMs);
    const sub = tracker.sub;
    if (sub) {
      capSun.textContent = `Sub-solar ${formatLatLon(sub.subSolar.lat, sub.subSolar.lon)}`;
      capEarth.textContent = `Sub-Earth ${formatLatLon(sub.subEarth.lat, sub.subEarth.lon)}`;
      capSun.classList.remove('is-error');
    } else {
      capSun.textContent = tracker.error ? tracker.error.message : 'Loading ephemeris…';
      capSun.classList.toggle('is-error', !!tracker.error);
      capEarth.textContent = '';
    }
  }
  const tracker = createSubTracker(app, updateCaption);
  capTime.textContent = formatUtc(store.get().timeMs);

  const unsub = store.subscribe((s, changed) => {
    if (changed.includes('mapMode') && s.mapMode !== childMode) mountMode(s.mapMode);
    else if (changed.includes('scenarios') || changed.includes('activeId')) updateSuggest();
    if (changed.includes('timeMs')) capTime.textContent = formatUtc(s.timeMs);
  }, ['mapMode', 'scenarios', 'activeId', 'timeMs']);

  const initial = store.get().mapMode;
  mountMode(MODES.some((m) => m[0] === initial) ? initial : 'globe');

  return {
    destroy() {
      destroyed = true;
      unsub();
      tracker.destroy();
      if (child) child.destroy();
      child = null;
      toolbar.remove();
      stage.remove();
      caption.remove();
      container.classList.remove('mv-root');
    },
  };
}

const uid = Math.random().toString(36).slice(2, 7);
