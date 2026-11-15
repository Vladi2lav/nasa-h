




const DAY_MS = 86400000;

export const SCENARIO_COLORS = ['#f5a524', '#4da3ff', '#3ecf8e', '#e879a6', '#a78bfa', '#f97316'];



export function defaultState(nowMs = Date.now()) {
  return {
    timeMs: nowMs,            
    scenarios: [],            
    activeId: null,           
    opts: {                   
      sunMinFraction: 0.5,
      commMaskDeg: 2,
      panel: 'tracking',
      observerHeightM: 2,
    },
    view: 'explore',          
    mapMode: 'globe',         
    timelineDays: 30,         
    playing: false,           
    speed: 3600,              
    learn: false,             
    theme: 'dark',            
  };
}

let nextId = 1;
export function makeScenario(site, t0Ms, durationDays = 14, index = 0) {
  return {
    id: `s${nextId++}`,
    site: { id: site.id, name: site.name, lat: site.lat, lon: site.lon },
    t0Ms,
    durationDays,
    color: SCENARIO_COLORS[index % SCENARIO_COLORS.length],
  };
}

export function createStore(initial = defaultState()) {
  let state = initial;
  const listeners = new Set();

  return {
    get: () => state,

    
    set(patch) {
      const changed = [];
      const next = { ...state };
      for (const [key, value] of Object.entries(patch)) {
        const merged = key === 'opts' ? { ...state.opts, ...value } : value;
        if (key === 'opts' ? JSON.stringify(merged) !== JSON.stringify(state.opts) : merged !== state[key]) {
          next[key] = merged;
          changed.push(key);
        }
      }
      if (!changed.length) return;
      state = next;
      for (const fn of [...listeners]) fn(state, changed);
    },

    
    subscribe(fn, keys = null) {
      const wrapped = keys ? (s, changed) => { if (changed.some((k) => keys.includes(k))) fn(s, changed); } : fn;
      listeners.add(wrapped);
      return () => listeners.delete(wrapped);
    },

    active() {
      return state.scenarios.find((s) => s.id === state.activeId) || state.scenarios[0] || null;
    },

    addScenario(site, t0Ms = state.timeMs, durationDays = 14) {
      const sc = makeScenario(site, t0Ms, durationDays, state.scenarios.length);
      this.set({ scenarios: [...state.scenarios, sc], activeId: sc.id });
      return sc;
    },

    updateScenario(id, patch) {
      this.set({ scenarios: state.scenarios.map((s) => (s.id === id ? { ...s, ...patch } : s)) });
    },

    removeScenario(id) {
      const scenarios = state.scenarios.filter((s) => s.id !== id);
      const activeId = state.activeId === id ? (scenarios[0]?.id ?? null) : state.activeId;
      this.set({ scenarios, activeId });
    },
  };
}




export function encodeHash(state) {
  const iso = (ms) => new Date(ms).toISOString().slice(0, 16) + 'Z';
  const sc = state.scenarios
    .map((s) => [s.site.lat.toFixed(5), s.site.lon.toFixed(5), iso(s.t0Ms), s.durationDays, s.site.id || '', encodeURIComponent(s.site.name)].join(','))
    .join('|');
  const p = new URLSearchParams();
  p.set('t', iso(state.timeMs));
  if (sc) p.set('s', sc);
  p.set('a', String(Math.max(0, state.scenarios.findIndex((s) => s.id === state.activeId))));
  p.set('v', state.view);
  p.set('m', state.mapMode);
  p.set('o', [state.opts.sunMinFraction, state.opts.commMaskDeg, state.opts.panel, state.opts.observerHeightM].join(','));
  return '#' + p.toString();
}


export function decodeHash(hash) {
  const patch = {};
  if (!hash || hash.length < 2) return patch;
  const p = new URLSearchParams(hash.slice(1));
  const t = Date.parse(p.get('t') || '');
  if (Number.isFinite(t)) patch.timeMs = t;
  const s = p.get('s');
  if (s) {
    const scenarios = [];
    for (const part of s.split('|')) {
      const [lat, lon, t0, days, id, ...nameParts] = part.split(',');
      const site = { name: decodeURIComponent(nameParts.join(',')) || 'Custom site', lat: Number(lat), lon: Number(lon) };
      if (id) site.id = id;
      const t0Ms = Date.parse(t0);
      if (Number.isFinite(site.lat) && Number.isFinite(site.lon) && Math.abs(site.lat) <= 90 && Number.isFinite(t0Ms)) {
        scenarios.push(makeScenario(site, t0Ms, Math.min(400, Math.max(1, Number(days) || 14)), scenarios.length));
      }
    }
    if (scenarios.length) {
      patch.scenarios = scenarios;
      patch.activeId = (scenarios[Number(p.get('a')) || 0] || scenarios[0]).id;
    }
  }
  if (['explore', 'compare', 'plan', 'learn'].includes(p.get('v'))) patch.view = p.get('v');
  if (['globe', 'global', 'south', 'north'].includes(p.get('m'))) patch.mapMode = p.get('m');
  const o = (p.get('o') || '').split(',');
  if (o.length === 4) {
    const opts = {};
    if (Number(o[0]) > 0 && Number(o[0]) <= 1) opts.sunMinFraction = Number(o[0]);
    if (Number.isFinite(Number(o[1]))) opts.commMaskDeg = Number(o[1]);
    if (['tracking', 'horizontal'].includes(o[2])) opts.panel = o[2];
    if (Number(o[3]) >= 0) opts.observerHeightM = Number(o[3]);
    patch.opts = opts;
  }
  return patch;
}

export { DAY_MS };
