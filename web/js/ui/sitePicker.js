




import { icon } from './icons.js';
import { escapeHtml, latlon, utcDate, parseLatLon, shortName, roundToHour } from './format.js';
import { debounce } from './dom.js';

const REGIONS = [
  ['south-pole', 'South pole'],
  ['north-pole', 'North pole'],
  ['near-side', 'Near side'],
  ['far-side', 'Far side'],
];
const STATUSES = [
  ['landed', 'Landed'],
  ['planned', 'Planned'],
  ['candidate', 'Candidate'],
  ['failed', 'Failed'],
  ['feature', 'Feature'],
];
const CATEGORY_LABELS = {
  apollo: 'Apollo', luna: 'Luna', surveyor: 'Surveyor', change: "Chang'e", chandrayaan: 'Chandrayaan',
  clps: 'CLPS', commercial: 'Commercial', artemis: 'Artemis', jaxa: 'JAXA', other: 'Other', feature: 'Features',
};
const STATUS_ICON = { landed: 'check', planned: 'calendar', candidate: 'target', failed: 'close', feature: 'pin' };

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function mount(container, app) {
  const { store, nav } = app;
  const sites = nav.sites.slice();
  const index = sites.map((s) => norm([s.name, s.agency, s.country, s.category, CATEGORY_LABELS[s.category], s.region, s.status, s.id].join(' ')));
  const categories = [...new Set(sites.map((s) => s.category))].filter(Boolean);
  const filters = { region: new Set(), status: new Set(), category: new Set() };
  let query = '';

  container.innerHTML = `
    <div class="panel-head">
      <h2 id="sites-heading">Sites</h2>
      <span class="panel-count num" id="site-count"></span>
    </div>
    <div class="search">
      ${icon('search', { size: 16 })}
      <input type="search" class="search-input" placeholder="Search ${sites.length} sites, agencies, regions" aria-label="Search sites" autocomplete="off" spellcheck="false">
    </div>
    <details class="filters">
      <summary><span>${icon('sliders', { size: 15 })}Filters</span><span class="filters-count" aria-live="polite"></span></summary>
      ${group('region', 'Region', REGIONS)}
      ${group('status', 'Status', STATUSES)}
      ${group('category', 'Programme', categories.map((c) => [c, CATEGORY_LABELS[c] || c]))}
      <button type="button" class="btn btn-xs btn-ghost filters-clear">Clear filters</button>
    </details>
    <ul class="site-list" aria-label="Catalogue sites"></ul>
    <form class="custom-form" novalidate>
      <h3 class="sub-head">${icon('crosshair', { size: 15 })}Custom coordinates</h3>
      <label class="field">
        <span class="field-label">Latitude, longitude</span>
        <input type="text" name="coords" class="num" placeholder="-89.45, 222.6  or  89.45S 137.4W" autocomplete="off" spellcheck="false" aria-describedby="coords-help coords-err">
      </label>
      <p class="field-help" id="coords-help">Planetocentric degrees, east-positive. Longitude 0…360 or −180…180. Or click any map.</p>
      <label class="field">
        <span class="field-label">Name <span class="field-optional">(optional)</span></span>
        <input type="text" name="sitename" placeholder="Custom site" maxlength="60" autocomplete="off">
      </label>
      <p class="field-error" id="coords-err" role="alert" hidden></p>
      <div class="form-actions">
        <button type="submit" class="btn btn-sm btn-primary" data-mode="add">${icon('plus', { size: 15 })}Add scenario</button>
        <button type="button" class="btn btn-sm" data-mode="replace">${icon('replace', { size: 15 })}Replace active</button>
      </div>
    </form>`;

  function group(key, label, items) {
    return `<div class="chip-group" role="group" aria-label="${label}">
      <span class="chip-group-label">${label}</span>
      ${items.map(([v, l]) => `<button type="button" class="chip" data-filter="${key}" data-value="${escapeHtml(v)}" aria-pressed="false">${escapeHtml(l)}</button>`).join('')}
    </div>`;
  }

  const list = container.querySelector('.site-list');
  const countEl = container.querySelector('#site-count');
  const searchEl = container.querySelector('.search-input');
  const filtersCount = container.querySelector('.filters-count');
  const form = container.querySelector('.custom-form');
  const errEl = container.querySelector('#coords-err');
  const coordsEl = form.querySelector('[name="coords"]');
  const nameEl = form.querySelector('[name="sitename"]');

  function matches(i) {
    const s = sites[i];
    if (filters.region.size && !filters.region.has(s.region)) return false;
    if (filters.status.size && !filters.status.has(s.status)) return false;
    if (filters.category.size && !filters.category.has(s.category)) return false;
    if (!query) return true;
    return query.split(/\s+/).every((w) => index[i].includes(w));
  }

  function renderList() {
    const st = store.get();
    const inUse = new Map(st.scenarios.filter((sc) => sc.site.id).map((sc) => [sc.site.id, sc.color]));
    const shown = [];
    for (let i = 0; i < sites.length; i++) if (matches(i)) shown.push(i);
    countEl.textContent = shown.length === sites.length ? `${sites.length}` : `${shown.length} of ${sites.length}`;
    const nf = filters.region.size + filters.status.size + filters.category.size;
    filtersCount.textContent = nf ? `${nf} active` : '';
    if (!shown.length) {
      list.innerHTML = `<li class="empty-note">No site matches. Clear the filters or enter custom coordinates below.</li>`;
      return;
    }
    const cov = app.coverage;
    list.innerHTML = shown
      .map((i) => {
        const s = sites[i];
        const name = escapeHtml(s.name);
        const landedMs = s.date_utc ? Date.parse(s.date_utc) : NaN;
        const hasDate = Number.isFinite(landedMs);
        const dateOk = hasDate && landedMs >= cov.startMs && landedMs <= cov.endMs - 86400000;
        const meta = [s.agency && s.agency !== '—' ? escapeHtml(s.agency) : null,
          `<span class="status-tag status-${escapeHtml(s.status)}">${icon(STATUS_ICON[s.status] || 'pin', { size: 11 })}${escapeHtml(s.status)}${hasDate ? ` ${utcDate(landedMs)}` : ''}</span>`]
          .filter(Boolean).join(' · ');
        const color = inUse.get(s.id);
        return `<li class="site-item" data-idx="${i}">
          <div class="site-main">
            <span class="site-name">${color ? `<span class="scn-dot" style="--scn:${color}" title="In use as a scenario"></span>` : ''}${name}</span>
            <span class="site-meta">${meta}</span>
            <span class="site-coords num">${escapeHtml(latlon(s.lat, s.lon, 2))}</span>
          </div>
          <div class="site-actions">
            <button type="button" class="btn btn-xs" data-act="add" aria-label="Add ${name} as a new scenario">${icon('plus', { size: 13 })}Add</button>
            <button type="button" class="btn btn-xs btn-ghost" data-source="site:${escapeHtml(s.id)}" aria-label="Details and source for ${name}">Info</button>
            <button type="button" class="btn btn-xs btn-ghost" data-act="replace" aria-label="Replace the active scenario's site with ${name}">Replace</button>
            ${hasDate ? `<button type="button" class="icon-btn icon-btn--sm" data-act="historic" ${dateOk ? '' : 'disabled'}
              aria-label="Add ${name} at its landing date ${utcDate(landedMs)}" title="${dateOk ? `Add at its landing date (${utcDate(landedMs)})` : 'Landing date is outside the ephemeris coverage'}">${icon('calendar', { size: 14 })}</button>` : ''}
          </div>
        </li>`;
      })
      .join('');
  }

  const onListClick = (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const s = sites[Number(b.closest('.site-item').dataset.idx)];
    if (!s) return;
    if (b.dataset.act === 'add') {
      if (app.addScenario(s)) app.toast(`Added ${shortName(s.name)} at ${app.fmt.utc(roundToHour(store.get().timeMs))}.`, 'success', { key: 'add' });
    } else if (b.dataset.act === 'replace') {
      app.replaceActiveSite(s);
      app.toast(`Active scenario now uses ${shortName(s.name)}.`, 'success', { key: 'add' });
    } else if (b.dataset.act === 'historic') {
      const t = Date.parse(s.date_utc);
      const sc = app.addScenario(s, t, 14);
      if (sc) {
        app.setTime(t);
        app.toast(`Added ${shortName(s.name)} at its landing time ${app.fmt.utc(t)}.`, 'success', { key: 'add' });
      }
    }
  };
  list.addEventListener('click', onListClick);

  container.querySelector('.filters').addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (c) {
      const set = filters[c.dataset.filter];
      const v = c.dataset.value;
      if (set.has(v)) set.delete(v);
      else set.add(v);
      c.setAttribute('aria-pressed', String(set.has(v)));
      renderList();
    } else if (e.target.closest('.filters-clear')) {
      Object.values(filters).forEach((s) => s.clear());
      container.querySelectorAll('.chip').forEach((x) => x.setAttribute('aria-pressed', 'false'));
      renderList();
    }
  });
  const onSearch = debounce(() => {
    query = norm(searchEl.value.trim());
    renderList();
  }, 80);
  searchEl.addEventListener('input', onSearch);
  searchEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = list.querySelector('[data-act="add"]');
      first?.focus();
    }
  });

  
  function readForm() {
    errEl.hidden = true;
    try {
      const { lat, lon } = parseLatLon(coordsEl.value);
      const name = nameEl.value.trim() || `Custom site ${latlon(lat, lon, 2)}`;
      coordsEl.removeAttribute('aria-invalid');
      return { name, lat, lon };
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
      coordsEl.setAttribute('aria-invalid', 'true');
      coordsEl.focus();
      return null;
    }
  }
  const submit = (mode) => {
    const site = readForm();
    if (!site) return;
    if (mode === 'replace') {
      app.replaceActiveSite(site);
      app.toast(`Active scenario now uses ${shortName(site.name)}.`, 'success', { key: 'add' });
    } else if (app.addScenario(site)) {
      app.toast(`Added ${shortName(site.name)}.`, 'success', { key: 'add' });
    }
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit('add');
  });
  form.querySelector('[data-mode="replace"]').addEventListener('click', () => submit('replace'));
  coordsEl.addEventListener('input', () => {
    if (!errEl.hidden) {
      errEl.hidden = true;
      coordsEl.removeAttribute('aria-invalid');
    }
  });

  
  app.proposeSite = ({ lat, lon, name, id }) => {
    const txt = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
    coordsEl.value = txt;
    nameEl.value = name || '';
    errEl.hidden = true;
    const site = { name: name || `Picked point ${latlon(lat, lon, 2)}`, lat, lon: app.fmt.normalizeLon(lon) };
    if (id) site.id = id;
    form.classList.add('is-flash');
    setTimeout(() => form.classList.remove('is-flash'), 1200);
    app.toast(id ? `Selected ${shortName(site.name)}.` : `Picked ${latlon(lat, lon, 3)}.`, 'info', {
      key: 'pick',
      actions: [
        { label: 'Add as scenario', onClick: () => { if (app.addScenario(site)) app.toast(`Added ${site.name}.`, 'success', { key: 'add' }); } },
        { label: 'Replace active', onClick: () => app.replaceActiveSite(site) },
      ],
    });
  };

  const unsub = store.subscribe(renderList, ['scenarios']);
  renderList();

  return {
    destroy() {
      unsub();
      onSearch.cancel();
      list.removeEventListener('click', onListClick);
      if (app.proposeSite) delete app.proposeSite;
      container.innerHTML = '';
    },
  };
}
