import { icon } from './icons.js';
import { popover, saveBlob } from './dom.js';
import { toCsv, shortName } from './format.js';

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
const slug = (s) => String(s || 'site').normalize('NFD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 40);
const r6 = (x) => (Number.isFinite(x) ? Math.round(x * 1e6) / 1e6 : '');

export function seriesRows(sr) {
  const rows = [[
    'time_utc', 'sun_az_deg', 'sun_el_deg', 'sun_horizon_el_deg', 'sun_clearance_deg', 'sun_visible_fraction', 'sunlit',
    'earth_az_deg', 'earth_el_deg', 'earth_horizon_el_deg', 'earth_clearance_deg', 'earth_visible_fraction', 'dte', 'comm',
    'stations_in_view', 'irradiance_wm2', 'power_factor',
  ]];
  for (let i = 0; i < sr.n; i++) {
    rows.push([
      iso(sr.tMs[i]), r6(sr.sun.azDeg[i]), r6(sr.sun.elDeg[i]), r6(sr.sun.horizonElDeg[i]), r6(sr.sun.clearanceDeg[i]), r6(sr.sun.visibleFraction[i]), sr.sunlit[i],
      r6(sr.earth.azDeg[i]), r6(sr.earth.elDeg[i]), r6(sr.earth.horizonElDeg[i]), r6(sr.earth.clearanceDeg[i]), r6(sr.earth.visibleFraction[i]), sr.dte[i], sr.comm[i],
      sr.stationCount[i], r6(sr.irradianceWm2[i]), r6(sr.powerFactor[i]),
    ]);
  }
  return rows;
}

export function compareRows(rows) {
  const out = [[
    'rank', 'site', 'site_id', 'lat_deg', 'lon_deg', 'landing_utc', 'duration_days', 'horizon_source', 'score',
    'sunlit_fraction', 'sunlit_hours', 'longest_dark_hours', 'energy_whm2', 'mean_power_factor', 'comm_basis',
    'comm_fraction', 'comm_longest_gap_hours', 'earth_visible_fraction', 'both_fraction',
    'sun_el_min_deg', 'sun_el_max_deg', 'earth_el_min_deg', 'earth_el_max_deg',
  ]];
  for (const r of rows) {
    const s = r.summary;
    out.push([
      r.rank, r.site.name, r.site.id || '', r6(r.site.lat), r6(r.site.lon), iso(r.t0Ms), r.durationDays, r.horizonSource, r6(r.score.score),
      r6(s.sun.sunlitFraction), r6(s.sun.sunlitHours), r6(s.sun.longestDarkHours), r6(s.power.energyWhm2), r6(s.power.meanFactor), s.comm.basis,
      r6(s.comm.fraction), r6(s.comm.longestGapHours), r6(s.earth.visibleFraction), r6(s.both.fraction),
      r6(s.sun.elevationMinDeg), r6(s.sun.elevationMaxDeg), r6(s.earth.elevationMinDeg), r6(s.earth.elevationMaxDeg),
    ]);
  }
  return out;
}

export function mount(container, app) {
  const { store, nav } = app;
  container.innerHTML = `
    <button type="button" class="icon-btn exp-btn" aria-label="Share and export" title="Share and export">${icon('download')}</button>
    <div class="popover exp-pop" role="dialog" aria-label="Share and export">
      <h2 class="pop-title">Share &amp; export</h2>
      <ul class="menu">
        <li><button type="button" class="menu-item" data-x="link">${icon('share', { size: 16 })}<span><strong>Copy share link</strong><small>Scenarios, time, view and options in the URL</small></span></button></li>
        <li><button type="button" class="menu-item" data-x="series">${icon('download', { size: 16 })}<span><strong>Time series (CSV)</strong><small>Active scenario, mission window, every 10 min</small></span></button></li>
        <li><button type="button" class="menu-item" data-x="compare">${icon('table', { size: 16 })}<span><strong>Comparison table (CSV)</strong><small>KPIs and score of every scenario</small></span></button></li>
        <li><button type="button" class="menu-item" data-x="json">${icon('copy', { size: 16 })}<span><strong>Scenario set (JSON)</strong><small>Sites, dates, options</small></span></button></li>
        <li><button type="button" class="menu-item" data-x="print">${icon('print', { size: 16 })}<span><strong>Print report</strong><small>Printer-friendly page of the current view</small></span></button></li>
      </ul>
    </div>`;
  const btn = container.querySelector('.exp-btn');
  const pop = container.querySelector('.exp-pop');
  const pv = popover(btn, pop);
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '');

  async function copyLink() {
    const url = app.shareUrl ? app.shareUrl() : location.href;
    try {
      await navigator.clipboard.writeText(url);
      app.toast('Share link copied to the clipboard.', 'success');
    } catch {
      window.prompt('Copy this link:', url);
    }
  }

  async function exportSeries() {
    const sc = store.active();
    if (!sc) return;
    app.toast('Computing the time series…', 'info', { key: 'export' });
    const ctx = await app.ctxFor(sc);
    const sr = await nav.series(ctx, sc.t0Ms, sc.t0Ms + sc.durationDays * DAY, 600, app.analysisOpts());
    saveBlob(new Blob([toCsv(seriesRows(sr))], { type: 'text/csv;charset=utf-8' }), `lunarnav_${slug(sc.site.name)}_${iso(sc.t0Ms).slice(0, 10)}_series.csv`);
    app.toast(`Saved ${sr.n} samples of ${shortName(sc.site.name)} (${ctx.horizonSource} horizon).`, 'success', { key: 'export' });
  }

  async function exportCompare() {
    const s = store.get();
    app.toast('Computing the comparison…', 'info', { key: 'export' });
    const ctxs = await Promise.all(s.scenarios.map((sc) => app.ctxFor(sc)));
    const rows = await nav.compare(s.scenarios.map((sc, i) => ({ site: ctxs[i], t0Ms: sc.t0Ms, durationDays: sc.durationDays })), app.analysisOpts(s));
    saveBlob(new Blob([toCsv(compareRows(rows))], { type: 'text/csv;charset=utf-8' }), `lunarnav_compare_${stamp()}.csv`);
    app.toast(`Saved the comparison of ${rows.length} scenarios.`, 'success', { key: 'export' });
  }

  function exportJson() {
    const s = store.get();
    const doc = {
      format: 'lunarnav-scenarios-1',
      generated: iso(Date.now()),
      shownTimeUtc: iso(s.timeMs),
      options: s.opts,
      shareUrl: app.shareUrl ? app.shareUrl() : location.href,
      scenarios: s.scenarios.map((sc) => ({
        site: sc.site, landingUtc: iso(sc.t0Ms), durationDays: sc.durationDays, color: sc.color, active: sc.id === s.activeId,
      })),
      data: 'NASA/JPL NAIF SPICE (DE440), NASA LRO LOLA & LROC',
    };
    saveBlob(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }), `lunarnav_scenarios_${stamp()}.json`);
  }

  pop.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-x]');
    if (!b) return;
    pv.close(true);
    try {
      if (b.dataset.x === 'link') await copyLink();
      else if (b.dataset.x === 'series') await exportSeries();
      else if (b.dataset.x === 'compare') await exportCompare();
      else if (b.dataset.x === 'json') exportJson();
      else if (b.dataset.x === 'print') setTimeout(() => window.print(), 50);
    } catch (err) {
      app.toast(`Export failed: ${err.message}`, 'error', { key: 'export' });
    }
  });
  return {
    destroy() {
      pv.destroy();
      container.innerHTML = '';
    },
  };
}
