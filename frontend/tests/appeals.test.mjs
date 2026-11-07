import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createApi } from '../js/api.js';
import {
  answerChoices,
  appealsApiQuery,
  appealsByCriterion,
  appealsQueryToHash,
  buildAppealRequest,
  buildDecisionRequest,
  choiceKeyFor,
  describeDecision,
  findChoice,
  normalizeAppealsQuery,
  normalizeEvidenceIds,
  toggleEvidenceId,
  validateAppeal,
  validateDecision,
} from '../js/lib/appeals.js';

// Синтетические критерии по образцу checklist_snapshot из docs/examples; ID произвольные.
const binary = {
  id: 'greet',
  name: 'Приветствие',
  answer_type: 'binary',
  weight: 10,
  options: [
    { value: true, label: 'Да', description: 'Поздоровался.', normalized: 1 },
    { value: false, label: 'Нет', description: 'Не поздоровался.', normalized: 0 },
  ],
  na_allowed: false,
  na_condition: null,
};
const binaryNa = { ...binary, id: 'ident', na_allowed: true, na_condition: 'Защищённых действий не было.' };
const scale = {
  id: 'advice',
  name: 'Консультация',
  answer_type: 'scale',
  weight: 20,
  options: [
    { value: 0, label: 'Нет ответа', description: '', normalized: 0 },
    { value: 10, label: 'Частично', description: 'Часть вопроса закрыта.', normalized: 0.5 },
    { value: 20, label: 'Полностью', description: '', normalized: 1 },
  ],
  na_allowed: true,
  na_condition: null,
};
const flag = {
  id: 'gross',
  name: 'Грубые ошибки',
  answer_type: 'flag',
  weight: null,
  options: [
    { value: true, label: 'Да', description: '', normalized: null },
    { value: false, label: 'Нет', description: '', normalized: null },
  ],
  na_allowed: false,
  na_condition: null,
};

test('варианты ответа строятся из опций критерия; N/A — только при na_allowed', () => {
  const plain = answerChoices(binary);
  assert.deepEqual(plain.map((choice) => [choice.key, choice.label]), [['option-0', 'Да'], ['option-1', 'Нет']]);
  assert.deepEqual(plain[0].answer, { status: 'answered', value: true });
  assert.equal(plain[1].description, 'Не поздоровался.');

  const withNa = answerChoices(binaryNa);
  assert.equal(withNa.length, 3);
  assert.deepEqual(withNa[2], {
    key: 'na',
    answer: { status: 'not_applicable', value: null },
    label: 'N/A',
    description: 'Защищённых действий не было.',
  });

  assert.deepEqual(answerChoices(scale).map((choice) => choice.label), ['Нет ответа', 'Частично', 'Полностью', 'N/A']);
  assert.deepEqual(answerChoices(flag).map((choice) => choice.label), ['Нарушение', 'Нет нарушения']);
  assert.deepEqual(answerChoices(null), []);
});

test('текущий ответ находит свой вариант строго: true не равно 1', () => {
  const choices = answerChoices(binaryNa);
  assert.equal(choiceKeyFor({ status: 'answered', value: false }, choices), 'option-1');
  assert.equal(choiceKeyFor({ status: 'not_applicable', value: null }, choices), 'na');
  assert.equal(choiceKeyFor({ status: 'answered', value: 1 }, choices), null);
  assert.equal(choiceKeyFor({ status: 'invalid', value: null }, choices), null);
  assert.equal(findChoice(choices, 'option-0').answer.value, true);
  assert.equal(findChoice(choices, 'нет такого'), null);
});

test('подача: ровно evaluation_id, criterion_id, comment; комментарий без пробелов по краям', () => {
  assert.deepEqual(
    buildAppealRequest({ evaluationId: 'ev-1', criterionId: 'greet', comment: '  Оператор поздоровался в #3.  ' }),
    { evaluation_id: 'ev-1', criterion_id: 'greet', comment: 'Оператор поздоровался в #3.' },
  );
  assert.deepEqual(validateAppeal({ comment: '   ' }), { comment: 'Опишите, с чем не согласен оператор.' });
  assert.deepEqual(validateAppeal({ comment: 'есть' }), {});
});

test('решение «Подтвердить»: только action, reason, expected_final_revision', () => {
  const body = buildDecisionRequest({
    action: 'confirm',
    reason: ' Ответ верный. ',
    expectedFinalRevision: 2,
    choice: findChoice(answerChoices(binary), 'option-1'),
    naReason: 'не должно попасть',
    evidenceIds: [4],
  });
  assert.deepEqual(body, { action: 'confirm', reason: 'Ответ верный.', expected_final_revision: 2 });
});

test('решение «Изменить» на ответ шкалы с доказательствами', () => {
  const body = buildDecisionRequest({
    action: 'change',
    reason: 'Ответ дан частично.',
    expectedFinalRevision: 0,
    choice: findChoice(answerChoices(scale), 'option-1'),
    naReason: 'игнорируется',
    evidenceIds: [9, 3, 9],
  });
  assert.deepEqual(body, {
    action: 'change',
    reason: 'Ответ дан частично.',
    expected_final_revision: 0,
    new_answer: { status: 'answered', value: 10 },
    evidence_message_ids: [3, 9],
  });
  assert.equal(JSON.stringify(body.new_answer), '{"status":"answered","value":10}');
});

test('решение «Изменить» без доказательств — без evidence_message_ids; boolean остаётся boolean', () => {
  const body = buildDecisionRequest({
    action: 'change',
    reason: 'Нет приветствия.',
    expectedFinalRevision: 1,
    choice: findChoice(answerChoices(binary), 'option-1'),
    evidenceIds: [],
  });
  assert.deepEqual(body, {
    action: 'change',
    reason: 'Нет приветствия.',
    expected_final_revision: 1,
    new_answer: { status: 'answered', value: false },
  });
  assert.equal(body.new_answer.value, false);
  assert.ok(!('evidence_message_ids' in body));
  assert.ok(!('na_reason' in body));
});

test('решение «Изменить» на N/A: value null и обязательная na_reason', () => {
  const body = buildDecisionRequest({
    action: 'change',
    reason: 'Критерий не применим.',
    expectedFinalRevision: 3,
    choice: findChoice(answerChoices(binaryNa), 'na'),
    naReason: '  Защищённых действий не было.  ',
  });
  assert.deepEqual(body, {
    action: 'change',
    reason: 'Критерий не применим.',
    expected_final_revision: 3,
    new_answer: { status: 'not_applicable', value: null },
    na_reason: 'Защищённых действий не было.',
  });
});

test('проверка формы решения до отправки', () => {
  const na = findChoice(answerChoices(binaryNa), 'na');
  assert.deepEqual(validateDecision({ action: null, reason: 'x' }), { action: 'Выберите решение.' });
  assert.deepEqual(validateDecision({ action: 'confirm', reason: '  ' }), { reason: 'Укажите причину решения.' });
  assert.deepEqual(validateDecision({ action: 'change', reason: 'x', choice: null }), { new_answer: 'Выберите новый ответ.' });
  assert.deepEqual(validateDecision({ action: 'change', reason: 'x', choice: na, naReason: ' ' }), { na_reason: 'Укажите, почему критерий неприменим.' });
  assert.deepEqual(validateDecision({ action: 'change', reason: 'x', choice: na, naReason: 'есть' }), {});
});

test('доказательства: без повторов, по возрастанию, переключение по щелчку', () => {
  assert.deepEqual(normalizeEvidenceIds([5, 2, 5, 0, -1, 1.5, '3']), [2, 5]);
  assert.deepEqual(toggleEvidenceId([5, 2], 3), [2, 3, 5]);
  assert.deepEqual(toggleEvidenceId([2, 3, 5], 3), [2, 5]);
});

test('апелляции по критериям: одна открытая и решённые, новые сверху', () => {
  const index = appealsByCriterion([
    { id: 'a1', criterion_id: 'greet', status: 'resolved', created_at: '2026-11-07T10:00:00Z', resolved_at: '2026-11-07T10:05:00Z' },
    { id: 'a2', criterion_id: 'greet', status: 'open', created_at: '2026-11-07T11:00:00Z', resolved_at: null },
    { id: 'a3', criterion_id: 'greet', status: 'resolved', created_at: '2026-11-07T09:00:00Z', resolved_at: '2026-11-07T12:00:00Z' },
    { id: 'a4', criterion_id: 'advice', status: 'open', created_at: '2026-11-07T11:30:00Z', resolved_at: null },
  ]);
  assert.equal(index.get('greet').open.id, 'a2');
  assert.deepEqual(index.get('greet').resolved.map((appeal) => appeal.id), ['a3', 'a1']);
  assert.equal(index.get('advice').open.id, 'a4');
  assert.equal(index.get('nothing'), undefined);
  assert.equal(appealsByCriterion(null).size, 0);
});

test('описание решения по типу критерия', () => {
  const changed = describeDecision({
    action: 'change',
    before: { answer: { status: 'answered', value: false } },
    after: { answer: { status: 'answered', value: true } },
  }, flag);
  assert.deepEqual(changed, { action: 'change', actionLabel: 'Ответ изменён', before: 'Нет нарушения', after: 'Нарушение', answerChanged: true });
  const confirmed = describeDecision({
    action: 'confirm',
    before: { answer: { status: 'answered', value: 10 } },
    after: { answer: { status: 'answered', value: 10 } },
  }, scale);
  assert.equal(confirmed.actionLabel, 'Ответ подтверждён');
  assert.equal(confirmed.after, 'Частично');
  assert.equal(confirmed.answerChanged, false);
  assert.equal(describeDecision(null, scale), null);
});

test('фильтр списка: открытые по умолчанию, «все» — без status, мусор из адреса отбрасывается', () => {
  assert.deepEqual(normalizeAppealsQuery({}), { status: 'open', limit: 25, offset: 0 });
  assert.deepEqual(normalizeAppealsQuery({ status: 'closed', offset: '-5', limit: '7' }), { status: 'open', limit: 25, offset: 0 });
  const all = normalizeAppealsQuery({ status: 'all', offset: '25' });
  assert.deepEqual(appealsApiQuery(all), { status: undefined, limit: 25, offset: 25 });
  assert.deepEqual(appealsApiQuery(normalizeAppealsQuery({ status: 'resolved' })), { status: 'resolved', limit: 25, offset: 0 });
  assert.deepEqual(appealsQueryToHash(normalizeAppealsQuery({})), {});
  assert.deepEqual(appealsQueryToHash(all), { status: 'all', offset: 25 });
});

function recordingApi(data) {
  const calls = [];
  const api = createApi({
    base: '',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ data, meta: { request_id: 'r' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  return { api, calls };
}

test('api: подача, список, решение — маршруты и тела из контракта', async () => {
  const { api, calls } = recordingApi({});
  await api.createAppeal({ evaluation_id: 'ev 1', criterion_id: 'greet', comment: 'x' });
  await api.listAppeals(appealsApiQuery(normalizeAppealsQuery({ status: 'all' })));
  await api.listAppeals({ evaluation_id: 'ev-1', limit: 100 });
  await api.getAppeal('a/1');
  await api.decideAppeal('a/1', { action: 'confirm', reason: 'r', expected_final_revision: 0 });
  assert.deepEqual(calls.map((call) => `${call.init.method} ${call.url}`), [
    'POST /api/appeals',
    'GET /api/appeals?limit=25&offset=0',
    'GET /api/appeals?evaluation_id=ev-1&limit=100',
    'GET /api/appeals/a%2F1',
    'POST /api/appeals/a%2F1/decision',
  ]);
  assert.equal(calls[0].init.body, '{"evaluation_id":"ev 1","criterion_id":"greet","comment":"x"}');
  assert.equal(calls[4].init.body, '{"action":"confirm","reason":"r","expected_final_revision":0}');
});
