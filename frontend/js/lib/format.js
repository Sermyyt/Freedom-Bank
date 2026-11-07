// Форматирование для показа. Баллы приходят с сервера готовыми: здесь их не пересчитывают,
// а только выводят с scoring_policy.decimals знаками.

export const DASH = '—';
const NBSP = ' ';
const numberFormats = new Map();
const dateFormats = new Map();

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function normalizeDecimals(decimals) {
  return Number.isInteger(decimals) && decimals >= 0 && decimals <= 8 ? decimals : 2;
}

function numberFormat(decimals, signed) {
  const key = `${decimals}:${signed}`;
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat('ru-RU', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      ...(signed ? { signDisplay: 'exceptZero' } : {}),
    });
    numberFormats.set(key, format);
  }
  return format;
}

// Значение, которое при выводе стало бы «-0,00», показываем как ноль.
function withoutNegativeZero(value, decimals) {
  return Math.abs(value) < 0.5 * 10 ** -decimals ? 0 : value;
}

export function formatNumber(value, decimals) {
  if (!isNumber(value)) return DASH;
  const places = normalizeDecimals(decimals);
  return numberFormat(places, false).format(withoutNegativeZero(value, places));
}

// Разница со знаком: «+0,89», «-0,15», «0,00»; null — «—», а не ноль.
export function formatDelta(value, decimals) {
  if (!isNumber(value)) return DASH;
  const places = normalizeDecimals(decimals);
  return numberFormat(places, true).format(withoutNegativeZero(value, places));
}

export function formatPercent(value, decimals) {
  return isNumber(value) ? `${formatNumber(value, decimals)}${NBSP}%` : DASH;
}

export function formatDateTime(iso, timeZone) {
  if (typeof iso !== 'string' || !iso) return DASH;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const key = timeZone || '';
  let format = dateFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      ...(timeZone ? { timeZone } : {}),
    });
    dateFormats.set(key, format);
  }
  return format.format(date);
}

// Время реплики: MM:SS показываем как есть, у ISO-меток — только время суток из самой строки.
const ISO_CLOCK = /^\d{4}-\d{2}-\d{2}[T ](\d{2}:\d{2}:\d{2})/;

export function displayTimestamp(timestamp) {
  if (typeof timestamp !== 'string') return '';
  const match = ISO_CLOCK.exec(timestamp);
  return match ? match[1] : timestamp;
}

// pluralRu(5, ['сообщение', 'сообщения', 'сообщений']) → 'сообщений'
export function pluralRu(count, [one, few, many]) {
  const n = Math.abs(Math.trunc(count)) % 100;
  const last = n % 10;
  if (n > 10 && n < 20) return many;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}
