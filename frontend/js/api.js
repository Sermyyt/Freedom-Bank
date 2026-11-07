// Все запросы к API идут только через этот модуль.
// Успех: снимает конверт {data, meta} и возвращает data. Ошибка: бросает ApiError.
import { API_BASE } from './config.js';
import { ApiError, errorFromResponse } from './lib/errors.js';
import { buildQuery } from './lib/query.js';

export function createApi({ base = API_BASE, fetchImpl } = {}) {
  const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args));

  async function request(method, path, { query, json, form, signal } = {}) {
    const url = `${base}/api${path}${buildQuery(query)}`;
    const init = { method, headers: { Accept: 'application/json' } };
    if (signal) init.signal = signal;
    if (json !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(json);
    } else if (form !== undefined) {
      // Content-Type с границей multipart браузер выставляет сам.
      init.body = form;
    }

    let response;
    try {
      response = await doFetch(url, init);
    } catch (cause) {
      if (cause && cause.name === 'AbortError') throw cause;
      throw new ApiError({ status: 0 });
    }

    let body = null;
    try {
      body = await response.json();
    } catch (cause) {
      if (cause && cause.name === 'AbortError') throw cause;
      body = null;
    }

    if (!response.ok) {
      const retryAfter = response.headers && response.headers.get ? response.headers.get('Retry-After') : null;
      throw errorFromResponse(response.status, body, retryAfter);
    }
    if (!body || typeof body !== 'object' || !('data' in body)) {
      throw new ApiError({ status: response.status });
    }
    return body.data;
  }

  const id = (value) => encodeURIComponent(value);

  return {
    // POST никогда не повторяется автоматически: повтор создал бы второе задание или импорт.
    get: (path, query, options) => request('GET', path, { ...options, query }),
    post: (path, json) => request('POST', path, { json }),
    postForm: (path, form) => request('POST', path, { form }),

    getHealth: (options) => request('GET', '/health', options),
    listConversations: (query, options) => request('GET', '/conversations', { ...options, query }),
    getConversation: (conversationId, revisionId, options) =>
      request('GET', `/conversations/${id(conversationId)}`, { ...options, query: { revision_id: revisionId } }),
    importDataset: (groupId) => request('POST', '/imports/dataset', { json: { group_id: groupId } }),
    importFile: (file, groupId) => {
      const form = new FormData();
      form.append('file', file);
      if (groupId) form.append('group_id', groupId);
      return request('POST', '/imports/file', { form });
    },
    startEvaluation: (body) => request('POST', '/evaluations', { json: body }),
    getJob: (jobId, options) => request('GET', `/jobs/${id(jobId)}`, options),
    listEvaluations: (query, options) => request('GET', '/evaluations', { ...options, query }),
    getEvaluation: (evaluationId, options) => request('GET', `/evaluations/${id(evaluationId)}`, options),
    getChecklistVersion: (versionId, options) => request('GET', `/checklist-versions/${id(versionId)}`, options),
    createAppeal: (body) => request('POST', '/appeals', { json: body }),
    listAppeals: (query, options) => request('GET', '/appeals', { ...options, query }),
    getAppeal: (appealId, options) => request('GET', `/appeals/${id(appealId)}`, options),
    decideAppeal: (appealId, body) => request('POST', `/appeals/${id(appealId)}/decision`, { json: body }),
  };
}

export const api = createApi();
