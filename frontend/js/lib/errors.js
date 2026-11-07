// Разбор ошибок API в один объект. Сообщение сервера уже безопасный русский текст.

export const NETWORK_MESSAGE =
  'Сервер недоступен или вернул неожиданный ответ. Проверьте, что бэкенд запущен, и повторите.';

export class ApiError extends Error {
  constructor({
    status = 0,
    code = 'NETWORK_OR_SERVER',
    message = NETWORK_MESSAGE,
    details = [],
    retryable = false,
    requestId = null,
    retryAfter = null,
  } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryable = retryable;
    this.requestId = requestId;
    this.retryAfter = retryAfter;
  }
}

// Retry-After: число секунд или HTTP-дата.
export function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - now) / 1000));
  return null;
}

export function busyMessage(seconds) {
  return seconds === null || seconds === undefined
    ? 'Сервер занят, повторите позже.'
    : `Сервер занят, повторите через ${seconds} с.`;
}

export function errorFromResponse(status, body, retryAfterHeader = null) {
  const error = body && typeof body === 'object' ? body.error : null;
  const requestId = body && typeof body === 'object' && body.meta ? body.meta.request_id ?? null : null;
  if (!error || typeof error !== 'object' || typeof error.message !== 'string') {
    return new ApiError({ status, requestId });
  }
  const retryAfter = status === 429 ? parseRetryAfter(retryAfterHeader) : null;
  return new ApiError({
    status,
    code: typeof error.code === 'string' ? error.code : 'NETWORK_OR_SERVER',
    message: status === 429 ? busyMessage(retryAfter) : error.message,
    details: Array.isArray(error.details) ? error.details : [],
    retryable: error.retryable === true,
    requestId,
    retryAfter,
  });
}

export function isAbortError(error) {
  return Boolean(error) && error.name === 'AbortError';
}

// details[].path → ключ поля формы: ["body","criteria",0,"weight"] → "criteria.0.weight".
export function fieldKey(path) {
  const parts = Array.isArray(path) ? [...path] : [];
  if (parts.length && ['body', 'query', 'path', 'form'].includes(parts[0])) parts.shift();
  return parts.join('.');
}

// Сообщения ошибок по полям; ошибки без поля — под ключом ''.
export function fieldErrors(details) {
  const result = {};
  for (const detail of Array.isArray(details) ? details : []) {
    if (!detail || typeof detail.message !== 'string') continue;
    const key = fieldKey(detail.path);
    if (!(key in result)) result[key] = detail.message;
  }
  return result;
}
