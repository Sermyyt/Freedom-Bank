// Модальное окно на <dialog>: фокус внутри окна, Esc и затемнение даёт браузер.
// Окно добавляется внутрь #cqa-root, чтобы на него действовали стили .cqa-app и при встраивании в чужую страницу.
import { h } from '../dom.js';

let sequence = 0;

export function openModal({ title, body, footer, onClose } = {}) {
  const root = document.getElementById('cqa-root') || document.body;
  const titleId = `cqa-modal-title-${++sequence}`;
  const closeButton = h('button', { type: 'button', class: 'cqa-modal-close', 'aria-label': 'Закрыть окно', text: '×' });
  const dialog = h(
    'dialog',
    { class: 'cqa-modal', 'aria-labelledby': titleId },
    h('div', { class: 'cqa-modal-head' }, h('h2', { id: titleId, text: title }), closeButton),
    h('div', { class: 'cqa-modal-body' }, body),
    footer ? h('div', { class: 'cqa-modal-foot' }, footer) : null,
  );
  let closed = false;

  function close() {
    if (closed) return;
    closed = true;
    if (dialog.open) dialog.close();
    dialog.remove();
    if (onClose) onClose();
  }

  closeButton.addEventListener('click', close);
  // Esc: браузер закрывает окно сам, мы только убираем его из DOM.
  // Клик мимо окна его не закрывает: в форме может быть недописанный комментарий.
  dialog.addEventListener('close', close);

  root.append(dialog);
  dialog.showModal();
  return { dialog, close };
}
