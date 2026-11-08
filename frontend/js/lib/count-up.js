// Счётчики главной: плавный досчёт до значения API при первом показе. Только отображение:
// промежуточные кадры — целые числа от 0 до цели, последний кадр всегда равен значению сервера.
import { milliseconds, prefersReducedMotion } from './motion.js';

export function easeOutCubic(t) {
  const x = Math.min(1, Math.max(0, Number(t) || 0));
  return 1 - (1 - x) ** 3;
}

export function countAt(target, progress) {
  if (!Number.isFinite(target)) return target;
  if (progress >= 1) return target;
  const value = Math.round(target * easeOutCubic(progress));
  return target >= 0 ? Math.min(target, Math.max(0, value)) : Math.max(target, Math.min(0, value));
}

export function countFrames(target, duration, frame = 16) {
  if (!Number.isFinite(target) || duration <= 0) return [target];
  const frames = [];
  for (let time = 0; time < duration; time += frame) frames.push(countAt(target, time / duration));
  frames.push(target);
  return frames;
}

// el получает текст кадров; при reduced motion или без rAF — сразу итог. Возвращает функцию остановки.
export function animateCount(el, target, format = String) {
  const finalText = format(target);
  const raf = globalThis.requestAnimationFrame;
  if (!Number.isFinite(target) || target === 0 || prefersReducedMotion() || typeof raf !== 'function') {
    el.textContent = finalText;
    return () => {};
  }
  const style = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
  const duration = milliseconds(style?.getPropertyValue('--cqa-duration-count'), 900);
  let frame = 0;
  let started = null;
  const finish = () => {
    globalThis.cancelAnimationFrame?.(frame);
    el.textContent = finalText;
  };
  const step = (now) => {
    if (started === null) started = now;
    if (el.isConnected === false) { finish(); return; }
    const progress = duration ? (now - started) / duration : 1;
    el.textContent = progress >= 1 ? finalText : format(countAt(target, progress));
    if (progress < 1) frame = raf(step);
  };
  el.textContent = format(0);
  frame = raf(step);
  return finish;
}
