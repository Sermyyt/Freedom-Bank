import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApiError } from '../js/lib/errors.js';
import { describeJob, pollJob } from '../js/lib/poll.js';

const job = (status, extra = {}) => ({
  id: 'job-1',
  status,
  total: 1,
  processed: status === 'completed' || status === 'failed' ? 1 : 0,
  succeeded: status === 'completed' ? 1 : 0,
  failed: status === 'failed' ? 1 : 0,
  manual_review_count: 0,
  progress_percent: status === 'completed' || status === 'failed' ? 100 : 0,
  items: [],
  error: null,
  ...extra,
});

// Без настоящих таймеров: ожидание записывается и сразу завершается.
function harness(responses) {
  const waits = [];
  const calls = [];
  const queue = [...responses];
  return {
    waits,
    calls,
    wait: async (ms) => {
      waits.push(ms);
    },
    getJob: async (id) => {
      calls.push(id);
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

test('опрос раз в секунду до completed', async () => {
  const h = harness([job('running'), job('running'), job('completed')]);
  const updates = [];
  const result = await pollJob({ job: job('queued'), getJob: h.getJob, wait: h.wait, onUpdate: (j) => updates.push(j.status) });
  assert.equal(result.status, 'completed');
  assert.deepEqual(updates, ['queued', 'running', 'running', 'completed']);
  assert.deepEqual(h.waits, [1000, 1000, 1000]);
  assert.equal(h.calls.length, 3);
});

test('опрос останавливается на failed', async () => {
  const h = harness([job('failed'), job('completed')]);
  const result = await pollJob({ job: job('running'), getJob: h.getJob, wait: h.wait });
  assert.equal(result.status, 'failed');
  assert.equal(h.calls.length, 1);
});

test('уже завершённое задание не опрашивается', async () => {
  const h = harness([]);
  const result = await pollJob({ job: job('completed'), getJob: h.getJob, wait: h.wait });
  assert.equal(result.status, 'completed');
  assert.equal(h.calls.length, 0);
});

test('опрос не повторяет POST: использует только чтение задания', async () => {
  const api = {
    posts: 0,
    gets: 0,
    post() {
      this.posts += 1;
    },
    async getJob() {
      this.gets += 1;
      return job('completed');
    },
  };
  await pollJob({ job: job('queued'), getJob: (id) => api.getJob(id), wait: async () => {} });
  assert.equal(api.posts, 0);
  assert.equal(api.gets, 1);
});

test('временная ошибка сети не прерывает опрос, Retry-After увеличивает паузу', async () => {
  const busy = new ApiError({ status: 429, code: 'BUSY', retryable: true, retryAfter: 3 });
  const h = harness([new ApiError({ status: 0 }), busy, job('completed')]);
  const result = await pollJob({ job: job('queued'), getJob: h.getJob, wait: h.wait });
  assert.equal(result.status, 'completed');
  assert.deepEqual(h.waits, [1000, 1000, 3000]);
});

test('неповторяемая ошибка прерывает опрос', async () => {
  const h = harness([new ApiError({ status: 404, code: 'NOT_FOUND', message: 'Объект не найден.' })]);
  await assert.rejects(pollJob({ job: job('queued'), getJob: h.getJob, wait: h.wait }), { code: 'NOT_FOUND' });
});

test('после пяти временных ошибок подряд опрос сдаётся', async () => {
  const h = harness(Array.from({ length: 6 }, () => new ApiError({ status: 0 })));
  await assert.rejects(pollJob({ job: job('queued'), getJob: h.getJob, wait: h.wait }), { code: 'NETWORK_OR_SERVER' });
  assert.equal(h.calls.length, 5);
});

test('уход с экрана останавливает опрос', async () => {
  const controller = new AbortController();
  const h = harness([job('running'), job('running'), job('completed')]);
  const promise = pollJob({
    job: job('queued'),
    getJob: h.getJob,
    signal: controller.signal,
    onUpdate: (j) => {
      if (j.status === 'running') controller.abort();
    },
    wait: async () => {},
  });
  await assert.rejects(promise, { name: 'AbortError' });
  assert.equal(h.calls.length, 1);
});

test('настоящая пауза отменяется сигналом', async () => {
  const controller = new AbortController();
  const promise = pollJob({ job: job('queued'), getJob: async () => job('completed'), signal: controller.signal, intervalMs: 60000 });
  controller.abort();
  await assert.rejects(promise, { name: 'AbortError' });
});

test('сводка задания: failed с успешными элементами — «готово с ошибками»', () => {
  const partial = describeJob(job('failed', {
    total: 3,
    processed: 3,
    succeeded: 2,
    failed: 1,
    manual_review_count: 1,
    items: [
      { revision_id: 'r1', status: 'completed', evaluation_id: 'e1', error: null },
      { revision_id: 'r2', status: 'failed', evaluation_id: null, error: { code: 'PROVIDER_ERROR', message: 'Модель не ответила.', retryable: true } },
      { revision_id: 'r3', status: 'completed', evaluation_id: 'e3', error: null },
    ],
  }));
  assert.equal(partial.label, 'Готово с ошибками');
  assert.equal(partial.finished, true);
  assert.equal(partial.manualReview, 1);
  assert.deepEqual(partial.itemErrors, [{ revisionId: 'r2', code: 'PROVIDER_ERROR', message: 'Модель не ответила.' }]);
  assert.deepEqual(partial.evaluationIds, ['e1', 'e3']);
  assert.equal(describeJob(job('failed')).label, 'Ошибка');
  assert.equal(describeJob(job('completed')).label, 'Готово');
  assert.equal(describeJob(job('queued')).finished, false);
  assert.equal(describeJob(job('paused')).label, 'paused');
  assert.equal(describeJob(null), null);
});
