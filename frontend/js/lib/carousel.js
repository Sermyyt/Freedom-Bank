// Логика карусели без DOM: индексы, подписи, клавиши, свайп и часы автосмены с причинами паузы.
export const AUTOPLAY_MS = 6000;
export const SWIPE_THRESHOLD = 48;

export function wrapIndex(index, count) {
  if (!Number.isInteger(count) || count <= 0) return 0;
  const value = Math.trunc(Number(index) || 0) % count;
  return value < 0 ? value + count : value;
}

export function slideLabel(index, count) {
  return `${wrapIndex(index, count) + 1} из ${count}`;
}

// Стрелки листают по кругу, Home/End — к первому и последнему слайду. Другие клавиши не трогаем.
export function keyToIndex(key, index, count) {
  if (count <= 0) return null;
  if (key === 'ArrowRight') return wrapIndex(index + 1, count);
  if (key === 'ArrowLeft') return wrapIndex(index - 1, count);
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

// Горизонтальный жест длиннее порога и заметно горизонтальнее вертикального: влево — следующий слайд.
export function swipeIntent(dx, dy, threshold = SWIPE_THRESHOLD) {
  const x = Number(dx) || 0;
  const y = Number(dy) || 0;
  if (Math.abs(x) < threshold || Math.abs(x) <= Math.abs(y) * 1.2) return null;
  return x < 0 ? 'next' : 'prev';
}

// Часы автосмены. Время передаётся снаружи (now), поэтому логика проверяется без таймеров.
// Пауза хранит причины: наведение, фокус, скрытая вкладка, кнопка «Пауза». Пока есть хоть одна — часы стоят.
export function createAutoplayClock(duration = AUTOPLAY_MS, now = 0) {
  const reasons = new Set();
  let elapsed = 0;
  let startedAt = now;

  function settle(at) {
    if (reasons.size === 0) elapsed += Math.max(0, at - startedAt);
    startedAt = at;
  }

  return {
    duration,
    pause(reason, at) {
      settle(at);
      reasons.add(reason);
    },
    resume(reason, at) {
      settle(at);
      reasons.delete(reason);
    },
    reset(at) {
      elapsed = 0;
      startedAt = at;
    },
    has(reason) {
      return reasons.has(reason);
    },
    running() {
      return reasons.size === 0;
    },
    progress(at) {
      const running = reasons.size === 0 ? Math.max(0, at - startedAt) : 0;
      return Math.min(1, (elapsed + running) / duration);
    },
    remaining(at) {
      return Math.max(0, duration - this.progress(at) * duration);
    },
  };
}
