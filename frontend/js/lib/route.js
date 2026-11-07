// Разбор и сборка hash-адресов вида #/conversation/<id>?revision=...&evaluation=...
import { buildQuery } from './query.js';

export const DEFAULT_ROUTE = 'conversations';

function decode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function parseHash(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  const mark = raw.indexOf('?');
  const pathPart = mark === -1 ? raw : raw.slice(0, mark);
  const queryPart = mark === -1 ? '' : raw.slice(mark + 1);
  const segments = pathPart.split('/').filter(Boolean).map(decode);
  const query = {};
  for (const [key, value] of new URLSearchParams(queryPart)) {
    if (!(key in query)) query[key] = value;
  }
  return { name: segments[0] || DEFAULT_ROUTE, params: segments.slice(1), query };
}

export function buildHash(name, params = [], query = {}) {
  const path = [name, ...params.map((part) => encodeURIComponent(part))].join('/');
  return `#/${path}${buildQuery(query)}`;
}
