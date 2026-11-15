import { icon } from './icons.js';
import { escapeHtml, utc, latlon, shortName } from './format.js';

export function mount(container, app) {
  const { store } = app;
  container.innerHTML = `
    <div class="view-head">
      <div>
        <h1 class="view-title">${icon('calendar', { size: 20 })}Plan the landing date</h1>
        <p class="view-sub plan-sub"></p>
      </div>
    </div>
    <section class="card card--flush plan-card"><div class="mount mount-landing"></div></section>
    <section class="card card--flush plan-card"><div class="mount mount-year"></div></section>`;
  const sub = container.querySelector('.plan-sub');
  const handles = [
    app.mountModule(container.querySelector('.mount-landing'), './charts/landingWindows.js'),
    app.mountModule(container.querySelector('.mount-year'), './charts/yearHeatmap.js'),
  ];
  const renderSub = () => {
    const sc = store.active();
    sub.innerHTML = sc
      ? `For <strong style="color:${escapeHtml(sc.color)}">${escapeHtml(shortName(sc.site.name, 48))}</strong> (${escapeHtml(latlon(sc.site.lat, sc.site.lon, 2))}), current landing ${escapeHtml(utc(sc.t0Ms))}, ${sc.durationDays}-day mission. What happens if the date slips, and when in the year is the site lit and in contact?`
      : 'Add a scenario first.';
  };
  const unsub = store.subscribe(renderSub, ['scenarios', 'activeId']);
  renderSub();
  return {
    destroy() {
      unsub();
      handles.forEach((h) => h.destroy());
      container.innerHTML = '';
    },
  };
}
