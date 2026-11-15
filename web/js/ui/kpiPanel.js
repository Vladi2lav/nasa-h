import { icon } from './icons.js';
import { escapeHtml, utc, pct, duration, energy, deg, score as fmtScore, countdown, num } from './format.js';
import { latest } from './dom.js';

const COMPONENTS = [
  ['sunlight', 'Sunlight', 'Share of the window with the Sun up (sunlit fraction)'],
  ['power', 'Power', 'Mean power factor of the selected panel'],
  ['comm', 'Comm', 'Share of the window with a communication link'],
  ['night', 'Night', '1 − longest darkness / 354 h (a full equatorial lunar night)'],
  ['both', 'Both', 'Share of the window with power and comm together'],
];

export function scoreBreakdown(sc) {
  const w = sc.weights;
  const sum = Object.values(w).reduce((a, b) => a + b, 0) || 1;
  return COMPONENTS.map(([k, label, help]) => ({
    key: k,
    label,
    help,
    value: sc.components[k],
    weight: w[k] / sum,
    points: (100 * w[k] * sc.components[k]) / sum,
  }));
}

export function mount(container, app) {
  const { store } = app;
  const gen = latest();
  container.innerHTML = `<section class="card kpi-card" aria-labelledby="kpi-title" aria-busy="true"></section>`;
  const card = container.firstElementChild;

  function skeleton(sc) {
    card.setAttribute('aria-busy', 'true');
    card.innerHTML = `<header class="card-head"><h2 id="kpi-title">Mission window</h2></header>
      <div class="skeleton" role="status"><span class="spinner" aria-hidden="true"></span><span>Computing ${sc ? `${sc.durationDays} days of Sun and Earth visibility` : 'the summary'}…</span></div>`;
  }

  async function update() {
    const sc = store.active();
    const id = gen.next();
    if (!sc) {
      card.innerHTML = `<header class="card-head"><h2 id="kpi-title">Mission window</h2></header><p class="empty-note">No scenario selected.</p>`;
      return;
    }
    skeleton(sc);
    try {
      const sum = await app.summaryFor(sc);
      if (!gen.is(id)) return;
      render(sc, sum);
    } catch (e) {
      if (!gen.is(id)) return;
      card.setAttribute('aria-busy', 'false');
      card.innerHTML = `<header class="card-head"><h2 id="kpi-title">Mission window</h2></header>
        <div class="placeholder" role="alert"><span class="placeholder-icon">${icon('warning', { size: 22 })}</span>
        <p class="placeholder-title">${e instanceof RangeError ? 'Mission window outside the ephemeris coverage' : 'Could not compute the summary'}</p>
        <p class="placeholder-text">${escapeHtml(e instanceof RangeError ? `Available: ${app.coverageText()}.` : e.message)}</p></div>`;
    }
  }

  function render(sc, s) {
    card.setAttribute('aria-busy', 'false');
    const st = store.get();
    const parts = scoreBreakdown(s.score);
    const commLabel = s.comm.basis === 'link' ? 'Earth link (DTE + ground station)' : 'Direct-to-Earth';
    const n = s.next;
    const hrs = (ms) => (Number.isFinite(ms) ? (ms - s.t0Ms) / 3600000 : null);
    const firstSun = n.sunlitNow
      ? `Sun sets ${Number.isFinite(n.sunsetMs) ? `${countdown(hrs(n.sunsetMs))} after landing` : 'not within 400 days'}`
      : `Landing in darkness: sunrise ${Number.isFinite(n.sunriseMs) ? countdown(hrs(n.sunriseMs)) : 'not within 400 days'}`;
    const firstEarth = n.earthVisibleNow
      ? `Earth sets ${Number.isFinite(n.earthsetMs) ? `${countdown(hrs(n.earthsetMs))} after landing` : 'not within 400 days'}`
      : `No Earth at landing: Earthrise ${Number.isFinite(n.earthriseMs) ? countdown(hrs(n.earthriseMs)) : 'not within 400 days'}`;
    const cls = (x) => (x >= 0.8 ? 'good' : x >= 0.4 ? 'mid' : 'low');
    card.innerHTML = `
      <header class="card-head">
        <div>
          <h2 id="kpi-title">Mission window</h2>
          <p class="card-sub num">${sc.durationDays} d from landing ${escapeHtml(utc(sc.t0Ms))}</p>
        </div>
        <div class="score" title="Transparent score: weighted sum of the components below">
          <span class="score-value num">${fmtScore(s.score.score)}</span><span class="score-max">/ 100</span>
          <span class="score-label">score</span>
        </div>
      </header>

      <ol class="score-bars" aria-label="Score breakdown">
        ${parts.map((p) => `<li title="${escapeHtml(p.help)}">
          <span class="sb-label">${p.label}</span>
          <span class="sb-track" aria-hidden="true"><span class="sb-fill sb-${p.key}" style="width:${Math.max(0, Math.min(100, p.value * 100))}%"></span></span>
          <span class="sb-value num">${pct(p.value)}</span>
          <span class="sb-points num" aria-label="${num(p.points, 1)} points of ${num(p.weight * 100, 0)}">${num(p.points, 1)} / ${num(p.weight * 100, 0)}</span>
        </li>`).join('')}
      </ol>

      <dl class="kpis">
        <div class="kpi kpi--sun">
          <dt>${icon('sun', { size: 15 })}Sunlit</dt>
          <dd><span class="kpi-big num ${cls(s.sun.sunlitFraction)}">${pct(s.sun.sunlitFraction)}</span>
          <span class="kpi-sub num">${duration(s.sun.sunlitHours)}${s.sun.alwaysLitInWindow ? ' · whole window' : ''}</span></dd>
        </div>
        <div class="kpi kpi--dark">
          <dt>${icon('shadow', { size: 15 })}Longest darkness</dt>
          <dd><span class="kpi-big num">${s.sun.longestDarkHours > 0 ? duration(s.sun.longestDarkHours) : 'none'}</span>
          <span class="kpi-sub num">${s.sun.neverLitInWindow ? 'never lit in window' : `dark ${duration(s.sun.darkHours)} in total`}</span></dd>
        </div>
        <div class="kpi kpi--power">
          <dt>${icon('power', { size: 15 })}Solar energy</dt>
          <dd><span class="kpi-big num">${energy(s.power.energyWhm2)}</span>
          <span class="kpi-sub num">${escapeHtml(st.opts.panel)} panel · mean factor ${pct(s.power.meanFactor)}</span></dd>
        </div>
        <div class="kpi kpi--earth">
          <dt>${icon('link', { size: 15 })}${commLabel}</dt>
          <dd><span class="kpi-big num ${cls(s.comm.fraction)}">${pct(s.comm.fraction)}</span>
          <span class="kpi-sub num">${duration(s.comm.hours)} · longest gap ${s.comm.longestGapHours > 0 ? duration(s.comm.longestGapHours) : 'none'}</span></dd>
        </div>
        <div class="kpi kpi--both">
          <dt>${icon('check', { size: 15 })}Power + comm</dt>
          <dd><span class="kpi-big num ${cls(s.both.fraction)}">${pct(s.both.fraction)}</span>
          <span class="kpi-sub num">${duration(s.both.hours)}</span></dd>
        </div>
        <div class="kpi">
          <dt>${icon('compass', { size: 15 })}Elevations</dt>
          <dd><span class="kpi-sub num">Sun ${deg(s.sun.elevationMinDeg)} … ${deg(s.sun.elevationMaxDeg)}</span>
          <span class="kpi-sub num">Earth ${deg(s.earth.elevationMinDeg)} … ${deg(s.earth.elevationMaxDeg)}</span></dd>
        </div>
      </dl>
      <ul class="kpi-notes">
        <li>${icon(n.sunlitNow ? 'sunset' : 'sunrise', { size: 14 })}${escapeHtml(firstSun)}</li>
        <li>${icon(n.earthVisibleNow ? 'earthset' : 'earthrise', { size: 14 })}${escapeHtml(firstEarth)}</li>
      </ul>
      ${st.learn ? `<p class="hint">${icon('info', { size: 14 })}The score is 100 × the weighted mean of the five components. It is a transparent ranking aid, not a mission requirement; check each component against your own needs.</p>` : ''}`;
  }

  const unsub = store.subscribe(update, ['scenarios', 'activeId', 'opts', 'learn']);
  update();
  return {
    destroy() {
      unsub();
      gen.cancel();
      container.innerHTML = '';
    },
  };
}
