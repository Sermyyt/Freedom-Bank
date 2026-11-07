// Оценка всей группы: тело запроса и итоговое сообщение. Сервер сам берёт текущие ревизии всех разговоров группы.
import { describeJob } from './poll.js';

// Ровно одно поле селектора: group_id без revision_ids (иначе 422).
export function buildGroupEvaluationRequest(groupId) {
  return { group_id: String(groupId ?? '').trim() };
}

export function groupJobSummary(groupId, job) {
  const view = describeJob(job);
  if (!view) return '';
  let head;
  if (job.status === 'completed') head = `Группа ${groupId} оценена`;
  else if (job.status === 'failed' && view.succeeded > 0) head = `Группа ${groupId} оценена с ошибками`;
  else if (job.status === 'failed') head = `Оценка группы ${groupId} не удалась`;
  else head = `Оценка группы ${groupId}: ${view.label.toLowerCase()}`;
  return `${head}: успешно ${view.succeeded} из ${view.total}, с ошибкой ${view.failed}, на ручную проверку ${view.manualReview}.`;
}
