// Пустое состояние списка: что произошло и что сделать дальше.
import { h } from '../dom.js';

export function emptyState({ title, hint, action } = {}) {
  return h(
    'div',
    { class: 'cqa-empty' },
    h('p', { class: 'cqa-empty-title', text: title }),
    hint ? h('p', { class: 'cqa-empty-hint', text: hint }) : null,
    action || null,
  );
}
