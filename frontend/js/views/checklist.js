// Редактор чек-листа: активная версия → черновик → живая проверка на сервере → новая версия, сразу применённая
// по галочке. Критерии не зашиты в код: всё, что видно на экране, приходит из версии сервера.
import { api } from '../api.js';
import { badge } from '../components/badge.js';
import { emptyState } from '../components/empty-state.js';
import { field } from '../components/field.js';
import { createJobProgress } from '../components/job-progress.js';
import { showError, showToast } from '../components/toast.js';
import { append, clear, debounce, h } from '../dom.js';
import {
  ANSWER_TYPES,
  ANSWER_TYPE_LABELS,
  autoNormalized,
  buildVersionRequest,
  changeAnswerType,
  describeChanges,
  localErrors,
  moveItem,
  newCriterion,
  replaceCriterion,
  summarizeChanges,
  toDefinition,
  toDraft,
  undoReplacement,
} from '../lib/checklist.js';
import { fieldErrors, isAbortError } from '../lib/errors.js';
import { formatDateTime, formatNumber } from '../lib/format.js';
import { describeJob, pollJob } from '../lib/poll.js';
import { buildHash } from '../lib/route.js';
import { refreshHealth, setViewDemo, state } from '../state.js';

const BOOLEAN_VALUE_LABELS = {
  binary: { true: 'Да', false: 'Нет' },
  flag: { true: 'Нарушение', false: 'Нет нарушения' },
};
const VALIDATE_DELAY = 500;

export function mount(container) {
  const controller = new AbortController();
  let checklist = null;
  let base = null;
  let versions = [];
  let draft = null;
  let expanded = new Set();
  let fields = new Map();
  let slots = new Map();
  let heads = new Map();
  let errors = {};
  let warnings = [];
  let validation = 'idle';
  let validationFailure = '';
  let validateController = null;
  let validateSeq = 0;
  let saving = false;
  let lastRemoved = null;
  let focusAfterRender = null;
  let pollController = null;

  setViewDemo(false);

  // ---------- Каркас ----------
  const lead = h('p', { class: 'cqa-page-lead' });
  const loadAlert = h('div', { class: 'cqa-alert cqa-alert--bad', role: 'alert', hidden: true });
  const nameField = field({ id: 'cqa-cl-name', label: 'Название чек-листа', control: h('input', { type: 'text', autocomplete: 'off' }) });
  const descriptionField = field({ id: 'cqa-cl-description', label: 'Описание', control: h('textarea', { rows: 3 }) });
  const generalErrors = h('ul', { class: 'cqa-form-error cqa-ed-general', role: 'alert', hidden: true });
  const warningsList = h('ul', { class: 'cqa-ed-warnings', hidden: true });
  const sectionsList = h('datalist', { id: 'cqa-ed-sections' });
  const criteriaCount = h('span', { class: 'cqa-muted' });
  const removedNotice = h('p', { class: 'cqa-ed-removed', role: 'status', hidden: true });
  const list = h('ol', { class: 'cqa-ed-list' });
  const versionsList = h('ol', { class: 'cqa-versions' });
  const savedBox = h('div', { class: 'cqa-alert cqa-saved', role: 'status', tabindex: '-1', hidden: true });

  const validationNode = h('p', { class: 'cqa-savebar-status', 'aria-live': 'polite' });
  const changesNode = h('p', { class: 'cqa-savebar-changes' });
  const formError = h('div', { class: 'cqa-form-error', role: 'alert', hidden: true });
  const activateBox = h('input', { type: 'checkbox', id: 'cqa-cl-activate', checked: true });
  const saveButton = h('button', { type: 'button', class: 'cqa-button cqa-button--primary', text: 'Сохранить новую версию', on: { click: save } });
  const resetButton = h('button', { type: 'button', class: 'cqa-button', text: 'Отменить изменения', on: { click: resetDraft } });
  const saveBar = h(
    'div',
    { class: 'cqa-savebar' },
    h('div', { class: 'cqa-savebar-info' }, validationNode, changesNode, formError),
    h('label', { class: 'cqa-check', for: 'cqa-cl-activate' }, activateBox, h('span', { text: 'Сразу применить' })),
    h('div', { class: 'cqa-actions' }, resetButton, saveButton),
  );

  const editor = h(
    'div',
    { class: 'cqa-ed-grid', hidden: true },
    h(
      'div',
      { class: 'cqa-ed-main' },
      h('section', { class: 'cqa-card', 'aria-labelledby': 'cqa-ed-meta-title' },
        h('h2', { id: 'cqa-ed-meta-title', text: 'Чек-лист' }),
        nameField.el,
        descriptionField.el),
      h(
        'section',
        { class: 'cqa-card', 'aria-labelledby': 'cqa-ed-criteria-title' },
        h('div', { class: 'cqa-card-head' },
          h('h2', { id: 'cqa-ed-criteria-title' }, 'Критерии ', criteriaCount),
          h('div', { class: 'cqa-actions' },
            h('button', { type: 'button', class: 'cqa-button cqa-button--ghost', text: 'Развернуть все', on: { click: () => setAllOpen(true) } }),
            h('button', { type: 'button', class: 'cqa-button cqa-button--ghost', text: 'Свернуть все', on: { click: () => setAllOpen(false) } }),
            h('button', { type: 'button', class: 'cqa-button', text: 'Добавить критерий', on: { click: addCriterion } }))),
        h('p', { class: 'cqa-field-hint', text: '«Заменить» ставит на место критерия новое правило с новым ID: старые оценки остаются по старому правилу, а сравнение покажет «удалён» и «добавлен».' }),
        removedNotice,
        generalErrors,
        list,
        sectionsList,
      ),
      warningsList,
      savedBox,
      saveBar,
    ),
    h('aside', { class: 'cqa-ed-aside' },
      h('section', { class: 'cqa-card', 'aria-labelledby': 'cqa-versions-title' },
        h('h2', { id: 'cqa-versions-title', text: 'Версии' }),
        h('p', { class: 'cqa-field-hint', text: 'Версии неизменяемы: сохранение создаёт новую. Оценки помнят свою версию.' }),
        versionsList)),
  );

  container.append(h(
    'section',
    { class: 'cqa-page cqa-editor' },
    h('div', { class: 'cqa-page-intro' }, h('h1', { text: 'Чек-лист' }), lead),
    loadAlert,
    editor,
  ));

  nameField.control.addEventListener('input', () => {
    draft.name = nameField.control.value;
    changed();
  });
  descriptionField.control.addEventListener('input', () => {
    draft.description = descriptionField.control.value;
    changed();
  });

  // ---------- Загрузка ----------
  async function load({ prefer = 'active' } = {}) {
    const { signal } = controller;
    loadAlert.hidden = true;
    editor.classList.add('is-loading');
    try {
      const health = await api.getHealth({ signal });
      let versionId = health.active_checklist_version_id;
      if (!versionId || prefer === 'latest') {
        let checklistId = null;
        if (versionId) {
          checklistId = (await api.getChecklistVersion(versionId, { signal })).checklist_id;
        } else {
          const page = await api.listChecklists({ limit: 1 }, { signal });
          if (!page.items.length) {
            renderNoChecklist();
            return;
          }
          checklistId = page.items[0].id;
        }
        versionId = (await api.getChecklist(checklistId, { signal })).latest_version_id;
      }
      // Версии не берутся из кеша: is_active вычисляется сервером и меняется при активации.
      const version = await api.getChecklistVersion(versionId, { signal });
      const [owner, page] = await Promise.all([
        api.getChecklist(version.checklist_id, { signal }),
        api.listChecklistVersions(version.checklist_id, { limit: 100 }, { signal }),
      ]);
      checklist = owner;
      versions = page.items;
      base = version;
      draft = toDraft(version.definition);
      expanded = new Set();
      errors = {};
      warnings = [];
      validation = 'valid';
      lastRemoved = null;
      renderAll();
    } catch (error) {
      if (isAbortError(error)) return;
      clear(loadAlert).append(
        h('p', { text: error.message }),
        h('div', { class: 'cqa-actions' }, h('button', { type: 'button', class: 'cqa-button', text: 'Повторить', on: { click: () => load({ prefer }) } })),
      );
      loadAlert.hidden = false;
      showError(error);
    } finally {
      editor.classList.remove('is-loading');
    }
  }

  function renderNoChecklist() {
    editor.hidden = true;
    lead.textContent = '';
    clear(loadAlert).append(emptyState({
      title: 'Чек-листов на сервере нет.',
      hint: 'Сервер создаёт исходный чек-лист при первом запуске. Проверьте, что бэкенд запущен с исходными данными.',
    }));
    loadAlert.className = '';
    loadAlert.hidden = false;
  }

  // ---------- Вывод ----------
  function renderAll() {
    editor.hidden = false;
    renderLead();
    nameField.control.value = draft.name;
    descriptionField.control.value = draft.description;
    renderCriteria();
    renderVersions();
    applyErrors(errors, warnings);
    updateSaveBar();
  }

  function renderLead() {
    const active = base.is_active ? 'активна' : 'не активна';
    lead.textContent = `В редакторе версия v${base.version} от ${formatDateTime(base.created_at)}, ${active}. Сохранение создаёт новую версию; галочка «Сразу применить» делает её активной для новых оценок.`;
  }

  function renderVersions() {
    clear(versionsList).append(...versions.map((version) => h(
      'li',
      { class: `cqa-version${version.id === base.id ? ' is-current' : ''}` },
      h('span', { class: 'cqa-version-number', text: `v${version.version}` }),
      h('span', { class: 'cqa-version-meta' },
        h('span', { text: formatDateTime(version.created_at) }),
        h('span', { class: 'cqa-muted', text: `критериев: ${version.definition.criteria.length}` })),
      h('span', { class: 'cqa-version-tags' },
        version.is_active ? badge('активна', 'good') : null,
        version.id === base.id ? badge('в редакторе', 'info') : null),
    )));
  }

  function baseIds() {
    return base ? base.definition.criteria.map((criterion) => criterion.id) : [];
  }

  function updateSections() {
    const sections = [...new Set(draft.criteria.map((criterion) => criterion.section).filter(Boolean))];
    sectionsList.replaceChildren(...sections.map((section) => h('option', { value: section })));
  }

  function renderCriteria() {
    fields = new Map([['name', nameField], ['description', descriptionField]]);
    slots = new Map();
    heads = new Map();
    criteriaCount.textContent = `(${draft.criteria.length})`;
    updateSections();
    list.replaceChildren(...draft.criteria.map((criterion, index) => criterionItem(criterion, index)));
    renderRemovedNotice();
    if (focusAfterRender) {
      const target = document.getElementById(focusAfterRender);
      focusAfterRender = null;
      if (target) {
        target.focus();
        if (typeof target.select === 'function' && target.tagName === 'INPUT') target.select();
      }
    }
  }

  function renderRemovedNotice() {
    if (!lastRemoved) {
      removedNotice.hidden = true;
      return;
    }
    clear(removedNotice).append(
      `Критерий «${lastRemoved.criterion.name || lastRemoved.criterion.id}» удалён из черновика. `,
      h('button', { type: 'button', class: 'cqa-button cqa-button--ghost cqa-button--small', text: 'Вернуть', on: { click: restoreRemoved } }),
    );
    removedNotice.hidden = false;
  }

  function headMeta(criterion) {
    const parts = [h('code', { class: 'cqa-ed-id', text: criterion.id || 'без ID' }), h('span', { text: ANSWER_TYPE_LABELS[criterion.answer_type] || criterion.answer_type })];
    if (criterion.answer_type !== 'flag') parts.push(h('span', { text: `вес ${criterion.weight || '—'}` }));
    if (criterion.section) parts.push(h('span', { text: criterion.section }));
    if (criterion.na_allowed) parts.push(h('span', { text: 'N/A разрешён' }));
    return parts;
  }

  function updateHead(criterion) {
    const head = heads.get(criterion.key);
    if (!head) return;
    head.name.textContent = criterion.name || 'Без названия';
    clear(head.meta).append(...headMeta(criterion));
  }

  function criterionTags(criterion) {
    const tags = [];
    if (criterion.replaces) tags.push(badge(`заменяет ${criterion.replaces}`, 'warn'));
    else if (!criterion.existing) tags.push(badge('новый', 'info'));
    return tags;
  }

  function iconButton(symbol, label, disabled, onClick) {
    return h('button', { type: 'button', class: 'cqa-icon-button', 'aria-label': label, title: label, disabled, text: symbol, on: { click: onClick } });
  }

  function criterionItem(criterion, index) {
    const open = expanded.has(criterion.key);
    const bodyId = `cqa-ed-${criterion.key}-body`;
    const name = h('span', { class: 'cqa-ed-name' });
    const meta = h('span', { class: 'cqa-ed-meta' });
    const errorTag = h('span', { class: 'cqa-badge cqa-badge--bad', text: 'есть ошибки', hidden: true });
    heads.set(criterion.key, { name, meta, errorTag });
    const label = criterion.name || criterion.id || `критерий ${index + 1}`;
    const toggle = h(
      'button',
      { type: 'button', class: 'cqa-ed-toggle', id: `cqa-ed-${criterion.key}-toggle`, 'aria-expanded': String(open), 'aria-controls': bodyId, on: { click: () => setOpen(criterion.key, !expanded.has(criterion.key)) } },
      h('span', { class: 'cqa-ed-caret', 'aria-hidden': 'true' }),
      h('span', { class: 'cqa-ed-title' }, name, meta),
    );
    let swap;
    if (criterion.replaces) {
      swap = h('button', { type: 'button', class: 'cqa-button cqa-button--small', text: 'Отменить замену', on: { click: () => undoReplace(index) } });
    } else if (criterion.existing) {
      swap = h('button', { type: 'button', class: 'cqa-button cqa-button--small cqa-button--replace', id: `cqa-ed-${criterion.key}-replace`, text: 'Заменить', title: 'Поставить на это место новое правило с новым ID', on: { click: () => replace(index) } });
    }
    const item = h(
      'li',
      { class: `cqa-ed-item${open ? ' is-open' : ''}${criterion.replaces ? ' is-replacement' : ''}${!criterion.existing && !criterion.replaces ? ' is-new' : ''}`, dataset: { key: criterion.key } },
      h(
        'div',
        { class: 'cqa-ed-head' },
        h('span', { class: 'cqa-ed-num', text: String(index + 1) }),
        toggle,
        h('span', { class: 'cqa-ed-tags' }, criterionTags(criterion), errorTag),
        h('div', { class: 'cqa-ed-actions' },
          iconButton('↑', `Переместить «${label}» выше`, index === 0, () => move(index, -1)),
          iconButton('↓', `Переместить «${label}» ниже`, index === draft.criteria.length - 1, () => move(index, 1)),
          swap || null,
          h('button', { type: 'button', class: 'cqa-button cqa-button--small cqa-button--quiet-danger', text: 'Удалить', on: { click: () => removeCriterion(index) } })),
      ),
      criterionBody(criterion, index, bodyId, open),
    );
    updateHead(criterion);
    return item;
  }

  function register(path, fieldObject) {
    fields.set(path, fieldObject);
    return fieldObject.el;
  }

  function criterionBody(criterion, index, bodyId, open) {
    const path = `criteria.${index}`;
    const prefix = `cqa-ed-${criterion.key}`;

    const idInput = h('input', { type: 'text', value: criterion.id, readonly: criterion.existing, spellcheck: 'false', autocomplete: 'off' });
    let idHint = 'ID существующего правила не меняется.';
    if (criterion.replaces) idHint = `Новый ID для нового правила, например ${criterion.replaces.replace(/_v\d+$/, '')}_v2. Можно изменить.`;
    else if (!criterion.existing) idHint = 'Новый ID для нового правила: латиница, цифры, «_» или «-».';
    const idField = field({ id: `${prefix}-id`, label: 'ID', control: idInput, hint: idHint });
    idInput.addEventListener('input', () => {
      criterion.id = idInput.value;
      updateHead(criterion);
      changed();
    });

    const nameInput = field({ id: `${prefix}-name`, label: 'Название', control: h('input', { type: 'text', value: criterion.name, autocomplete: 'off' }) });
    nameInput.control.addEventListener('input', () => {
      criterion.name = nameInput.control.value;
      updateHead(criterion);
      changed();
    });

    const sectionInput = field({
      id: `${prefix}-section`,
      label: 'Секция',
      control: h('input', { type: 'text', value: criterion.section, list: 'cqa-ed-sections', autocomplete: 'off' }),
      hint: 'Пустая секция — общая.',
    });
    sectionInput.control.addEventListener('input', () => {
      criterion.section = sectionInput.control.value;
      updateHead(criterion);
      changed();
    });
    sectionInput.control.addEventListener('change', updateSections);

    const typeSelect = h('select', {}, ANSWER_TYPES.map((type) => h('option', { value: type, text: ANSWER_TYPE_LABELS[type], selected: type === criterion.answer_type })));
    const typeField = field({ id: `${prefix}-type`, label: 'Тип ответа', control: typeSelect });
    typeSelect.addEventListener('change', () => {
      draft.criteria[index] = changeAnswerType(criterion, typeSelect.value);
      focusAfterRender = `${prefix}-type`;
      structuralChange();
    });

    const weightField = field({
      id: `${prefix}-weight`,
      label: 'Вес',
      control: h('input', { type: 'number', value: criterion.weight, min: '0', step: 'any', inputmode: 'decimal' }),
      hint: 'Положительное число; итог считает сервер.',
    });
    weightField.el.hidden = criterion.answer_type === 'flag';
    weightField.control.addEventListener('input', () => {
      criterion.weight = weightField.control.value;
      updateHead(criterion);
      changed();
    });

    const descriptionInput = field({ id: `${prefix}-description`, label: 'Описание правила', control: h('textarea', { rows: 3, value: criterion.description }) });
    descriptionInput.control.value = criterion.description;
    descriptionInput.control.addEventListener('input', () => {
      criterion.description = descriptionInput.control.value;
      changed();
    });

    const naCondition = field({
      id: `${prefix}-na`,
      label: 'Условие N/A',
      control: h('textarea', { rows: 2 }),
      hint: 'Когда критерий неприменим к разговору. Без условия N/A не разрешён.',
    });
    naCondition.control.value = criterion.na_condition;
    naCondition.el.hidden = !criterion.na_allowed;
    naCondition.control.addEventListener('input', () => {
      criterion.na_condition = naCondition.control.value;
      changed();
    });
    const naBox = h('input', { type: 'checkbox', id: `${prefix}-na-allowed`, checked: criterion.na_allowed });
    naBox.addEventListener('change', () => {
      criterion.na_allowed = naBox.checked;
      naCondition.el.hidden = !naBox.checked;
      updateHead(criterion);
      changed();
    });

    const criterionError = h('div', { class: 'cqa-field-error', hidden: true });
    slots.set(path, criterionError);

    return h(
      'div',
      { class: 'cqa-ed-body', id: bodyId, hidden: !open },
      h('div', { class: 'cqa-ed-fields' },
        register(`${path}.id`, idField),
        register(`${path}.name`, nameInput),
        register(`${path}.section`, sectionInput),
        register(`${path}.answer_type`, typeField),
        register(`${path}.weight`, weightField)),
      register(`${path}.description`, descriptionInput),
      h('div', { class: 'cqa-ed-na' },
        h('label', { class: 'cqa-check', for: `${prefix}-na-allowed` }, naBox, h('span', { text: 'Разрешить N/A' })),
        register(`${path}.na_condition`, naCondition)),
      optionsEditor(criterion, index),
      criterionError,
    );
  }

  function optionsEditor(criterion, index) {
    const path = `criteria.${index}.options`;
    const prefix = `cqa-ed-${criterion.key}-opt`;
    const optionsError = h('div', { class: 'cqa-field-error', hidden: true });
    slots.set(path, optionsError);
    const isScale = criterion.answer_type === 'scale';
    const normalizedInputs = [];

    function syncAutoHints() {
      for (const { input, option } of normalizedInputs) {
        const auto = autoNormalized(criterion.options, option);
        input.placeholder = auto === null ? 'авто' : `авто: ${formatNumber(auto, 2)}`;
      }
    }

    const rows = criterion.options.map((option, optionIndex) => {
      const optionPath = `${path}.${optionIndex}`;
      const id = `${prefix}-${optionIndex}`;
      const cells = [];
      if (isScale) {
        const value = field({ id: `${id}-value`, label: 'Значение', control: h('input', { type: 'number', value: option.value, step: 'any', inputmode: 'decimal' }) });
        value.control.addEventListener('input', () => {
          option.value = value.control.value;
          syncAutoHints();
          changed();
        });
        cells.push(register(`${optionPath}.value`, value));
      } else {
        cells.push(h('div', { class: 'cqa-ed-option-value' },
          h('span', { class: 'cqa-ed-option-answer', text: BOOLEAN_VALUE_LABELS[criterion.answer_type][String(option.value)] }),
          h('code', { text: String(option.value) })));
      }
      const label = field({ id: `${id}-label`, label: 'Подпись', control: h('input', { type: 'text', value: option.label, autocomplete: 'off' }) });
      label.control.addEventListener('input', () => {
        option.label = label.control.value;
        changed();
      });
      const description = field({ id: `${id}-description`, label: 'Когда выбирать', control: h('input', { type: 'text', value: option.description, autocomplete: 'off' }) });
      description.control.addEventListener('input', () => {
        option.description = description.control.value;
        changed();
      });
      cells.push(register(`${optionPath}.label`, label), register(`${optionPath}.description`, description));
      if (isScale) {
        const normalized = field({ id: `${id}-normalized`, label: 'Доля балла', control: h('input', { type: 'number', value: option.normalized, min: '0', max: '1', step: 'any', inputmode: 'decimal' }) });
        normalizedInputs.push({ input: normalized.control, option });
        normalized.control.addEventListener('input', () => {
          option.normalized = normalized.control.value;
          changed();
        });
        cells.push(register(`${optionPath}.normalized`, normalized));
        cells.push(h('button', {
          type: 'button',
          class: 'cqa-icon-button cqa-ed-option-remove',
          'aria-label': `Удалить ступень ${option.label || optionIndex + 1}`,
          title: 'Удалить ступень',
          disabled: criterion.options.length <= 1,
          text: '×',
          on: {
            click: () => {
              criterion.options.splice(optionIndex, 1);
              focusAfterRender = `${prefix}-add`;
              structuralChange();
            },
          },
        }));
      }
      return h('li', { class: `cqa-ed-option${isScale ? ' cqa-ed-option--scale' : ''}` }, cells);
    });
    syncAutoHints();

    return h(
      'fieldset',
      { class: 'cqa-fieldset cqa-ed-options' },
      h('legend', { text: isScale ? 'Ступени шкалы' : 'Варианты ответа' }),
      isScale ? h('p', { class: 'cqa-field-hint', text: 'Доля балла от 0 до 1; пусто — сервер подставит «значение / максимум».' }) : null,
      h('ol', { class: 'cqa-ed-option-list' }, rows),
      isScale
        ? h('button', {
          type: 'button',
          class: 'cqa-button cqa-button--small',
          id: `${prefix}-add`,
          text: 'Добавить ступень',
          on: {
            click: () => {
              criterion.options.push({ value: '', label: '', description: '', normalized: '' });
              focusAfterRender = `${prefix}-${criterion.options.length - 1}-value`;
              structuralChange();
            },
          },
        })
        : null,
      optionsError,
    );
  }

  // ---------- Действия с критериями ----------
  function setOpen(key, open) {
    if (open) expanded.add(key);
    else expanded.delete(key);
    const item = [...list.children].find((node) => node.dataset.key === key);
    if (!item) return;
    item.classList.toggle('is-open', open);
    item.querySelector('.cqa-ed-toggle').setAttribute('aria-expanded', String(open));
    item.querySelector('.cqa-ed-body').hidden = !open;
  }

  function setAllOpen(open) {
    for (const criterion of draft.criteria) setOpen(criterion.key, open);
  }

  function move(index, delta) {
    const { key } = draft.criteria[index];
    draft.criteria = moveItem(draft.criteria, index, delta);
    structuralChange();
    // Фокус остаётся на той же стрелке, если двигать дальше ещё можно.
    const item = [...list.children].find((node) => node.dataset.key === key);
    if (item) {
      const buttons = item.querySelectorAll('.cqa-ed-actions .cqa-icon-button');
      const target = delta < 0 ? buttons[0] : buttons[1];
      (target && !target.disabled ? target : item.querySelector('.cqa-ed-toggle')).focus();
    }
  }

  function takenIds() {
    const ids = new Set(baseIds());
    for (const version of versions) for (const criterion of version.definition.criteria) ids.add(criterion.id);
    for (const criterion of draft.criteria) ids.add(String(criterion.id).trim());
    return [...ids];
  }

  function replace(index) {
    const replacement = replaceCriterion(draft.criteria[index], takenIds());
    draft.criteria[index] = replacement;
    expanded.add(replacement.key);
    focusAfterRender = `cqa-ed-${replacement.key}-id`;
    structuralChange();
    const item = [...list.children].find((node) => node.dataset.key === replacement.key);
    if (item) item.scrollIntoView({ block: 'nearest' });
  }

  function undoReplace(index) {
    const original = undoReplacement(draft.criteria[index]);
    draft.criteria[index] = original;
    expanded.add(original.key);
    focusAfterRender = `cqa-ed-${original.key}-replace`;
    structuralChange();
  }

  function removeCriterion(index) {
    const [criterion] = draft.criteria.splice(index, 1);
    lastRemoved = { criterion, index };
    structuralChange();
    const button = removedNotice.querySelector('button');
    if (button) button.focus();
  }

  function restoreRemoved() {
    if (!lastRemoved) return;
    const { criterion, index } = lastRemoved;
    draft.criteria.splice(Math.min(index, draft.criteria.length), 0, criterion);
    lastRemoved = null;
    focusAfterRender = `cqa-ed-${criterion.key}-toggle`;
    structuralChange();
  }

  function addCriterion() {
    const last = draft.criteria[draft.criteria.length - 1];
    const criterion = newCriterion({ section: last ? last.section : '' });
    draft.criteria.push(criterion);
    expanded.add(criterion.key);
    focusAfterRender = `cqa-ed-${criterion.key}-id`;
    structuralChange();
    const item = list.lastElementChild;
    if (item) item.scrollIntoView({ block: 'nearest' });
  }

  function resetDraft() {
    draft = toDraft(base.definition);
    expanded = new Set();
    errors = {};
    warnings = [];
    lastRemoved = null;
    formError.hidden = true;
    validation = 'valid';
    renderAll();
  }

  // ---------- Проверка ----------
  const validateLater = debounce(() => validateNow(), VALIDATE_DELAY);

  function changed() {
    formError.hidden = true;
    validation = 'pending';
    validateLater();
    updateSaveBar();
  }

  // После перемещения, удаления или смены типа индексы в путях ошибок другие: проверяем сразу.
  function structuralChange() {
    errors = {};
    renderCriteria();
    applyErrors(errors, warnings);
    formError.hidden = true;
    validateLater.cancel();
    validateNow();
  }

  async function validateNow() {
    const seq = ++validateSeq;
    if (validateController) validateController.abort();
    validateController = new AbortController();
    validation = 'pending';
    updateSaveBar();
    const local = localErrors(draft, baseIds());
    try {
      const report = await api.validateChecklist(toDefinition(draft), { signal: validateController.signal });
      if (seq !== validateSeq) return;
      applyErrors({ ...fieldErrors(report.errors), ...local }, report.warnings);
      validation = report.valid && !Object.keys(local).length ? 'valid' : 'invalid';
    } catch (error) {
      if (isAbortError(error) || seq !== validateSeq) return;
      if (error.status === 422) {
        applyErrors({ ...fieldErrors(error.details), ...local }, []);
        validation = 'invalid';
      } else {
        validation = 'failed';
        validationFailure = error.message;
      }
    }
    updateSaveBar();
  }

  function slotFor(key) {
    if (slots.has(key)) return slots.get(key);
    const match = /^(criteria\.\d+)(?:\.options)?/.exec(key);
    if (match && key.startsWith(`${match[1]}.options`) && slots.has(`${match[1]}.options`)) return slots.get(`${match[1]}.options`);
    if (match && slots.has(match[1])) return slots.get(match[1]);
    return null;
  }

  function applyErrors(next, nextWarnings) {
    errors = next;
    warnings = Array.isArray(nextWarnings) ? nextWarnings : [];
    for (const fieldObject of fields.values()) fieldObject.clearError();
    for (const node of slots.values()) {
      node.textContent = '';
      node.hidden = true;
    }
    for (const head of heads.values()) head.errorTag.hidden = true;
    const general = [];
    for (const [key, message] of Object.entries(errors)) {
      const target = fields.get(key);
      const match = /^criteria\.(\d+)/.exec(key);
      if (match) {
        const criterion = draft.criteria[Number(match[1])];
        const head = criterion ? heads.get(criterion.key) : null;
        if (head) head.errorTag.hidden = false;
      }
      if (target) {
        target.setError(message);
        continue;
      }
      const slot = slotFor(key);
      if (slot) {
        slot.textContent = slot.textContent ? `${slot.textContent} ${message}` : message;
        slot.hidden = false;
      } else {
        general.push(message);
      }
    }
    generalErrors.replaceChildren(...general.map((message) => h('li', { text: message })));
    generalErrors.hidden = general.length === 0;
    warningsList.replaceChildren(...warnings.map((warning) => h('li', { text: warning.message || String(warning) })));
    warningsList.hidden = warnings.length === 0;
  }

  // Ошибки свёрнутых критериев: раскрыть их и поставить фокус на первое поле с ошибкой.
  function revealErrors() {
    for (const key of Object.keys(errors)) {
      const match = /^criteria\.(\d+)/.exec(key);
      const criterion = match ? draft.criteria[Number(match[1])] : null;
      if (criterion) setOpen(criterion.key, true);
    }
    const first = editor.querySelector('[aria-invalid="true"]') || editor.querySelector('.cqa-ed-body .cqa-field-error:not([hidden])');
    if (first) {
      first.scrollIntoView({ block: 'center' });
      if (typeof first.focus === 'function') first.focus({ preventScroll: true });
    }
  }

  function updateSaveBar() {
    if (!draft || !base) return;
    const summary = summarizeChanges(base.definition, draft);
    changesNode.textContent = describeChanges(summary);
    const count = Object.keys(errors).length;
    let text = '';
    let tone = 'neutral';
    if (validation === 'pending') text = 'Проверка правил на сервере…';
    else if (validation === 'valid') {
      text = 'Сервер проверил правила: ошибок нет.';
      tone = 'good';
    } else if (validation === 'invalid') {
      text = `Ошибок: ${count}. Исправьте их — они отмечены у полей.`;
      tone = 'bad';
    } else if (validation === 'failed') {
      text = `Проверка недоступна: ${validationFailure}`;
      tone = 'warn';
    }
    if (warnings.length && validation !== 'pending') text += ` Предупреждений: ${warnings.length}.`;
    validationNode.textContent = text;
    validationNode.dataset.tone = tone;
    saveButton.disabled = saving || !summary.any || validation === 'invalid';
    resetButton.disabled = saving || !summary.any;
    activateBox.disabled = saving;
    saveButton.textContent = saving ? 'Сохранение…' : 'Сохранить новую версию';
  }

  // ---------- Сохранение ----------
  async function save() {
    if (saving || !draft) return;
    const local = localErrors(draft, baseIds());
    if (Object.keys(local).length) {
      applyErrors({ ...errors, ...local }, warnings);
      validation = 'invalid';
      updateSaveBar();
      revealErrors();
      return;
    }
    saving = true;
    formError.hidden = true;
    savedBox.hidden = true;
    validateLater.cancel();
    validateSeq += 1;
    if (validateController) validateController.abort();
    updateSaveBar();
    const activate = activateBox.checked;
    try {
      // Ожидаемая активная версия — из свежего health, в том числе null.
      const health = await api.getHealth({ signal: controller.signal });
      const body = buildVersionRequest(toDefinition(draft), {
        latestVersionId: checklist.latest_version_id,
        activate,
        activeVersionId: health.active_checklist_version_id,
      });
      const created = await api.createChecklistVersion(checklist.id, body);
      await refreshHealth();
      saving = false;
      await load({ prefer: activate ? 'active' : 'latest' });
      showSaved(created, activate);
      showToast(activate ? `Версия v${created.version} сохранена и применена.` : `Версия v${created.version} сохранена без применения.`, { tone: 'success' });
    } catch (error) {
      saving = false;
      if (isAbortError(error)) return;
      if (error.code === 'VERSION_CONFLICT') {
        showToast('Чек-лист изменился, загружена последняя версия.', { tone: 'error', timeout: 10000 });
        await load({ prefer: 'latest' });
        formError.textContent = 'Чек-лист изменился, загружена последняя версия. Повторите правку и сохраните снова.';
        formError.hidden = false;
      } else {
        const byField = fieldErrors(error.details);
        if (Object.keys(byField).length) {
          applyErrors(byField, warnings);
          validation = 'invalid';
          revealErrors();
        }
        formError.textContent = error.message;
        formError.hidden = false;
        showError(error);
      }
    } finally {
      saving = false;
      updateSaveBar();
    }
  }

  // ---------- После сохранения: переоценка и сравнение ----------
  function showSaved(created, activated) {
    clear(savedBox);
    savedBox.className = `cqa-alert cqa-saved ${activated ? 'cqa-saved--applied' : ''}`;
    savedBox.append(
      h('p', { class: 'cqa-alert-title', text: activated ? `Версия v${created.version} сохранена и применена` : `Версия v${created.version} сохранена, но не применена` }),
      h('p', { text: activated
        ? 'Новые оценки пойдут по этой версии. Прошлые оценки не меняются: чтобы увидеть влияние правки, переоцените разговор и сравните с прошлой оценкой.'
        : 'Новые оценки по-прежнему идут по активной версии. Чтобы применить эту, сохраните её с галочкой «Сразу применить».' }),
    );
    const conversation = state.lastConversation;
    if (activated && conversation) {
      savedBox.append(reevaluationBlock(conversation, created));
    } else if (activated) {
      savedBox.append(h(
        'p',
        {},
        'Разговор ещё не открывали. ',
        h('a', { href: state.lastListHash || '#/conversations', text: 'Откройте разговор из списка' }),
        ' и нажмите «Оценить», затем «Сравнить с текущей» у прошлой оценки.',
      ));
    }
    savedBox.hidden = false;
    savedBox.focus({ preventScroll: true });
    savedBox.scrollIntoView({ block: 'nearest' });
  }

  function reevaluationBlock(conversation, created) {
    const progress = createJobProgress();
    const error = h('div', { class: 'cqa-form-error', role: 'alert', hidden: true });
    const result = h('p', { class: 'cqa-saved-result', hidden: true });
    let comparison = null;
    const compareButton = h('button', {
      type: 'button',
      class: 'cqa-button',
      text: 'Сравнить с прошлой оценкой',
      disabled: true,
      title: 'Станет доступно после переоценки',
      on: {
        click: () => {
          if (comparison) location.hash = buildHash('compare', [], comparison);
        },
      },
    });
    const reevaluateButton = h('button', { type: 'button', class: 'cqa-button cqa-button--primary', text: 'Переоценить разговор' });

    reevaluateButton.addEventListener('click', async () => {
      if (pollController) return;
      reevaluateButton.disabled = true;
      error.hidden = true;
      pollController = new AbortController();
      const { signal } = pollController;
      try {
        // Прошлая оценка той же ревизии — левая сторона сравнения (сравнивать можно только одну ревизию).
        const previous = await api.listEvaluations({ conversation_id: conversation.id, revision_id: conversation.revisionId, limit: 1 }, { signal });
        const previousId = previous.items.length ? previous.items[0].id : null;
        const job = await api.startEvaluation({ revision_ids: [conversation.revisionId], checklist_version_id: created.id });
        progress.update(job);
        const finished = await pollJob({ job, getJob: (id, jobSignal) => api.getJob(id, { signal: jobSignal }), signal, onUpdate: progress.update });
        const summary = describeJob(finished);
        const evaluationId = summary.evaluationIds[0];
        if (!evaluationId) throw new Error((summary.itemErrors[0] && summary.itemErrors[0].message) || summary.jobError || 'Оценка не выполнена.');
        clear(result).append(
          'Новая оценка готова. ',
          h('a', { href: buildHash('conversation', [conversation.id], { evaluation: evaluationId }), text: 'Открыть в карточке разговора' }),
          previousId ? '' : '. У этой ревизии не было прошлой оценки, сравнивать не с чем.',
        );
        result.hidden = false;
        if (previousId) {
          comparison = { left: previousId, right: evaluationId };
          compareButton.disabled = false;
          compareButton.title = 'Слева прошлая оценка, справа новая';
          compareButton.focus();
        }
        showToast('Разговор переоценён по новой версии.', { tone: 'success' });
      } catch (failure) {
        if (isAbortError(failure)) return;
        error.textContent = failure.message;
        error.hidden = false;
        reevaluateButton.disabled = false;
        if (failure.code) showError(failure);
      } finally {
        pollController = null;
      }
    });

    return h(
      'div',
      { class: 'cqa-saved-next' },
      h('p', { class: 'cqa-field-hint' }, 'Разговор: ', h('strong', { text: conversation.externalId }), ` (последний открытый), оценка по v${created.version}.`),
      h('div', { class: 'cqa-actions' }, reevaluateButton, compareButton),
      progress.el,
      result,
      error,
    );
  }

  load();

  return {
    destroy() {
      controller.abort();
      validateLater.cancel();
      if (validateController) validateController.abort();
      if (pollController) pollController.abort();
    },
  };
}
