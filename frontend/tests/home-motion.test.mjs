import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTOPLAY_MS, createAutoplayClock, keyToIndex, slideLabel, swipeIntent, wrapIndex } from '../js/lib/carousel.js';
import { countAt, countFrames, easeOutCubic } from '../js/lib/count-up.js';
import { pickRevealed, revealOnScroll, staggerDelay } from '../js/lib/reveal.js';

function replaceGlobal(t, name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  });
}

// ---------- Карусель ----------

test('carousel: индексы листаются по кругу и подписываются «N из M»', () => {
  assert.equal(wrapIndex(5, 5), 0);
  assert.equal(wrapIndex(-1, 5), 4);
  assert.equal(wrapIndex(12, 5), 2);
  assert.equal(wrapIndex(3, 0), 0);
  assert.equal(slideLabel(1, 5), '2 из 5');
  assert.equal(slideLabel(-1, 5), '5 из 5');
});

test('carousel: стрелки, Home и End; прочие клавиши не меняют слайд', () => {
  assert.equal(keyToIndex('ArrowRight', 4, 5), 0);
  assert.equal(keyToIndex('ArrowLeft', 0, 5), 4);
  assert.equal(keyToIndex('Home', 3, 5), 0);
  assert.equal(keyToIndex('End', 0, 5), 4);
  assert.equal(keyToIndex('Enter', 2, 5), null);
  assert.equal(keyToIndex('ArrowRight', 0, 0), null);
});

test('carousel: свайп — только заметный горизонтальный жест', () => {
  assert.equal(swipeIntent(-80, 10), 'next');
  assert.equal(swipeIntent(90, -5), 'prev');
  assert.equal(swipeIntent(-30, 0), null, 'короче порога');
  assert.equal(swipeIntent(-70, 65), null, 'почти вертикальная прокрутка');
  assert.equal(swipeIntent(undefined, undefined), null);
});

test('carousel: часы автосмены идут 6 с и стоят, пока есть хоть одна причина паузы', () => {
  assert.equal(AUTOPLAY_MS, 6000);
  const clock = createAutoplayClock(AUTOPLAY_MS, 0);
  assert.equal(clock.progress(3000), 0.5);
  clock.pause('hover', 3000);
  clock.pause('focus', 3500);
  assert.equal(clock.running(), false);
  assert.equal(clock.progress(9000), 0.5, 'на паузе прогресс не растёт');
  clock.resume('hover', 9000);
  assert.equal(clock.progress(12000), 0.5, 'фокус всё ещё держит паузу');
  assert.equal(clock.has('focus'), true);
  clock.resume('focus', 12000);
  assert.equal(clock.running(), true);
  assert.equal(clock.remaining(13500), 1500);
  assert.equal(clock.progress(20000), 1, 'не больше единицы');
  clock.reset(20000);
  assert.equal(clock.progress(20000), 0);
});

test('carousel: скрытая вкладка и кнопка «Пауза» — независимые причины', () => {
  const clock = createAutoplayClock(1000, 0);
  clock.pause('user', 100);
  clock.pause('hidden', 200);
  clock.resume('hidden', 5000);
  assert.equal(clock.running(), false, 'возврат на вкладку не отменяет паузу человека');
  assert.equal(clock.progress(5000), 0.1);
  clock.resume('user', 6000);
  assert.equal(clock.progress(6450), 0.55);
});

// ---------- Счётчики ----------

test('count-up: кривая замедляется к концу и ограничена 0…1', () => {
  assert.equal(easeOutCubic(0), 0);
  assert.equal(easeOutCubic(1), 1);
  assert.equal(easeOutCubic(2), 1);
  assert.equal(easeOutCubic(-1), 0);
  assert.ok(easeOutCubic(0.5) > 0.5);
});

test('count-up: кадры — целые, не убывают, не превышают цель и заканчиваются точным значением', () => {
  const frames = countFrames(65, 900);
  assert.equal(frames[0], 0);
  assert.equal(frames.at(-1), 65);
  for (let i = 1; i < frames.length; i += 1) {
    assert.ok(Number.isInteger(frames[i]));
    assert.ok(frames[i] >= frames[i - 1]);
    assert.ok(frames[i] <= 65);
  }
  assert.equal(countAt(7, 1), 7);
  assert.equal(countAt(0, 0.5), 0);
  assert.deepEqual(countFrames(12, 0), [12]);
  assert.ok(Number.isNaN(countAt(Number.NaN, 0.3)));
});

// ---------- Появление при прокрутке ----------

test('reveal: задержка растёт по шагу и ограничена сверху', () => {
  assert.equal(staggerDelay(0), 0);
  assert.equal(staggerDelay(2), 140);
  assert.equal(staggerDelay(50), 420);
  assert.equal(staggerDelay(-3), 0);
  assert.equal(staggerDelay(3, 100, 250), 250);
});

test('reveal: каждый элемент показывается один раз, в порядке пересечения', () => {
  const shown = new WeakSet();
  const a = {};
  const b = {};
  const c = {};
  assert.deepEqual(pickRevealed([{ target: a, isIntersecting: true }, { target: b, isIntersecting: false }], shown), [a]);
  assert.deepEqual(pickRevealed([{ target: a, isIntersecting: true }, { target: c, intersectionRatio: 0.4 }], shown), [c]);
  assert.deepEqual(pickRevealed([{ target: b, isIntersecting: true }], shown), [b]);
  assert.deepEqual(pickRevealed([{ target: b, isIntersecting: true }], shown), []);
});

test('reveal: элементы прячутся до пересечения, наблюдение снимается после показа', (t) => {
  replaceGlobal(t, 'matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  let instance = null;
  class FakeObserver {
    constructor(callback) { this.callback = callback; this.observed = new Set(); instance = this; }
    observe(node) { this.observed.add(node); }
    unobserve(node) { this.observed.delete(node); }
    disconnect() { this.observed.clear(); }
  }
  const node = () => ({ style: {}, isConnected: true, animate: () => ({ finished: Promise.resolve(), cancel() {} }) });
  const first = node();
  const second = node();
  const stop = revealOnScroll([first, second], { Observer: FakeObserver });
  assert.equal(first.style.opacity, '0');
  assert.equal(instance.observed.size, 2);
  instance.callback([{ target: first, isIntersecting: true }]);
  assert.equal(first.style.opacity, '', 'показанный элемент возвращается к стилям CSS');
  assert.equal(instance.observed.has(first), false);
  stop();
  assert.equal(second.style.opacity, '', 'после ухода с экрана ничего не остаётся скрытым');
});

test('reveal: без IntersectionObserver и при reduced motion ничего не прячется', (t) => {
  const element = { style: {} };
  revealOnScroll([element], { Observer: undefined });
  assert.equal(element.style.opacity, undefined);
  replaceGlobal(t, 'matchMedia', () => ({ matches: true }));
  revealOnScroll([element], { Observer: class {} });
  assert.equal(element.style.opacity, undefined);
});
