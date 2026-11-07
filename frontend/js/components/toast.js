// Всплывающие сообщения внутри #cqa-root.
import { h } from '../dom.js';
import { NETWORK_MESSAGE } from '../lib/errors.js';
import { dismiss, reveal } from '../lib/motion.js';

let host = null;

export function initToasts(root) {
  host = h('div', { class: 'cqa-toasts', 'aria-live': 'polite' });
  root.append(host);
}

export function showToast(message, { tone = 'info', timeout = 6000 } = {}) {
  if (!host) return;
  const opener = document.activeElement;
  let closing = false;
  let timer = null;
  let remaining = timeout;
  let startedAt = 0;
  let hovered = false;
  const item = h(
    'div',
    { class: `cqa-toast cqa-toast--${tone}`, role: tone === 'error' ? 'alert' : 'status' },
    h('span', { class: 'cqa-toast-text', text: message }),
    h('button', {
      type: 'button',
      class: 'cqa-toast-close',
      'aria-label': 'Закрыть сообщение',
      text: '×',
      on: { click: close },
    }),
  );

  function pause() {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
    remaining = Math.max(0, remaining - (Date.now() - startedAt));
  }

  function resume() {
    if (closing || timer !== null || !timeout || hovered || item.contains(document.activeElement)) return;
    startedAt = Date.now();
    timer = setTimeout(close, remaining);
  }

  function close() {
    if (closing) return;
    closing = true;
    pause();
    dismiss(item).then(() => {
      const hadFocus = item.contains(document.activeElement);
      item.remove();
      if (hadFocus && opener?.isConnected && typeof opener.focus === 'function') {
        opener.focus({ preventScroll: true });
      }
    });
  }

  item.addEventListener('pointerenter', () => { hovered = true; pause(); });
  item.addEventListener('pointerleave', () => { hovered = false; resume(); });
  item.addEventListener('focusin', pause);
  item.addEventListener('focusout', (event) => {
    if (!item.contains(event.relatedTarget)) queueMicrotask(resume);
  });
  host.append(item);
  reveal(item);
  resume();
  return { close };
}

export function showError(error) {
  showToast((error && error.message) || NETWORK_MESSAGE, { tone: 'error', timeout: 10000 });
}
