// История: подписи событий человеческими словами, фильтры из адреса, ссылки на связанные объекты.
// Неизвестный тип события показывается как есть — история append-only, новые типы не должны ломать экран.
import { buildHash } from './route.js';
import { DEFAULT_PAGE_SIZE, normalizePageSize } from './filters.js';

export const HISTORY_EVENT_LABELS = {
  dataset_imported: 'Импорт набора',
  conversation_created: 'Новый разговор',
  conversation_revised: 'Новая ревизия разговора',
  checklist_version_created: 'Создана версия чек-листа',
  checklist_version_activated: 'Применена версия чек-листа',
  evaluation_created: 'Оценка разговора',
  appeal_created: 'Подана апелляция',
  appeal_resolved: 'Решение по апелляции',
};

export const HISTORY_EVENT_TONES = {
  dataset_imported: 'neutral',
  conversation_created: 'neutral',
  conversation_revised: 'neutral',
  checklist_version_created: 'info',
  checklist_version_activated: 'info',
  evaluation_created: 'good',
  appeal_created: 'warn',
  appeal_resolved: 'warn',
};

// demo_* — действие из интерфейса без установленной личности, а не подтверждённый пользователь.
export const HISTORY_ACTOR_LABELS = {
  system: 'Система',
  demo_operator: 'Оператор (демо)',
  demo_reviewer: 'Проверяющий (демо)',
};

export const HISTORY_EVENT_TYPES = Object.keys(HISTORY_EVENT_LABELS);

export function eventLabel(type) {
  return Object.prototype.hasOwnProperty.call(HISTORY_EVENT_LABELS, type) ? HISTORY_EVENT_LABELS[type] : String(type ?? '');
}

export function normalizeHistoryQuery(query = {}, fallbackLimit = DEFAULT_PAGE_SIZE) {
  const result = {};
  if (HISTORY_EVENT_TYPES.includes(query.event_type)) result.event_type = query.event_type;
  const conversationId = typeof query.conversation_id === 'string' ? query.conversation_id.trim() : '';
  if (conversationId) result.conversation_id = conversationId;
  result.limit = normalizePageSize(query.limit, fallbackLimit);
  const offset = Number(query.offset);
  result.offset = Number.isInteger(offset) && offset > 0 ? offset : 0;
  return result;
}

// Те же поля уходят на сервер: event_type, conversation_id, limit, offset (пустые buildQuery отбросит).
export function historyApiQuery(query) {
  return { event_type: query.event_type, conversation_id: query.conversation_id, limit: query.limit, offset: query.offset };
}

export function historyQueryToHash(query) {
  const result = {};
  if (query.event_type) result.event_type = query.event_type;
  if (query.conversation_id) result.conversation_id = query.conversation_id;
  if (query.limit !== DEFAULT_PAGE_SIZE) result.limit = query.limit;
  if (query.offset) result.offset = query.offset;
  return result;
}

export function hasHistoryFilters(query) {
  return Boolean(query && (query.event_type || query.conversation_id));
}

// Ссылки события: разговор, оценка (в карточке разговора), апелляция (карточка с панелью решения), чек-лист.
export function eventLinks(event) {
  const links = [];
  if (!event) return links;
  const conversationId = event.conversation_id;
  if (conversationId) links.push({ kind: 'conversation', href: buildHash('conversation', [conversationId]) });
  if (conversationId && event.evaluation_id) {
    links.push({ kind: 'evaluation', href: buildHash('conversation', [conversationId], { evaluation: event.evaluation_id }) });
  }
  if (conversationId && event.evaluation_id && event.appeal_id) {
    links.push({
      kind: 'appeal',
      href: buildHash('conversation', [conversationId], { evaluation: event.evaluation_id, appeal: event.appeal_id }),
    });
  }
  if (event.checklist_version_id) {
    links.push({ kind: 'checklist', href: buildHash('checklist'), versionId: event.checklist_version_id });
  }
  return links;
}
