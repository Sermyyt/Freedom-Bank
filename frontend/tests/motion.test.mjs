import test from 'node:test';
import assert from 'node:assert/strict';
import { milliseconds, prefersReducedMotion, reveal, dismiss } from '../js/lib/motion.js';
import { openModal } from '../js/components/modal.js';
import { initToasts, showToast } from '../js/components/toast.js';
import { startRouter } from '../js/router.js';

function replaceGlobal(t, name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  });
}

function media(t, reduced = false) {
  const listeners = new Set();
  const query = {
    matches: reduced,
    addEventListener(type, listener) { assert.equal(type, 'change'); listeners.add(listener); },
    removeEventListener(type, listener) { assert.equal(type, 'change'); listeners.delete(listener); },
  };
  replaceGlobal(t, 'matchMedia', (text) => {
    assert.equal(text, '(prefers-reduced-motion: reduce)');
    return query;
  });
  return {
    listeners,
    set(matches) {
      query.matches = matches;
      for (const listener of [...listeners]) listener({ matches });
    },
  };
}

function element() {
  const animations = [];
  return {
    isConnected: true,
    animations,
    animate(frames, options) {
      let resolve;
      let reject;
      const finished = new Promise((yes, no) => { resolve = yes; reject = no; });
      const animation = {
        frames, options, finished, cancels: 0,
        finish: () => resolve(),
        cancel() { this.cancels += 1; reject(new Error('Animation cancelled')); },
      };
      animations.push(animation);
      return animation;
    },
  };
}

test('duration tokens accept CSS units and fall back for invalid or excessive values', () => {
  assert.equal(milliseconds(' 180ms ', 140), 180);
  assert.equal(milliseconds('.18s', 140), 180);
  assert.equal(milliseconds('0s', 140), 0);
  assert.equal(milliseconds('12s', 140), 1000);
  for (const token of ['', 'auto', '-2s', 'Infinityms', '180']) {
    assert.equal(milliseconds(token, 140), 140);
  }
});

test('reduced motion and missing browser features finish without starting an animation', async (t) => {
  const preference = media(t, true);
  const node = element();
  assert.equal(prefersReducedMotion(), true);
  assert.equal(await reveal(node), false);
  assert.equal(node.animations.length, 0);
  assert.equal(await dismiss(null), false);
  preference.set(false);
  assert.equal(prefersReducedMotion(), false);
  assert.equal(await reveal({ isConnected: true }), false);
  node.isConnected = false;
  assert.equal(await reveal(node), false);
  assert.equal(node.animations.length, 0);
});

test('absence of matchMedia does not prevent an optional animation', async (t) => {
  replaceGlobal(t, 'matchMedia', undefined);
  assert.equal(prefersReducedMotion(), false);
  const node = element();
  const result = reveal(node);
  node.animations[0].finish();
  assert.equal(await result, true);
});

test('entry and exit use only opacity and transform with inherited token timing', async (t) => {
  const preference = media(t);
  replaceGlobal(t, 'getComputedStyle', () => ({
    getPropertyValue: (name) => ({
      '--cqa-duration-enter': '.2s', '--cqa-duration-exit': '120ms',
      '--cqa-ease-enter': 'ease-out', '--cqa-ease-exit': 'ease-in',
    })[name] || '',
  }));
  const node = element();
  const entering = reveal(node, 30);
  assert.deepEqual(node.animations[0].options, { duration: 200, easing: 'ease-out', delay: 30, fill: 'both' });
  node.animations[0].finish();
  assert.equal(await entering, true);
  const leaving = dismiss(node);
  assert.deepEqual(node.animations[1].options, { duration: 120, easing: 'ease-in', delay: 0, fill: 'both' });
  for (const animation of node.animations) {
    for (const frame of animation.frames) assert.deepEqual(Object.keys(frame).sort(), ['opacity', 'transform']);
  }
  node.animations[1].finish();
  assert.equal(await leaving, true);
  assert.equal(preference.listeners.size, 0);
  assert.equal(node.animations[1].cancels, 1, 'fill is released after completion');
});

test('a new animation cancels the prior one and prior cleanup does not cancel its replacement', async (t) => {
  const preference = media(t);
  const node = element();
  const entering = reveal(node);
  const leaving = dismiss(node);
  assert.equal(await entering, false);
  assert.equal(node.animations[1].cancels, 0, 'old completion cannot cancel the new animation');
  assert.equal(preference.listeners.size, 1);
  const enteringAgain = reveal(node);
  assert.equal(await leaving, false, 'the replacement remains tracked and is itself cancelled');
  assert.equal(node.animations[2].cancels, 0);
  node.animations[2].finish();
  assert.equal(await enteringAgain, true);
  assert.equal(preference.listeners.size, 0);
});

test('enabling reduced motion cancels motion already in progress and cleans up the preference listener', async (t) => {
  const preference = media(t);
  const node = element();
  const result = reveal(node);
  preference.set(false);
  assert.equal(node.animations[0].cancels, 0);
  preference.set(true);
  assert.equal(await result, false);
  assert.equal(preference.listeners.size, 0);
  assert.equal(await dismiss(node), false, 'subsequent removal remains immediate');
  assert.equal(node.animations.length, 1);
});

test('WAAPI failure or cancellation resolves instead of preventing caller cleanup', async (t) => {
  const preference = media(t);
  assert.equal(await reveal({ isConnected: true, animate() { throw new Error('Unsupported easing'); } }), false);
  const node = element();
  const result = dismiss(node);
  node.animations[0].cancel();
  assert.equal(await result, false);
  assert.equal(preference.listeners.size, 0);
});

// Small DOM model for lifecycle/focus ownership only. Native browser focus
// trapping, keyboard events and the actual visuals still require browser QA.
function documentModel(t) {
  const doc = {};
  class NodeModel extends EventTarget {
    constructor(tag = '') {
      super();
      this.tag = tag;
      this.children = [];
      this.parent = null;
      this.attributes = new Map();
      this.dataset = {};
      this.style = {};
      this.open = false;
    }
    get isConnected() { return this === doc.body || Boolean(this.parent?.isConnected); }
    append(...children) {
      for (const child of children) { child.parent = this; this.children.push(child); }
    }
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
      this.parent = null;
    }
    replaceChildren(...children) {
      for (const child of this.children) child.parent = null;
      this.children = [];
      this.append(...children);
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name); }
    contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
    querySelector(selector) {
      if (selector === 'main h1') return this.querySelector('main')?.querySelector('h1') || null;
      for (const child of this.children) {
        if ((selector === 'dialog[open]' && child.tag === 'dialog' && child.open) || child.tag === selector) return child;
        const found = child.querySelector(selector);
        if (found) return found;
      }
      return null;
    }
    focus() { doc.activeElement = this; }
    showModal() { this.open = true; this.focus(); }
    close() { this.open = false; this.dispatchEvent(new Event('close')); }
  }
  doc.createElement = (tag) => new NodeModel(tag);
  doc.createTextNode = (text) => Object.assign(new NodeModel(), { textContent: text });
  doc.body = new NodeModel('body');
  const root = doc.createElement('div');
  const main = doc.createElement('main');
  const heading = doc.createElement('h1');
  const opener = doc.createElement('button');
  doc.body.append(root);
  root.append(main);
  main.append(heading, opener);
  opener.focus();
  doc.getElementById = (id) => id === 'cqa-root' ? root : null;
  replaceGlobal(t, 'Node', NodeModel);
  replaceGlobal(t, 'document', doc);
  return { doc, root, main, heading, opener };
}

async function flushPromises() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

test('modal Escape closes once, preserves native open until exit and returns focus', async (t) => {
  media(t, false);
  const { doc, opener } = documentModel(t);
  let closed = 0;
  const modal = openModal({ title: 'Dialog', onClose: () => { closed += 1; } });
  const animated = element();
  modal.dialog.animate = animated.animate.bind(animated);
  const cancel = new Event('cancel', { cancelable: true });
  modal.dialog.dispatchEvent(cancel);
  const firstClose = modal.close();
  assert.equal(modal.close(), firstClose, 'repeated close shares the in-flight exit');
  assert.equal(cancel.defaultPrevented, true);
  assert.equal(modal.dialog.open, true, 'native focus containment remains during exit');
  assert.equal(modal.dialog.isConnected, true);
  assert.equal(animated.animations.length, 1);
  animated.animations[0].finish();
  await firstClose;
  assert.equal(modal.dialog.isConnected, false);
  assert.equal(doc.activeElement, opener);
  assert.equal(closed, 1);
  await modal.close();
  assert.equal(closed, 1);
});

test('modal return focus survives replacement of its opener and respects another open modal', async (t) => {
  media(t, true);
  const { doc, opener, heading } = documentModel(t);
  const modal = openModal({ title: 'Dialog' });
  opener.remove();
  await modal.close();
  assert.equal(doc.activeElement, heading);
  assert.equal(heading.tabIndex, -1);
  const first = openModal({ title: 'First' });
  const second = openModal({ title: 'Second' });
  await first.close();
  assert.equal(doc.activeElement, second.dialog, 'closing an older dialog must not move focus behind the top modal');
  await second.close();
});

test('modal wraps Tab in both directions and excludes disabled, hidden and untabbable controls', async (t) => {
  media(t, true);
  const { doc } = documentModel(t);
  replaceGlobal(t, 'getComputedStyle', (node) => ({ visibility: node.cssVisibility || 'visible' }));
  const modal = openModal({ title: 'Keyboard dialog' });
  function control(overrides = {}) {
    const node = doc.createElement('button');
    Object.assign(node, {
      tabIndex: 0,
      matches: () => Boolean(node.disabled),
      closest: () => node.hiddenAncestor || null,
      getClientRects: () => node.notRendered ? [] : [{}],
    }, overrides);
    return node;
  }
  const first = control();
  const middle = control();
  const last = control();
  const hidden = control({ hiddenAncestor: {} });
  const disabled = control({ disabled: true });
  const cssHidden = control({ cssVisibility: 'hidden' });
  const absent = control({ notRendered: true });
  const untabbable = control({ tabIndex: -1 });
  modal.dialog.append(first, middle, last, hidden, disabled, cssHidden, absent, untabbable);
  modal.dialog.querySelectorAll = () => [hidden, first, middle, last, disabled, cssHidden, absent, untabbable];
  function tab(shiftKey = false) {
    const event = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Tab', shiftKey });
    modal.dialog.dispatchEvent(event);
    return event;
  }
  last.focus();
  assert.equal(tab().defaultPrevented, true);
  assert.equal(doc.activeElement, first, 'Tab from the last usable control wraps before browser chrome');
  assert.equal(tab(true).defaultPrevented, true);
  assert.equal(doc.activeElement, last, 'Shift+Tab wraps to the last usable control');
  middle.focus();
  assert.equal(tab().defaultPrevented, false, 'navigation between inner controls remains native');
  modal.dialog.focus();
  assert.equal(tab().defaultPrevented, true);
  assert.equal(doc.activeElement, first, 'a non-tab stop inside the dialog re-enters its control order');
  await modal.close();
});

test('toast timeout pauses for hover and focus, resumes once and restores focus on manual close', async (t) => {
  media(t, true);
  const { doc, root, opener } = documentModel(t);
  let now = 0;
  let sequence = 0;
  const timers = new Map();
  t.mock.method(Date, 'now', () => now);
  replaceGlobal(t, 'setTimeout', (callback, delay) => {
    const id = ++sequence;
    timers.set(id, { callback, at: now + delay });
    return id;
  });
  replaceGlobal(t, 'clearTimeout', (id) => timers.delete(id));
  function advance(ms) {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now) { timers.delete(id); timer.callback(); }
    }
  }
  initToasts(root);
  const toast = showToast('Saved', { timeout: 1000 });
  const host = root.children.at(-1);
  const item = host.children[0];
  advance(300);
  item.dispatchEvent(new Event('pointerenter'));
  advance(2000);
  assert.equal(item.isConnected, true);
  assert.equal(timers.size, 0);
  item.querySelector('button').focus();
  item.dispatchEvent(new Event('focusin'));
  item.dispatchEvent(new Event('pointerleave'));
  assert.equal(timers.size, 0, 'keyboard focus keeps the timeout paused');
  opener.focus();
  const blur = new Event('focusout');
  Object.defineProperty(blur, 'relatedTarget', { value: opener });
  item.dispatchEvent(blur);
  item.dispatchEvent(new Event('pointerleave'));
  await flushPromises();
  assert.equal(timers.size, 1, 'overlapping resume events do not create duplicate timers');
  advance(699);
  assert.equal(item.isConnected, true);
  advance(1);
  await flushPromises();
  assert.equal(item.isConnected, false);
  toast.close();
  showToast('Persistent', { timeout: 0 });
  const persistent = host.children[0];
  const closeButton = persistent.querySelector('button');
  closeButton.focus();
  closeButton.dispatchEvent(new Event('click'));
  await flushPromises();
  assert.equal(persistent.isConnected, false);
  assert.equal(doc.activeElement, opener);
  assert.equal(timers.size, 0);
});

test('router focuses new views but preserves input focus during an in-place route update', (t) => {
  media(t, true);
  const { doc, main, opener } = documentModel(t);
  const events = new EventTarget();
  events.scrollTo = () => {};
  replaceGlobal(t, 'window', events);
  const location = { hash: '#/first' };
  replaceGlobal(t, 'location', location);
  let updates = 0;
  let destroys = 0;
  const first = {
    mount(container) {
      container.append(doc.createElement('h1'), opener);
      return { update() { updates += 1; }, destroy() { destroys += 1; } };
    },
  };
  const second = { mount(container) { container.append(doc.createElement('h1')); } };
  startRouter(main, { first, second });
  assert.equal(doc.activeElement, opener, 'initial load does not move focus');
  location.hash = '#/first?q=changed';
  events.dispatchEvent(new Event('hashchange'));
  assert.equal(updates, 1);
  assert.equal(doc.activeElement, opener);
  location.hash = '#/second';
  events.dispatchEvent(new Event('hashchange'));
  assert.equal(destroys, 1);
  assert.equal(doc.activeElement, main.querySelector('h1'));
  assert.equal(doc.activeElement.tabIndex, -1);
});
