import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  chooseEvaluation,
  comparableWith,
  criterionRows,
  groupBySection,
  rangeIds,
  sectionTitle,
  totalsDiffer,
  violatedFlags,
} from '../js/lib/evaluation.js';

// Синтетика по образцу docs/examples/evaluation.json; ID критериев — произвольные.
const criterion = (id, section, type = 'binary') => ({
  id,
  name: `Правило ${id}`,
  description: '',
  section,
  answer_type: type,
  weight: type === 'flag' ? null : 10,
  options: [
    { value: true, label: 'Да', description: '', normalized: type === 'flag' ? null : 1 },
    { value: false, label: 'Нет', description: '', normalized: type === 'flag' ? null : 0 },
  ],
  na_allowed: false,
  na_condition: null,
});
const result = (id, value) => ({ criterion_id: id, answer: { status: 'answered', value } });

function evaluation({ original, final, criteria }) {
  return {
    id: 'ev-1',
    conversation: { id: 'c-1', revision_id: 'rev-1' },
    checklist_snapshot: { name: 'Синтетический', description: '', criteria },
    original: { total: original.total, criteria: original.criteria },
    final: { total: final.total, criteria: final.criteria },
  };
}

const criteria = [criterion('b', 'Начало'), criterion('a', 'Начало'), criterion('z', 'Итог'), criterion('f', 'Нарушения', 'flag')];

test('критерии в порядке снимка, а не результатов; изменение апелляцией видно', () => {
  const rows = criterionRows(evaluation({
    criteria,
    original: { total: 100, criteria: [result('z', true), result('a', true), result('b', true), result('f', false)] },
    final: { total: 66.67, criteria: [result('a', false), result('z', true), result('b', true), result('f', true)] },
  }));
  assert.deepEqual(rows.map((row) => row.criterion.id), ['b', 'a', 'z', 'f']);
  assert.deepEqual(rows.map((row) => row.changedByAppeal), [false, true, false, true]);
  assert.deepEqual(rows.map((row) => row.isFlag), [false, false, false, true]);
});

test('критерий без результата не ломает разбор', () => {
  const rows = criterionRows(evaluation({ criteria, original: { total: null, criteria: [] }, final: { total: null, criteria: [] } }));
  assert.equal(rows.length, 4);
  assert.equal(rows[0].final, null);
  assert.equal(rows[0].changedByAppeal, false);
  assert.deepEqual(criterionRows(null), []);
});

test('группировка по секциям сохраняет порядок', () => {
  const rows = criteria.map((c) => ({ criterion: c }));
  const groups = groupBySection(rows);
  assert.deepEqual(groups.map((g) => [g.section, g.rows.length]), [['Начало', 2], ['Итог', 1], ['Нарушения', 1]]);
  assert.equal(sectionTitle(''), 'Общая секция');
});

test('итог до и после апелляций, нарушенные флаги', () => {
  const changed = evaluation({
    criteria,
    original: { total: 100, criteria: [result('f', false)] },
    final: { total: 90, criteria: [result('f', true)] },
  });
  assert.equal(totalsDiffer(changed), true);
  assert.deepEqual(violatedFlags(changed), ['Правило f']);
  const same = evaluation({ criteria, original: { total: null, criteria: [] }, final: { total: null, criteria: [] } });
  assert.equal(totalsDiffer(same), false);
  assert.deepEqual(violatedFlags(same), []);
});

test('диапазон проверенных сообщений включает обе границы', () => {
  assert.deepEqual(rangeIds({ start_id: 3, end_id: 6 }), [3, 4, 5, 6]);
  assert.deepEqual(rangeIds({ start_id: 4, end_id: 4 }), [4]);
  assert.deepEqual(rangeIds({ start_id: 5, end_id: 4 }), []);
  assert.deepEqual(rangeIds(null), []);
});

test('выбор оценки для карточки', () => {
  const list = [
    { id: 'e3', conversation: { revision_id: 'rev-2' } },
    { id: 'e2', conversation: { revision_id: 'rev-1' } },
    { id: 'e1', conversation: { revision_id: 'rev-1' } },
  ];
  assert.equal(chooseEvaluation(list).id, 'e3');
  assert.equal(chooseEvaluation(list, { evaluationId: 'e1' }).id, 'e1');
  assert.deepEqual(chooseEvaluation(list, { evaluationId: 'старая' }), { id: 'старая' });
  assert.equal(chooseEvaluation(list, { revisionId: 'rev-1' }).id, 'e2');
  assert.equal(chooseEvaluation(list, { revisionId: 'rev-9' }), null);
  assert.equal(chooseEvaluation([]), null);
});

test('сравнивать можно только оценки одной ревизии', () => {
  const current = { id: 'e3', conversation: { revision_id: 'rev-1' } };
  assert.equal(comparableWith({ id: 'e2', conversation: { revision_id: 'rev-1' } }, current), true);
  assert.equal(comparableWith({ id: 'e1', conversation: { revision_id: 'rev-0' } }, current), false);
  assert.equal(comparableWith(current, current), false);
});
