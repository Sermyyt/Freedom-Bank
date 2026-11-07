import assert from 'node:assert/strict';
import { test } from 'node:test';

import { answerTone, answersEqual, formatAnswer, selectedOption } from '../js/lib/answers.js';

const binary = {
  id: 'contact',
  answer_type: 'binary',
  options: [
    { value: true, label: 'Выполнено', description: '', normalized: 1 },
    { value: false, label: 'Не выполнено', description: '', normalized: 0 },
  ],
};
const scale = {
  id: 'consultation',
  answer_type: 'scale',
  options: [
    { value: 0, label: 'Нет ответа', description: '', normalized: 0 },
    { value: 10, label: 'Частично', description: '', normalized: 0.5 },
    { value: 20, label: 'Полностью', description: '', normalized: 1 },
  ],
};
const flag = {
  id: 'rule_breach',
  answer_type: 'flag',
  options: [
    { value: true, label: 'Да', description: '', normalized: null },
    { value: false, label: 'Нет', description: '', normalized: null },
  ],
};
const answered = (value) => ({ status: 'answered', value });

test('binary: true → «Да», false → «Нет» независимо от подписей опций', () => {
  assert.equal(formatAnswer(answered(true), binary), 'Да');
  assert.equal(formatAnswer(answered(false), binary), 'Нет');
});

test('scale: подпись ступени с таким значением', () => {
  assert.equal(formatAnswer(answered(10), scale), 'Частично');
  assert.equal(formatAnswer(answered(20.0), scale), 'Полностью');
  assert.equal(formatAnswer(answered(15), scale), '15');
});

test('flag: «Нарушение» / «Нет нарушения»', () => {
  assert.equal(formatAnswer(answered(true), flag), 'Нарушение');
  assert.equal(formatAnswer(answered(false), flag), 'Нет нарушения');
});

test('N/A и невалидный ответ', () => {
  assert.equal(formatAnswer({ status: 'not_applicable', value: null }, binary), 'N/A');
  assert.equal(formatAnswer({ status: 'invalid', value: null }, scale), 'Нет валидного ответа');
  assert.equal(formatAnswer(null, scale), 'Нет валидного ответа');
  assert.equal(formatAnswer({ status: 'pending_review', value: null }, scale), 'pending_review');
});

test('строгое сравнение: true не равно 1, 1 не равно true', () => {
  assert.equal(formatAnswer(answered(1), binary), '1');
  assert.equal(formatAnswer(answered(1), flag), '1');
  const booleanScale = { ...scale, options: [{ value: 1, label: 'Один', description: '', normalized: 1 }] };
  assert.equal(formatAnswer(answered(true), booleanScale), 'true');
  assert.equal(selectedOption(answered(true), booleanScale), null);
  assert.equal(answersEqual(answered(true), answered(1)), false);
  assert.equal(answersEqual(answered(20), answered(20.0)), true);
  assert.equal(answersEqual({ status: 'not_applicable', value: null }, { status: 'answered', value: null }), false);
});

test('неизвестный тип критерия показывает значение как есть', () => {
  assert.equal(formatAnswer(answered('A'), { answer_type: 'letter', options: [] }), 'A');
});

test('тон ответа по нормированию ступени', () => {
  assert.equal(answerTone(answered(true), binary), 'good');
  assert.equal(answerTone(answered(false), binary), 'bad');
  assert.equal(answerTone(answered(20), scale), 'good');
  assert.equal(answerTone(answered(10), scale), 'partial');
  assert.equal(answerTone(answered(0), scale), 'bad');
  assert.equal(answerTone(answered(true), flag), 'bad');
  assert.equal(answerTone(answered(false), flag), 'good');
  assert.equal(answerTone({ status: 'not_applicable', value: null }, binary), 'na');
  assert.equal(answerTone({ status: 'invalid', value: null }, binary), 'invalid');
  assert.equal(answerTone(answered(1), binary), 'invalid');
});
