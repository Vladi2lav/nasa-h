import { icon } from './icons.js';
import { escapeHtml, duration, deg, pct, shortName, utc, num, LUNAR_DAY_DAYS } from './format.js';
import { latest } from './dom.js';

const DAY = 86400000;
const H = 3600000;

function seriesStats(sr) {
  let maxRate = 0;
  let azMin = Infinity;
  let azMax = -Infinity;
  const e = sr.earth.azDeg;
  const ref = e[0];
  for (let i = 0; i < sr.n; i++) {
    if (i > 0) maxRate = Math.max(maxRate, Math.abs(sr.sun.elDeg[i] - sr.sun.elDeg[i - 1]) / (sr.stepS / 3600));
    let d = e[i] - ref;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    azMin = Math.min(azMin, d);
    azMax = Math.max(azMax, d);
  }
  return { maxSunRateDegPerH: maxRate, earthAzSpanDeg: azMax - azMin };
}

export function mount(container, app) {
  const { store, nav } = app;
  const gen = latest();
  container.innerHTML = `
    <div class="view-head">
      <div>
        <h1 class="view-title">${icon('book', { size: 20 })}Why landing on the Moon is about time and terrain</h1>
        <p class="view-sub learn-sub"></p>
      </div>
    </div>
    <div class="learn-grid"></div>`;
  const grid = container.querySelector('.learn-grid');
  const sub = container.querySelector('.learn-sub');

  const card = (n, title, figure, figLabel, body, action = '') => `
    <article class="card learn-card">
      <p class="learn-step num">${n}</p>
      <h2 class="learn-title">${title}</h2>
      ${figure ? `<p class="learn-figure num">${figure}<span class="learn-fig-label">${figLabel}</span></p>` : ''}
      <div class="learn-body">${body}</div>
      ${action}
    </article>`;

  function skeleton() {
    grid.innerHTML = Array.from({ length: 6 }, (_, i) => `<article class="card learn-card"><p class="learn-step num">${i + 1}</p>
      <div class="skeleton" role="status"><span class="spinner" aria-hidden="true"></span><span>Computing live numbers…</span></div></article>`).join('');
  }

  async function update() {
    const id = gen.next();
    const s = store.get();
    const act = store.active();
    const base = act ? act.t0Ms : s.timeMs;
    const opts = app.analysisOpts(s);
    const apollo = nav.sites.find((x) => x.id === 'apollo-11') || { name: 'Apollo 11', lat: 0.674, lon: 23.473 };
    const poleSite = act && Math.abs(act.site.lat) >= 75 ? act.site : nav.sites.find((x) => x.id === 'im-2-athena') || { name: 'Mons Mouton', lat: -84.79, lon: 29.2 };
    sub.textContent = `Live figures for ${shortName(apollo.name)} (equator) and ${shortName(poleSite.name)} (pole), starting ${utc(base)}.`;
    skeleton();
    try {
      const end = Math.min(app.coverage.endMs, base + 70 * DAY);
      const span = Math.min(LUNAR_DAY_DAYS, (app.coverage.endMs - base) / DAY - 1);
      const [ctxA, ctxP] = await Promise.all([app.ctxFor(apollo), app.ctxFor(poleSite)]);
      const [evA, sumA, sumP, srA, srP] = await Promise.all([
        nav.events(ctxA, base, end, opts),
        nav.summary(ctxA, base, span, opts),
        nav.summary(ctxP, base, span, opts),
        nav.series(ctxA, base, base + span * DAY, 3600, opts),
        nav.series(ctxP, base, base + span * DAY, 3600, opts),
      ]);
      let slip = null;
      if (act) {
        const tries = [0, 7, 14].map((d) => ({ ...act, t0Ms: Math.min(act.t0Ms + d * DAY, app.coverage.endMs - (act.durationDays + 1) * DAY) }));
        slip = await Promise.all(tries.map((t) => app.summaryFor(t)));
      }
      const srcs = act ? await Promise.all(s.scenarios.map((sc) => app.ctxFor(sc).then((c) => [sc, c]))) : [];
      if (!gen.is(id)) return;

      const rises = evA.events.filter((e) => e.type === 'sunrise');
      const sets = evA.events.filter((e) => e.type === 'sunset');
      let cycleH = null;
      let dayH = null;
      if (rises.length >= 2) cycleH = (rises[1].tMs - rises[0].tMs) / H;
      if (rises.length) {
        const set = sets.find((e) => e.tMs > rises[0].tMs);
        if (set) dayH = (set.tMs - rises[0].tMs) / H;
      }
      const stA = seriesStats(srA);
      const stP = seriesStats(srP);
      const nameA = escapeHtml(shortName(apollo.name, 30));
      const nameP = escapeHtml(shortName(poleSite.name, 30));
      const delayA = stA.maxSunRateDegPerH > 0 ? 1 / stA.maxSunRateDegPerH : null;
      const delayP = stP.maxSunRateDegPerH > 0 ? 1 / stP.maxSunRateDegPerH : null;
      const anySphere = srcs.some(([, c]) => c.horizonSource === 'sphere') || ctxP.horizonSource === 'sphere';

      grid.innerHTML = [
        card(1, 'A day on the Moon lasts a month',
          cycleH ? duration(cycleH) : `${num(LUNAR_DAY_DAYS, 2)} d`, `sunrise to sunrise at ${nameA}`,
          `<p>The Moon turns once per orbit relative to the Sun, so one solar day lasts about 29.5 Earth days.
           ${dayH ? `At ${nameA} the next daylight lasts <strong>${duration(dayH)}</strong>, followed by a night of about the same length` : 'Roughly two weeks of daylight are followed by two weeks of night'} —
           at −170 °C, with no sunlight for solar panels.</p>`),
        card(2, 'At the poles the Sun only skims the horizon',
          deg(sumP.sun.elevationMaxDeg), `highest Sun at ${nameP} this lunar day`,
          `<p>The Moon's axis is tilted only 1.5°, so near the poles the Sun circles the sky just above the horizon.
           At ${nameP} it never rises above <strong>${deg(sumP.sun.elevationMaxDeg)}</strong> in the coming ${num(span, 1)} days, while at ${nameA} it reaches <strong>${deg(sumA.sun.elevationMaxDeg)}</strong>.
           A low Sun means long shadows: a hill a few hundred metres high can hide it for days — or a peak can stay lit almost permanently.</p>`),
        card(3, 'Earth hangs still in the sky — except near the poles',
          `${deg(sumP.earth.elevationMinDeg)} … ${deg(sumP.earth.elevationMaxDeg)}`, `Earth elevation at ${nameP}`,
          `<p>The Moon always shows the same face to Earth, so from ${nameA} Earth stays near one point (it drifts only <strong>${deg(stA.earthAzSpanDeg)}</strong> in azimuth this month, by libration).
           Near the pole the same ±6–8° libration makes Earth bob up and down on the horizon: at ${nameP} it is in view only <strong>${pct(sumP.earth.visibleFraction)}</strong> of the time, with gaps up to <strong>${duration(sumP.earth.longestGapHours)}</strong>.
           On the far side Earth never rises at all.</p>`),
        card(4, 'No air, no twilight: the horizon is a hard edge',
          delayP ? duration(delayP) : '—', `extra delay per 1° of terrain at ${nameP}`,
          `<p>Without an atmosphere there is no twilight and no refraction: the Sun is either above the skyline or it is not.
           At ${nameA} the Sun climbs up to <strong>${num(stA.maxSunRateDegPerH, 2)}°/h</strong>, so a 1° ridge delays sunrise by about ${delayA ? duration(delayA) : '—'}.
           At ${nameP} it climbs at most <strong>${num(stP.maxSunRateDegPerH, 3)}°/h</strong> — the same ridge costs ${delayP ? duration(delayP) : 'far longer'}. That is why the real terrain horizon matters.</p>`),
        slip
          ? card(5, 'Why a slipped launch date matters',
            `${pct(slip[0].sun.sunlitFraction)} → ${pct(slip[2].sun.sunlitFraction)}`, `sunlit share if ${escapeHtml(shortName(act.site.name, 26))} lands 14 days later`,
            `<p>Landing at ${escapeHtml(shortName(act.site.name, 30))} on ${escapeHtml(utc(act.t0Ms))}: sunlit <strong>${pct(slip[0].sun.sunlitFraction)}</strong>, link <strong>${pct(slip[0].comm.fraction)}</strong> of the ${act.durationDays}-day mission.
             One week later: <strong>${pct(slip[1].sun.sunlitFraction)}</strong> / <strong>${pct(slip[1].comm.fraction)}</strong>. Two weeks later: <strong>${pct(slip[2].sun.sunlitFraction)}</strong> / <strong>${pct(slip[2].comm.fraction)}</strong>.
             Half a lunar day can turn a mission in sunlight into a mission in the dark.</p>`,
            `<button type="button" class="btn btn-sm" data-go="plan">${icon('calendar', { size: 15 })}Open the date-slip planner</button>`)
          : card(5, 'Why a slipped launch date matters', '', '', '<p>Add a scenario to see how its numbers change when the landing slips.</p>'),
        card(6, 'Real data, stated honestly',
          '', '',
          `<p>Sun and Earth positions come from NASA/JPL's DE440 planetary ephemeris (via NAIF SPICE), shipped with the app and valid ${escapeHtml(app.coverageText())}.
           Horizons come from NASA LRO LOLA elevation data when it is available for a site:</p>
           <ul class="learn-list">${srcs.map(([sc, c]) => `<li><span class="scn-dot" style="--scn:${escapeHtml(sc.color)}" aria-hidden="true"></span>${escapeHtml(shortName(sc.site.name, 30))}: <span class="src-tag src-${c.horizonSource}">${c.horizonSource === 'sphere' ? `${icon('warning', { size: 12 })}smooth sphere` : `${icon('mountain', { size: 12 })}${c.horizonSource === 'precomputed' ? 'LOLA high-resolution' : 'LOLA web DEM'}`}</span></li>`).join('')}</ul>
           ${anySphere ? '<p>Where no terrain is loaded the app uses a smooth sphere and says so on every status card — hills and crater walls are then ignored.</p>' : ''}`),
      ].join('');
    } catch (e) {
      if (!gen.is(id)) return;
      grid.innerHTML = `<div class="placeholder" role="alert"><span class="placeholder-icon">${icon('warning', { size: 22 })}</span>
        <p class="placeholder-title">Could not compute the live figures</p><p class="placeholder-text">${escapeHtml(e instanceof RangeError ? `Dates must lie within ${app.coverageText()}.` : e.message)}</p></div>`;
    }
  }

  const onClick = (e) => {
    const b = e.target.closest('[data-go]');
    if (b) app.setView(b.dataset.go);
  };
  grid.addEventListener('click', onClick);
  const unsub = store.subscribe(update, ['scenarios', 'activeId', 'opts']);
  update();
  return {
    destroy() {
      unsub();
      gen.cancel();
      grid.removeEventListener('click', onClick);
      container.innerHTML = '';
    },
  };
}
