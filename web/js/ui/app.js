






import { LunarNav } from '../core/index.js';
import { browserLoader } from '../core/loader.js';
import { createStore, defaultState, encodeHash, decodeHash, SCENARIO_COLORS, DAY_MS } from './store.js';
import { fmt, roundToHour, escapeHtml, utc, utcDate } from './format.js';
import { icon } from './icons.js';
import { $, $$, debounce, reducedMotion } from './dom.js';
import * as scenarioBar from './scenarioBar.js';
import * as sitePicker from './sitePicker.js';
import * as timeControl from './timeControl.js';
import * as statusCard from './statusCard.js';
import * as kpiPanel from './kpiPanel.js';
import * as compareView from './compareView.js';
import * as planView from './planView.js';
import * as learnView from './learnView.js';
import { mountSources } from './sources.js';
import * as options from './options.js';
import * as exporter from './exporter.js';

const MAX_SCENARIOS = 6;
const DEFAULT_SITE_IDS = ['im-2-athena', 'apollo-11'];
const THEME_KEY = 'lunarnav.theme';
const VIEWS = ['explore', 'compare', 'plan', 'learn'];
const HOUR_MS = 3600000;



const bootEl = document.getElementById('boot');
const bootMsg = document.getElementById('boot-msg');
const bootBar = document.getElementById('boot-bar');
function bootStep(text, progress) {
  if (bootMsg) bootMsg.textContent = text;
  if (bootBar && Number.isFinite(progress)) bootBar.style.width = `${Math.round(progress * 100)}%`;
}
function bootFail(err) {
  console.error(err);
  if (!bootEl) return;
  bootEl.classList.add('boot--error');
  const box = document.getElementById('boot-error');
  if (box) {
    box.hidden = false;
    box.innerHTML = `
      <p class="boot-error-title">${icon('warning')} The navigator could not start.</p>
      <p class="boot-error-detail">${escapeHtml(err?.message || String(err))}</p>
      <p class="boot-error-hint">The app needs to be served over HTTP (for example
      <code>python -m http.server --directory web</code>) so it can load its data files.</p>
      <button type="button" class="btn btn-primary" id="boot-retry">Try again</button>`;
    document.getElementById('boot-retry')?.addEventListener('click', () => location.reload());
  }
}
function bootDone() {
  document.body.classList.remove('booting');
  if (!bootEl) return;
  bootEl.classList.add('boot--done');
  setTimeout(() => bootEl.remove(), reducedMotion() ? 0 : 400);
}



const toastHost = () => document.getElementById('toasts');
const toastKeys = new Map();

function toast(message, kind = 'info', extra = {}) {
  const host = toastHost();
  if (!host) {
    console.log(`[${kind}] ${message}`);
    return () => {};
  }
  const { key = null, actions = [], timeoutMs = kind === 'error' ? 9000 : actions.length ? 12000 : 5000 } = extra;
  if (key && toastKeys.has(key)) toastKeys.get(key)();
  const el = document.createElement('div');
  el.className = `toast toast--${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  const ic = { info: 'info', success: 'check', warn: 'warning', error: 'warning' }[kind] || 'info';
  el.innerHTML = `<span class="toast-icon">${icon(ic)}</span><div class="toast-body"><p class="toast-text"></p><div class="toast-actions"></div></div>
    <button type="button" class="icon-btn icon-btn--sm toast-close" aria-label="Dismiss notification">${icon('close', { size: 14 })}</button>`;
  el.querySelector('.toast-text').textContent = message;
  const actHost = el.querySelector('.toast-actions');
  let timer = 0;
  const dismiss = () => {
    clearTimeout(timer);
    if (key && toastKeys.get(key) === dismiss) toastKeys.delete(key);
    el.classList.add('toast--out');
    setTimeout(() => el.remove(), reducedMotion() ? 0 : 200);
  };
  for (const a of actions) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-sm';
    b.textContent = a.label;
    b.addEventListener('click', () => {
      dismiss();
      a.onClick?.();
    });
    actHost.appendChild(b);
  }
  if (!actions.length) actHost.remove();
  el.querySelector('.toast-close').addEventListener('click', dismiss);
  host.appendChild(el);
  while (host.children.length > 4) host.firstElementChild.remove();
  if (timeoutMs > 0) {
    timer = setTimeout(dismiss, timeoutMs);
    el.addEventListener('pointerenter', () => clearTimeout(timer));
    el.addEventListener('pointerleave', () => { timer = setTimeout(dismiss, 3000); });
  }
  if (key) toastKeys.set(key, dismiss);
  return dismiss;
}



let lastErrorToast = 0;
function reportError(err, where = '') {
  console.error(where || 'Unhandled error', err);
  const now = Date.now();
  if (now - lastErrorToast < 4000) return;
  lastErrorToast = now;
  const msg = err?.message || String(err || 'unknown error');
  toast(`Something went wrong${where ? ` in ${where}` : ''}: ${msg}`, 'error', { key: 'global-error' });
}
window.addEventListener('error', (e) => {
  
  if (!e.error && e.target && e.target !== window) return;
  reportError(e.error || e.message);
});
window.addEventListener('unhandledrejection', (e) => reportError(e.reason));





function createApp(nav, store) {
  const coverage = nav.coverage;
  const ctxCache = new Map();
  const summaryCache = new Map();
  const loaded = []; 

  const siteOf = (x) => (x && x.site && Number.isFinite(x.site.lat) ? x.site : x);
  const ctxKey = (site, h) => `${site.id || ''}|${Number(site.lat).toFixed(6)}|${Number(site.lon).toFixed(6)}|${h}`;

  const app = {
    nav,
    store,
    fmt,
    icon,
    toast,
    coverage,
    MAX_SCENARIOS,
    reportError,

    
    analysisOpts(state = store.get()) {
      const { sunMinFraction, commMaskDeg, panel } = state.opts;
      return { sunMinFraction, commMaskDeg, panel };
    },

    
    ctxFor(scOrSite) {
      const site = siteOf(scOrSite);
      if (!site || !Number.isFinite(site.lat) || !Number.isFinite(site.lon)) {
        return Promise.reject(new RangeError('ctxFor needs a scenario or a site with lat/lon'));
      }
      const h = store.get().opts.observerHeightM ?? 2;
      const key = ctxKey(site, h);
      let p = ctxCache.get(key);
      if (!p) {
        const clean = { lat: site.lat, lon: site.lon, name: site.name };
        if (site.id) {
          const cat = nav.sites.find((s) => s.id === site.id);
          Object.assign(clean, cat ? { ...cat, lat: site.lat, lon: site.lon } : { id: site.id });
        }
        p = nav.prepare(clean, { observerHeightM: h });
        ctxCache.set(key, p);
        p.catch(() => ctxCache.delete(key));
        if (ctxCache.size > 64) ctxCache.delete(ctxCache.keys().next().value);
      }
      return p;
    },

    
    async summaryFor(sc, optsOverride = null) {
      const opts = optsOverride || app.analysisOpts();
      const h = store.get().opts.observerHeightM ?? 2;
      const key = `${ctxKey(sc.site, h)}|${sc.t0Ms}|${sc.durationDays}|${JSON.stringify(opts)}`;
      let p = summaryCache.get(key);
      if (!p) {
        p = app.ctxFor(sc).then((ctx) => nav.summary(ctx, sc.t0Ms, sc.durationDays, opts));
        summaryCache.set(key, p);
        p.catch(() => summaryCache.delete(key));
        if (summaryCache.size > 80) summaryCache.delete(summaryCache.keys().next().value);
      }
      return p;
    },

    active: () => store.active(),

    
    clampTime(ms, marginMs = 0) {
      const lo = coverage.startMs;
      const hi = coverage.endMs - marginMs;
      if (!Number.isFinite(ms)) return { ms: store.get().timeMs, clamped: true };
      if (ms < lo) return { ms: lo, clamped: true };
      if (ms > hi) return { ms: hi, clamped: true };
      return { ms, clamped: false };
    },

    coverageText() {
      return `${utcDate(coverage.startMs)} … ${utcDate(coverage.endMs)}`;
    },

    
    isLoaded(t0, t1 = t0) {
      return loaded.some(([a, b]) => t0 >= a && t1 <= b);
    },

    
    async ensure(t0, t1 = t0) {
      const a = Math.max(coverage.startMs, Math.min(t0, t1));
      const b = Math.min(coverage.endMs, Math.max(t0, t1));
      if (app.isLoaded(a, b)) return;
      await nav.ensure(a, b);
      loaded.push([a, b]);
      loaded.sort((x, y) => x[0] - y[0]);
      for (let i = loaded.length - 2; i >= 0; i--) {
        if (loaded[i + 1][0] <= loaded[i][1]) {
          loaded[i][1] = Math.max(loaded[i][1], loaded[i + 1][1]);
          loaded.splice(i + 1, 1);
        }
      }
    },

    
    async setTime(ms) {
      const c = app.clampTime(ms);
      if (c.clamped && Number.isFinite(ms)) coverageToast();
      try {
        await app.ensure(c.ms - DAY_MS, c.ms + 30 * DAY_MS);
      } catch (e) {
        reportError(e, 'loading the ephemeris');
      }
      store.set({ timeMs: c.ms });
    },

    
    addScenario(site, t0Ms = roundToHour(store.get().timeMs), durationDays = 14) {
      const s = store.get();
      if (s.scenarios.length >= MAX_SCENARIOS) {
        toast(`Up to ${MAX_SCENARIOS} scenarios can be compared. Remove one first.`, 'warn', { key: 'max-scn' });
        return null;
      }
      const sc = store.addScenario({ id: site.id, name: site.name || 'Custom site', lat: site.lat, lon: site.lon }, t0Ms, durationDays);
      const used = new Set(s.scenarios.map((x) => x.color));
      const free = SCENARIO_COLORS.find((c) => !used.has(c));
      if (free && free !== sc.color) store.updateScenario(sc.id, { color: free });
      return store.get().scenarios.find((x) => x.id === sc.id);
    },

    
    replaceActiveSite(site) {
      const act = store.active();
      if (!act) return app.addScenario(site);
      store.updateScenario(act.id, { site: { id: site.id, name: site.name || 'Custom site', lat: site.lat, lon: site.lon } });
      return act;
    },

    setView(view) {
      if (VIEWS.includes(view)) store.set({ view });
    },

    
    mountModule: (container, path, o) => mountModule(app, container, path, o),
  };

  
  const rawSet = store.set.bind(store);
  store.set = (patch) => {
    const p = { ...patch };
    if ('timeMs' in p) {
      const c = app.clampTime(p.timeMs);
      if (c.clamped && Number.isFinite(p.timeMs)) coverageToast();
      p.timeMs = c.ms;
    }
    if ('scenarios' in p && Array.isArray(p.scenarios)) {
      let clamped = false;
      p.scenarios = p.scenarios.map((sc) => {
        let durationDays = Number(sc.durationDays);
        if (!(durationDays >= 1)) durationDays = 1;
        if (durationDays > 400) durationDays = 400;
        const c = app.clampTime(sc.t0Ms, durationDays * DAY_MS);
        if (c.clamped) clamped = true;
        return c.ms === sc.t0Ms && durationDays === sc.durationDays ? sc : { ...sc, t0Ms: c.ms, durationDays };
      });
      if (clamped) coverageToast(true);
    }
    rawSet(p);
  };

  function coverageToast(isScenario = false) {
    toast(
      `${isScenario ? 'Mission windows' : 'Dates'} must lie within the ephemeris coverage ${app.coverageText()} (NASA/JPL DE440 data shipped with the app). The value was moved to the nearest valid date.`,
      'warn',
      { key: 'coverage' },
    );
  }

  return app;
}



const MODULE_LABELS = {
  './maps/mapView.js': 'Map & globe',
  './charts/timeline.js': 'Timeline',
  './charts/skyPanorama.js': 'Sky panorama',
  './charts/yearHeatmap.js': 'Year heatmap',
  './charts/landingWindows.js': 'Landing windows',
};


function mountModule(app, container, path, { exportName = 'mount', label = MODULE_LABELS[path] || path } = {}) {
  let handle = null;
  let dead = false;
  container.classList.add('mount--loading');
  container.innerHTML = `<div class="skeleton" role="status"><span class="spinner" aria-hidden="true"></span><span>Loading ${escapeHtml(label)}…</span></div>`;
  const fail = (err, phase) => {
    if (dead) return;
    const missing = phase === 'import' && /fetch|import|404|resolve|Failed to load/i.test(String(err?.message || err));
    console.warn(`[shell] ${label} (${path}) ${phase} failed:`, err);
    container.classList.remove('mount--loading');
    container.classList.add('mount--placeholder');
    container.innerHTML = `
      <div class="placeholder" role="note">
        <span class="placeholder-icon">${icon(missing ? 'layers' : 'warning', { size: 22 })}</span>
        <p class="placeholder-title">${escapeHtml(label)} ${missing ? 'is not available yet' : 'could not start'}</p>
        <p class="placeholder-text">${missing
          ? `The module <code>${escapeHtml(path.replace('./', 'js/ui/'))}</code> is not installed in this build. The rest of the navigator works without it.`
          : escapeHtml(err?.message || String(err))}</p>
      </div>`;
  };
  import(path)
    .then(async (mod) => {
      if (dead) return;
      const fn = mod[exportName];
      if (typeof fn !== 'function') throw Object.assign(new Error(`${path} does not export ${exportName}()`), { phase: 'mount' });
      container.classList.remove('mount--loading');
      container.innerHTML = '';
      try {
        let h = fn(container, app);
        if (h && typeof h.then === 'function') h = await h;
        if (dead) {
          h?.destroy?.();
          return;
        }
        handle = h;
      } catch (e) {
        e.phase = 'mount';
        throw e;
      }
    }, (e) => fail(e, 'import'))
    .catch((e) => fail(e, e?.phase || 'mount'));
  return {
    destroy() {
      dead = true;
      try {
        handle?.destroy?.();
      } catch (e) {
        console.error(`[shell] destroying ${label}:`, e);
      }
      handle = null;
      container.innerHTML = '';
      container.classList.remove('mount--loading', 'mount--placeholder');
    },
  };
}


function mountLocal(app, container, mod, label) {
  try {
    return mod.mount(container, app) || { destroy() {} };
  } catch (e) {
    reportError(e, label);
    container.innerHTML = `<div class="placeholder" role="note"><span class="placeholder-icon">${icon('warning', { size: 22 })}</span>
      <p class="placeholder-title">${escapeHtml(label)} could not start</p><p class="placeholder-text">${escapeHtml(e.message)}</p></div>`;
    return { destroy() { container.innerHTML = ''; } };
  }
}



function setupViews(app) {
  const { store } = app;
  const mounted = {}; 
  const enter = {
    explore: () => [
      app.mountModule($('#mount-map'), './maps/mapView.js'),
      app.mountModule($('#mount-timeline'), './charts/timeline.js'),
      app.mountModule($('#mount-sky'), './charts/skyPanorama.js'),
      mountLocal(app, $('#status-card'), statusCard, 'Status card'),
      mountLocal(app, $('#kpi-panel'), kpiPanel, 'Mission summary'),
    ],
    compare: () => [mountLocal(app, $('#view-compare'), compareView, 'Compare view')],
    plan: () => [mountLocal(app, $('#view-plan'), planView, 'Plan view')],
    learn: () => [mountLocal(app, $('#view-learn'), learnView, 'Learn view')],
  };
  const tabs = $$('.view-tab');
  function show(view) {
    for (const v of VIEWS) {
      const panel = $(`#view-${v}`);
      const on = v === view;
      panel.hidden = !on;
      if (on && !mounted[v]) mounted[v] = enter[v]();
      if (!on && mounted[v]) {
        mounted[v].forEach((h) => h.destroy());
        mounted[v] = null;
      }
    }
    for (const t of tabs) {
      const on = t.dataset.view === view;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
    }
    document.body.dataset.view = view;
  }
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => app.setView(t.dataset.view));
    t.addEventListener('keydown', (e) => {
      let j = null;
      if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
      if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
      if (e.key === 'Home') j = 0;
      if (e.key === 'End') j = tabs.length - 1;
      if (j !== null) {
        e.preventDefault();
        tabs[j].focus();
        app.setView(tabs[j].dataset.view);
      }
    });
  });
  store.subscribe((s) => show(s.view), ['view']);
  show(store.get().view);
}



function setupHashSync(app) {
  const { store } = app;
  let lastHash = '';
  const write = () => {
    const h = encodeHash(store.get());
    lastHash = h;
    if (h !== location.hash) history.replaceState(null, '', h);
  };
  const slow = debounce(write, 1500);
  const fast = debounce(write, 350);
  store.subscribe((s, changed) => {
    if (changed.length === 1 && changed[0] === 'timeMs' && s.playing) slow();
    else fast();
  }, ['timeMs', 'scenarios', 'activeId', 'view', 'mapMode', 'opts']);
  window.addEventListener('hashchange', () => {
    if (location.hash === lastHash) return;
    const patch = decodeHash(location.hash);
    if (Object.keys(patch).length) {
      store.set({ ...patch, playing: false });
      toast('Loaded the scenarios from the link.', 'info', { key: 'hash' });
    }
  });
  app.writeHash = write;
  app.shareUrl = () => {
    write();
    return location.href;
  };
  write();
}



function setupClock(app) {
  const { store, coverage } = app;
  let raf = 0;
  let last = 0;
  let acc = 0;
  let prefetching = false;
  const prefetch = (t, speed) => {
    const ahead = Math.max(30 * DAY_MS, speed * 1000 * 20); 
    const end = Math.min(coverage.endMs, t + ahead);
    if (prefetching || app.isLoaded(t, end)) return;
    prefetching = true;
    app.ensure(t, Math.min(coverage.endMs, t + ahead * 2))
      .catch((e) => reportError(e, 'loading the ephemeris'))
      .finally(() => { prefetching = false; });
  };
  const frame = (now) => {
    raf = 0;
    const s = store.get();
    if (!s.playing) return;
    const dt = Math.min(0.25, Math.max(0, (now - last) / 1000));
    last = now;
    acc += dt;
    
    const quantum = reducedMotion() ? 0.5 : 0;
    if (acc >= quantum) {
      let t = s.timeMs + acc * s.speed * 1000;
      acc = 0;
      if (t >= coverage.endMs) {
        t = coverage.endMs;
        store.set({ timeMs: t, playing: false });
        toast(`Reached the end of the ephemeris coverage (${utcDate(coverage.endMs)}).`, 'info');
        return;
      }
      if (!app.isLoaded(t)) {
        
        prefetch(s.timeMs, s.speed);
      } else {
        store.set({ timeMs: t });
        prefetch(t, s.speed);
      }
    }
    raf = requestAnimationFrame(frame);
  };
  const sync = (s) => {
    if (s.playing && !raf) {
      last = performance.now();
      acc = 0;
      raf = requestAnimationFrame(frame);
    } else if (!s.playing && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };
  store.subscribe(sync, ['playing']);
  
  store.subscribe((s) => {
    if (!app.isLoaded(s.timeMs - DAY_MS, Math.min(coverage.endMs, s.timeMs + 7 * DAY_MS))) {
      app.ensure(s.timeMs - 2 * DAY_MS, s.timeMs + 60 * DAY_MS).catch((e) => reportError(e, 'loading the ephemeris'));
    }
  }, ['timeMs']);
  store.subscribe((s) => {
    for (const sc of s.scenarios) {
      app.ensure(sc.t0Ms, sc.t0Ms + sc.durationDays * DAY_MS).catch((e) => reportError(e, 'loading the ephemeris'));
    }
  }, ['scenarios']);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && store.get().playing) store.set({ playing: false });
  });
}



function setupChrome(app) {
  app.sources = mountSources(app);
  const { store } = app;
  const root = document.documentElement;
  const btn = $('#theme-toggle');
  const apply = (theme) => {
    root.dataset.theme = theme;
    try { localStorage.setItem(THEME_KEY, theme); } catch {  }
    if (btn) {
      const next = theme === 'dark' ? 'light' : 'dark';
      btn.innerHTML = icon(theme === 'dark' ? 'sun' : 'moon');
      btn.setAttribute('aria-label', `Switch to ${next} theme`);
      btn.title = `Switch to ${next} theme`;
    }
    window.dispatchEvent(new CustomEvent('lunarnav:theme', { detail: { theme } }));
  };
  btn?.addEventListener('click', () => store.set({ theme: store.get().theme === 'dark' ? 'light' : 'dark' }));
  store.subscribe((s) => apply(s.theme), ['theme']);
  apply(store.get().theme);

  
  const header = $('.app-header');
  if (header) new ResizeObserver(() => root.style.setProperty('--header-h', `${header.offsetHeight}px`)).observe(header);

  
  const toggle = $('#drawer-toggle');
  const rail = $('#rail');
  const scrim = $('#drawer-scrim');
  const setDrawer = (open) => {
    document.body.classList.toggle('drawer-open', open);
    toggle?.setAttribute('aria-expanded', String(open));
    if (open) rail?.querySelector('input, button')?.focus({ preventScroll: true });
  };
  app.openDrawer = () => setDrawer(true);
  app.closeDrawer = () => {
    if (document.body.classList.contains('drawer-open')) {
      setDrawer(false);
      toggle?.focus({ preventScroll: true });
    }
  };
  toggle?.addEventListener('click', () => setDrawer(!document.body.classList.contains('drawer-open')));
  scrim?.addEventListener('click', () => app.closeDrawer());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('drawer-open')) app.closeDrawer();
  });
  
  store.subscribe(() => {
    if (matchMedia('(max-width: 799.98px)').matches) app.closeDrawer();
  }, ['activeId']);

  
  let themeBeforePrint = null;
  window.addEventListener('afterprint', () => { if (themeBeforePrint) root.dataset.theme = themeBeforePrint; themeBeforePrint = null; });
  window.addEventListener('beforeprint', () => {
    themeBeforePrint = root.dataset.theme;
    root.dataset.theme = 'light';
    const ph = $('#print-header');
    if (!ph) return;
    const s = store.get();
    ph.innerHTML = `<h1>Lunar Landing Site Navigator — report</h1>
      <p>Generated ${escapeHtml(utc(Date.now()))} · shown instant ${escapeHtml(utc(s.timeMs))} ·
      sunlit ≥ ${Math.round(s.opts.sunMinFraction * 100)}% of disc, DTE mask ${s.opts.commMaskDeg}°,
      ${escapeHtml(s.opts.panel)} panel, observer ${s.opts.observerHeightM} m</p>
      <ol>${s.scenarios.map((sc) => `<li>${escapeHtml(sc.site.name)} — ${escapeHtml(fmt.latlon(sc.site.lat, sc.site.lon))} — landing ${escapeHtml(utc(sc.t0Ms))}, ${sc.durationDays} d</li>`).join('')}</ol>
      <p class="print-link">${escapeHtml(app.shareUrl ? app.shareUrl() : location.href)}</p>`;
  });
}



function initialState(nav) {
  let theme = 'dark';
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t === 'light' || t === 'dark') theme = t;
  } catch {  }
  const cov = nav.coverage;
  const nowMs = Math.min(cov.endMs - 30 * DAY_MS, Math.max(cov.startMs, roundToHour(Date.now())));
  const state = { ...defaultState(nowMs), theme };
  const patch = decodeHash(location.hash);
  Object.assign(state, patch);
  if (patch.opts) state.opts = { ...defaultState().opts, ...patch.opts };
  if (!state.scenarios.length) {
    const tmp = createStore(state);
    for (const id of DEFAULT_SITE_IDS) {
      const site = nav.sites.find((s) => s.id === id);
      if (site) tmp.addScenario(site, nowMs, 14);
    }
    if (!tmp.get().scenarios.length) {
      tmp.addScenario({ name: 'Lunar south pole region', lat: -84.79, lon: 29.2 }, nowMs, 14);
    }
    Object.assign(state, tmp.get(), { activeId: tmp.get().scenarios[0].id });
  }
  return state;
}

async function boot() {
  bootStep('Loading the site catalogue and the ephemeris index…', 0.1);
  const nav = await LunarNav.create({ loader: browserLoader('data/') });
  if (nav.warnings.length) console.info('[LunarNav] warnings:', nav.warnings);

  const store = createStore(initialState(nav));
  const app = createApp(nav, store);
  window.lunarnav = app; 
  
  const s0 = store.get();
  store.set({ timeMs: s0.timeMs, scenarios: [...s0.scenarios] });

  const s = store.get();
  bootStep(`Loading NASA/JPL ephemeris for ${utcDate(s.timeMs)}…`, 0.35);
  await app.ensure(s.timeMs - 2 * DAY_MS, s.timeMs + 60 * DAY_MS);
  await Promise.all(s.scenarios.map((sc) => app.ensure(sc.t0Ms, sc.t0Ms + sc.durationDays * DAY_MS)));

  bootStep('Preparing landing sites (terrain horizons)…', 0.65);
  const ctxs = await Promise.allSettled(s.scenarios.map((sc) => app.ctxFor(sc)));
  ctxs.filter((r) => r.status === 'rejected').forEach((r) => console.warn('[shell] prepare failed', r.reason));

  bootStep('Drawing the interface…', 0.9);
  setupChrome(app);
  mountLocal(app, $('#time-control'), timeControl, 'Time control');
  mountLocal(app, $('#options-slot'), options, 'Options');
  mountLocal(app, $('#export-slot'), exporter, 'Export');
  mountLocal(app, $('#scenario-bar'), scenarioBar, 'Scenarios');
  mountLocal(app, $('#site-picker'), sitePicker, 'Site picker');
  setupViews(app);
  setupHashSync(app);
  setupClock(app);

  
  document.addEventListener('pick', (e) => {
    const d = e.detail || {};
    if (!Number.isFinite(d.lat) || !Number.isFinite(d.lon)) return;
    const cat = d.siteId ? nav.sites.find((x) => x.id === d.siteId) : null;
    app.proposeSite?.(cat ? { ...cat } : { lat: d.lat, lon: d.lon, name: d.name });
  });

  const sphere = ctxs.some((r) => r.status === 'fulfilled' && r.value.horizonSource === 'sphere');
  if (sphere) {
    toast('Terrain data is not installed in this build: horizons use a smooth sphere. Each status card says which horizon source it uses.', 'warn', { key: 'terrain' });
  }
  bootStep('Ready', 1);
  bootDone();
}

boot().catch(bootFail);
