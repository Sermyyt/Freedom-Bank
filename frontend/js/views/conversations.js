// Список разговоров: импорт группы и файла, отчёт импорта, фильтры, таблица, пагинация.
import { api } from '../api.js';
import { badge } from '../components/badge.js';
import { emptyState } from '../components/empty-state.js';
import { loadingState } from '../components/loading-state.js';
import { field } from '../components/field.js';
import { createJobProgress } from '../components/job-progress.js';
import { showError, showToast } from '../components/toast.js';
import { clear, debounce, h } from '../dom.js';
import { setExpanded } from '../lib/disclosure.js';
import { fieldErrors, isAbortError } from '../lib/errors.js';
import { buildGroupEvaluationRequest, groupJobSummary } from '../lib/group-evaluation.js';
import { isTerminalJob, pollJob } from '../lib/poll.js';
import {
  EVALUATION_STATUSES,
  PAGE_SIZES,
  hasActiveFilters,
  listQueryToHash,
  normalizeListQuery,
  pageRange,
} from '../lib/filters.js';
import { DASH, formatDateTime, formatSummaryScore } from '../lib/format.js';
import {
  CHANNEL_LABELS,
  EVALUATION_STATUS_LABELS,
  EVALUATION_STATUS_TONES,
  describeIssueLocation,
  labelFor,
} from '../lib/labels.js';
import { buildHash } from '../lib/route.js';
import {
  rememberGroup,
  setGroupJob,
  setImportOpen,
  setLastListHash,
  setPageSize,
  setViewDemo,
  state,
  subscribe,
} from '../state.js';

// Значения из данных организаторов; встреченные в ответах новые значения добавляются к выбору.
const KNOWN_LANGUAGES = ['RU', 'KZ', 'EN'];
const KNOWN_CHANNELS = ['agent chat', 'voice call'];
const COLUMNS = ['Внешний ID', 'Группа', 'Канал', 'Язык', 'Сообщений', 'Итог', 'Статус оценки', 'Грубое нарушение', 'Апелляции', 'Демо'];
const NUMERIC_COLUMNS = new Set(['Сообщений', 'Итог']);

function fillSelect(select, options, value) {
  const current = value || '';
  const list = [...options];
  if (current && !list.some(([optionValue]) => optionValue === current)) list.push([current, current]);
  select.replaceChildren(...list.map(([optionValue, text]) => h('option', { value: optionValue, text })));
  select.value = current;
}

export function mount(container, route) {
  const controller = new AbortController();
  let query = normalizeListQuery(route.query, state.pageSize);
  let loadSeq = 0;
  let datasetBusy = false;
  const seenLanguages = new Set(KNOWN_LANGUAGES);
  const seenChannels = new Set(KNOWN_CHANNELS);
  const seenGroups = new Set();

  // ---------- Импорт по группе ----------
  const datasetGroup = field({
    id: 'cqa-dataset-group',
    label: 'ID группы',
    control: h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'например, DEV' }),
  });
  const datasetHint = h('p', { class: 'cqa-field-hint' });
  const datasetError = h('div', { class: 'cqa-form-error', role: 'alert', hidden: true });
  const datasetButton = h('button', { type: 'submit', class: 'cqa-button cqa-button--primary', text: 'Импортировать группу' });
  const datasetForm = h(
    'form',
    { class: 'cqa-import-form', novalidate: true, on: { submit: (event) => { event.preventDefault(); importDataset(); } } },
    h('h3', { text: 'Группа с сервера организаторов' }),
    datasetGroup.el,
    datasetHint,
    datasetError,
    h('div', { class: 'cqa-actions' }, datasetButton),
  );

  // ---------- Импорт файлом ----------
  const fileInput = field({
    id: 'cqa-import-file',
    label: 'Файл JSON',
    control: h('input', { type: 'file', accept: '.json,application/json' }),
    hint: 'Полный ответ организаторов или массив записей в UTF-8.',
  });
  const fileGroup = field({
    id: 'cqa-import-file-group',
    label: 'ID группы',
    control: h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'необязательно для полного ответа' }),
    hint: 'Обязателен для массива записей. Для полного ответа организаторов можно не указывать: если указан, должен совпасть с группой в файле.',
  });
  const fileError = h('div', { class: 'cqa-form-error', role: 'alert', hidden: true });
  const fileButton = h('button', { type: 'submit', class: 'cqa-button cqa-button--primary', text: 'Загрузить файл' });
  const fileForm = h(
    'form',
    { class: 'cqa-import-form', novalidate: true, on: { submit: (event) => { event.preventDefault(); importFile(); } } },
    h('h3', { text: 'Файл с разговорами' }),
    fileInput.el,
    fileGroup.el,
    fileError,
    h('div', { class: 'cqa-actions' }, fileButton),
  );

  const report = h('div', { class: 'cqa-import-report', hidden: true, 'aria-live': 'polite' });
  // Блок импорта сворачивается, чтобы список был на первом экране. Выбор человека запоминается;
  // Без него панель открывается после загрузки пустого списка, без вспышки при старте.
  let autoCollapseChecked = state.importOpen !== null;
  let importOpen = state.importOpen === true;
  const importToggle = h('button', {
    type: 'button', class: 'cqa-import-toggle cqa-button', text: 'Импорт разговоров',
    'aria-controls': 'cqa-import-panel', 'aria-expanded': String(importOpen),
    on: { click: () => {
      autoCollapseChecked = true;
      setImportOpen(!importOpen);
      setImportBoxOpen(!importOpen);
    } },
  });
  const importBox = h(
    'section',
    { id: 'cqa-import-panel', class: 'cqa-card cqa-import-panel', hidden: !importOpen, 'aria-labelledby': 'cqa-import-title' },
    h('h2', { id: 'cqa-import-title', text: 'Импорт разговоров' }),
    h('div', { class: 'cqa-import-grid' }, datasetForm, fileForm),
    report,
  );

  function setImportBoxOpen(open) {
    const hadFocus = importBox.contains(document.activeElement);
    importOpen = open;
    importToggle.setAttribute('aria-expanded', String(open));
    setExpanded(importBox, open).then(() => {
      if (!importOpen && importBox.hidden && hadFocus && importToggle.isConnected
        && (importBox.contains(document.activeElement) || document.activeElement === document.body)) importToggle.focus();
    });
  }

  // ---------- Фильтры ----------
  const groupOptions = h('datalist', { id: 'cqa-group-options' });
  const groupFilter = field({
    id: 'cqa-filter-group',
    label: 'Группа',
    control: h('input', { type: 'text', list: 'cqa-group-options', autocomplete: 'off', spellcheck: 'false', placeholder: 'все группы' }),
  });
  const languageFilter = field({ id: 'cqa-filter-language', label: 'Язык', control: h('select') });
  const channelFilter = field({ id: 'cqa-filter-channel', label: 'Канал', control: h('select') });
  const statusFilter = field({ id: 'cqa-filter-status', label: 'Статус оценки', control: h('select') });
  const grossFilter = field({ id: 'cqa-filter-gross', label: 'Грубое нарушение', control: h('select') });
  const appealsFilter = field({ id: 'cqa-filter-appeals', label: 'Открытые апелляции', control: h('select') });
  const searchFilter = field({
    id: 'cqa-filter-q',
    label: 'Поиск по внешнему ID',
    control: h('input', { type: 'search', autocomplete: 'off', spellcheck: 'false', placeholder: 'часть ID' }),
  });
  const pageSizeFilter = field({ id: 'cqa-filter-limit', label: 'На странице', control: h('select') });
  const resetButton = h('button', { type: 'button', class: 'cqa-button', text: 'Сбросить фильтры', on: { click: resetFilters } });

  fillSelect(statusFilter.control, [['', 'Все'], ...EVALUATION_STATUSES.map((value) => [value, EVALUATION_STATUS_LABELS[value]])], '');
  fillSelect(grossFilter.control, [['', 'Все'], ['true', 'Есть'], ['false', 'Нет']], '');
  fillSelect(appealsFilter.control, [['', 'Все'], ['true', 'Есть'], ['false', 'Нет']], '');
  fillSelect(pageSizeFilter.control, PAGE_SIZES.map((size) => [String(size), String(size)]), String(query.limit));

  let advancedOpen = null;
  const advancedSummary = h('summary', { text: 'Все фильтры' });
  const advancedFilters = h('details', { class: 'cqa-filter-more' },
    advancedSummary,
    h('div', { class: 'cqa-filters-secondary' }, statusFilter.el, grossFilter.el, appealsFilter.el),
  );
  advancedFilters.addEventListener('cqa:disclosure', event => { advancedOpen = event.detail.open; });

  const filtersForm = h(
    'form',
    { class: 'cqa-filters', role: 'search', on: { submit: (event) => { event.preventDefault(); applyText(); } } },
    h('div', { class: 'cqa-filters-primary' }, searchFilter.el, groupFilter.el, groupOptions, languageFilter.el, channelFilter.el),
    h('div', { class: 'cqa-filters-tools' }, advancedFilters, resetButton),
  );

  // ---------- Оценка всей группы ----------
  // Ошибки элементов задания подписываются внешним ID разговора, если строка уже встречалась в таблице.
  const revisionLabels = new Map();
  const groupProgress = createJobProgress({ itemLabel: (revisionId) => revisionLabels.get(revisionId) || null });
  const groupTitle = h('p', { class: 'cqa-group-eval-title' });
  const groupHint = h('p', { class: 'cqa-field-hint' });
  const groupError = h('div', { class: 'cqa-form-error', role: 'alert', hidden: true });
  const groupButton = h('button', { type: 'button', class: 'cqa-button cqa-button--primary', text: 'Оценить всю группу', on: { click: evaluateGroup } });
  const groupDismiss = h('button', { type: 'button', class: 'cqa-button cqa-button--ghost cqa-button--small', text: 'Скрыть итог', hidden: true, on: { click: dismissGroupJob } });
  const groupBox = h(
    'section',
    { class: 'cqa-group-eval', 'aria-label': 'Оценка всей группы' },
    h('div', { class: 'cqa-group-eval-head' },
      h('div', { class: 'cqa-group-eval-text' }, groupTitle, groupHint),
      h('div', { class: 'cqa-actions' }, groupDismiss, groupButton)),
    groupError,
    groupProgress.el,
  );
  let groupStarting = false;
  let groupPoll = null;

  // ---------- Таблица ----------
  const listStatus = h('p', { class: 'cqa-list-status', 'aria-live': 'polite', tabindex: '-1' });
  const listError = h('div', { class: 'cqa-alert cqa-alert--bad', role: 'alert', hidden: true });
  const tableBody = h('tbody');
  const table = h(
    'table',
    { class: 'cqa-table cqa-conversations-table', role: 'table', 'aria-label': 'Разговоры' },
    h('thead', {}, h('tr', {}, COLUMNS.map((title) => h('th', { scope: 'col', class: NUMERIC_COLUMNS.has(title) ? 'cqa-num' : null, text: title })))),
    tableBody,
  );
  const tableWrap = h('div', { class: 'cqa-table-wrap cqa-list-scroll', role: 'region', tabindex: '0', 'aria-label': 'Разговоры, прокручиваемый список' }, table);
  const loading = loadingState();
  const listEmpty = h('div', { hidden: true });
  const pager = h('nav', { class: 'cqa-pager', 'aria-label': 'Страницы списка' });

  container.append(
    h(
      'section',
      { class: 'cqa-page cqa-conversations-page' },
      h('div', { class: 'cqa-page-head' }, h('h1', { text: 'Разговоры' }), importToggle),
      importBox,
      h(
        'section',
        { class: 'cqa-card cqa-conversations-list', 'aria-labelledby': 'cqa-list-title' },
        h('h2', { id: 'cqa-list-title', class: 'cqa-sr-only', text: 'Список разговоров' }),
        groupBox,
        filtersForm,
        listStatus,
        listError,
        loading,
        tableWrap,
        listEmpty,
        h('div', { class: 'cqa-list-footer' }, pageSizeFilter.el, pager),
      ),
    ),
  );

  // ---------- Импорт: действия ----------
  function syncDatasetAvailability() {
    const unavailable = Boolean(state.health && state.health.dataset_ready === false);
    datasetButton.disabled = unavailable || datasetBusy;
    datasetGroup.control.disabled = unavailable;
    datasetHint.textContent = unavailable
      ? 'На сервере не настроен DATASET_URL; используйте загрузку файла.'
      : 'Сервер сам скачает набор по этой группе: ссылка источника хранится только на сервере.';
  }

  function hideFormError(node) {
    node.textContent = '';
    node.hidden = true;
  }

  function showImportError(error, fields, formError) {
    const byField = fieldErrors(error.details);
    for (const [key, message] of Object.entries(byField)) {
      if (fields[key]) fields[key].setError(message);
    }
    formError.textContent = error.message;
    formError.hidden = false;
    showError(error);
  }

  async function runImport(button, call, fields, formError) {
    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'Импорт…';
    try {
      const result = await call();
      if (controller.signal.aborted) return;
      renderReport(result);
      rememberGroup(result.group_id);
      showToast(`Импорт группы ${result.group_id} завершён: получено ${result.received}, новых ${result.created}.`, { tone: 'success' });
      navigate({ group_id: result.group_id, limit: query.limit }, { force: true });
    } catch (error) {
      if (!controller.signal.aborted && !isAbortError(error)) showImportError(error, fields, formError);
    } finally {
      button.textContent = label;
      button.disabled = false;
    }
  }

  async function importDataset() {
    datasetGroup.clearError();
    hideFormError(datasetError);
    const groupId = datasetGroup.control.value.trim();
    if (!groupId) {
      datasetGroup.setError('Укажите ID группы.');
      datasetGroup.control.focus();
      return;
    }
    datasetBusy = true;
    try {
      await runImport(datasetButton, () => api.importDataset(groupId), { group_id: datasetGroup }, datasetError);
    } finally {
      datasetBusy = false;
      syncDatasetAvailability();
    }
  }

  async function importFile() {
    fileInput.clearError();
    fileGroup.clearError();
    hideFormError(fileError);
    const file = fileInput.control.files && fileInput.control.files[0];
    if (!file) {
      fileInput.setError('Выберите файл .json.');
      fileInput.control.focus();
      return;
    }
    const groupId = fileGroup.control.value.trim();
    await runImport(fileButton, () => api.importFile(file, groupId || null), { file: fileInput, group_id: fileGroup }, fileError);
  }

  function issueList(title, issues, tone) {
    const list = Array.isArray(issues) ? issues : [];
    if (list.length === 0) return h('p', { class: 'cqa-muted', text: `${title}: нет.` });
    return h(
      'details',
      { class: `cqa-issues cqa-issues--${tone}`, open: list.length <= 10 },
      h('summary', { text: `${title}: ${list.length}` }),
      h(
        'ul',
        {},
        list.map((issue) =>
          h(
            'li',
            {},
            h('span', { class: 'cqa-issue-where', text: describeIssueLocation(issue) || 'Набор целиком' }),
            ' — ',
            issue.message,
            ' ',
            h('code', { class: 'cqa-issue-code', text: issue.code }),
          ),
        ),
      ),
    );
  }

  function unknownPhrases(phrases) {
    const list = Array.isArray(phrases) ? phrases : [];
    if (list.length === 0) return h('p', { class: 'cqa-muted', text: 'Нераспознанных системных фраз: 0.' });
    const occurrences = list.reduce((sum, phrase) => sum + (Number(phrase.count) || 0), 0);
    return h(
      'details',
      { class: 'cqa-issues cqa-issues--warn' },
      h('summary', { text: `Нераспознанных системных фраз: ${list.length} (вхождений: ${occurrences}) — показать` }),
      h(
        'ul',
        {},
        list.map((phrase) => h('li', {}, h('span', { text: phrase.text }), h('span', { class: 'cqa-muted', text: ` × ${phrase.count}` }))),
      ),
    );
  }

  function renderReport(result) {
    const stats = [
      ['Получено', result.received],
      ['Новых', result.created],
      ['Без изменений', result.unchanged],
      ['Изменённых', result.revised],
      ['Пропущено', result.skipped],
    ];
    clear(report).append(
      h(
        'div',
        { class: 'cqa-report-head' },
        h('h3', { text: `Отчёт импорта: группа ${result.group_id}` }),
        h('span', { class: 'cqa-muted', text: formatDateTime(result.created_at) }),
        h('button', { type: 'button', class: 'cqa-button cqa-button--ghost', text: 'Скрыть отчёт', on: { click: () => {
          const hadFocus = report.contains(document.activeElement);
          setExpanded(report, false).then(() => {
            if (report.hidden && hadFocus && importToggle.isConnected && (report.contains(document.activeElement) || document.activeElement === document.body)) {
              importToggle.focus();
            }
          });
        } } }),
      ),
      h('dl', { class: 'cqa-stats' }, stats.map(([label, value]) => h('div', { class: 'cqa-stat' }, h('dt', { text: label }), h('dd', { text: String(value) })))),
      issueList('Ошибки', result.errors, 'bad'),
      issueList('Предупреждения', result.warnings, 'warn'),
      unknownPhrases(result.unknown_system_phrases),
    );
    setExpanded(report, true);
  }

  // ---------- Фильтры: действия ----------
  function navigate(next, { force = false } = {}) {
    const normalized = normalizeListQuery(next, state.pageSize);
    const hash = buildHash('conversations', [], listQueryToHash(normalized));
    if (hash === location.hash) {
      if (force) {
        query = normalized;
        syncInputs();
        load();
      }
      return;
    }
    location.hash = hash;
  }

  function applyFilter(key, value) {
    navigate({ ...query, [key]: value, offset: 0 });
  }

  const applyText = () => {
    applyTextDebounced.cancel();
    navigate({
      ...query,
      group_id: groupFilter.control.value,
      q: searchFilter.control.value,
      offset: 0,
    });
  };
  const applyTextDebounced = debounce(applyText, 400);

  function resetFilters() {
    groupFilter.control.value = '';
    searchFilter.control.value = '';
    navigate({ limit: query.limit });
  }

  groupFilter.control.addEventListener('input', applyTextDebounced);
  groupFilter.control.addEventListener('change', applyText);
  searchFilter.control.addEventListener('input', applyTextDebounced);
  languageFilter.control.addEventListener('change', () => applyFilter('language', languageFilter.control.value));
  channelFilter.control.addEventListener('change', () => applyFilter('channel', channelFilter.control.value));
  statusFilter.control.addEventListener('change', () => applyFilter('evaluation_status', statusFilter.control.value));
  grossFilter.control.addEventListener('change', () => applyFilter('has_gross_error', grossFilter.control.value));
  appealsFilter.control.addEventListener('change', () => applyFilter('has_open_appeals', appealsFilter.control.value));
  pageSizeFilter.control.addEventListener('change', () => {
    setPageSize(pageSizeFilter.control.value);
    applyFilter('limit', pageSizeFilter.control.value);
  });

  function syncInputs() {
    const setText = (input, value) => {
      if (document.activeElement !== input) input.value = value || '';
    };
    setText(groupFilter.control, query.group_id);
    setText(searchFilter.control, query.q);
    fillSelect(languageFilter.control, [['', 'Все'], ...[...seenLanguages].map((value) => [value, value])], query.language);
    fillSelect(channelFilter.control, [['', 'Все'], ...[...seenChannels].map((value) => [value, labelFor(CHANNEL_LABELS, value)])], query.channel);
    statusFilter.control.value = query.evaluation_status || '';
    grossFilter.control.value = query.has_gross_error || '';
    appealsFilter.control.value = query.has_open_appeals || '';
    const advancedCount = ['evaluation_status', 'has_gross_error', 'has_open_appeals'].filter(key => Boolean(query[key])).length;
    advancedSummary.textContent = advancedCount ? `Все фильтры (${advancedCount})` : 'Все фильтры';
    if (advancedCount > 0 && advancedOpen !== false) advancedFilters.open = true;
    pageSizeFilter.control.value = String(query.limit);
    resetButton.disabled = !hasActiveFilters(query);
    syncGroupEval();
    groupOptions.replaceChildren(
      ...[...new Set([...state.recentGroups, ...seenGroups])].map((group) => h('option', { value: group })),
    );
  }

  // ---------- Оценка всей группы: действия ----------
  function groupJobRunning() {
    const current = state.groupJob;
    return Boolean(current && !isTerminalJob(current.job));
  }

  function syncGroupEval() {
    const current = state.groupJob;
    const running = groupJobRunning();
    const groupId = query.group_id || '';
    clear(groupTitle);
    if (running) groupTitle.append('Идёт оценка группы ', h('strong', { text: current.groupId }));
    else if (groupId) groupTitle.append('Группа ', h('strong', { text: groupId }));
    else groupTitle.append('Оценка всей группы');
    if (running) {
      groupHint.textContent = 'Можно открывать разговоры: ход задания сохранится, таблица обновится по окончании.';
    } else if (!groupId) {
      groupHint.textContent = 'Выберите группу в фильтре «Группа» или импортируйте группу: кнопка оценит все её разговоры.';
    } else if (state.health && state.health.evaluation_ready === false) {
      groupHint.textContent = 'Сервер сообщает, что оценка сейчас недоступна. Нажмите «Оценить всю группу», чтобы увидеть причину.';
    } else {
      groupHint.textContent = 'Все текущие разговоры группы, по активному чек-листу. Фильтры ниже не влияют на оценку.';
    }
    groupButton.disabled = running || groupStarting || !groupId;
    groupButton.textContent = running || groupStarting ? 'Оценка группы…' : 'Оценить всю группу';
    groupDismiss.hidden = !(current && isTerminalJob(current.job));
  }

  async function evaluateGroup() {
    const groupId = query.group_id;
    if (controller.signal.aborted || !groupId || groupStarting || groupJobRunning()) return;
    groupStarting = true;
    groupError.hidden = true;
    syncGroupEval();
    let job;
    try {
      // POST не повторяется автоматически: повтор создал бы второе задание.
      job = await api.startEvaluation(buildGroupEvaluationRequest(groupId));
    } catch (error) {
      if (controller.signal.aborted) return;
      groupStarting = false;
      groupError.textContent = error.message;
      groupError.hidden = false;
      showError(error);
      syncGroupEval();
      return;
    }
    groupStarting = false;
    // Сохраняем ID для возврата к списку, даже если POST завершился после ухода.
    setGroupJob({ groupId, job, pollFailed: false });
    if (controller.signal.aborted) return;
    trackGroupJob();
  }

  async function trackGroupJob() {
    if (controller.signal.aborted) return;
    const current = state.groupJob;
    if (!current) return;
    current.pollFailed = false;
    groupError.hidden = true;
    groupProgress.update(current.job);
    if (current.job && current.job.is_demo === true) setViewDemo(true);
    syncGroupEval();
    if (isTerminalJob(current.job) || groupPoll) return;
    groupPoll = new AbortController();
    try {
      const finished = await pollJob({
        job: current.job,
        getJob: (id, signal) => api.getJob(id, { signal }),
        signal: groupPoll.signal,
        onUpdate: (update) => {
          if (controller.signal.aborted) return;
          current.job = update;
          groupProgress.update(update);
          if (update.is_demo === true) setViewDemo(true);
        },
      });
      if (controller.signal.aborted) return;
      current.job = finished;
      groupPoll = null;
      syncGroupEval();
      showToast(groupJobSummary(current.groupId, finished), { tone: finished.status === 'completed' ? 'success' : 'error', timeout: 10000 });
      load();
    } catch (error) {
      groupPoll = null;
      if (isAbortError(error) || controller.signal.aborted) return;
      // Задание на сервере продолжается: даём проверить его ход снова, а не запускать второе.
      current.pollFailed = true;
      clear(groupError).append(
        h('span', { text: `Не удалось узнать ход задания: ${error.message} ` }),
        h('button', { type: 'button', class: 'cqa-button cqa-button--small', text: 'Проверить снова', on: { click: trackGroupJob } }),
      );
      groupError.hidden = false;
      showError(error);
      syncGroupEval();
    }
  }

  function dismissGroupJob() {
    setGroupJob(null);
    groupProgress.hide();
    groupError.hidden = true;
    syncGroupEval();
  }

  // ---------- Таблица: загрузка и вывод ----------
  function totalCell(evaluation) {
    if (!evaluation) return h('span', { class: 'cqa-muted', text: DASH });
    const finalText = formatSummaryScore(evaluation.final_total, evaluation.scoring_policy);
    if (evaluation.original_total !== evaluation.final_total) {
      return [
        h('strong', { text: finalText }),
        h('div', { class: 'cqa-muted cqa-small', text: `исходно ${formatSummaryScore(evaluation.original_total, evaluation.scoring_policy)}` }),
      ];
    }
    return h('strong', { text: finalText });
  }

  function grossCell(evaluation) {
    if (!evaluation) return h('span', { class: 'cqa-muted', text: DASH });
    if (evaluation.gross_error === true) return badge('Да', 'bad');
    if (evaluation.gross_error === false) return h('span', { text: 'Нет' });
    return badge('Не определено', 'neutral', 'Хотя бы по одному флагу нет ответа');
  }

  function row(item) {
    const evaluation = item.latest_evaluation;
    const href = buildHash('conversation', [item.ref.id]);
    const status = evaluation ? evaluation.status : 'not_evaluated';
    const tr = h(
      'tr',
      {
        class: 'cqa-row-link', role: 'row',
        on: {
          click: (event) => {
            if (event.target.closest('a')) return;
            location.hash = href;
          },
        },
      },
      h(
        'td',
        {},
        h('a', { href, class: 'cqa-strong', text: item.ref.conversation_id }),
        item.ref.revision > 1 ? h('div', { class: 'cqa-muted cqa-small', text: `ревизия ${item.ref.revision}` }) : null,
      ),
      h('td', { text: item.ref.group_id }),
      h('td', {}, labelFor(CHANNEL_LABELS, item.channel), item.has_audio ? h('span', { class: 'cqa-tag cqa-tag--neutral cqa-tag--inline', text: 'есть запись' }) : null),
      h('td', { text: item.language }),
      h('td', { class: 'cqa-num', text: String(item.message_count) }),
      h('td', { class: 'cqa-num' }, totalCell(evaluation)),
      h('td', {}, badge(labelFor(EVALUATION_STATUS_LABELS, status), EVALUATION_STATUS_TONES[status] || 'neutral')),
      h('td', {}, grossCell(evaluation)),
      h('td', {}, item.has_open_appeals ? badge('Есть открытая', 'warn') : h('span', { class: 'cqa-muted', text: 'нет' })),
      h('td', {}, evaluation && evaluation.is_demo ? badge('Демо', 'demo') : h('span', { class: 'cqa-muted', text: DASH })),
    );
    [...tr.children].forEach((cell, index) => {
      cell.setAttribute('role', 'cell');
      cell.prepend(h('span', { class: 'cqa-mobile-label', 'aria-hidden': 'true', text: COLUMNS[index] }));
    });
    return tr;
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
    const current = Math.floor(page.offset / page.limit) + 1;
    pager.append(
      h('button', {
        type: 'button',
        class: 'cqa-button',
        text: 'Назад',
        disabled: page.offset <= 0,
        on: { click: () => navigate({ ...query, offset: Math.max(0, page.offset - page.limit) }) },
      }),
      h('span', { class: 'cqa-muted', text: `Страница ${current} из ${pages}` }),
      h('button', {
        type: 'button',
        class: 'cqa-button',
        text: 'Вперёд',
        disabled: page.offset + page.limit >= page.total,
        on: { click: () => navigate({ ...query, offset: page.offset + page.limit }) },
      }),
    );
  }

  function renderPage(page) {
    if (!autoCollapseChecked) {
      autoCollapseChecked = true;
      setImportBoxOpen(page.total === 0 && !hasActiveFilters(query));
    }
    for (const item of page.items) {
      seenLanguages.add(item.language);
      seenChannels.add(item.channel);
      seenGroups.add(item.ref.group_id);
      revisionLabels.set(item.ref.revision_id, item.ref.conversation_id);
    }
    syncInputs();
    setViewDemo(page.items.some((item) => item.latest_evaluation && item.latest_evaluation.is_demo === true)
      || Boolean(state.groupJob && state.groupJob.job && state.groupJob.job.is_demo === true));

    const range = pageRange(page);
    if (!range) {
      tableWrap.hidden = true;
      listEmpty.hidden = false;
      listStatus.textContent = '';
      if (page.total > 0) {
        listEmpty.replaceChildren(emptyState({
          title: 'На этой странице ничего нет.',
          hint: `Всего найдено: ${page.total}.`,
          action: h('button', { type: 'button', class: 'cqa-button', text: 'К первой странице', on: { click: () => navigate({ ...query, offset: 0 }) } }),
        }));
      } else if (hasActiveFilters(query)) {
        listEmpty.replaceChildren(emptyState({
          title: 'По этим фильтрам разговоров нет.',
          hint: 'Измените или сбросьте фильтры.',
          action: h('button', { type: 'button', class: 'cqa-button', text: 'Сбросить фильтры', on: { click: resetFilters } }),
        }));
      } else {
        listEmpty.replaceChildren(emptyState({
          title: 'Разговоров пока нет.',
          hint: 'Импортируйте набор: укажите ID группы или загрузите JSON-файл в панели «Импорт разговоров» выше.',
        }));
      }
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
    setLastListHash(buildHash('conversations', [], listQueryToHash(query)));
    listError.hidden = true;
    tableWrap.classList.add('is-loading');
    tableWrap.setAttribute('aria-busy', 'true');
    loading.hidden = Boolean(tableBody.childElementCount);
    listStatus.textContent = 'Загрузка…';
    try {
      const page = await api.listConversations(query, { signal: controller.signal });
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

  const unsubscribe = subscribe(() => {
    syncDatasetAvailability();
    syncGroupEval();
  });

  syncDatasetAvailability();
  syncInputs();
  load();
  // Вернулись к списку во время оценки группы — продолжаем показывать её ход (или итог).
  if (state.groupJob) trackGroupJob();

  return {
    update(nextRoute) {
      query = normalizeListQuery(nextRoute.query, state.pageSize);
      syncInputs();
      load();
      return true;
    },
    destroy() {
      controller.abort();
      // Задание на сервере продолжается; опрос возобновится при возврате к списку.
      if (groupPoll) groupPoll.abort();
      applyTextDebounced.cancel();
      unsubscribe();
    },
  };
}
