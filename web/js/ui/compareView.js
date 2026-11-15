import { icon } from './icons.js';
import { escapeHtml, utc, utcDate, pct, duration, energy, score as fmtScore, ratio, shortName, latlon } from './format.js';
import { latest } from './dom.js';

export const COLUMNS = [
  { key: 'score', label: 'Score', better: 'max', get: (r) => r.score.score, fmt: (v) => fmtScore(v), title: 'Weighted score 0–100' },
  { key: 'sunlit', label: 'Sunlit', better: 'max', get: (r) => r.summary.sun.sunlitFraction, fmt: (v) => pct(v), title: 'Share of the window with the Sun up' },
  { key: 'dark', label: 'Longest dark', better: 'min', get: (r) => r.summary.sun.longestDarkHours, fmt: (v) => (v > 0 ? duration(v) : 'none'), title: 'Longest continuous darkness in the window' },
  { key: 'energy', label: 'Energy', better: 'max', get: (r) => r.summary.power.energyWhm2, fmt: (v) => energy(v), title: 'Solar energy per m² of the selected panel' },
  { key: 'comm', label: 'Comm', better: 'max', get: (r) => r.summary.comm.fraction, fmt: (v) => pct(v), title: 'Share of the window with a communication link' },
  { key: 'gap', label: 'Longest comm gap', better: 'min', get: (r) => r.summary.comm.longestGapHours, fmt: (v) => (v > 0 ? duration(v) : 'none'), title: 'Longest continuous time without a link' },
  { key: 'both', label: 'Power + comm', better: 'max', get: (r) => r.summary.both.fraction, fmt: (v) => pct(v), title: 'Share with Sun and link together' },
];

const SOURCE_TEXT = { precomputed: 'LOLA high-res', computed: 'LOLA web DEM', sphere: 'Sphere (no terrain)' };

export function bestRows(rows, col) {
  if (rows.length < 2 || !col.better) return new Set();
  const vals = rows.map(col.get);
  const target = col.better === 'max' ? Math.max(...vals) : Math.min(...vals);
  const spread = Math.max(...vals) - Math.min(...vals);
  if (!(spread > Math.abs(target) * 1e-3 + 1e-9)) return new Set();
  const tol = spread * 1e-3;
  return new Set(rows.map((r, i) => (Math.abs(vals[i] - target) <= tol ? i : -1)).filter((i) => i >= 0));
}

export function verdict(rows) {
  if (!rows.length) return [];
  const names = rows.map((r) => shortName(r.site.name, 34));
  const dupNames = new Set(names.filter((n, i) => names.indexOf(n) !== i));
  const label = (r) => {
    const n = shortName(r.site.name, 34);
    return dupNames.has(n) ? `${n} (landing ${utcDate(r.t0Ms)})` : n;
  };
  const out = [];
  if (rows.length === 1) {
    const r = rows[0];
    const s = r.summary;
    out.push(`**${label(r)}** scores ${fmtScore(r.score.score)}/100: sunlit ${pct(s.sun.sunlitFraction)} and in contact ${pct(s.comm.fraction)} of its ${r.durationDays}-day window. Add another scenario to compare.`);
    return out;
  }
  const byScore = rows.slice().sort((a, b) => b.score.score - a.score.score);
  const [A, B] = byScore;
  const a = A.summary;
  const b = B.summary;
  const sameSite = Math.abs(A.site.lat - B.site.lat) < 1e-6 && Math.abs(A.site.lon - B.site.lon) < 1e-6;
  const gapScore = A.score.score - B.score.score;
  if (gapScore < 1) out.push(`**${label(A)}** and **${label(B)}** are practically tied (${fmtScore(A.score.score)} vs ${fmtScore(B.score.score)}).`);
  else if (sameSite) out.push(`For the same site, landing on ${utc(A.t0Ms)} scores ${fmtScore(A.score.score)}, against ${fmtScore(B.score.score)} for ${utc(B.t0Ms)}.`);
  else out.push(`**${label(A)}** ranks first with a score of ${fmtScore(A.score.score)}, ahead of **${label(B)}** (${fmtScore(B.score.score)}).`);

  const sa = a.sun.sunlitHours;
  const sb = b.sun.sunlitHours;
  let sun = '';
  if (sa > sb * 1.1 + 1) sun = `**${label(A)}** keeps the Sun ${sb > 0 ? ratio(sa, sb) : 'far'} longer (${pct(a.sun.sunlitFraction)} vs ${pct(b.sun.sunlitFraction)} of the window)`;
  else if (sb > sa * 1.1 + 1) sun = `**${label(B)}** actually gets more sunlight (${pct(b.sun.sunlitFraction)} vs ${pct(a.sun.sunlitFraction)})`;
  else sun = `Both get similar sunlight (${pct(a.sun.sunlitFraction)} vs ${pct(b.sun.sunlitFraction)})`;
  const ga = a.comm.longestGapHours;
  const gb = b.comm.longestGapHours;
  let comm = '';
  if (ga > gb + 6 && ga > 12) comm = `but loses Earth contact for up to ${duration(ga)} (vs ${gb > 0 ? duration(gb) : 'never'})`;
  else if (gb > ga + 6 && gb > 12) comm = `and avoids the ${duration(gb)} communication gap of **${label(B)}**`;
  else if (Math.abs(a.comm.fraction - b.comm.fraction) > 0.1) comm = `with a link ${pct(a.comm.fraction)} vs ${pct(b.comm.fraction)} of the time`;
  out.push(comm ? `${sun}, ${comm}.` : `${sun}.`);

  for (const r of byScore) {
    const s = r.summary;
    if (s.sun.neverLitInWindow) out.push(`**${label(r)}** never sees the Sun during its window — no solar power at all.`);
    else if (s.sun.longestDarkHours >= 48) out.push(`**${label(r)}** must survive a night of ${duration(s.sun.longestDarkHours)} inside its window.`);
    if (s.earth.neverVisibleInWindow) out.push(`**${label(r)}** never sees the Earth: direct-to-Earth communication is impossible (a relay would be needed).`);
  }
  const lit = byScore.filter((r) => r.summary.sun.alwaysLitInWindow).map(label);
  if (lit.length && lit.length < rows.length) out.push(`Continuously sunlit for the whole window: ${lit.map((n) => `**${n}**`).join(', ')}.`);

  const sphere = rows.filter((r) => r.horizonSource === 'sphere').length;
  if (sphere) out.push(`Caution: ${sphere === rows.length ? 'all scenarios use' : `${sphere} of ${rows.length} scenarios use`} a smooth-sphere horizon (no terrain data loaded); real hills and crater walls can shorten sunlight and Earth visibility.`);
  return out;
}

const boldify = (s) => escapeHtml(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

export function mount(container, app) {
  const { store, nav } = app;
  const gen = latest();
  let rows = [];
  let scenarios = [];
  let sort = { key: 'rank', dir: 1 };

  container.innerHTML = `
    <div class="view-head">
      <div>
        <h1 class="view-title">${icon('table', { size: 20 })}Compare scenarios</h1>
        <p class="view-sub">Mission-window KPIs of every scenario, computed with the same options. The best value of each column is marked with a star.</p>
      </div>
    </div>
    <section class="card verdict-card" aria-labelledby="verdict-title">
      <h2 id="verdict-title" class="card-title">Verdict</h2>
      <div class="verdict" aria-live="polite"></div>
    </section>
    <section class="card table-card" aria-labelledby="cmp-title">
      <h2 id="cmp-title" class="card-title">Comparison table</h2>
      <div class="table-wrap" tabindex="0" role="region" aria-labelledby="cmp-title"><div class="cmp-table-host"></div></div>
    </section>
    <section class="card card--flush cmp-chart-card">
      <div class="mount mount-compare"></div>
    </section>`;
  const verdictEl = container.querySelector('.verdict');
  const tableHost = container.querySelector('.cmp-table-host');
  const chart = app.mountModule(container.querySelector('.mount-compare'), './charts/timeline.js', { exportName: 'mountCompare', label: 'Mission-window small multiples' });

  async function update() {
    const id = gen.next();
    const s = store.get();
    scenarios = s.scenarios.slice();
    tableHost.innerHTML = `<div class="skeleton" role="status"><span class="spinner" aria-hidden="true"></span><span>Computing ${scenarios.length} mission windows…</span></div>`;
    verdictEl.innerHTML = '';
    try {
      const ctxs = await Promise.all(scenarios.map((sc) => app.ctxFor(sc)));
      const r = await nav.compare(scenarios.map((sc, i) => ({ site: ctxs[i], t0Ms: sc.t0Ms, durationDays: sc.durationDays })), app.analysisOpts(s));
      if (!gen.is(id)) return;
      rows = r;
      app.lastCompare = { scenarios, rows };
      render();
    } catch (e) {
      if (!gen.is(id)) return;
      tableHost.innerHTML = `<div class="placeholder" role="alert"><span class="placeholder-icon">${icon('warning', { size: 22 })}</span>
        <p class="placeholder-title">Could not compare</p><p class="placeholder-text">${escapeHtml(e instanceof RangeError ? `A mission window lies outside the ephemeris coverage ${app.coverageText()}.` : e.message)}</p></div>`;
    }
  }

  function sortedIdx() {
    const idx = rows.map((_, i) => i);
    const col = COLUMNS.find((c) => c.key === sort.key);
    if (sort.key === 'rank') idx.sort((a, b) => (rows[a].rank - rows[b].rank) * sort.dir);
    else if (sort.key === 'name') idx.sort((a, b) => rows[a].site.name.localeCompare(rows[b].site.name) * sort.dir);
    else if (sort.key === 'landing') idx.sort((a, b) => (rows[a].t0Ms - rows[b].t0Ms) * sort.dir);
    else if (col) idx.sort((a, b) => (col.get(rows[a]) - col.get(rows[b])) * sort.dir);
    return idx;
  }

  function th(key, label, title = '', numeric = true) {
    const on = sort.key === key;
    const aria = on ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none';
    return `<th scope="col" aria-sort="${aria}" class="${numeric ? 'num-col' : ''}">
      <button type="button" class="sort-btn" data-sort="${key}" title="${escapeHtml(title || `Sort by ${label}`)}">${escapeHtml(label)}
      ${icon(on ? (sort.dir > 0 ? 'sortAsc' : 'sortDesc') : 'sort', { size: 13, cls: 'sort-ico' })}</button></th>`;
  }

  function render() {
    const act = store.active();
    const best = Object.fromEntries(COLUMNS.map((c) => [c.key, bestRows(rows, c)]));
    const order = sortedIdx();
    tableHost.innerHTML = `
      <table class="cmp-table">
        <caption class="sr-only">Scenario comparison, sortable. Best values are marked “best”.</caption>
        <thead><tr>
          ${th('rank', 'Rank', 'Rank by score')}
          ${th('name', 'Scenario', '', false)}
          ${th('landing', 'Landing (UTC)', '', false)}
          ${COLUMNS.map((c) => th(c.key, c.label, c.title)).join('')}
          <th scope="col">Horizon</th>
        </tr></thead>
        <tbody>
          ${order.map((i) => {
            const r = rows[i];
            const sc = scenarios[r.index];
            return `<tr class="${act && sc && sc.id === act.id ? 'is-active' : ''}" data-id="${escapeHtml(sc?.id || '')}">
              <td class="num-col num rank">${r.rank}</td>
              <th scope="row" class="scn-cell"><button type="button" class="link-btn" data-select="${escapeHtml(sc?.id || '')}" title="Make active and open in Explore">
                <span class="scn-dot" style="--scn:${escapeHtml(sc?.color || 'var(--text-3)')}" aria-hidden="true"></span>${escapeHtml(shortName(r.site.name, 36))}</button>
                <span class="cell-sub num">${escapeHtml(latlon(r.site.lat, r.site.lon, 2))}</span></th>
              <td class="num">${escapeHtml(utc(r.t0Ms, { suffix: false }))}<span class="cell-sub">${r.durationDays} d</span></td>
              ${COLUMNS.map((c) => {
                const isBest = best[c.key].has(i);
                return `<td class="num-col num${isBest ? ' is-best' : ''}">${isBest ? `${icon('star', { size: 12, cls: 'best-ico' })}` : ''}${escapeHtml(c.fmt(c.get(r)))}${isBest ? '<span class="sr-only"> (best)</span>' : ''}</td>`;
              }).join('')}
              <td><span class="src-tag src-${r.horizonSource}">${r.horizonSource === 'sphere' ? icon('warning', { size: 12 }) : icon('mountain', { size: 12 })}${SOURCE_TEXT[r.horizonSource] || r.horizonSource}</span></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
      <p class="table-note">Comm basis: ${rows[0]?.summary.comm.basis === 'link' ? 'Earth in view above the mask <em>and</em> at least one listed ground station sees the Moon' : 'direct-to-Earth geometry only'}. Score weights: sunlight 30, power 15, comm 30, night 15, both 10.</p>`;
    verdictEl.innerHTML = verdict(rows).map((s) => `<p>${boldify(s)}</p>`).join('');
  }

  const onClick = (e) => {
    const sb = e.target.closest('[data-sort]');
    if (sb) {
      const k = sb.dataset.sort;
      if (sort.key === k) sort.dir = -sort.dir;
      else sort = { key: k, dir: k === 'rank' || k === 'name' || k === 'landing' || COLUMNS.find((c) => c.key === k)?.better === 'min' ? 1 : -1 };
      render();
      tableHost.querySelector(`[data-sort="${k}"]`)?.focus();
      return;
    }
    const sel = e.target.closest('[data-select]');
    if (sel && sel.dataset.select) store.set({ activeId: sel.dataset.select, view: 'explore' });
  };
  tableHost.addEventListener('click', onClick);
  const unsub = [
    store.subscribe(update, ['scenarios', 'opts']),
    store.subscribe(() => rows.length && render(), ['activeId']),
  ];
  update();
  return {
    destroy() {
      unsub.forEach((u) => u());
      gen.cancel();
      chart.destroy();
      tableHost.removeEventListener('click', onClick);
      container.innerHTML = '';
    },
  };
}
