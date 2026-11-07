// Static skeletons keep the layout readable without background animation.
import { h } from '../dom.js';

export function loadingState(label = '') {
  return h('div', { class: 'cqa-loading-state', role: label ? 'status' : null, 'aria-hidden': label ? null : 'true' },
    label ? h('p', { class: 'cqa-muted', text: label }) : null,
    h('div', { class: 'cqa-skeleton', 'aria-hidden': 'true' },
      Array.from({ length: 3 }, () => h('div', { class: 'cqa-skeleton-row' },
        h('span', { class: 'cqa-skeleton-line' }), h('span', { class: 'cqa-skeleton-line' })))));
}
