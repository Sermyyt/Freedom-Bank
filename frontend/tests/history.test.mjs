import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createApi } from '../js/api.js';
import {
  HISTORY_ACTOR_LABELS,
  eventLabel,
  eventLinks,
  hasHistoryFilters,
  historyApiQuery,
  historyQueryToHash,
  normalizeHistoryQuery,
} from '../js/lib/history.js';
import { labelFor } from '../js/lib/labels.js';

test('события человеческими словами; неизвестный тип — как есть', () => {
  assert.equal(eventLabel('appeal_resolved'), 'Решение по апелляции');
  assert.equal(eventLabel('checklist_version_activated'), 'Применена версия чек-листа');
  assert.equal(eventLabel('evaluation_created'), 'Оценка разговора');
  assert.equal(eventLabel('something_new'), 'something_new');
  assert.equal(labelFor(HISTORY_ACTOR_LABELS, 'demo_reviewer'), 'Проверяющий (демо)');
  assert.equal(labelFor(HISTORY_ACTOR_LABELS, 'robot'), 'robot');
});

test('фильтры из адреса: известный тип, разговор, страница; мусор отбрасывается', () => {
  assert.deepEqual(normalizeHistoryQuery({}), { limit: 25, offset: 0 });
  assert.deepEqual(
    normalizeHistoryQuery({ event_type: 'appeal_created', conversation_id: ' c-1 ', limit: '50', offset: '50' }),
    { event_type: 'appeal_created', conversation_id: 'c-1', limit: 50, offset: 50 },
  );
  assert.deepEqual(normalizeHistoryQuery({ event_type: 'drop table', offset: '-1', limit: '7' }), { limit: 25, offset: 0 });
  assert.equal(hasHistoryFilters(normalizeHistoryQuery({ conversation_id: 'c-1' })), true);
  assert.equal(hasHistoryFilters(normalizeHistoryQuery({ limit: '50' })), false);
});

test('адрес без значений по умолчанию; в API — только поля фильтров контракта', () => {
  const query = normalizeHistoryQuery({ event_type: 'evaluation_created', conversation_id: 'c-1', offset: '25' });
  assert.deepEqual(historyQueryToHash(query), { event_type: 'evaluation_created', conversation_id: 'c-1', offset: 25 });
  assert.deepEqual(historyQueryToHash(normalizeHistoryQuery({})), {});
  assert.deepEqual(Object.keys(historyApiQuery(query)), ['event_type', 'conversation_id', 'limit', 'offset']);
});

test('ссылки события: разговор, оценка, апелляция с панелью решения, версия чек-листа', () => {
  const appeal = { event_type: 'appeal_resolved', conversation_id: 'c 1', evaluation_id: 'e1', appeal_id: 'a1', checklist_version_id: null };
  assert.deepEqual(eventLinks(appeal).map((link) => [link.kind, link.href]), [
    ['conversation', '#/conversation/c%201'],
    ['evaluation', '#/conversation/c%201?evaluation=e1'],
    ['appeal', '#/conversation/c%201?evaluation=e1&appeal=a1'],
  ]);
  const version = { event_type: 'checklist_version_created', conversation_id: null, evaluation_id: null, appeal_id: null, checklist_version_id: 'v2' };
  assert.deepEqual(eventLinks(version), [{ kind: 'checklist', href: '#/checklist', versionId: 'v2' }]);
  const imported = { event_type: 'dataset_imported', conversation_id: null, evaluation_id: null, appeal_id: null, checklist_version_id: null };
  assert.deepEqual(eventLinks(imported), []);
  assert.deepEqual(eventLinks(null), []);
});

test('api: GET /api/history с фильтрами, пустые не уходят', async () => {
  const calls = [];
  const api = createApi({
    base: '',
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response(JSON.stringify({ data: { items: [], total: 0, limit: 25, offset: 0 }, meta: { request_id: 'r' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  await api.listHistory(historyApiQuery(normalizeHistoryQuery({})));
  await api.listHistory(historyApiQuery(normalizeHistoryQuery({ event_type: 'appeal_created', conversation_id: 'c-1' })));
  assert.deepEqual(calls, [
    '/api/history?limit=25&offset=0',
    '/api/history?event_type=appeal_created&conversation_id=c-1&limit=25&offset=0',
  ]);
});
