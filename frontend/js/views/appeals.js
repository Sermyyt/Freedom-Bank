// Список апелляций: фильтр по статусу (открытые по умолчанию), разговор, критерий, комментарий, дата, статус.
// Решение принимается в карточке разговора, рядом с перепиской: «Рассмотреть» открывает её с формой решения.
import { api } from '../api.js';
import { badge } from '../components/badge.js';
import { emptyState } from '../components/empty-state.js';
import { loadingState } from '../components/loading-state.js';
import { showError } from '../components/toast.js';
import { append, clear, h } from '../dom.js';
import {
  APPEAL_STATUS_LABELS,
  APPEAL_STATUS_TONES,
  appealsApiQuery,
  appealsQueryToHash,
  describeDecision,
  normalizeAppealsQuery,
} from '../lib/appeals.js';
import { isAbortError } from '../lib/errors.js';
import { pageRange } from '../lib/filters.js';
import { DASH, excerpt, formatDateTime } from '../lib/format.js';
import { buildHash } from '../lib/route.js';
import { setLastAppealsHash, setViewDemo, state } from '../state.js';
import { appealHash } from './appeal-forms.js';

const FILTERS = [
  { status: 'open', label: 'Открытые' },
  { status: 'resolved', label: 'Решённые' },
  { status: 'all', label: 'Все' },
];
const COLUMNS = ['Разговор', 'Критерий', 'Комментарий оператора', 'Подана', 'Статус', 'Решение', 'Действие'];

const EMPTY = {
  open: {
    title: 'Открытых апелляций нет.',
    hint: 'Апелляцию подают из карточки разговора: кнопка «Оспорить» у критерия оценки. Решённые апелляции — во вкладке «Решённые».',
  },
  resolved: {
    title: 'Решённых апелляций пока нет.',
    hint: 'Решение принимается в карточке разговора: кнопка «Рассмотреть» у открытой апелляции.',
  },
  all: {
    title: 'Апелляций пока нет.',
    hint: 'Апелляцию подают из карточки разговора: кнопка «Оспорить» у критерия оценки.',
  },
};

export function mount(container, route) {
  const controller = new AbortController();
  let query = normalizeAppealsQuery(route.query);
  let loadSeq = 0;
  // В Appeal нет разговора и названия критерия: берём их из оценки (одна загрузка на оценку).
  const evaluations = new Map();

  const filterLinks = FILTERS.map((filter) => h('a', { class: 'cqa-filter-tab', text: filter.label, dataset: { status: filter.status } }));
  const filterNav = h('nav', { class: 'cqa-filter-tabs', 'aria-label': 'Статус апелляций' }, filterLinks);
  const listStatus = h('p', { class: 'cqa-list-status', 'aria-live': 'polite', tabindex: '-1' });
  const listError = h('div', { class: 'cqa-alert cqa-alert--bad', role: 'alert', hidden: true });
  const tableBody = h('tbody');
  const loading = loadingState();
  const tableWrap = h(
    'div',
    { class: 'cqa-table-wrap', role: 'region', tabindex: '0', 'aria-label': 'Апелляции, прокручиваемая таблица' },
    h('table', { class: 'cqa-table cqa-appeals-table' }, h('thead', {}, h('tr', {}, COLUMNS.map((title) => h('th', { scope: 'col', text: title })))), tableBody),
  );
  const listEmpty = h('div', { hidden: true });
  const pager = h('nav', { class: 'cqa-pager', 'aria-label': 'Страницы списка' });

  container.append(h(
    'section',
    { class: 'cqa-page' },
    h(
      'div',
      { class: 'cqa-page-intro' },
      h('h1', { text: 'Апелляции' }),
      h('p', { class: 'cqa-page-lead', text: 'Оператор оспаривает критерий в карточке разговора, проверяющий принимает решение там же, рядом с перепиской. Итог оценки сервер пересчитывает сразу, история решений сохраняется.' }),
    ),
    h('section', { class: 'cqa-card', 'aria-labelledby': 'cqa-appeals-title' },
      h('div', { class: 'cqa-card-head' }, h('h2', { id: 'cqa-appeals-title', text: 'Список апелляций' }), filterNav),
      listStatus,
      listError,
      loading,
      tableWrap,
      listEmpty,
      pager),
  ));

  function hashFor(next) {
    return buildHash('appeals', [], appealsQueryToHash(normalizeAppealsQuery(next)));
  }

  function syncFilters() {
    for (const link of filterLinks) {
      const active = link.dataset.status === query.status;
      link.setAttribute('href', hashFor({ status: link.dataset.status }));
      link.classList.toggle('is-active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
  }

  function loadEvaluation(evaluationId) {
    if (!evaluations.has(evaluationId)) {
      const pending = api.getEvaluation(evaluationId, { signal: controller.signal }).catch((error) => {
        if (isAbortError(error)) throw error;
        evaluations.delete(evaluationId);
        return { failed: error };
      });
      evaluations.set(evaluationId, pending);
    }
    return evaluations.get(evaluationId);
  }

  function placeholder() {
    return h('span', { class: 'cqa-muted', text: '…' });
  }

  function decisionCell(appeal, criterion) {
    const summary = describeDecision(appeal.decision, criterion);
    if (!summary) return h('span', { class: 'cqa-muted', text: DASH });
    return [
      h('strong', { text: summary.actionLabel }),
      h('div', { class: 'cqa-appeal-outcome', text: summary.answerChanged ? `${summary.before} → ${summary.after}` : summary.after }),
      appeal.decision.reason ? h('div', { class: 'cqa-muted cqa-small', title: appeal.decision.reason, text: excerpt(appeal.decision.reason, 120) }) : null,
      h('div', { class: 'cqa-muted cqa-small', text: formatDateTime(appeal.resolved_at) }),
    ];
  }

  function row(appeal) {
    const conversationCell = h('td', { class: 'cqa-nowrap' }, placeholder());
    const criterionCell = h('td', { class: 'cqa-appeal-criterion-cell' }, placeholder());
    const decisionTd = h('td', { class: 'cqa-appeal-decision-cell' }, appeal.status === 'open' ? h('span', { class: 'cqa-muted', text: DASH }) : placeholder());
    const actionCell = h('td', { class: 'cqa-nowrap' }, placeholder());
    const tr = h(
      'tr',
      {},
      conversationCell,
      criterionCell,
      h('td', { class: 'cqa-appeal-comment-cell' }, h('span', { class: 'cqa-clamp', title: appeal.comment, text: appeal.comment })),
      h('td', { class: 'cqa-nowrap', text: formatDateTime(appeal.created_at) }),
      h('td', {}, badge(APPEAL_STATUS_LABELS[appeal.status] || appeal.status, APPEAL_STATUS_TONES[appeal.status] || 'neutral')),
      decisionTd,
      actionCell,
    );

    loadEvaluation(appeal.evaluation_id).then((evaluation) => {
      // Строка уже заменена новой загрузкой списка.
      if (!tableBody.contains(tr)) return;
      if (!evaluation || evaluation.failed) {
        clear(conversationCell).append(h('span', { class: 'cqa-muted', text: 'оценка не загружена' }));
        clear(criterionCell).append(h('code', { text: appeal.criterion_id }));
        clear(actionCell).append(h('span', { class: 'cqa-muted', text: DASH }));
        if (appeal.status !== 'open') append(clear(decisionTd), decisionCell(appeal, null));
        return;
      }
      if (evaluation.is_demo === true) setViewDemo(true);
      const ref = evaluation.conversation;
      const criterion = (evaluation.checklist_snapshot.criteria || []).find((item) => item.id === appeal.criterion_id) || null;
      const cardHref = buildHash('conversation', [ref.id], { evaluation: evaluation.id });
      clear(conversationCell).append(
        h('a', { class: 'cqa-strong', href: cardHref, text: ref.conversation_id }),
        h('div', { class: 'cqa-muted cqa-small', text: ref.revision > 1 ? `группа ${ref.group_id}, ревизия ${ref.revision}` : `группа ${ref.group_id}` }),
      );
      clear(criterionCell).append(criterion ? criterion.name : h('code', { text: appeal.criterion_id }));
      if (appeal.status !== 'open') append(clear(decisionTd), decisionCell(appeal, criterion));
      clear(actionCell).append(appeal.status === 'open'
        ? h('a', { class: 'cqa-button cqa-button--primary cqa-button--small', href: appealHash(ref.id, appeal), text: 'Рассмотреть' })
        : h('a', { href: cardHref, text: 'Открыть в карточке' }));
    }).catch((error) => {
      if (!isAbortError(error)) showError(error);
    });
    return tr;
  }

  function pageLink(text, offset, disabled) {
    return disabled
      ? h('button', { type: 'button', class: 'cqa-button', disabled: true, text })
      : h('a', { class: 'cqa-button', href: hashFor({ ...query, offset }), text });
  }

  function renderPager(page) {
    const hadFocus = pager.contains(document.activeElement);
    clear(pager);
    if (hadFocus) {
      listStatus.focus({ preventScroll: true });
      listStatus.scrollIntoView({ block: 'center' });
    }
    if (!page || page.total <= page.limit) return;
    const pages = Math.ceil(page.total / page.limit);
    const currentPage = Math.floor(page.offset / page.limit) + 1;
    pager.append(
      pageLink('Назад', Math.max(0, page.offset - page.limit), page.offset <= 0),
      h('span', { class: 'cqa-muted', text: `Страница ${currentPage} из ${pages}` }),
      pageLink('Вперёд', page.offset + page.limit, page.offset + page.limit >= page.total),
    );
  }

  function renderPage(page) {
    const range = pageRange(page);
    if (!range) {
      tableWrap.hidden = true;
      listEmpty.hidden = false;
      listStatus.textContent = '';
      const empty = page.total > 0
        ? emptyState({
          title: 'На этой странице ничего нет.',
          hint: `Всего найдено: ${page.total}.`,
          action: h('a', { class: 'cqa-button', href: hashFor({ status: query.status }), text: 'К первой странице' }),
        })
        : emptyState({
          ...EMPTY[query.status],
          action: h('a', { class: 'cqa-button', href: state.lastListHash || '#/conversations', text: 'К списку разговоров' }),
        });
      listEmpty.replaceChildren(empty);
    } else {
      tableWrap.hidden = false;
      listEmpty.hidden = true;
      tableBody.replaceChildren(...page.items.map(row));
      listStatus.textContent = `Показаны ${range.from}–${range.to} из ${range.total}`;
    }
    renderPager(page);
  }

  async function load() {
    const seq = ++loadSeq;
    setLastAppealsHash(hashFor(query));
    syncFilters();
    // Решения меняют оценки: при каждой загрузке списка оценки запрашиваются заново.
    evaluations.clear();
    setViewDemo(false);
    listError.hidden = true;
    tableWrap.classList.add('is-loading');
    tableWrap.setAttribute('aria-busy', 'true');
    loading.hidden = Boolean(tableBody.childElementCount);
    listStatus.textContent = 'Загрузка…';
    try {
      const page = await api.listAppeals(appealsApiQuery(query), { signal: controller.signal });
      if (seq !== loadSeq) return;
      renderPage(page);
    } catch (error) {
      if (isAbortError(error) || seq !== loadSeq) return;
      listStatus.textContent = '';
      clear(listError).append(
        h('span', { text: error.message }),
        ' ',
        h('button', { type: 'button', class: 'cqa-button', text: 'Повторить', on: { click: load } }),
      );
      listError.hidden = false;
      showError(error);
    } finally {
      if (seq === loadSeq) {
        tableWrap.classList.remove('is-loading');
        tableWrap.setAttribute('aria-busy', 'false');
        loading.hidden = true;
      }
    }
  }

  load();

  return {
    update(nextRoute) {
      query = normalizeAppealsQuery(nextRoute.query);
      load();
      return true;
    },
    destroy() {
      controller.abort();
    },
  };
}
