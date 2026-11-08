// История: события сервера (append-only) — фильтр по типу и по разговору, пагинация, ссылки на связанные объекты.
import { api } from '../api.js';
import { badge } from '../components/badge.js';
import { emptyState } from '../components/empty-state.js';
import { loadingState } from '../components/loading-state.js';
import { cardTable, labelRow } from '../components/table.js';
import { field } from '../components/field.js';
import { showError } from '../components/toast.js';
import { append, clear, h } from '../dom.js';
import { isAbortError } from '../lib/errors.js';
import { PAGE_SIZES, pageRange } from '../lib/filters.js';
import { DASH, formatDateTime } from '../lib/format.js';
import {
  HISTORY_ACTOR_LABELS,
  HISTORY_EVENT_TONES,
  HISTORY_EVENT_TYPES,
  eventLabel,
  eventLinks,
  hasHistoryFilters,
  historyApiQuery,
  historyQueryToHash,
  normalizeHistoryQuery,
} from '../lib/history.js';
import { labelFor } from '../lib/labels.js';
import { staggerIn } from '../lib/motion.js';
import { buildHash } from '../lib/route.js';
import { getChecklistVersion, setViewDemo, state } from '../state.js';

const COLUMNS = ['Время', 'Событие', 'Что произошло', 'Связано', 'Кто'];

export function mount(container, route) {
  const controller = new AbortController();
  let query = normalizeHistoryQuery(route.query);
  let loadSeq = 0;
  // История хранит внутренний ID разговора; внешний ID берём из карточки разговора (одна загрузка на разговор).
  const conversationNames = new Map();

  setViewDemo(false);

  // ---------- Фильтры ----------
  const typeSelect = h(
    'select',
    {},
    h('option', { value: '', text: 'Все события' }),
    HISTORY_EVENT_TYPES.map((type) => h('option', { value: type, text: eventLabel(type) })),
  );
  const typeField = field({ id: 'cqa-history-type', label: 'Тип события', control: typeSelect });
  const searchInput = h('input', {
    type: 'search', autocomplete: 'off', spellcheck: 'false', placeholder: 'ID разговора',
    title: 'Останутся только события найденного разговора.',
  });
  const searchField = field({
    id: 'cqa-history-conversation',
    label: 'Разговор',
    control: searchInput,
  });
  const searchButton = h('button', { type: 'submit', class: 'cqa-button', text: 'Найти' });
  const sizeSelect = h('select', {}, PAGE_SIZES.map((size) => h('option', { value: String(size), text: String(size) })));
  const sizeField = field({ id: 'cqa-history-limit', label: 'На странице', control: sizeSelect });
  const resetButton = h('button', { type: 'button', class: 'cqa-button', text: 'Сбросить фильтры', on: { click: () => navigate({ limit: query.limit }) } });
  const activeConversation = h('div', { class: 'cqa-history-active', hidden: true });
  const matches = h('div', { class: 'cqa-history-matches', 'aria-live': 'polite', hidden: true });
  const filters = h(
    'form',
    { class: 'cqa-filters cqa-history-filters', role: 'search', novalidate: true, on: { submit: (event) => { event.preventDefault(); findConversation(); } } },
    typeField.el,
    h('div', { class: 'cqa-history-search' }, searchField.el, searchButton),
    sizeField.el,
    h('div', { class: 'cqa-filters-actions' }, resetButton),
  );

  // ---------- Таблица ----------
  const listStatus = h('p', { class: 'cqa-list-status', 'aria-live': 'polite', tabindex: '-1' });
  const loading = loadingState();
  const listError = h('div', { class: 'cqa-alert cqa-alert--bad', role: 'alert', hidden: true });
  const tableBody = h('tbody');
  const tableWrap = h(
    'div',
    { class: 'cqa-table-wrap', role: 'region', tabindex: '0', 'aria-label': 'История событий, прокручиваемая таблица' },
    cardTable(h('table', { class: 'cqa-table cqa-history-table' }, h('thead', {}, h('tr', {}, COLUMNS.map((title) => h('th', { scope: 'col', text: title })))), tableBody)),
  );
  const listEmpty = h('div', { hidden: true });
  const pager = h('nav', { class: 'cqa-pager', 'aria-label': 'Страницы истории' });

  container.append(h(
    'section',
    { class: 'cqa-page' },
    h(
      'div',
      { class: 'cqa-page-intro' },
      h('div', { class: 'cqa-page-title' },
        h('h1', { text: 'История' }),
        h('p', { class: 'cqa-page-lead', text: 'Импорт, оценки, апелляции и версии чек-листа. Записи не меняются.' })),
    ),
    h('section', { class: 'cqa-card', 'aria-labelledby': 'cqa-history-title' },
      h('h2', { id: 'cqa-history-title', class: 'cqa-sr-only', text: 'События' }),
      filters,
      activeConversation,
      matches,
      listStatus,
      listError,
      loading,
      tableWrap,
      listEmpty,
      pager),
  ));

  typeSelect.addEventListener('change', () => navigate({ ...query, event_type: typeSelect.value, offset: 0 }));
  sizeSelect.addEventListener('change', () => navigate({ ...query, limit: sizeSelect.value, offset: 0 }));

  function hashFor(next) {
    return buildHash('history', [], historyQueryToHash(normalizeHistoryQuery(next)));
  }

  function navigate(next) {
    const hash = hashFor(next);
    if (hash === location.hash) {
      load();
      return;
    }
    location.hash = hash;
  }

  function syncInputs() {
    typeSelect.value = query.event_type || '';
    sizeSelect.value = String(query.limit);
    resetButton.disabled = !hasHistoryFilters(query);
    renderActiveConversation();
  }

  // ---------- Разговор: внешний ID ----------
  function conversationName(conversationId) {
    if (!conversationNames.has(conversationId)) {
      conversationNames.set(conversationId, api.getConversation(conversationId, undefined, { signal: controller.signal })
        .then((detail) => detail.ref.conversation_id)
        .catch((error) => {
          if (isAbortError(error)) throw error;
          return null;
        }));
    }
    return conversationNames.get(conversationId);
  }

  function renderActiveConversation() {
    if (!query.conversation_id) {
      activeConversation.hidden = true;
      return;
    }
    const name = h('strong', { text: '…' });
    const conversationId = query.conversation_id;
    conversationName(conversationId)
      .then((value) => {
        name.textContent = value || 'разговор не найден';
      })
      .catch(() => {});
    clear(activeConversation).append(
      h('span', {}, 'Только события разговора ', name),
      h('a', { href: buildHash('conversation', [conversationId]), text: 'Открыть карточку' }),
      h('button', {
        type: 'button',
        class: 'cqa-button cqa-button--ghost cqa-button--small',
        text: 'Показать все разговоры',
        on: { click: () => navigate({ ...query, conversation_id: '', offset: 0 }) },
      }),
    );
    activeConversation.hidden = false;
  }

  function chooseConversation(item) {
    conversationNames.set(item.ref.id, Promise.resolve(item.ref.conversation_id));
    matches.hidden = true;
    searchInput.value = '';
    navigate({ ...query, conversation_id: item.ref.id, offset: 0 });
  }

  async function findConversation() {
    const text = searchInput.value.trim();
    searchField.clearError();
    matches.hidden = true;
    if (!text) {
      searchField.setError('Введите внешний ID разговора.');
      searchInput.focus();
      return;
    }
    searchButton.disabled = true;
    try {
      const page = await api.listConversations({ q: text, limit: 10 }, { signal: controller.signal });
      const exact = page.items.filter((item) => item.ref.conversation_id === text);
      if (exact.length === 1) {
        chooseConversation(exact[0]);
        return;
      }
      if (!exact.length && page.items.length === 1) {
        chooseConversation(page.items[0]);
        return;
      }
      if (!page.items.length) {
        searchField.setError('Разговор с таким ID не найден.');
        return;
      }
      const shown = exact.length > 1 ? exact : page.items;
      // append из dom.js пропускает null; нативный Element.append вывел бы «null» текстом.
      append(clear(matches), [
        h('p', { class: 'cqa-muted', text: `Найдено разговоров: ${exact.length > 1 ? exact.length : page.total}. Выберите один:` }),
        h('ul', { class: 'cqa-history-match-list' }, shown.map((item) => h(
          'li',
          {},
          h('button', { type: 'button', class: 'cqa-button cqa-button--small', text: item.ref.conversation_id, on: { click: () => chooseConversation(item) } }),
          h('span', { class: 'cqa-muted', text: `группа ${item.ref.group_id}` }),
        ))),
        page.total > page.items.length && exact.length <= 1 ? h('p', { class: 'cqa-field-hint', text: 'Показаны первые 10 — уточните ID.' }) : null,
      ]);
      matches.hidden = false;
    } catch (error) {
      if (isAbortError(error)) return;
      searchField.setError(error.message);
      showError(error);
    } finally {
      searchButton.disabled = false;
    }
  }

  // ---------- Строки ----------
  function versionNode(versionId, tag, attrs, prefix) {
    const node = h(tag, attrs, `${prefix}…`);
    getChecklistVersion(versionId)
      .then((version) => {
        node.textContent = `${prefix}v${version.version}`;
      })
      .catch(() => {
        node.textContent = `${prefix}версия не загружена`;
      });
    return node;
  }

  function linkNodes(event) {
    return eventLinks(event).map((link) => {
      if (link.kind === 'conversation') {
        const node = h('a', { href: link.href, text: 'Разговор' });
        conversationName(event.conversation_id)
          .then((name) => {
            if (name) node.textContent = `Разговор ${name}`;
          })
          .catch(() => {});
        return node;
      }
      if (link.kind === 'evaluation') return h('a', { href: link.href, text: 'Оценка' });
      if (link.kind === 'appeal') return h('a', { href: link.href, text: 'Апелляция' });
      // Версия чек-листа: у событий чек-листа — ссылка на редактор, у оценки — по какой версии оценено.
      if (String(event.event_type).startsWith('checklist_version')) {
        return versionNode(link.versionId, 'a', { href: link.href }, 'Чек-лист ');
      }
      return versionNode(link.versionId, 'span', { class: 'cqa-muted' }, 'по чек-листу ');
    });
  }

  function row(event) {
    const links = linkNodes(event);
    return labelRow(h(
      'tr',
      {},
      h('td', { class: 'cqa-nowrap', text: formatDateTime(event.created_at) }),
      h('td', {}, badge(eventLabel(event.event_type), HISTORY_EVENT_TONES[event.event_type] || 'neutral')),
      h('td', { class: 'cqa-history-summary cqa-wide', text: event.summary }),
      h('td', {}, links.length ? h('span', { class: 'cqa-row-actions' }, links) : h('span', { class: 'cqa-muted', text: DASH })),
      h('td', { class: 'cqa-nowrap', text: labelFor(HISTORY_ACTOR_LABELS, event.actor) }),
    ), COLUMNS);
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
      let empty;
      if (page.total > 0) {
        empty = emptyState({
          title: 'На этой странице ничего нет.',
          hint: `Всего событий: ${page.total}.`,
          action: h('a', { class: 'cqa-button', href: hashFor({ ...query, offset: 0 }), text: 'К первой странице' }),
        });
      } else if (hasHistoryFilters(query)) {
        empty = emptyState({
          title: 'По этим фильтрам событий нет.',
          hint: 'Выберите другой тип события или покажите все разговоры.',
          action: h('button', { type: 'button', class: 'cqa-button', text: 'Сбросить фильтры', on: { click: () => navigate({ limit: query.limit }) } }),
        });
      } else {
        empty = emptyState({
          title: 'Событий пока нет.',
          hint: 'События появятся после импорта и оценки.',
          action: h('a', { class: 'cqa-button', href: state.lastListHash || '#/conversations', text: 'К списку разговоров' }),
        });
      }
      listEmpty.replaceChildren(empty);
    } else {
      tableWrap.hidden = false;
      listEmpty.hidden = true;
      tableBody.replaceChildren(...page.items.map(row));
      staggerIn(tableBody.children);
      listStatus.textContent = `Показаны ${range.from}–${range.to} из ${range.total}, сначала новые`;
    }
    renderPager(page);
  }

  async function load() {
    const seq = ++loadSeq;
    syncInputs();
    listError.hidden = true;
    tableWrap.classList.add('is-loading');
    tableWrap.setAttribute('aria-busy', 'true');
    loading.hidden = Boolean(tableBody.childElementCount);
    listStatus.textContent = 'Загрузка…';
    try {
      const page = await api.listHistory(historyApiQuery(query), { signal: controller.signal });
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
      query = normalizeHistoryQuery(nextRoute.query);
      load();
      return true;
    },
    destroy() {
      controller.abort();
    },
  };
}
