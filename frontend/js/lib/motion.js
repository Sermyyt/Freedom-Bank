// Short UI motion only. Absence of WAAPI never blocks functionality.
const active = new WeakMap();

export function prefersReducedMotion() {
  return Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

export function milliseconds(value, fallback) {
  const token = String(value || '').trim();
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)m?s$/.test(token)) return fallback;
  const result = Number.parseFloat(token) * (token.endsWith('ms') ? 1 : 1000);
  return Number.isFinite(result) ? Math.min(1000, result) : fallback;
}

// Длительности по умолчанию, если токен на .cqa-app не задан.
const FALLBACK_MS = { enter: 180, exit: 140, page: 320, reveal: 560, row: 260 };

function options(element, kind, delay) {
  const style = typeof getComputedStyle === 'function' ? getComputedStyle(element) : null;
  const token = (name) => style?.getPropertyValue(name).trim() || '';
  return {
    duration: milliseconds(token(`--cqa-duration-${kind}`), FALLBACK_MS[kind] ?? 180),
    easing: token(`--cqa-ease-${kind}`) || 'cubic-bezier(.2,.8,.2,1)',
    delay,
    fill: 'both',
  };
}

export function playMotion(element, frames, { kind = 'enter', delay = 0 } = {}) {
  if (!element) return Promise.resolve(false);
  active.get(element)?.cancel();
  const query = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  if (element.isConnected === false || query?.matches || typeof element.animate !== 'function') {
    return Promise.resolve(false);
  }
  let animation;
  try {
    animation = element.animate(frames, options(element, kind, delay));
  } catch {
    return Promise.resolve(false);
  }
  active.set(element, animation);
  const stopForPreference = (event) => { if (event.matches) animation.cancel(); };
  query?.addEventListener?.('change', stopForPreference);
  return animation.finished.then(() => true, () => false).finally(() => {
    query?.removeEventListener?.('change', stopForPreference);
    if (active.get(element) === animation) active.delete(element);
    animation.cancel();
  });
}

export function reveal(element, delay = 0) {
  return playMotion(element, [
    { opacity: 0, transform: 'translateY(8px)' },
    { opacity: 1, transform: 'translateY(0)' },
  ], { delay });
}

export function dismiss(element) {
  return playMotion(element, [
    { opacity: 1, transform: 'translateY(0)' },
    { opacity: 0, transform: 'translateY(4px)' },
  ], { kind: 'exit' });
}

// Смена экрана: новый экран мягко поднимается на место.
export function enterPage(element) {
  return playMotion(element, [
    { opacity: 0, transform: 'translateY(14px)' },
    { opacity: 1, transform: 'translateY(0)' },
  ], { kind: 'page' });
}

// Поочерёдное появление строк и карточек: только первые max элементов, остальные видны сразу.
export function staggerIn(nodes, { step = 32, max = 8 } = {}) {
  [...nodes].slice(0, max).forEach((node, index) => {
    playMotion(node, [
      { opacity: 0, transform: 'translateY(8px)' },
      { opacity: 1, transform: 'translateY(0)' },
    ], { kind: 'row', delay: index * step });
  });
}
