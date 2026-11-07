// Плашка статуса. Смысл всегда передаётся текстом, цвет только помогает.
import { h } from '../dom.js';

export function badge(text, tone = 'neutral', title) {
  return h('span', { class: `cqa-badge cqa-badge--${tone}`, title }, text);
}
