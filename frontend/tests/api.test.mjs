import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createApi } from '../js/api.js';
import { ApiError, NETWORK_MESSAGE, fieldErrors, parseRetryAfter } from '../js/lib/errors.js';

function json(status, body, headers = {}) {
  return () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function fakeFetch(makeResponse) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return makeResponse(url, init);
  };
  return { calls, api: createApi({ base: '', fetchImpl }) };
}

const failure = (code, message, extra = {}) => ({
  error: { code, message, details: [], retryable: false, ...extra },
  meta: { request_id: 'req-1' },
});

test('успешный конверт → data', async () => {
  const { calls, api } = fakeFetch(json(200, { data: { status: 'ok', is_demo: true }, meta: { request_id: 'r' } }));
  assert.deepEqual(await api.getHealth(), { status: 'ok', is_demo: true });
  assert.equal(calls[0].url, '/api/health');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.body, undefined);
});

test('202 с заданием тоже снимает конверт', async () => {
  const { api } = fakeFetch(json(202, { data: { id: 'job-1', status: 'queued' }, meta: { request_id: 'r' } }));
  assert.deepEqual(await api.startEvaluation({ revision_ids: ['rev-1'] }), { id: 'job-1', status: 'queued' });
});

test('ошибка → ApiError с code, message, details, retryable, requestId', async () => {
  const details = [{ path: ['body', 'group_id'], code: 'missing', message: 'Неверное или отсутствующее значение.' }];
  const { api } = fakeFetch(json(422, failure('VALIDATION_ERROR', 'Проверьте поля запроса.', { details })));
  await assert.rejects(api.importDataset(''), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 422);
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.equal(error.message, 'Проверьте поля запроса.');
    assert.deepEqual(error.details, details);
    assert.equal(error.retryable, false);
    assert.equal(error.requestId, 'req-1');
    return true;
  });
});

test('409 конфликт сохраняет код сервера', async () => {
  const { api } = fakeFetch(json(409, failure('DUPLICATE_OPEN_APPEAL', 'Уже есть открытая апелляция.')));
  await assert.rejects(api.post('/appeals', { evaluation_id: 'e', criterion_id: 'c', comment: 'x' }), {
    name: 'ApiError',
    code: 'DUPLICATE_OPEN_APPEAL',
    status: 409,
  });
});

test('429 BUSY → «Сервер занят, повторите через N с» по Retry-After', async () => {
  const { api } = fakeFetch(json(429, failure('BUSY', 'Сервер перегружен.', { retryable: true }), { 'Retry-After': '3' }));
  await assert.rejects(api.getJob('job-1'), (error) => {
    assert.equal(error.code, 'BUSY');
    assert.equal(error.retryAfter, 3);
    assert.equal(error.retryable, true);
    assert.equal(error.message, 'Сервер занят, повторите через 3 с.');
    return true;
  });
});

test('не-JSON ответ с ошибкой → общая ошибка NETWORK_OR_SERVER', async () => {
  const { api } = fakeFetch(() => new Response('<html>Bad gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } }));
  await assert.rejects(api.getHealth(), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 502);
    assert.equal(error.code, 'NETWORK_OR_SERVER');
    assert.equal(error.message, NETWORK_MESSAGE);
    return true;
  });
});

test('200 без конверта тоже считается ошибкой сервера', async () => {
  const { api } = fakeFetch(() => new Response('ok', { status: 200 }));
  await assert.rejects(api.getHealth(), { code: 'NETWORK_OR_SERVER', status: 200 });
});

test('сбой сети → NETWORK_OR_SERVER со статусом 0', async () => {
  const { api } = fakeFetch(() => {
    throw new TypeError('Failed to fetch');
  });
  await assert.rejects(api.getHealth(), { name: 'ApiError', code: 'NETWORK_OR_SERVER', status: 0 });
});

test('отмена запроса не превращается в ApiError', async () => {
  const { api } = fakeFetch(() => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  });
  await assert.rejects(api.getHealth({ signal: new AbortController().signal }), { name: 'AbortError' });
});

test('пустые фильтры не попадают в запрос, булевы — строками', async () => {
  const { calls, api } = fakeFetch(json(200, { data: { items: [], total: 0, limit: 25, offset: 0 }, meta: { request_id: 'r' } }));
  await api.listConversations({ group_id: 'SYN', language: '', q: null, channel: undefined, has_gross_error: 'true', limit: 25, offset: 0 });
  assert.equal(calls[0].url, '/api/conversations?group_id=SYN&has_gross_error=true&limit=25&offset=0');
});

test('ID в пути кодируются, revision_id передаётся только если задан', async () => {
  const { calls, api } = fakeFetch(json(200, { data: {}, meta: { request_id: 'r' } }));
  await api.getConversation('a/b', 'rev 1');
  await api.getConversation('c', undefined);
  assert.equal(calls[0].url, '/api/conversations/a%2Fb?revision_id=rev+1');
  assert.equal(calls[1].url, '/api/conversations/c');
});

test('адрес API берётся из base', async () => {
  const calls = [];
  const api = createApi({
    base: 'http://127.0.0.1:8000',
    fetchImpl: async (url) => {
      calls.push(url);
      return json(200, { data: 1, meta: { request_id: 'r' } })();
    },
  });
  await api.getHealth();
  assert.equal(calls[0], 'http://127.0.0.1:8000/api/health');
});

test('POST отправляет ровно JSON тела с Content-Type', async () => {
  const { calls, api } = fakeFetch(json(202, { data: { id: 'j' }, meta: { request_id: 'r' } }));
  await api.startEvaluation({ revision_ids: ['rev-1'] });
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].init.body, '{"revision_ids":["rev-1"]}');
});

test('загрузка файла — FormData с file и необязательным group_id, без ручного Content-Type', async () => {
  const { calls, api } = fakeFetch(json(200, { data: { received: 1 }, meta: { request_id: 'r' } }));
  const file = new Blob(['[]'], { type: 'application/json' });
  await api.importFile(file, 'SYN');
  await api.importFile(file, null);
  const [withGroup, withoutGroup] = calls.map((call) => call.init);
  assert.ok(withGroup.body instanceof FormData);
  assert.equal(withGroup.headers['Content-Type'], undefined);
  assert.deepEqual([...withGroup.body.keys()], ['file', 'group_id']);
  assert.equal(withGroup.body.get('group_id'), 'SYN');
  assert.deepEqual([...withoutGroup.body.keys()], ['file']);
});

test('POST после ошибки сервера не повторяется автоматически', async () => {
  const { calls, api } = fakeFetch(json(500, failure('INTERNAL_ERROR', 'Внутренняя ошибка сервера.')));
  await assert.rejects(api.startEvaluation({ group_id: 'SYN' }), { code: 'INTERNAL_ERROR' });
  assert.equal(calls.length, 1);
});

test('fieldErrors: путь без body/query превращается в ключ поля', () => {
  assert.deepEqual(
    fieldErrors([
      { path: ['body', 'group_id'], code: 'missing', message: 'Нет группы' },
      { path: ['body', 'criteria', 0, 'weight'], code: 'x', message: 'Вес' },
      { path: ['body'], code: 'value_error', message: 'Тело' },
      { path: ['query', 'limit'], code: 'x', message: 'Лимит' },
    ]),
    { group_id: 'Нет группы', 'criteria.0.weight': 'Вес', '': 'Тело', limit: 'Лимит' },
  );
  assert.deepEqual(fieldErrors(undefined), {});
});

test('Retry-After: секунды и HTTP-дата', () => {
  assert.equal(parseRetryAfter('1'), 1);
  assert.equal(parseRetryAfter('2.2'), 3);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter('abc'), null);
  const now = Date.parse('2026-11-07T12:00:00Z');
  assert.equal(parseRetryAfter('Sat, 07 Nov 2026 12:00:05 GMT', now), 5);
});
