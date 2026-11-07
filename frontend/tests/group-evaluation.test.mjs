import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createApi } from '../js/api.js';
import { buildGroupEvaluationRequest, groupJobSummary } from '../js/lib/group-evaluation.js';

const job = (status, counts) => ({
  id: 'job-1',
  status,
  total: 4,
  processed: counts.succeeded + counts.failed,
  succeeded: counts.succeeded,
  failed: counts.failed,
  manual_review_count: counts.manual ?? 0,
  progress_percent: (100 * (counts.succeeded + counts.failed)) / 4,
  items: [],
  error: null,
});

test('тело запроса оценки группы — ровно group_id, без revision_ids', () => {
  assert.deepEqual(buildGroupEvaluationRequest('  SYN-F1 '), { group_id: 'SYN-F1' });
  assert.deepEqual(Object.keys(buildGroupEvaluationRequest('DEV')), ['group_id']);
});

test('итог задания группы: готово, с ошибками, неудача', () => {
  assert.equal(
    groupJobSummary('SYN', job('completed', { succeeded: 4, failed: 0, manual: 2 })),
    'Группа SYN оценена: успешно 4 из 4, с ошибкой 0, на ручную проверку 2.',
  );
  assert.equal(
    groupJobSummary('SYN', job('failed', { succeeded: 3, failed: 1 })),
    'Группа SYN оценена с ошибками: успешно 3 из 4, с ошибкой 1, на ручную проверку 0.',
  );
  assert.equal(
    groupJobSummary('SYN', job('failed', { succeeded: 0, failed: 4 })),
    'Оценка группы SYN не удалась: успешно 0 из 4, с ошибкой 4, на ручную проверку 0.',
  );
  assert.equal(groupJobSummary('SYN', null), '');
});

test('api: оценка группы — POST /api/evaluations с телом {"group_id": …}, без повтора при ошибке', async () => {
  const calls = [];
  const api = createApi({
    base: '',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Группа не найдена.', details: [], retryable: false }, meta: { request_id: 'r' } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  await assert.rejects(api.startEvaluation(buildGroupEvaluationRequest('EMPTY')), { code: 'NOT_FOUND', message: 'Группа не найдена.' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/evaluations');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.body, '{"group_id":"EMPTY"}');
});
