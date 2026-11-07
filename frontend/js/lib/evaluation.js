// Разбор оценки для показа: критерии в порядке снимка чек-листа, сравнение исходного и финального ответа.
// Баллы здесь не считаются: все числа берутся из ответа сервера.
import { answersEqual } from './answers.js';

function indexBy(list, key) {
  const map = new Map();
  for (const item of Array.isArray(list) ? list : []) {
    if (item && !map.has(item[key])) map.set(item[key], item);
  }
  return map;
}

export function criterionRows(evaluation) {
  const snapshot = evaluation && evaluation.checklist_snapshot ? evaluation.checklist_snapshot.criteria : [];
  const finalById = indexBy(evaluation && evaluation.final ? evaluation.final.criteria : [], 'criterion_id');
  const originalById = indexBy(evaluation && evaluation.original ? evaluation.original.criteria : [], 'criterion_id');
  return (Array.isArray(snapshot) ? snapshot : []).map((criterion) => {
    const final = finalById.get(criterion.id) || null;
    const original = originalById.get(criterion.id) || null;
    return {
      criterion,
      final,
      original,
      isFlag: criterion.answer_type === 'flag',
      changedByAppeal: Boolean(final && original && !answersEqual(final.answer, original.answer)),
    };
  });
}

// Подряд идущие критерии одной секции — одна группа; порядок снимка не меняется.
export function groupBySection(rows) {
  const groups = [];
  for (const row of rows) {
    const section = row.criterion.section || '';
    const last = groups[groups.length - 1];
    if (last && last.section === section) last.rows.push(row);
    else groups.push({ section, rows: [row] });
  }
  return groups;
}

export function sectionTitle(section) {
  return section ? section : 'Общая секция';
}

export function totalsDiffer(evaluation) {
  if (!evaluation || !evaluation.original || !evaluation.final) return false;
  return evaluation.original.total !== evaluation.final.total;
}

// Имена флагов, отмеченных как нарушение в финальном результате.
export function violatedFlags(evaluation) {
  const rows = criterionRows(evaluation);
  return rows
    .filter((row) => row.isFlag && row.final && row.final.answer && row.final.answer.status === 'answered' && row.final.answer.value === true)
    .map((row) => row.criterion.name);
}

export function rangeIds(range) {
  if (!range || !Number.isInteger(range.start_id) || !Number.isInteger(range.end_id) || range.end_id < range.start_id) {
    return [];
  }
  const ids = [];
  for (let id = range.start_id; id <= range.end_id; id += 1) ids.push(id);
  return ids;
}

// Оценку можно сравнивать только с оценкой той же ревизии разговора.
export function comparableWith(summary, evaluation) {
  return Boolean(summary && evaluation && summary.id !== evaluation.id
    && summary.conversation && evaluation.conversation
    && summary.conversation.revision_id === evaluation.conversation.revision_id);
}

// Выбор оценки и ревизии для карточки:
// явная оценка из адреса → её ревизия; иначе явная ревизия → последняя оценка этой ревизии;
// иначе последняя оценка разговора и её ревизия; без оценок — текущая ревизия.
export function chooseEvaluation(summaries, { evaluationId, revisionId } = {}) {
  const list = Array.isArray(summaries) ? summaries : [];
  if (evaluationId) return list.find((item) => item.id === evaluationId) || { id: evaluationId };
  if (revisionId) return list.find((item) => item.conversation && item.conversation.revision_id === revisionId) || null;
  return list[0] || null;
}
