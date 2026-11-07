import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createApi } from '../js/api.js';
import {
  autoNormalized,
  buildVersionRequest,
  changeAnswerType,
  describeChanges,
  localErrors,
  moveItem,
  newCriterion,
  parseNumber,
  replaceCriterion,
  suggestReplacementId,
  summarizeChanges,
  toDefinition,
  toDraft,
  undoReplacement,
} from '../js/lib/checklist.js';
import { CHANGE_LABELS, comparisonRows, deltaTone } from '../js/lib/compare.js';

// Синтетическое определение в форме ответа сервера (нормирование задано явно, веса — числа).
const definition = {
  name: 'Синтетический чек-лист',
  description: 'Для тестов редактора.',
  criteria: [
    {
      id: 'greet', name: 'Приветствие', description: 'Оператор поздоровался.', section: 'Начало', answer_type: 'binary', weight: 10.0,
      options: [
        { value: true, label: 'Да', description: 'Поздоровался.', normalized: 1.0 },
        { value: false, label: 'Нет', description: 'Не поздоровался.', normalized: 0.0 },
      ],
      na_allowed: false, na_condition: null,
    },
    {
      id: 'advice', name: 'Консультация', description: 'Ответ по существу.', section: 'Решение', answer_type: 'scale', weight: 20.0,
      options: [
        { value: 0.0, label: '0', description: 'Нет ответа.', normalized: 0.0 },
        { value: 10.0, label: '10', description: 'Частично.', normalized: 0.5 },
        { value: 20.0, label: '20', description: 'Полностью.', normalized: 1.0 },
      ],
      na_allowed: true, na_condition: 'Вопроса не было.',
    },
    {
      id: 'gross', name: 'Грубые ошибки', description: 'Нарушения.', section: '', answer_type: 'flag', weight: null,
      options: [
        { value: true, label: 'Да', description: 'Есть.', normalized: null },
        { value: false, label: 'Нет', description: 'Нет.', normalized: null },
      ],
      na_allowed: false, na_condition: null,
    },
  ],
};

test('черновик без правок превращается обратно ровно в определение сервера', () => {
  const draft = toDraft(definition);
  assert.equal(JSON.stringify(toDefinition(draft)), JSON.stringify(definition));
  assert.equal(summarizeChanges(definition, draft).any, false);
  assert.equal(describeChanges(summarizeChanges(definition, draft)), 'Изменений нет');
});

test('числа из полей: строки, запятая, пусто и мусор → null; флаг без веса', () => {
  assert.equal(parseNumber('15'), 15);
  assert.equal(parseNumber('2,5'), 2.5);
  assert.equal(parseNumber(''), null);
  assert.equal(parseNumber('abc'), null);
  const draft = toDraft(definition);
  draft.criteria[0].weight = '12,5';
  draft.criteria[1].options[1].normalized = '';
  draft.criteria[2].weight = '99';
  const result = toDefinition(draft);
  assert.equal(result.criteria[0].weight, 12.5);
  assert.equal(result.criteria[1].options[1].normalized, null);
  assert.equal(result.criteria[2].weight, null);
  assert.deepEqual(result.criteria[0].options.map((option) => option.normalized), [1, 0]);
  assert.deepEqual(result.criteria[2].options.map((option) => option.normalized), [null, null]);
});

test('«Заменить»: тот же слот, новый ID <старый>_v2, старый помнится для отмены', () => {
  const draft = toDraft(definition);
  const original = draft.criteria[0];
  const replacement = replaceCriterion(original, ['greet', 'advice', 'gross']);
  assert.equal(replacement.id, 'greet_v2');
  assert.equal(replacement.replaces, 'greet');
  assert.equal(replacement.existing, false);
  assert.notEqual(replacement.key, original.key);
  assert.equal(replacement.name, original.name);
  replacement.options[0].label = 'Изменено';
  assert.equal(original.options[0].label, 'Да', 'опции копируются, а не делятся');
  draft.criteria[0] = replacement;
  const summary = summarizeChanges(definition, draft);
  assert.deepEqual(summary.replaced, [{ from: 'greet', to: 'greet_v2' }]);
  assert.deepEqual(summary.removed, []);
  assert.deepEqual(summary.added, []);
  assert.equal(describeChanges(summary), 'Изменения: заменено правил: 1');
  assert.deepEqual(toDefinition(draft).criteria.map((criterion) => criterion.id), ['greet_v2', 'advice', 'gross']);
  assert.equal(undoReplacement(replacement), original);
});

test('подсказка нового ID пропускает занятые и продолжает нумерацию', () => {
  assert.equal(suggestReplacementId('contact'), 'contact_v2');
  assert.equal(suggestReplacementId('contact', ['contact_v2']), 'contact_v3');
  assert.equal(suggestReplacementId('contact_v2', ['contact_v3']), 'contact_v4');
});

test('новый ID: латиница и не ID прежнего правила; существующие ID не проверяются', () => {
  const draft = toDraft(definition);
  draft.criteria.push({ ...newCriterion(), id: 'приветствие' });
  draft.criteria.push({ ...newCriterion(), id: 'greet' });
  draft.criteria.push({ ...newCriterion(), id: '' });
  draft.criteria.push({ ...newCriterion(), id: 'closing_v2' });
  const errors = localErrors(draft, ['greet', 'advice', 'gross']);
  assert.deepEqual(Object.keys(errors).sort(), ['criteria.3.id', 'criteria.4.id', 'criteria.5.id']);
  assert.match(errors['criteria.3.id'], /латинские/);
  assert.match(errors['criteria.4.id'], /прежнего правила/);
  assert.match(errors['criteria.5.id'], /Укажите ID/);
});

test('смена типа ответа: флаг без веса, шкала из «Да/Нет» берёт подписи', () => {
  const draft = toDraft(definition);
  const flag = changeAnswerType(draft.criteria[0], 'flag');
  assert.equal(flag.answer_type, 'flag');
  assert.equal(flag.weight, '');
  assert.deepEqual(flag.options.map((option) => [option.value, option.label]), [[true, 'Да'], [false, 'Нет']]);
  const scale = changeAnswerType(draft.criteria[0], 'scale');
  assert.deepEqual(scale.options.map((option) => [option.value, option.label]), [['0', 'Нет'], ['1', 'Да']]);
  assert.equal(scale.weight, '10');
  assert.equal(changeAnswerType(draft.criteria[0], 'binary'), draft.criteria[0]);
});

test('авто-нормирование ступени: значение / максимум', () => {
  const options = [{ value: '0' }, { value: '5' }, { value: '20' }];
  assert.equal(autoNormalized(options, options[1]), 0.25);
  assert.equal(autoNormalized(options, { value: '' }), null);
  assert.equal(autoNormalized([{ value: '0' }], { value: '0' }), null);
});

test('перемещение и сводка: порядок, удаление, добавление, правка', () => {
  const draft = toDraft(definition);
  draft.criteria = moveItem(draft.criteria, 2, -1);
  assert.deepEqual(draft.criteria.map((c) => c.id), ['greet', 'gross', 'advice']);
  assert.equal(moveItem(draft.criteria, 0, -1), draft.criteria);
  draft.criteria[2].weight = '25';
  draft.criteria.splice(0, 1);
  draft.criteria.push({ ...newCriterion(), id: 'farewell' });
  const summary = summarizeChanges(definition, draft);
  assert.deepEqual(summary.removed, ['greet']);
  assert.deepEqual(summary.added, ['farewell']);
  assert.deepEqual(summary.changed, ['advice']);
  assert.equal(summary.reordered, true);
});

test('тело новой версии: с активацией — expected_active_version_id (в том числе null), без — без него', () => {
  const body = buildVersionRequest(definition, { latestVersionId: 'v-2', activate: true, activeVersionId: 'v-1' });
  assert.deepEqual(Object.keys(body), ['name', 'description', 'criteria', 'expected_latest_version_id', 'activate', 'expected_active_version_id']);
  assert.equal(body.expected_active_version_id, 'v-1');
  const nullActive = buildVersionRequest(definition, { latestVersionId: 'v-2', activate: true, activeVersionId: null });
  assert.ok('expected_active_version_id' in nullActive);
  assert.equal(nullActive.expected_active_version_id, null);
  const inactive = buildVersionRequest(definition, { latestVersionId: 'v-2', activate: false, activeVersionId: 'v-1' });
  assert.equal(inactive.activate, false);
  assert.ok(!('expected_active_version_id' in inactive));
});

test('сравнение: подписи изменений, ответы по своей версии, null-разница не превращается в 0', () => {
  const left = definition.criteria[0];
  const right = { ...left, weight: 15 };
  const rows = comparisonRows({
    criteria: [
      { criterion_id: 'greet', change: 'weight_changed', left_definition: left, right_definition: right,
        left_result: { answer: { status: 'answered', value: true } }, right_result: { answer: { status: 'answered', value: false } }, contribution_delta: -0.5 },
      { criterion_id: 'greet_v2', change: 'added', left_definition: null, right_definition: { ...left, id: 'greet_v2', name: 'Новое приветствие' },
        left_result: null, right_result: { answer: { status: 'not_applicable', value: null } }, contribution_delta: null },
      { criterion_id: 'gross', change: 'removed', left_definition: definition.criteria[2], right_definition: null,
        left_result: { answer: { status: 'answered', value: true } }, right_result: null, contribution_delta: null },
    ],
  });
  assert.deepEqual(rows.map((row) => row.changeLabel), [CHANGE_LABELS.weight_changed, 'Добавлен', 'Удалён']);
  assert.deepEqual(rows.map((row) => [row.left, row.right]), [['Да', 'Нет'], [null, 'N/A'], ['Нарушение', null]]);
  assert.deepEqual(rows.map((row) => row.answerChanged), [true, false, false]);
  assert.deepEqual(rows[0].weights, { left: 10, right: 15 });
  assert.equal(rows[1].name, 'Новое приветствие');
  assert.equal(rows[1].delta, null);
  assert.equal(deltaTone(0.891, 2), 'up');
  assert.equal(deltaTone(-0.198, 2), 'down');
  assert.equal(deltaTone(0.001, 2), 'zero');
  assert.equal(deltaTone(null, 2), 'none');
});

test('api: проверка, версии, сохранение и сравнение — маршруты и тела', async () => {
  const calls = [];
  const api = createApi({
    base: '',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ data: {}, meta: { request_id: 'r' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  await api.validateChecklist(definition);
  await api.listChecklistVersions('cl 1', { limit: 100 });
  await api.createChecklistVersion('cl 1', buildVersionRequest(definition, { latestVersionId: 'v2', activate: true, activeVersionId: null }));
  await api.compareEvaluations('e1', 'e2');
  await api.getChecklist('cl 1');
  assert.deepEqual(calls.map((call) => `${call.init.method} ${call.url}`), [
    'POST /api/checklists/validate',
    'GET /api/checklists/cl%201/versions?limit=100',
    'POST /api/checklists/cl%201/versions',
    'GET /api/evaluations/compare?left_id=e1&right_id=e2',
    'GET /api/checklists/cl%201',
  ]);
  assert.equal(calls[0].init.body, JSON.stringify(definition));
  const saved = JSON.parse(calls[2].init.body);
  assert.equal(saved.expected_latest_version_id, 'v2');
  assert.equal(saved.activate, true);
  assert.equal(saved.expected_active_version_id, null);
});
