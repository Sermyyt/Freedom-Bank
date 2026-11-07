// Фильтры списка разговоров: значения из адреса приводятся к тому, что принимает сервер.
// Неверные значения отбрасываются, чтобы не получить 422 из-за испорченной ссылки.

export const PAGE_SIZES = [25, 50, 100];
export const DEFAULT_PAGE_SIZE = 25;
export const EVALUATION_STATUSES = ['not_evaluated', 'completed', 'manual_review', 'failed'];
export const TEXT_FILTERS = ['group_id', 'language', 'channel', 'q'];
export const BOOLEAN_FILTERS = ['has_gross_error', 'has_open_appeals'];
const BOOLEAN_VALUES = ['true', 'false'];

export function normalizePageSize(value, fallback = DEFAULT_PAGE_SIZE) {
  const size = Number(value);
  if (PAGE_SIZES.includes(size)) return size;
  return PAGE_SIZES.includes(Number(fallback)) ? Number(fallback) : DEFAULT_PAGE_SIZE;
}

export function normalizeListQuery(query = {}, fallbackLimit = DEFAULT_PAGE_SIZE) {
  const result = {};
  for (const key of TEXT_FILTERS) {
    const value = typeof query[key] === 'string' ? query[key].trim() : '';
    if (value) result[key] = value;
  }
  if (EVALUATION_STATUSES.includes(query.evaluation_status)) result.evaluation_status = query.evaluation_status;
  for (const key of BOOLEAN_FILTERS) {
    if (BOOLEAN_VALUES.includes(query[key])) result[key] = query[key];
  }
  result.limit = normalizePageSize(query.limit, fallbackLimit);
  const offset = Number(query.offset);
  result.offset = Number.isInteger(offset) && offset > 0 ? offset : 0;
  return result;
}

export function hasActiveFilters(query) {
  return [...TEXT_FILTERS, 'evaluation_status', ...BOOLEAN_FILTERS].some((key) => Boolean(query && query[key]));
}

// Параметры для адреса: без значений по умолчанию, чтобы ссылка оставалась короткой.
export function listQueryToHash(query) {
  const result = { ...query };
  if (result.limit === DEFAULT_PAGE_SIZE) delete result.limit;
  if (!result.offset) delete result.offset;
  return result;
}

export function pageRange(page) {
  if (!page || !page.total || !page.items || page.items.length === 0) return null;
  return { from: page.offset + 1, to: page.offset + page.items.length, total: page.total };
}
