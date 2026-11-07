// Сравнение двух оценок одной ревизии: строки таблицы по ответу сервера.
// Разница не считается на фронте: contribution_delta и total_delta приходят готовыми; null — «—», а не 0.
import { answersEqual, formatAnswer } from './answers.js';
import { normalizeDecimals } from './format.js';
import { labelFor } from './labels.js';

export const CHANGE_LABELS = {
  added: 'Добавлен',
  removed: 'Удалён',
  definition_changed: 'Правило изменено',
  weight_changed: 'Изменён вес',
  unchanged: 'Без изменений',
};

export const CHANGE_TONES = {
  added: 'good',
  removed: 'bad',
  definition_changed: 'warn',
  weight_changed: 'info',
  unchanged: 'neutral',
};

// up / down / zero по тому, что увидит человек после округления; none — разницы нет (null).
export function deltaTone(value, decimals) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'none';
  const places = normalizeDecimals(decimals);
  if (Math.abs(value) < 0.5 * 10 ** -places) return 'zero';
  return value > 0 ? 'up' : 'down';
}

export function comparisonRows(comparison) {
  const criteria = comparison && Array.isArray(comparison.criteria) ? comparison.criteria : [];
  return criteria.map((item) => {
    const definition = item.right_definition || item.left_definition || null;
    const left = item.left_result ? formatAnswer(item.left_result.answer, item.left_definition) : null;
    const right = item.right_result ? formatAnswer(item.right_result.answer, item.right_definition) : null;
    const weights = item.left_definition && item.right_definition && item.left_definition.weight !== item.right_definition.weight
      ? { left: item.left_definition.weight, right: item.right_definition.weight }
      : null;
    return {
      id: item.criterion_id,
      name: definition ? definition.name : item.criterion_id,
      isFlag: Boolean(definition && definition.answer_type === 'flag'),
      change: item.change,
      changeLabel: labelFor(CHANGE_LABELS, item.change),
      changeTone: CHANGE_TONES[item.change] || 'neutral',
      left,
      right,
      answerChanged: Boolean(item.left_result && item.right_result && !answersEqual(item.left_result.answer, item.right_result.answer)),
      weights,
      delta: item.contribution_delta,
    };
  });
}
