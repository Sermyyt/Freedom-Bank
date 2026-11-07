// Экран для адреса, которого нет в интерфейсе.
import { h } from '../dom.js';
import { setViewDemo } from '../state.js';

export const notFound = {
  mount(container) {
    setViewDemo(false);
    container.append(
      h(
        'section',
        { class: 'cqa-page' },
        h('h1', { text: 'Страница не найдена' }),
        h(
          'div',
          { class: 'cqa-card cqa-empty' },
          h('p', { class: 'cqa-empty-title', text: 'Такого адреса в интерфейсе нет.' }),
          h('a', { class: 'cqa-button', href: '#/conversations', text: 'К списку разговоров' }),
        ),
      ),
    );
    return null;
  },
};
