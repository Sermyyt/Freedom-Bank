import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hasActiveFilters, listQueryToHash, normalizeListQuery, normalizePageSize, pageRange } from '../js/lib/filters.js';
import { buildQuery } from '../js/lib/query.js';
import { buildHash, parseHash } from '../js/lib/route.js';

test('parseHash: маршрут, параметры и query', () => {
  assert.deepEqual(parseHash('#/conversation/abc-1?revision=r1&evaluation=e1'), {
    name: 'conversation',
    params: ['abc-1'],
    query: { revision: 'r1', evaluation: 'e1' },
  });
  assert.deepEqual(parseHash(''), { name: 'conversations', params: [], query: {} });
  assert.deepEqual(parseHash('#/conversations?q=a%20b&q=second'), { name: 'conversations', params: [], query: { q: 'a b' } });
  assert.deepEqual(parseHash('#/conversation/%E0%A4%A').params, ['%E0%A4%A']);
});

test('buildHash ↔ parseHash', () => {
  const hash = buildHash('compare', [], { left: 'e 1', right: 'e/2' });
  assert.equal(hash, '#/compare?left=e+1&right=e%2F2');
  assert.deepEqual(parseHash(hash).query, { left: 'e 1', right: 'e/2' });
  assert.equal(buildHash('conversation', ['a/b']), '#/conversation/a%2Fb');
  assert.deepEqual(parseHash(buildHash('conversation', ['a/b'])).params, ['a/b']);
});

test('buildQuery пропускает пустые значения', () => {
  assert.equal(buildQuery({ a: '', b: null, c: undefined, d: 0, e: false, f: 'x y' }), '?d=0&e=false&f=x+y');
  assert.equal(buildQuery({}), '');
  assert.equal(buildQuery(undefined), '');
});

test('фильтры из адреса приводятся к допустимым значениям', () => {
  assert.deepEqual(
    normalizeListQuery({
      group_id: ' DEV ',
      language: '',
      channel: 'voice call',
      q: '  ',
      evaluation_status: 'manual_review',
      has_gross_error: 'true',
      has_open_appeals: 'yes',
      limit: '50',
      offset: '25',
      foo: 'bar',
    }),
    { group_id: 'DEV', channel: 'voice call', evaluation_status: 'manual_review', has_gross_error: 'true', limit: 50, offset: 25 },
  );
  assert.deepEqual(normalizeListQuery({ limit: '7', offset: '-3', evaluation_status: 'bad' }), { limit: 25, offset: 0 });
  assert.deepEqual(normalizeListQuery({}, 100), { limit: 100, offset: 0 });
  assert.equal(normalizePageSize('100'), 100);
  assert.equal(normalizePageSize('13', 50), 50);
});

test('адрес списка без значений по умолчанию', () => {
  assert.deepEqual(listQueryToHash({ group_id: 'G', limit: 25, offset: 0 }), { group_id: 'G' });
  assert.deepEqual(listQueryToHash({ limit: 50, offset: 50 }), { limit: 50, offset: 50 });
  assert.equal(hasActiveFilters({ limit: 25, offset: 0 }), false);
  assert.equal(hasActiveFilters({ has_open_appeals: 'false' }), true);
});

test('диапазон страницы', () => {
  assert.deepEqual(pageRange({ items: [1, 2, 3], total: 30, limit: 25, offset: 25 }), { from: 26, to: 28, total: 30 });
  assert.equal(pageRange({ items: [], total: 0, limit: 25, offset: 0 }), null);
  assert.equal(pageRange(null), null);
});
