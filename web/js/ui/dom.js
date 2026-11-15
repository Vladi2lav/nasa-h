export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function debounce(fn, ms) {
  let t = 0;
  const d = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  d.cancel = () => clearTimeout(t);
  d.flush = (...args) => { clearTimeout(t); fn(...args); };
  return d;
}

export function throttle(fn, ms) {
  let last = 0;
  let timer = 0;
  let pendingArgs = null;
  const run = () => {
    timer = 0;
    last = performance.now();
    const args = pendingArgs;
    pendingArgs = null;
    fn(...args);
  };
  const t = (...args) => {
    pendingArgs = args;
    if (timer) return;
    const wait = Math.max(0, ms - (performance.now() - last));
    timer = setTimeout(run, wait);
  };
  t.cancel = () => { clearTimeout(timer); timer = 0; pendingArgs = null; };
  return t;
}

export function latest() {
  let n = 0;
  return { next: () => ++n, is: (id) => id === n, cancel: () => { n++; } };
}

export function popover(button, panel, { onOpen } = {}) {
  let isOpen = false;
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-haspopup', 'dialog');
  panel.hidden = true;
  const onDoc = (e) => {
    if (!isOpen) return;
    if (panel.contains(e.target) || button.contains(e.target)) return;
    close(false);
  };
  const onKey = (e) => {
    if (isOpen && e.key === 'Escape') {
      e.stopPropagation();
      close(true);
    }
  };
  function open() {
    if (isOpen) return;
    isOpen = true;
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    onOpen?.();
    const first = panel.querySelector('input, select, button, [tabindex]:not([tabindex="-1"])');
    first?.focus({ preventScroll: true });
  }
  function close(returnFocus = true) {
    if (!isOpen) return;
    isOpen = false;
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (returnFocus) button.focus({ preventScroll: true });
  }
  const onBtn = () => (isOpen ? close(true) : open());
  button.addEventListener('click', onBtn);
  document.addEventListener('pointerdown', onDoc, true);
  panel.addEventListener('keydown', onKey);
  button.addEventListener('keydown', onKey);
  return {
    open,
    close,
    toggle: onBtn,
    isOpen: () => isOpen,
    destroy() {
      button.removeEventListener('click', onBtn);
      document.removeEventListener('pointerdown', onDoc, true);
      panel.removeEventListener('keydown', onKey);
      button.removeEventListener('keydown', onKey);
    },
  };
}

export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function preserveFocus(root, render) {
  const active = document.activeElement;
  const key = active && root.contains(active) ? active.getAttribute('data-focus') : null;
  const sel = active && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
  render();
  if (!key) return;
  const el = root.querySelector(`[data-focus="${CSS.escape(key)}"]`);
  if (el) {
    el.focus({ preventScroll: true });
    if (sel && 'setSelectionRange' in el) {
      try { el.setSelectionRange(sel[0], sel[1]); } catch {  }
    }
  }
}

export const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
