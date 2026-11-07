// Честная заглушка для экранов следующих фаз.
import { h } from '../dom.js';
import { setViewDemo } from '../state.js';

export function placeholder(title, phase) {
  return {
    mount(container) {
      setViewDemo(false);
      container.append(
        h(
          'section',
          { class: 'cqa-page' },
          h('h1', { text: title }),
          h(
            'div',
            { class: 'cqa-card cqa-empty' },
            h('p', { class: 'cqa-empty-title', text: `Экран появится в фазе ${phase}.` }),
            h('p', { class: 'cqa-empty-hint', text: 'Пока доступны список разговоров, импорт, карточка разговора с оценкой и апелляции.' }),
            h('a', { class: 'cqa-button', href: '#/conversations', text: 'К списку разговоров' }),
          ),
        ),
      );
      return null;
    },
  };
}

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
