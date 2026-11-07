// Всплывающие сообщения внутри #cqa-root.
import { h } from '../dom.js';
import { NETWORK_MESSAGE } from '../lib/errors.js';

let host = null;

export function initToasts(root) {
  host = h('div', { class: 'cqa-toasts', 'aria-live': 'polite' });
  root.append(host);
}

export function showToast(message, { tone = 'info', timeout = 6000 } = {}) {
  if (!host) return;
  const item = h(
    'div',
    { class: `cqa-toast cqa-toast--${tone}`, role: tone === 'error' ? 'alert' : 'status' },
    h('span', { class: 'cqa-toast-text', text: message }),
    h('button', {
      type: 'button',
      class: 'cqa-toast-close',
      'aria-label': 'Закрыть сообщение',
      text: '×',
      on: { click: () => item.remove() },
    }),
  );
  host.append(item);
  if (timeout) setTimeout(() => item.remove(), timeout);
}

export function showError(error) {
  showToast((error && error.message) || NETWORK_MESSAGE, { tone: 'error', timeout: 10000 });
}
