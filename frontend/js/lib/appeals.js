// Апелляции: варианты ответа из снимка чек-листа, тела запросов строго по контракту, проверки форм,
// фильтры списка. Баллы здесь не считаются: пересчёт итога делает сервер.
import { answersEqual, formatAnswer, NA_LABEL } from './answers.js';
import { DEFAULT_PAGE_SIZE, normalizePageSize } from './filters.js';

export const APPEAL_STATUS_LABELS = { open: 'Открыта', resolved: 'Решена' };
export const APPEAL_STATUS_TONES = { open: 'warn', resolved: 'neutral' };
export const DECISION_ACTION_LABELS = { confirm: 'Ответ подтверждён', change: 'Ответ изменён' };

// Фильтр списка: «open» и «resolved» уходят на сервер, «all» — без параметра status.
export const APPEAL_STATUS_FILTERS = ['open', 'resolved', 'all'];
export const DEFAULT_APPEAL_STATUS = 'open';
export const NA_CHOICE = 'na';

// Варианты нового ответа — опции критерия из снимка этой оценки в их порядке, плюс N/A, если он разрешён.
// Подпись та же, что в карточке (formatAnswer), чтобы после решения человек увидел то, что выбрал.
export function answerChoices(criterion) {
  if (!criterion) return [];
  const options = Array.isArray(criterion.options) ? criterion.options : [];
  const choices = options.map((option, index) => {
    const answer = { status: 'answered', value: option.value };
    return { key: `option-${index}`, answer, label: formatAnswer(answer, criterion), description: option.description || '' };
  });
  if (criterion.na_allowed === true) {
    choices.push({
      key: NA_CHOICE,
      answer: { status: 'not_applicable', value: null },
      label: NA_LABEL,
      description: criterion.na_condition || '',
    });
  }
  return choices;
}

export function findChoice(choices, key) {
  return (Array.isArray(choices) ? choices : []).find((choice) => choice.key === key) || null;
}

// Ключ варианта, совпадающего с ответом (сравнение строгое: true не равно 1).
export function choiceKeyFor(answer, choices) {
  const match = (Array.isArray(choices) ? choices : []).find((choice) => answersEqual(choice.answer, answer));
  return match ? match.key : null;
}

const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

// Доказательства решения: целые ID без повторов, по возрастанию.
export function normalizeEvidenceIds(ids) {
  const unique = new Set((Array.isArray(ids) ? ids : []).filter((id) => Number.isInteger(id) && id > 0));
  return [...unique].sort((a, b) => a - b);
}

export function toggleEvidenceId(ids, id) {
  const current = normalizeEvidenceIds(ids);
  return current.includes(id) ? current.filter((item) => item !== id) : normalizeEvidenceIds([...current, id]);
}

// Ошибки ключуются так же, как details[].path сервера после fieldKey: 'comment', 'reason', 'na_reason'…
export function validateAppeal({ comment } = {}) {
  return trimmed(comment) ? {} : { comment: 'Опишите, с чем не согласен оператор.' };
}

export function buildAppealRequest({ evaluationId, criterionId, comment }) {
  return { evaluation_id: evaluationId, criterion_id: criterionId, comment: trimmed(comment) };
}

export function validateDecision({ action, reason, choice, naReason } = {}) {
  const errors = {};
  if (action !== 'confirm' && action !== 'change') errors.action = 'Выберите решение.';
  if (action === 'change') {
    if (!choice) errors.new_answer = 'Выберите новый ответ.';
    else if (choice.answer.status === 'not_applicable' && !trimmed(naReason)) errors.na_reason = 'Укажите, почему критерий неприменим.';
  }
  if (!trimmed(reason)) errors.reason = 'Укажите причину решения.';
  return errors;
}

// Ровно тело AppealDecisionRequest: только поля, нужные для выбранного действия.
// confirm — без нового ответа и доказательств; change — new_answer, а для N/A ещё na_reason;
// evidence_message_ids только если человек выбрал реплики (иначе сервер подставит [] и предупреждение).
export function buildDecisionRequest({ action, reason, expectedFinalRevision, choice, naReason, evidenceIds }) {
  const body = { action, reason: trimmed(reason), expected_final_revision: expectedFinalRevision };
  if (action !== 'change') return body;
  body.new_answer = { status: choice.answer.status, value: choice.answer.status === 'not_applicable' ? null : choice.answer.value };
  if (choice.answer.status === 'not_applicable') body.na_reason = trimmed(naReason);
  const evidence = normalizeEvidenceIds(evidenceIds);
  if (evidence.length) body.evidence_message_ids = evidence;
  return body;
}

// Апелляции одной оценки по критериям: открытая (не больше одной) и решённые, новые сверху.
export function appealsByCriterion(appeals) {
  const map = new Map();
  for (const appeal of Array.isArray(appeals) ? appeals : []) {
    if (!appeal || typeof appeal.criterion_id !== 'string') continue;
    if (!map.has(appeal.criterion_id)) map.set(appeal.criterion_id, { open: null, resolved: [] });
    const entry = map.get(appeal.criterion_id);
    if (appeal.status === 'open') {
      if (!entry.open) entry.open = appeal;
    } else {
      entry.resolved.push(appeal);
    }
  }
  for (const entry of map.values()) {
    entry.resolved.sort((a, b) => String(b.resolved_at || b.created_at).localeCompare(String(a.resolved_at || a.created_at)));
  }
  return map;
}

// Что решил проверяющий: подписи ответов до и после — по типу критерия из снимка.
export function describeDecision(decision, criterion) {
  if (!decision) return null;
  const before = decision.before ? decision.before.answer : null;
  const after = decision.after ? decision.after.answer : null;
  return {
    action: decision.action,
    actionLabel: DECISION_ACTION_LABELS[decision.action] || String(decision.action),
    before: formatAnswer(before, criterion),
    after: formatAnswer(after, criterion),
    answerChanged: !answersEqual(before, after),
  };
}

// ---------- Фильтры списка #/appeals ----------

export function normalizeAppealsQuery(query = {}, fallbackLimit = DEFAULT_PAGE_SIZE) {
  const status = APPEAL_STATUS_FILTERS.includes(query.status) ? query.status : DEFAULT_APPEAL_STATUS;
  const offset = Number(query.offset);
  return {
    status,
    limit: normalizePageSize(query.limit, fallbackLimit),
    offset: Number.isInteger(offset) && offset > 0 ? offset : 0,
  };
}

export function appealsApiQuery(query) {
  return { status: query.status === 'all' ? undefined : query.status, limit: query.limit, offset: query.offset };
}

export function appealsQueryToHash(query) {
  const result = {};
  if (query.status !== DEFAULT_APPEAL_STATUS) result.status = query.status;
  if (query.limit !== DEFAULT_PAGE_SIZE) result.limit = query.limit;
  if (query.offset) result.offset = query.offset;
  return result;
}
