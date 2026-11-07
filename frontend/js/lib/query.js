// Строка запроса без пустых значений: сервер отклоняет неизвестные и повторные параметры,
// а пустой параметр стал бы фильтром по пустой строке.
export function buildQuery(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    search.append(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}
