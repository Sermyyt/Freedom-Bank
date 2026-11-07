import { milliseconds, prefersReducedMotion } from './motion.js';

// Presentation only: the final score and its precision always come from the API.
export function animateScore(element, score, format) {
  const finalText = format(score);
  if (!Number.isFinite(score) || prefersReducedMotion()) return () => {};
  const query = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  const duration = milliseconds(getComputedStyle(element).getPropertyValue('--cqa-duration-score'), 480);
  const started = performance.now();
  let frame;
  const finish = () => {
    cancelAnimationFrame(frame);
    element.textContent = finalText;
    query?.removeEventListener?.('change', preferenceChanged);
  };
  const preferenceChanged = event => { if (event.matches) finish(); };
  const update = now => {
    if (!element.isConnected) { finish(); return; }
    const progress = duration ? Math.min(1, (now - started) / duration) : 1;
    element.textContent = progress === 1 ? finalText : format(score * progress);
    if (progress < 1) frame = requestAnimationFrame(update);
    else finish();
  };
  query?.addEventListener?.('change', preferenceChanged);
  frame = requestAnimationFrame(update);
  return finish;
}
