// Человекочитаемые подписи для известных значений контракта.
// Неизвестное значение показывается как есть: новые значения перечислений не должны ломать интерфейс.

export function labelFor(map, value) {
  if (value === null || value === undefined) return '';
  return Object.prototype.hasOwnProperty.call(map, value) ? map[value] : String(value);
}

export const ROLE_LABELS = {
  client: 'Клиент',
  operator: 'Оператор',
  bot: 'Бот',
  system: 'Система',
};

export const CHANNEL_LABELS = {
  'agent chat': 'Чат',
  'voice call': 'Звонок',
};

export const EVENT_LABELS = {
  escalation: 'Эскалация на оператора',
  identity_verified: 'Личность клиента подтверждена',
  connection_lost: 'Соединение с клиентом прервано',
  operator_closed: 'Оператор закрыл чат',
  client_left: 'Клиент покинул чат',
  client_ended: 'Клиент завершил разговор',
  agent_joined: 'Агент присоединился к разговору',
  recording_started: 'Запись и транскрибирование запущены',
  recording_paused: 'Запись приостановлена',
  recording_resumed: 'Запись возобновлена',
  consult_initiated: 'Запрошена консультация с коллегой',
  consult_started: 'Началась консультация с коллегой',
  hold_start: 'Клиент поставлен на удержание',
  hold_end: 'Клиент снят с удержания',
  agent_left: 'Коллега вышел из разговора',
  transfer_to_support: 'Перевод в службу поддержки',
  language_changed: 'Изменён язык бота и транскрипции',
  unknown: 'Нераспознанное системное событие',
};

const MESSAGE_FLAG_LABELS = {
  after_end: 'после завершения',
  pii_masked: 'данные скрыты',
  unknown_event: 'неизвестное событие',
};

export function messageFlagLabel(flag, message) {
  if (flag === 'duplicate_of_prev') {
    const original = message ? message.duplicate_of_message_id : null;
    return original === null || original === undefined ? 'дубль' : `дубль #${original}`;
  }
  return labelFor(MESSAGE_FLAG_LABELS, flag);
}

// Коды предупреждений импорта, которые сервер сохраняет в ConversationDetail.warnings.
export const IMPORT_WARNING_LABELS = {
  UNKNOWN_SYSTEM_EVENT: 'нераспознанное системное событие',
  UNKNOWN_ROLE: 'неизвестная роль',
  EMPTY_TEXT: 'пустая реплика',
  UNPARSEABLE_TIMESTAMP: 'неразобранное время реплики',
  NON_MONOTONIC_TIMESTAMP: 'время реплик идёт не по порядку',
  UNKNOWN_CHANNEL: 'неизвестный канал',
  UNKNOWN_LANGUAGE: 'неизвестный язык',
  TOTAL_RECORDS_MISMATCH: 'заявленное число записей не совпадает с фактическим',
};

export const EVALUATION_STATUS_LABELS = {
  not_evaluated: 'Не оценён',
  completed: 'Оценён',
  manual_review: 'Нужна ручная проверка',
  failed: 'Ошибка оценки',
};

export const EVALUATION_STATUS_TONES = {
  not_evaluated: 'neutral',
  completed: 'good',
  manual_review: 'warn',
  failed: 'bad',
};

// «Запись №3, demo-ru, реплика №5»: record_index с нуля, message_id с единицы.
export function describeIssueLocation(issue) {
  const parts = [];
  if (issue && Number.isInteger(issue.record_index)) parts.push(`Запись №${issue.record_index + 1}`);
  if (issue && typeof issue.conversation_id === 'string' && issue.conversation_id) parts.push(issue.conversation_id);
  if (issue && Number.isInteger(issue.message_id)) parts.push(`реплика №${issue.message_id}`);
  return parts.join(', ');
}
