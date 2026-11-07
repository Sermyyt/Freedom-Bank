// Редактор чек-листа: черновик из версии сервера, обратное преобразование в ChecklistDefinition,
// замена критерия новым правилом в том же слоте, сводка изменений, тело запроса новой версии.
// Правила проверяет сервер (/checklists/validate); здесь только то, что нужно форме.

export const ANSWER_TYPES = ['binary', 'scale', 'flag'];
export const ANSWER_TYPE_LABELS = { binary: 'Да / Нет', scale: 'Шкала', flag: 'Флаг нарушения' };
export const NEW_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

let keySequence = 0;
const nextKey = () => `k${++keySequence}`;

const text = (value) => (value === null || value === undefined ? '' : String(value));

// Числа в форме хранятся строками (как в полях ввода); '' и мусор → null, запятая допустима.
export function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const raw = text(value).trim().replace(',', '.');
  if (!raw) return null;
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
}

function optionDraft(option) {
  return {
    value: typeof option.value === 'boolean' ? option.value : text(option.value),
    label: text(option.label),
    description: text(option.description),
    normalized: option.normalized === null || option.normalized === undefined ? '' : String(option.normalized),
  };
}

export function criterionDraft(criterion, { existing = true } = {}) {
  return {
    key: nextKey(),
    existing,
    replaces: null,
    replaced: null,
    id: text(criterion.id),
    name: text(criterion.name),
    description: text(criterion.description),
    section: text(criterion.section),
    answer_type: criterion.answer_type,
    weight: criterion.weight === null || criterion.weight === undefined ? '' : String(criterion.weight),
    options: (Array.isArray(criterion.options) ? criterion.options : []).map(optionDraft),
    na_allowed: criterion.na_allowed === true,
    na_condition: text(criterion.na_condition),
  };
}

export function toDraft(definition) {
  return {
    name: text(definition && definition.name),
    description: text(definition && definition.description),
    criteria: (definition && Array.isArray(definition.criteria) ? definition.criteria : []).map((criterion) => criterionDraft(criterion)),
  };
}

// Ровно поля AnswerOption/Criterion из контракта, в одном порядке — чтобы сравнивать с версией сервера.
function optionDefinition(option, type) {
  if (type === 'scale') {
    return { value: parseNumber(option.value), label: option.label, description: option.description, normalized: parseNumber(option.normalized) };
  }
  const value = option.value === true;
  return { value, label: option.label, description: option.description, normalized: type === 'flag' ? null : (value ? 1 : 0) };
}

export function criterionDefinition(criterion) {
  const type = criterion.answer_type;
  const naCondition = text(criterion.na_condition);
  return {
    id: text(criterion.id).trim(),
    name: criterion.name,
    description: criterion.description,
    section: criterion.section,
    answer_type: type,
    weight: type === 'flag' ? null : parseNumber(criterion.weight),
    options: criterion.options.map((option) => optionDefinition(option, type)),
    na_allowed: criterion.na_allowed === true,
    na_condition: naCondition.trim() ? naCondition : null,
  };
}

export function toDefinition(draft) {
  return { name: draft.name, description: draft.description, criteria: draft.criteria.map(criterionDefinition) };
}

// Критерий версии сервера в том же виде, что criterionDefinition(черновик).
function canonicalCriterion(criterion) {
  return criterionDefinition(criterionDraft(criterion));
}

// ---------- Тип ответа ----------

const BOOLEAN_DEFAULTS = {
  binary: [{ value: true, label: 'Да' }, { value: false, label: 'Нет' }],
  flag: [{ value: true, label: 'Да' }, { value: false, label: 'Нет' }],
};

// Смена типа сохраняет то, что можно сохранить: подписи true/false между binary и flag,
// а при переходе binary → scale ступени 0 и 1 берут подписи «Нет» и «Да».
export function changeAnswerType(criterion, type) {
  if (!ANSWER_TYPES.includes(type) || criterion.answer_type === type) return criterion;
  const previous = criterion.answer_type;
  let options;
  if (type === 'binary' || type === 'flag') {
    options = BOOLEAN_DEFAULTS[type].map((fallback) => {
      const kept = previous !== 'scale' ? criterion.options.find((option) => option.value === fallback.value) : null;
      return kept ? { ...kept, normalized: '' } : { value: fallback.value, label: fallback.label, description: '', normalized: '' };
    });
  } else {
    const yes = criterion.options.find((option) => option.value === true);
    const no = criterion.options.find((option) => option.value === false);
    options = [
      { value: '0', label: no ? no.label : '0', description: no ? no.description : '', normalized: '' },
      { value: '1', label: yes ? yes.label : '1', description: yes ? yes.description : '', normalized: '' },
    ];
  }
  return { ...criterion, answer_type: type, options, weight: type === 'flag' ? '' : criterion.weight };
}

// Подсказка для пустого нормирования ступени: сервер подставит value / max.
export function autoNormalized(options, option) {
  const values = options.map((item) => parseNumber(item.value)).filter((value) => value !== null);
  const value = parseNumber(option.value);
  if (value === null || !values.length) return null;
  const max = Math.max(...values);
  if (!(max > 0)) return null;
  const result = value / max;
  return result >= 0 && result <= 1 ? result : null;
}

// ---------- Новый, заменённый, перемещённый критерий ----------

export function newCriterion({ section = '' } = {}) {
  return {
    key: nextKey(),
    existing: false,
    replaces: null,
    replaced: null,
    id: '',
    name: '',
    description: '',
    section,
    answer_type: 'binary',
    weight: '',
    options: BOOLEAN_DEFAULTS.binary.map((option) => ({ ...option, description: '', normalized: '' })),
    na_allowed: false,
    na_condition: '',
  };
}

// contact → contact_v2; contact_v2 → contact_v3; занятые ID пропускаются.
export function suggestReplacementId(oldId, takenIds = []) {
  const taken = new Set(takenIds);
  const match = /^(.*)_v(\d+)$/.exec(oldId);
  const base = match ? match[1] : oldId;
  let number = match ? Number(match[2]) + 1 : 2;
  while (taken.has(`${base}_v${number}`)) number += 1;
  return `${base}_v${number}`;
}

// Замена — новое правило в том же слоте: поля копируются для правки, ID новый, старый помнится для отмены.
export function replaceCriterion(criterion, takenIds = []) {
  return {
    ...criterion,
    key: nextKey(),
    existing: false,
    replaces: criterion.id,
    replaced: criterion,
    id: suggestReplacementId(criterion.id, takenIds),
    options: criterion.options.map((option) => ({ ...option })),
  };
}

export function undoReplacement(criterion) {
  return criterion.replaced || criterion;
}

export function moveItem(list, index, delta) {
  const target = index + delta;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return list;
  const result = [...list];
  const [item] = result.splice(index, 1);
  result.splice(target, 0, item);
  return result;
}

// ---------- Проверки формы до сервера ----------

// Только то, чего сервер не проверяет: ID нового правила — латиница и не ID прежнего правила.
export function localErrors(draft, baseIds = []) {
  const errors = {};
  const previous = new Set(baseIds);
  draft.criteria.forEach((criterion, index) => {
    if (criterion.existing) return;
    const id = text(criterion.id).trim();
    const key = `criteria.${index}.id`;
    if (!id) errors[key] = 'Укажите ID нового правила.';
    else if (!NEW_ID_PATTERN.test(id)) errors[key] = 'ID — латинские буквы, цифры, «_» и «-», начинается с буквы.';
    else if (previous.has(id)) errors[key] = `ID «${id}» был у прежнего правила: для нового правила нужен новый ID.`;
  });
  return errors;
}

// ---------- Сводка изменений и запрос ----------

export function summarizeChanges(baseDefinition, draft) {
  const base = baseDefinition || { name: '', description: '', criteria: [] };
  const baseById = new Map(base.criteria.map((criterion) => [criterion.id, criterion]));
  const current = toDefinition(draft);
  const replaced = [];
  const added = [];
  const changed = [];
  draft.criteria.forEach((criterion, index) => {
    const definition = current.criteria[index];
    if (criterion.replaces) replaced.push({ from: criterion.replaces, to: definition.id });
    else if (!criterion.existing || !baseById.has(definition.id)) added.push(definition.id);
    else if (JSON.stringify(definition) !== JSON.stringify(canonicalCriterion(baseById.get(definition.id)))) changed.push(definition.id);
  });
  const currentIds = new Set(current.criteria.map((criterion) => criterion.id));
  const replacedIds = new Set(replaced.map((item) => item.from));
  const removed = base.criteria.map((criterion) => criterion.id).filter((id) => !currentIds.has(id) && !replacedIds.has(id));
  const keptOrder = (list) => list.filter((id) => baseById.has(id) && currentIds.has(id));
  const reordered = JSON.stringify(keptOrder(current.criteria.map((criterion) => criterion.id)))
    !== JSON.stringify(keptOrder(base.criteria.map((criterion) => criterion.id)));
  const metaChanged = current.name !== base.name || current.description !== base.description;
  return {
    replaced,
    added,
    removed,
    changed,
    reordered,
    metaChanged,
    any: Boolean(replaced.length || added.length || removed.length || changed.length || reordered || metaChanged),
  };
}

export function describeChanges(summary) {
  if (!summary.any) return 'Изменений нет';
  const parts = [];
  if (summary.replaced.length) parts.push(`заменено правил: ${summary.replaced.length}`);
  if (summary.added.length) parts.push(`добавлено: ${summary.added.length}`);
  if (summary.removed.length) parts.push(`удалено: ${summary.removed.length}`);
  if (summary.changed.length) parts.push(`изменено: ${summary.changed.length}`);
  if (summary.reordered) parts.push('изменён порядок');
  if (summary.metaChanged) parts.push('изменены название или описание');
  return `Изменения: ${parts.join(', ')}`;
}

// CreateVersionRequest: определение + ожидаемая последняя версия; при активации — ожидаемая активная (в том числе null).
export function buildVersionRequest(definition, { latestVersionId, activate, activeVersionId }) {
  const body = { ...definition, expected_latest_version_id: latestVersionId, activate: activate === true };
  if (body.activate) body.expected_active_version_id = activeVersionId === undefined ? null : activeVersionId;
  return body;
}
