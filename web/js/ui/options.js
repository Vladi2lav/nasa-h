import { icon } from './icons.js';
import { popover, debounce } from './dom.js';
import { defaultState } from './store.js';

export function mount(container, app) {
  const { store } = app;
  container.innerHTML = `
    <button type="button" class="icon-btn opt-btn" aria-label="Analysis options" title="Analysis options">${icon('sliders')}</button>
    <div class="popover opt-pop" role="dialog" aria-label="Analysis options">
      <h2 class="pop-title">Analysis options</h2>
      <label class="field">
        <span class="field-label">Sunlit when at least <output class="num" data-out="sun"></output> of the solar disc is visible</span>
        <input type="range" min="0.05" max="1" step="0.05" data-opt="sunMinFraction">
      </label>
      <label class="field">
        <span class="field-label">Earth-link elevation mask (degrees above terrain)</span>
        <input type="number" min="0" max="20" step="0.5" class="num" data-opt="commMaskDeg">
      </label>
      <fieldset class="field">
        <legend class="field-label">Solar panel</legend>
        <label class="radio"><input type="radio" name="opt-panel" value="tracking"><span><strong>Sun-tracking</strong> vertical array (polar landers)</span></label>
        <label class="radio"><input type="radio" name="opt-panel" value="horizontal"><span><strong>Horizontal</strong> flat panel (deck-mounted)</span></label>
      </fieldset>
      <label class="field">
        <span class="field-label">Observer / antenna height above the ground (m)</span>
        <input type="number" min="0" max="100" step="0.5" class="num" data-opt="observerHeightM">
      </label>
      <label class="check"><input type="checkbox" data-opt="learn"><span>Show plain-language hints</span></label>
      <div class="pop-actions">
        <button type="button" class="btn btn-sm btn-ghost" data-reset>Reset to defaults</button>
        <button type="button" class="btn btn-sm btn-primary" data-close>Done</button>
      </div>
    </div>`;
  const btn = container.querySelector('.opt-btn');
  const pop = container.querySelector('.opt-pop');
  const q = (s) => pop.querySelector(s);
  const pv = popover(btn, pop, { onOpen: () => fill(store.get()) });

  function fill(s) {
    q('[data-opt="sunMinFraction"]').value = s.opts.sunMinFraction;
    q('[data-out="sun"]').textContent = `${Math.round(s.opts.sunMinFraction * 100)}%`;
    q('[data-opt="commMaskDeg"]').value = s.opts.commMaskDeg;
    q('[data-opt="observerHeightM"]').value = s.opts.observerHeightM;
    pop.querySelectorAll('[name="opt-panel"]').forEach((r) => { r.checked = r.value === s.opts.panel; });
    q('[data-opt="learn"]').checked = !!s.learn;
    const def = defaultState().opts;
    btn.classList.toggle('is-modified', JSON.stringify(s.opts) !== JSON.stringify(def));
  }
  const apply = debounce((patch) => store.set({ opts: patch }), 250);
  pop.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.opt === 'sunMinFraction') {
      q('[data-out="sun"]').textContent = `${Math.round(Number(t.value) * 100)}%`;
      apply({ sunMinFraction: Math.min(1, Math.max(0.05, Number(t.value))) });
    }
  });
  pop.addEventListener('change', (e) => {
    const t = e.target;
    const v = Number(t.value);
    if (t.dataset.opt === 'commMaskDeg') {
      if (Number.isFinite(v) && v >= 0 && v <= 20) apply({ commMaskDeg: v });
      else { app.toast('The elevation mask must be between 0° and 20°.', 'warn'); fill(store.get()); }
    } else if (t.dataset.opt === 'observerHeightM') {
      if (Number.isFinite(v) && v >= 0 && v <= 100) apply({ observerHeightM: v });
      else { app.toast('The observer height must be between 0 and 100 m.', 'warn'); fill(store.get()); }
    } else if (t.name === 'opt-panel') {
      apply({ panel: t.value });
    } else if (t.dataset.opt === 'learn') {
      store.set({ learn: t.checked });
    }
  });
  q('[data-reset]').addEventListener('click', () => {
    apply.cancel();
    store.set({ opts: defaultState().opts });
    fill(store.get());
  });
  q('[data-close]').addEventListener('click', () => pv.close(true));
  const unsub = store.subscribe(fill, ['opts', 'learn']);
  fill(store.get());
  return {
    destroy() {
      unsub();
      apply.cancel();
      pv.destroy();
      container.innerHTML = '';
    },
  };
}
