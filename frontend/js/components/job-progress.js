// Ход задания оценки: статус, полоса processed/total, счётчики и ошибки элементов.
import { h } from '../dom.js';
import { describeJob } from '../lib/poll.js';

// itemLabel(revisionId) — подпись элемента для ошибок (например, внешний ID разговора); null — без подписи.
export function createJobProgress({ itemLabel } = {}) {
  const label = h('span', { class: 'cqa-job-label' });
  const counts = h('span', { class: 'cqa-job-counts' });
  const fill = h('span', { class: 'cqa-progress-fill' });
  const bar = h('span', {
    class: 'cqa-progress',
    role: 'progressbar',
    'aria-valuemin': '0',
    'aria-valuemax': '100',
    'aria-label': 'Ход оценки',
  }, fill);
  const errors = h('ul', { class: 'cqa-job-errors', hidden: true });
  const el = h('div', { class: 'cqa-job', hidden: true, 'aria-live': 'polite' }, h('div', { class: 'cqa-job-head' }, label, counts), bar, errors);
  let lastSnapshot = null;

  function update(job) {
    const view = describeJob(job);
    if (!view) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const itemMessages = view.itemErrors.map((item) => {
      const who = itemLabel ? itemLabel(item.revisionId) : null;
      return who ? `${who}: ${item.message}` : item.message;
    });
    const messages = [...itemMessages, view.jobError].filter(Boolean);
    const snapshot = JSON.stringify([view.label, view.tone, view.processed, view.total,
      view.succeeded, view.failed, view.manualReview, view.percent, messages]);
    // Одинаковый результат опроса не повторяет объявление aria-live.
    if (snapshot === lastSnapshot) return;
    lastSnapshot = snapshot;
    el.dataset.tone = view.tone;
    label.textContent = view.label;
    counts.replaceChildren(
      h('span', { text: `обработано ${view.processed} из ${view.total}` }),
      h('span', { text: `успешно ${view.succeeded}` }),
      h('span', { text: `с ошибкой ${view.failed}` }),
      h('span', { text: `на ручную проверку ${view.manualReview}` }),
    );
    fill.style.transform = `scaleX(${view.percent / 100})`;
    bar.setAttribute('aria-valuenow', String(Math.round(view.percent)));
    bar.setAttribute('aria-valuetext', `Обработано ${view.processed} из ${view.total}; с ошибкой ${view.failed}; на ручную проверку ${view.manualReview}`);
    errors.replaceChildren(...messages.map((message) => h('li', { text: message })));
    errors.hidden = messages.length === 0;
  }

  return { el, update, hide: () => { el.hidden = true; } };
}
