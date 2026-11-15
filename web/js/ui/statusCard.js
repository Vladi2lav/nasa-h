







import { icon } from './icons.js';
import { escapeHtml, latlon, utc, az, deg, signedDeg, pct, countdown, metres, int, shortName, duration } from './format.js';
import { throttle } from './dom.js';

const H = 3600000;

export function horizonBadge(ctx) {
  if (!ctx) return '';
  const src = ctx.horizonSource;
  const text = ctx.horizon?.source || '';
  if (src === 'precomputed') {
    return { cls: 'good', ic: 'mountain', label: 'Terrain horizon: LOLA high-resolution', detail: text || 'Precomputed from NASA LRO LOLA elevation data' };
  }
  if (src === 'computed') {
    return { cls: 'info', ic: 'mountain', label: 'Terrain horizon: computed from LOLA web DEM', detail: text || 'Ray-cast in the browser from the ~240 m/px LOLA grid' };
  }
  return {
    cls: 'warn',
    ic: 'warning',
    label: 'No terrain data: smooth-sphere horizon',
    detail: 'Hills and crater walls are ignored, so real sunlight and Earth visibility can be shorter than shown.',
  };
}

export function mount(container, app) {
  const { store, nav } = app;
  let ctx = null;
  let ctxKey = '';
  let next = null; 
  let nextPending = null;
  let req = 0;
  let busy = false;
  let dirty = false;

  container.innerHTML = `<section class="card status-card" aria-labelledby="status-title" aria-busy="true">
      <div class="skeleton" role="status"><span class="spinner" aria-hidden="true"></span><span>Computing the sky at the site…</span></div>
    </section>`;
  const card = container.firstElementChild;

  const keyOf = (s) => {
    const sc = store.active();
    return sc ? `${sc.id}|${sc.site.lat}|${sc.site.lon}|${sc.site.id || ''}|${JSON.stringify(s.opts)}` : '';
  };

  async function getNext(t, key, opts) {
    if (next && next.key === key && t >= next.fromMs && t < next.validUntil) return next;
    if (nextPending && nextPending.key === key) return nextPending.p;
    const p = nav.nextEvents(ctx, t, opts).then((data) => {
      const times = [data.sunsetMs, data.sunriseMs, data.earthsetMs, data.earthriseMs].filter((x) => Number.isFinite(x));
      const validUntil = times.length ? Math.min(...times) : data.searchEndMs;
      const n = { key, fromMs: t, validUntil, data };
      if (key === keyOf(store.get())) next = n;
      return n;
    });
    nextPending = { key, p };
    try {
      return await p;
    } finally {
      if (nextPending?.p === p) nextPending = null;
    }
  }

  async function update() {
    if (busy) {
      dirty = true;
      return;
    }
    busy = true;
    const id = ++req;
    try {
      do {
        dirty = false;
        const s = store.get();
        const sc = store.active();
        if (!sc) {
          card.innerHTML = `<p class="empty-note">Add a scenario to see the conditions at its site.</p>`;
          break;
        }
        const key = keyOf(s);
        if (key !== ctxKey) {
          ctx = await app.ctxFor(sc);
          ctxKey = key;
          next = null;
        }
        const opts = app.analysisOpts(s);
        const t = s.timeMs;
        const inst = await nav.instant(ctx, t, opts);
        const ne = await getNext(t, key, opts);
        if (id !== req || key !== keyOf(store.get())) break;
        render(sc, s, inst, ne.data, t);
      } while (dirty);
    } catch (e) {
      if (id === req) renderError(e);
    } finally {
      busy = false;
      if (dirty) schedule();
    }
  }

  function renderError(e) {
    card.setAttribute('aria-busy', 'false');
    const range = e instanceof RangeError;
    card.innerHTML = `<div class="placeholder" role="alert"><span class="placeholder-icon">${icon('warning', { size: 22 })}</span>
      <p class="placeholder-title">${range ? 'Date outside the ephemeris coverage' : 'Could not compute the status'}</p>
      <p class="placeholder-text">${escapeHtml(range ? `The shipped NASA/JPL DE440 ephemeris covers ${app.coverageText()}.` : e.message)}</p></div>`;
  }

  function countdownRow(kind, ms, hoursFromShown, primary) {
    const meta = {
      sunset: ['sunset', 'Sunset', 'sun'],
      sunrise: ['sunrise', 'Sunrise', 'sun'],
      earthset: ['earthset', 'Earthset', 'earth'],
      earthrise: ['earthrise', 'Earthrise', 'earth'],
    }[kind];
    const has = Number.isFinite(ms);
    return `<li class="cd cd--${meta[2]}${primary ? ' cd--primary' : ''}">
      <span class="cd-icon">${icon(meta[0], { size: 18 })}</span>
      <span class="cd-label">${meta[1]}</span>
      <span class="cd-value num">${has ? escapeHtml(countdown(hoursFromShown)) : 'not within 400 d'}</span>
      <span class="cd-time num">${has ? escapeHtml(utc(ms)) : ''}</span>
    </li>`;
  }

  function render(sc, s, inst, ne, t) {
    card.setAttribute('aria-busy', 'false');
    const sun = inst.sun;
    const earth = inst.earth;
    const sunFrac = sun.visibleFraction;
    const partial = sunFrac > 0.005 && sunFrac < 0.995;
    const sunChip = inst.sunlit
      ? { cls: 'sun', ic: 'sun', title: 'Sunlit', sub: `${pct(sunFrac)} of the solar disc above terrain` }
      : { cls: 'dark', ic: 'shadow', title: 'In shadow', sub: partial ? `${pct(sunFrac)} of the disc visible (below the ${pct(s.opts.sunMinFraction)} threshold)` : 'Sun below the terrain horizon' };
    const c = inst.comm;
    const nVis = c.stations.filter((x) => x.visible).length;
    let earthChip;
    if (c.available && c.basis === 'link') earthChip = { cls: 'earth', ic: 'link', title: 'Earth link', sub: `Earth in view · ${nVis} of ${c.stations.length} ground stations see the Moon` };
    else if (c.available) earthChip = { cls: 'earth', ic: 'link', title: 'Earth in view', sub: 'Direct-to-Earth geometry (no ground stations evaluated)' };
    else if (c.dte) earthChip = { cls: 'dark', ic: 'nolink', title: 'No ground station', sub: 'Earth is in view but no listed station sees the Moon' };
    else earthChip = { cls: 'dark', ic: 'nolink', title: 'No direct link', sub: earth.clearanceDeg > -earth.angularRadiusDeg ? `Earth ${signedDeg(earth.clearanceDeg, 2)} above terrain, mask ${deg(s.opts.commMaskDeg)}` : 'Earth below the terrain horizon' };

    const hrs = (ms) => (Number.isFinite(ms) ? (ms - t) / H : null);
    const sunRows = ne.sunlitNow
      ? [countdownRow('sunset', ne.sunsetMs, hrs(ne.sunsetMs), true), countdownRow('sunrise', ne.sunriseMs, hrs(ne.sunriseMs), false)]
      : [countdownRow('sunrise', ne.sunriseMs, hrs(ne.sunriseMs), true), countdownRow('sunset', ne.sunsetMs, hrs(ne.sunsetMs), false)];
    const earthRows = ne.earthVisibleNow
      ? [countdownRow('earthset', ne.earthsetMs, hrs(ne.earthsetMs), true), countdownRow('earthrise', ne.earthriseMs, hrs(ne.earthriseMs), false)]
      : [countdownRow('earthrise', ne.earthriseMs, hrs(ne.earthriseMs), true), countdownRow('earthset', ne.earthsetMs, hrs(ne.earthsetMs), false)];

    const badge = horizonBadge(ctx);
    const warn = ctx.warnings?.length ? ctx.warnings : [];
    const visible = c.stations.filter((x) => x.visible);
    const sinceLanding = t - sc.t0Ms;
    const missionNote = sinceLanding < 0
      ? `Landing ${countdown(-sinceLanding / H)}`
      : sinceLanding <= sc.durationDays * 86400000
        ? `Mission day ${Math.floor(sinceLanding / 86400000) + 1} of ${sc.durationDays}`
        : `${duration(sinceLanding / H - sc.durationDays * 24)} after the mission window`;
    const learn = s.learn;

    card.innerHTML = `
      <header class="status-head">
        <div class="status-site">
          <span class="scn-dot scn-dot--lg" style="--scn:${escapeHtml(sc.color)}" aria-hidden="true"></span>
          <div>
            <h2 id="status-title" class="status-name" title="${escapeHtml(sc.site.name)}">${sc.site.id ? `<button type="button" class="status-name-btn" data-source="site:${escapeHtml(sc.site.id)}" title="Details and source">${escapeHtml(shortName(sc.site.name, 44))}</button>` : escapeHtml(shortName(sc.site.name, 44))}</h2>
            <p class="status-sub num">${escapeHtml(latlon(sc.site.lat, sc.site.lon))} · ${escapeHtml(missionNote)}</p>
          </div>
        </div>
        <p class="status-time num"><span class="sr-only">Shown instant: </span>${escapeHtml(utc(t))}</p>
      </header>

      <div class="status-chips">
        <div class="status-chip status-chip--${sunChip.cls}" role="status">
          <span class="status-chip-icon">${icon(sunChip.ic, { size: 26 })}</span>
          <span class="status-chip-text"><strong>${sunChip.title}</strong><span>${escapeHtml(sunChip.sub)}</span></span>
        </div>
        <div class="status-chip status-chip--${earthChip.cls}" role="status">
          <span class="status-chip-icon">${icon(earthChip.ic, { size: 26 })}</span>
          <span class="status-chip-text"><strong>${earthChip.title}</strong><span>${escapeHtml(earthChip.sub)}</span></span>
        </div>
      </div>

      <ul class="countdowns" aria-label="Next horizon events after the shown instant">
        ${sunRows.join('')}${earthRows.join('')}
      </ul>
      ${learn ? `<p class="hint">${icon('info', { size: 14 })}Countdowns use the real terrain horizon when available: the Sun “sets” when less than ${pct(s.opts.sunMinFraction)} of its disc is above the skyline; Earth “sets” when its centre is less than ${deg(s.opts.commMaskDeg)} above it.</p>` : ''}

      <table class="body-table">
        <caption class="sr-only">Sun and Earth seen from the site</caption>
        <thead><tr><th scope="col"></th><th scope="col">Azimuth</th><th scope="col">Elevation</th><th scope="col" title="Elevation above the terrain horizon at that azimuth">Above terrain</th></tr></thead>
        <tbody>
          <tr class="row-sun"><th scope="row">${icon('sun', { size: 15 })}Sun</th><td class="num">${az(sun.azDeg)}</td><td class="num">${signedDeg(sun.elDeg, 2)}</td><td class="num">${signedDeg(sun.clearanceDeg, 2)}</td></tr>
          <tr class="row-earth"><th scope="row">${icon('earth', { size: 15 })}Earth</th><td class="num">${az(earth.azDeg)}</td><td class="num">${signedDeg(earth.elDeg, 2)}</td><td class="num">${signedDeg(earth.clearanceDeg, 2)}</td></tr>
        </tbody>
      </table>
      <p class="src-line">Positions: <button type="button" class="src-link" data-source="dataset:ephemeris">NASA/JPL DE440 ephemeris</button></p>

      <dl class="facts">
        <div><dt>${icon('power', { size: 14 })}Power factor</dt><dd class="num">${pct(inst.power.factor)} <span class="unit">${escapeHtml(s.opts.panel)} panel · ${int(inst.power.irradianceWm2 * inst.power.factor)} W/m²</span></dd></div>
        <div><dt>${icon('antenna', { size: 14 })}Ground stations</dt><dd class="num">${nVis} of ${c.stations.length} see the Moon</dd></div>
        <div><dt>${icon('mountain', { size: 14 })}Terrain height</dt><dd class="num">${metres(ctx.terrainHeightM)} <span class="unit">+ ${metres(ctx.observerHeightM)} mast</span></dd></div>
        <div><dt>${icon('sun', { size: 14 })}Sun disc / horizon</dt><dd class="num">${deg(sun.angularRadiusDeg * 2, 2)} <span class="unit">wide · horizon ${signedDeg(sun.horizonElDeg, 2)}</span></dd></div>
      </dl>
      ${visible.length ? `<p class="stations-line"><span class="sr-only">Stations in view: </span>${visible.slice(0, 6).map((x) => `<button type="button" class="tag tag-btn" data-source="station:${escapeHtml(x.id)}" title="Station details and source">${escapeHtml(x.name.replace(/\s*\(.*\)$/, ''))}</button>`).join('')}${visible.length > 6 ? `<span class="tag">+${visible.length - 6}</span>` : ''}</p>` : ''}

      <div class="source-badge source-badge--${badge.cls}">
        <span class="source-icon">${icon(badge.ic, { size: 16 })}</span>
        <div class="source-text">
          <strong>${escapeHtml(badge.label)}</strong>
          <span>${escapeHtml(badge.detail)}</span>
          <button type="button" class="src-link" data-source="dataset:${sc.site.lat <= -80 ? 'lola-south' : sc.site.lat >= 80 ? 'lola-north' : 'lola-global'}">Elevation data source</button>
          ${warn.length ? `<details class="source-warnings"><summary>${warn.length} data note${warn.length > 1 ? 's' : ''}</summary><ul>${warn.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul></details>` : ''}
        </div>
      </div>`;
  }

  const schedule = throttle(update, 100); 
  const unsub = [
    store.subscribe(() => schedule(), ['timeMs']),
    store.subscribe(() => {
      next = null;
      update();
    }, ['scenarios', 'activeId', 'opts', 'learn']),
  ];
  update();

  return {
    destroy() {
      unsub.forEach((u) => u());
      schedule.cancel();
      req++;
      container.innerHTML = '';
    },
  };
}
