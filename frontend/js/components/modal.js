// Модальное окно на <dialog>: native-модальность, Esc и замкнутый Tab-порядок.
// Окно добавляется внутрь #cqa-root, чтобы на него действовали стили .cqa-app и при встраивании в чужую страницу.
import { h } from '../dom.js';
import { dismiss, reveal } from '../lib/motion.js';

let sequence = 0;

export function openModal({ title, body, footer, onClose } = {}) {
  const root = document.getElementById('cqa-root') || document.body;
  const opener = document.activeElement;
  const titleId = `cqa-modal-title-${++sequence}`;
  const closeButton = h('button', { type: 'button', class: 'cqa-modal-close', 'aria-label': 'Закрыть окно', text: '×' });
  const dialog = h(
    'dialog',
    { class: 'cqa-modal', 'aria-labelledby': titleId },
    h('div', { class: 'cqa-modal-head' }, h('h2', { id: titleId, text: title }), closeButton),
    h('div', { class: 'cqa-modal-body' }, body),
    footer ? h('div', { class: 'cqa-modal-foot' }, footer) : null,
  );
  let closePromise = null;
  let closed = false;

  function finishClose() {
    if (closed) return;
    closed = true;
    dialog.remove();
    // После сохранения родительский экран мог уже заменить кнопку открытия.
    if (!root.querySelector('dialog[open]')) {
      const target = opener?.isConnected && !opener.disabled ? opener : root.querySelector('main h1');
      if (target && typeof target.focus === 'function') {
        if (target !== opener) target.tabIndex = -1;
        target.focus({ preventScroll: true });
      }
    }
    if (onClose) onClose();
  }

  function close() {
    if (closed) return Promise.resolve();
    if (closePromise) return closePromise;
    // До конца выхода окно остаётся модальным: фокус не уходит под него.
    closePromise = dismiss(dialog).then(() => {
      if (dialog.open) dialog.close();
      finishClose();
    });
    return closePromise;
  }

  closeButton.addEventListener('click', close);
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab' || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    // Native dialog в некоторых браузерах допускает переход в адресную строку.
    // Замыкаем только границы; обычный порядок полей внутри остаётся нативным.
    const stops = [...dialog.querySelectorAll('a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]')]
      .filter((node) => node.tabIndex >= 0 && !node.matches(':disabled')
        && !node.closest('[hidden], [inert]') && node.getClientRects().length > 0
        && getComputedStyle(node).visibility !== 'hidden')
      .sort((left, right) => (left.tabIndex || Infinity) - (right.tabIndex || Infinity));
    const first = stops[0];
    const last = stops.at(-1);
    const active = document.activeElement;
    const outsideOrder = !stops.includes(active);
    if (!first || outsideOrder || (event.shiftKey ? active === first : active === last)) {
      event.preventDefault();
      (event.shiftKey ? last : first)?.focus({ preventScroll: true });
      if (!first) dialog.focus({ preventScroll: true });
    }
  });
  // Клик мимо окна его не закрывает: в форме может быть недописанный комментарий.
  dialog.addEventListener('close', finishClose);

  root.append(dialog);
  dialog.showModal();
  reveal(dialog);
  return { dialog, close };
}
