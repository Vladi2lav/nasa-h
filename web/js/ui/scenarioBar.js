import { icon } from './icons.js';
import { escapeHtml, latlon, utcInputValue, parseUtcInput, roundToHour, shortName } from './format.js';
import { preserveFocus } from './dom.js';

const DAY = 86400000;

export function mount(container, app) {
  const { store } = app;

  function render() {
    const s = store.get();
    const act = store.active();
    const n = s.scenarios.length;
    preserveFocus(container, () => {
      container.innerHTML = `
        <div class="panel-head">
          <h2 id="scn-heading">Scenarios</h2>
          <span class="panel-count num" aria-label="${n} of ${app.MAX_SCENARIOS} scenarios">${n} / ${app.MAX_SCENARIOS}</span>
        </div>
        ${n ? '' : `<p class="empty-note">No scenario yet. Add a site from the list below.</p>`}
        <ol class="scn-list">
          ${s.scenarios.map((sc) => chip(sc, act && sc.id === act.id, n)).join('')}
        </ol>
        <div class="scn-foot">
          <button type="button" class="btn btn-sm btn-ghost" data-act="now" data-focus="scn-now" title="Move the shown instant to the current date and time">${icon('clock', { size: 15 })}Now</button>
          <span class="scn-hint">Times are UTC. Click a scenario to make it active.</span>
        </div>`;
    });
  }

  function chip(sc, isActive, n) {
    const id = escapeHtml(sc.id);
    const name = escapeHtml(sc.site.name || 'Custom site');
    return `
      <li class="scn${isActive ? ' is-active' : ''}" style="--scn:${escapeHtml(sc.color)}" data-id="${id}">
        <button type="button" class="scn-select" data-act="select" data-focus="sel-${id}" aria-pressed="${isActive}"
          aria-label="${isActive ? 'Active scenario' : 'Make active'}: ${name}">
          <span class="scn-dot" aria-hidden="true"></span>
          <span class="scn-title">
            <span class="scn-name" title="${name}">${escapeHtml(shortName(sc.site.name, 40))}</span>
            <span class="scn-coords num">${escapeHtml(latlon(sc.site.lat, sc.site.lon, 2))}</span>
          </span>
          ${isActive ? `<span class="scn-badge">${icon('check', { size: 12 })}Active</span>` : ''}
        </button>
        <div class="scn-fields">
          <label class="field field--grow">
            <span class="field-label">Landing (UTC)</span>
            <input type="datetime-local" step="60" class="num" data-field="t0" data-focus="t0-${id}" value="${utcInputValue(sc.t0Ms)}"
              min="${utcInputValue(app.coverage.startMs)}" max="${utcInputValue(app.coverage.endMs)}" aria-label="Landing time of ${name}, UTC">
          </label>
          <label class="field field--days">
            <span class="field-label">Days</span>
            <input type="number" min="1" max="400" step="1" class="num" data-field="days" data-focus="days-${id}" value="${sc.durationDays}" aria-label="Mission duration of ${name}, days">
          </label>
        </div>
        <div class="scn-actions">
          <button type="button" class="btn btn-xs btn-ghost" data-act="goto" data-focus="goto-${id}" title="Move the shown instant to this landing">${icon('target', { size: 14 })}Go to landing</button>
          <button type="button" class="icon-btn icon-btn--sm" data-act="dup" data-focus="dup-${id}" aria-label="Duplicate ${name} with the landing one week later" title="Duplicate (landing +7 d) to try another date">${icon('copy', { size: 15 })}</button>
          <button type="button" class="icon-btn icon-btn--sm" data-act="remove" data-focus="rm-${id}" aria-label="Remove ${name}" title="Remove scenario" ${n <= 1 ? 'disabled' : ''}>${icon('trash', { size: 15 })}</button>
        </div>
      </li>`;
  }

  const onClick = (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || !container.contains(b)) return;
    const li = b.closest('.scn');
    const id = li?.dataset.id;
    const sc = id ? store.get().scenarios.find((x) => x.id === id) : null;
    switch (b.dataset.act) {
      case 'select':
        if (sc) store.set({ activeId: sc.id });
        break;
      case 'goto':
        if (sc) {
          store.set({ activeId: sc.id });
          app.setTime(sc.t0Ms);
        }
        break;
      case 'dup':
        if (sc) {
          const copy = app.addScenario(sc.site, sc.t0Ms + 7 * DAY, sc.durationDays);
          if (copy) app.toast(`Duplicated ${shortName(sc.site.name)} with the landing 7 days later. Edit its date to explore a slip.`, 'success', { key: 'dup' });
        }
        break;
      case 'remove':
        if (sc && store.get().scenarios.length > 1) {
          store.removeScenario(sc.id);
          app.toast(`Removed ${shortName(sc.site.name)}.`, 'info', {
            key: 'rm',
            actions: [{ label: 'Undo', onClick: () => restore(sc) }],
          });
        }
        break;
      case 'now':
        app.setTime(roundToHour(Date.now()));
        break;
      default:
    }
  };

  function restore(sc) {
    const s = store.get();
    if (s.scenarios.length >= app.MAX_SCENARIOS) return;
    store.set({ scenarios: [...s.scenarios, sc], activeId: sc.id });
  }

  const onChange = (e) => {
    const inp = e.target.closest('[data-field]');
    if (!inp) return;
    const id = inp.closest('.scn')?.dataset.id;
    const sc = store.get().scenarios.find((x) => x.id === id);
    if (!sc) return;
    if (inp.dataset.field === 't0') {
      const ms = parseUtcInput(inp.value);
      if (!Number.isFinite(ms)) {
        app.toast('Enter the landing time as YYYY-MM-DD HH:MM (UTC).', 'warn', { key: 'scn-parse' });
        inp.value = utcInputValue(sc.t0Ms);
        return;
      }
      if (ms !== sc.t0Ms) store.updateScenario(id, { t0Ms: ms });
    } else {
      let d = Math.round(Number(inp.value));
      if (!(d >= 1 && d <= 400)) {
        app.toast('Mission duration must be between 1 and 400 days.', 'warn', { key: 'scn-days' });
        d = Math.min(400, Math.max(1, d || sc.durationDays));
        inp.value = String(d);
      }
      if (d !== sc.durationDays) store.updateScenario(id, { durationDays: d });
    }
  };
  const onKey = (e) => {
    if (e.key === 'Enter' && e.target.matches('[data-field]')) {
      e.preventDefault();
      onChange(e);
    }
  };

  container.addEventListener('click', onClick);
  container.addEventListener('change', onChange);
  container.addEventListener('keydown', onKey);
  const unsub = store.subscribe(render, ['scenarios', 'activeId']);
  render();

  return {
    destroy() {
      unsub();
      container.removeEventListener('click', onClick);
      container.removeEventListener('change', onChange);
      container.removeEventListener('keydown', onKey);
      container.innerHTML = '';
    },
  };
}
