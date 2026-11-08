// Появление блоков при прокрутке: каждый элемент — один раз, с небольшой поочерёдной задержкой.
// Без IntersectionObserver или при reduced motion всё сразу видно: содержимое никогда не прячется навсегда.
import { playMotion, prefersReducedMotion } from './motion.js';

export function staggerDelay(index, step = 70, max = 420) {
  const value = Math.max(0, Math.trunc(Number(index) || 0)) * step;
  return Math.min(max, value);
}

// Какие элементы показать сейчас: пересёкшиеся с экраном и ещё не показанные. Порядок — как в документе.
export function pickRevealed(entries, shown) {
  const result = [];
  for (const entry of entries) {
    if ((entry.isIntersecting || entry.intersectionRatio > 0) && !shown.has(entry.target)) {
      shown.add(entry.target);
      result.push(entry.target);
    }
  }
  return result;
}

const HIDDEN = { opacity: 0, transform: 'translateY(18px)' };
const SHOWN = { opacity: 1, transform: 'translateY(0)' };

export function revealOnScroll(elements, { Observer = globalThis.IntersectionObserver, step = 70 } = {}) {
  const list = [...elements].filter(Boolean);
  if (!list.length || typeof Observer !== 'function' || prefersReducedMotion()) return () => {};
  const shown = new WeakSet();
  for (const element of list) {
    element.style.opacity = '0';
    element.style.transform = HIDDEN.transform;
  }
  const show = (element, delay) => {
    element.style.opacity = '';
    element.style.transform = '';
    playMotion(element, [HIDDEN, SHOWN], { kind: 'reveal', delay });
  };
  const observer = new Observer((entries) => {
    pickRevealed(entries, shown).forEach((element, index) => {
      observer.unobserve(element);
      show(element, staggerDelay(index, step));
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
  for (const element of list) observer.observe(element);
  return () => {
    observer.disconnect();
    for (const element of list) {
      element.style.opacity = '';
      element.style.transform = '';
    }
  };
}
