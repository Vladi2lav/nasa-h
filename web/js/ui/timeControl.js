import { icon } from './icons.js';
import { utcInputValue, parseUtcInput, roundToHour, LUNAR_DAY_DAYS, utc } from './format.js';
import { throttle } from './dom.js';

const H = 3600000;
const D = 86400000;
const LD = LUNAR_DAY_DAYS * D;
const SPEEDS = [
  [3600, '1 h/s'],
  [21600, '6 h/s'],
  [86400, '1 d/s'],
  [432000, '5 d/s'],
];

export function mount(container, app) {
  const { store } = app;
  container.innerHTML = `
    <div class="tc" role="group" aria-label="Time (UTC)">
      <div class="tc-steps">
        <button type="button" class="tc-btn" data-step="${-LD}" aria-label="Back one lunar day (29.53 days)" title="−1 lunar day (29.53 d)">${icon('dblBack', { size: 16 })}<span class="tc-lbl">LD</span></button>
        <button type="button" class="tc-btn" data-step="${-D}" aria-label="Back one day" title="−1 day">${icon('stepBack', { size: 16 })}<span class="tc-lbl">1 d</span></button>
        <button type="button" class="tc-btn" data-step="${-H}" aria-label="Back one hour" title="−1 hour">${icon('stepBack', { size: 16 })}<span class="tc-lbl">1 h</span></button>
      </div>
      <label class="tc-field">
        <span class="sr-only">Shown instant, UTC</span>
        <input type="datetime-local" class="tc-input num" step="60" data-focus="tc-input" aria-describedby="tc-utc">
        <span class="tc-utc" id="tc-utc">UTC</span>
      </label>
      <div class="tc-steps">
        <button type="button" class="tc-btn" data-step="${H}" aria-label="Forward one hour" title="+1 hour"><span class="tc-lbl">1 h</span>${icon('stepFwd', { size: 16 })}</button>
        <button type="button" class="tc-btn" data-step="${D}" aria-label="Forward one day" title="+1 day"><span class="tc-lbl">1 d</span>${icon('stepFwd', { size: 16 })}</button>
        <button type="button" class="tc-btn" data-step="${LD}" aria-label="Forward one lunar day (29.53 days)" title="+1 lunar day (29.53 d)"><span class="tc-lbl">LD</span>${icon('dblFwd', { size: 16 })}</button>
      </div>
      <div class="tc-play">
        <button type="button" class="tc-btn tc-playbtn" aria-pressed="false"></button>
        <label class="tc-speed"><span class="sr-only">Animation speed</span>
          <select class="tc-select" aria-label="Animation speed">${SPEEDS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
        </label>
        <button type="button" class="tc-btn tc-now" title="Jump to the current date and time">Now</button>
      </div>
    </div>`;

  const input = container.querySelector('.tc-input');
  const playBtn = container.querySelector('.tc-playbtn');
  const speedSel = container.querySelector('.tc-select');
  input.min = utcInputValue(app.coverage.startMs);
  input.max = utcInputValue(app.coverage.endMs);

  const renderTime = throttle((s) => {
    if (document.activeElement !== input) input.value = utcInputValue(s.timeMs);
    input.title = utc(s.timeMs, { seconds: true });
  }, 100);
  const renderPlay = (s) => {
    playBtn.innerHTML = s.playing ? `${icon('pause', { size: 16 })}<span class="tc-lbl">Pause</span>` : `${icon('play', { size: 16 })}<span class="tc-lbl">Play</span>`;
    playBtn.setAttribute('aria-pressed', String(s.playing));
    playBtn.setAttribute('aria-label', s.playing ? 'Pause the animation' : 'Play: advance time');
    playBtn.classList.toggle('is-on', s.playing);
    const v = String(s.speed);
    if (![...speedSel.options].some((o) => o.value === v)) {
      speedSel.insertAdjacentHTML('beforeend', `<option value="${v}">${Math.round(s.speed / 3600)} h/s</option>`);
    }
    speedSel.value = v;
  };

  const step = (ms) => {
    const s = store.get();
    app.setTime(s.timeMs + ms);
  };
  const onClick = (e) => {
    const b = e.target.closest('[data-step]');
    if (b) step(Number(b.dataset.step));
  };
  container.addEventListener('click', onClick);
  playBtn.addEventListener('click', () => {
    const s = store.get();
    if (!s.playing && s.timeMs >= app.coverage.endMs - H) {
      app.toast('The end of the ephemeris coverage is reached; move the time back first.', 'warn');
      return;
    }
    store.set({ playing: !s.playing });
  });
  speedSel.addEventListener('change', () => store.set({ speed: Number(speedSel.value) }));
  container.querySelector('.tc-now').addEventListener('click', () => app.setTime(roundToHour(Date.now())));
  const commit = () => {
    const ms = parseUtcInput(input.value);
    if (!Number.isFinite(ms)) {
      app.toast('Enter a date and time as YYYY-MM-DD HH:MM (UTC).', 'warn', { key: 'tc-parse' });
      input.value = utcInputValue(store.get().timeMs);
      return;
    }
    if (ms !== store.get().timeMs) app.setTime(ms);
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    }
  });
  input.addEventListener('blur', () => { input.value = utcInputValue(store.get().timeMs); });

  const onKey = (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target;
    if (t && (t.closest?.('input, select, textarea, button, [contenteditable], canvas, [role="slider"], [role="application"], .mount') )) return;
    if (e.key === ' ' ) {
      e.preventDefault();
      playBtn.click();
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const sign = e.key === 'ArrowRight' ? 1 : -1;
      step(sign * (e.shiftKey ? D : H));
    }
  };
  document.addEventListener('keydown', onKey);

  const unsub = [
    store.subscribe((s) => renderTime(s), ['timeMs']),
    store.subscribe(renderPlay, ['playing', 'speed']),
  ];
  input.value = utcInputValue(store.get().timeMs);
  renderPlay(store.get());

  return {
    destroy() {
      unsub.forEach((u) => u());
      renderTime.cancel();
      document.removeEventListener('keydown', onKey);
      container.removeEventListener('click', onClick);
      container.innerHTML = '';
    },
  };
}
