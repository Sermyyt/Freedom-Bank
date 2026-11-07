import test from 'node:test';
import assert from 'node:assert/strict';
import { animateScore } from '../js/lib/score-motion.js';

function harness(run, reduced = false) {
  const listeners = new Set();
  let callback;
  const values = {
    matchMedia: () => ({ matches: reduced, addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn) }),
    performance: { now: () => 0 },
    getComputedStyle: () => ({ getPropertyValue: () => '480ms' }),
    requestAnimationFrame: fn => { callback = fn; return 1; },
    cancelAnimationFrame: () => { callback = null; },
  };
  const original = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  try { run({ frame: time => callback?.(time), listeners, pending: () => Boolean(callback) }); }
  finally {
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

test('score motion ends on the exact server score and removes its listener', () => harness(({ frame, listeners, pending }) => {
  const element = { isConnected: true, textContent: '81.25' };
  animateScore(element, 81.25, value => value.toFixed(2));
  frame(240);
  assert.equal(element.textContent, '40.63');
  frame(480);
  assert.equal(element.textContent, '81.25');
  assert.equal(listeners.size, 0);
  assert.equal(pending(), false);
}));

test('reduced motion never starts a score counter', () => harness(({ pending }) => {
  const element = { isConnected: true, textContent: '81.25' };
  animateScore(element, 81.25, String);
  assert.equal(pending(), false);
  assert.equal(element.textContent, '81.25');
}, true));

test('changing motion preference or leaving the view finishes immediately', () => harness(({ frame, listeners, pending }) => {
  const element = { isConnected: true, textContent: '55' };
  const finish = animateScore(element, 55, String);
  frame(120);
  [...listeners][0]({ matches: true });
  assert.equal(element.textContent, '55');
  assert.equal(pending(), false);
  finish();
  animateScore(element, 55, String);
  element.isConnected = false;
  frame(240);
  assert.equal(listeners.size, 0);
  assert.equal(pending(), false);
}));
