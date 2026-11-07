// Поле формы с подписью, подсказкой и местом для ошибки сервера (по details.path).
import { h } from '../dom.js';

export function field({ id, label, control, hint }) {
  control.id = id;
  const error = h('div', { class: 'cqa-field-error', id: `${id}-error`, hidden: true });
  const hintNode = hint ? h('div', { class: 'cqa-field-hint', id: `${id}-hint`, text: hint }) : null;
  if (hintNode) control.setAttribute('aria-describedby', hintNode.id);
  const el = h('div', { class: 'cqa-field' }, h('label', { for: id, text: label }), control, hintNode, error);

  return {
    el,
    control,
    setHint(text) {
      if (hintNode) hintNode.textContent = text;
    },
    setError(message) {
      error.textContent = message;
      error.hidden = false;
      control.classList.add('is-invalid');
      control.setAttribute('aria-invalid', 'true');
      control.setAttribute('aria-describedby', [error.id, hintNode && hintNode.id].filter(Boolean).join(' '));
    },
    clearError() {
      error.textContent = '';
      error.hidden = true;
      control.classList.remove('is-invalid');
      control.removeAttribute('aria-invalid');
      if (hintNode) control.setAttribute('aria-describedby', hintNode.id);
      else control.removeAttribute('aria-describedby');
    },
  };
}
