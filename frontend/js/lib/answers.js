// Ответы по критерию — по типу из снимка чек-листа. Сравнение значений строгое: true не равно 1.

export const NA_LABEL = 'N/A';
export const INVALID_LABEL = 'Нет валидного ответа';

export function selectedOption(answer, criterion) {
  if (!answer || answer.status !== 'answered' || !criterion || !Array.isArray(criterion.options)) return null;
  return criterion.options.find((option) => option.value === answer.value) || null;
}

export function formatAnswer(answer, criterion) {
  if (!answer || typeof answer !== 'object') return INVALID_LABEL;
  if (answer.status === 'not_applicable') return NA_LABEL;
  if (answer.status === 'invalid') return INVALID_LABEL;
  if (answer.status !== 'answered') return String(answer.status);

  const { value } = answer;
  const type = criterion ? criterion.answer_type : undefined;
  if (type === 'binary') {
    if (value === true) return 'Да';
    if (value === false) return 'Нет';
  } else if (type === 'flag') {
    if (value === true) return 'Нарушение';
    if (value === false) return 'Нет нарушения';
  } else if (type === 'scale') {
    const option = selectedOption(answer, criterion);
    if (option) return option.label;
  }
  return value === null || value === undefined ? INVALID_LABEL : String(value);
}

export function answersEqual(left, right) {
  if (!left || !right) return left === right;
  return left.status === right.status && left.value === right.value;
}

// Тон для цвета и значка; смысл всё равно передаёт текст ответа.
// good — выполнено, bad — не выполнено или нарушение, partial — частично, na — неприменимо, invalid — нет ответа.
export function answerTone(answer, criterion) {
  if (!answer || answer.status === 'invalid') return 'invalid';
  if (answer.status === 'not_applicable') return 'na';
  if (answer.status !== 'answered') return 'invalid';
  const type = criterion ? criterion.answer_type : undefined;
  if (type === 'flag') {
    if (answer.value === true) return 'bad';
    if (answer.value === false) return 'good';
    return 'invalid';
  }
  if (type === 'binary') {
    if (answer.value === true) return 'good';
    if (answer.value === false) return 'bad';
    return 'invalid';
  }
  const option = selectedOption(answer, criterion);
  if (!option || typeof option.normalized !== 'number') return 'invalid';
  if (option.normalized >= 1) return 'good';
  if (option.normalized <= 0) return 'bad';
  return 'partial';
}
