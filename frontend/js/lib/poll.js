// Опрос задания оценки: GET /api/jobs/{id} раз в секунду до completed или failed.
// Модуль получает только функцию чтения задания, поэтому повторить POST он не может.

export const TERMINAL_JOB_STATUSES = ['completed', 'failed'];

export function isTerminalJob(job) {
  return Boolean(job) && TERMINAL_JOB_STATUSES.includes(job.status);
}

function abortError() {
  const error = new Error('Опрос задания остановлен.');
  error.name = 'AbortError';
  return error;
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function isRetryable(error) {
  return Boolean(error) && (error.status === 0 || error.status === 429 || error.status === 503 || error.retryable === true);
}

export async function pollJob({ job, getJob, onUpdate, signal, intervalMs = 1000, maxErrors = 5, wait = sleep }) {
  let current = job;
  let errors = 0;
  let delay = intervalMs;
  if (onUpdate) onUpdate(current);
  while (!isTerminalJob(current)) {
    await wait(delay, signal);
    if (signal && signal.aborted) throw abortError();
    delay = intervalMs;
    try {
      current = await getJob(current.id, signal);
      errors = 0;
    } catch (error) {
      if (error && error.name === 'AbortError') throw error;
      errors += 1;
      if (!isRetryable(error) || errors >= maxErrors) throw error;
      if (error.retryAfter) delay = Math.max(intervalMs, error.retryAfter * 1000);
      continue;
    }
    if (onUpdate) onUpdate(current);
  }
  return current;
}

// Сводка задания для интерфейса. failed при части успешных элементов — «готово с ошибками».
export function describeJob(job) {
  if (!job) return null;
  let label;
  let tone;
  if (job.status === 'completed') {
    label = 'Готово';
    tone = 'good';
  } else if (job.status === 'failed') {
    label = job.succeeded > 0 ? 'Готово с ошибками' : 'Ошибка';
    tone = job.succeeded > 0 ? 'partial' : 'bad';
  } else if (job.status === 'running') {
    label = 'Выполняется';
    tone = 'info';
  } else if (job.status === 'queued') {
    label = 'В очереди';
    tone = 'neutral';
  } else {
    label = String(job.status);
    tone = 'neutral';
  }
  const percent = typeof job.progress_percent === 'number' ? Math.min(100, Math.max(0, job.progress_percent)) : 0;
  const items = Array.isArray(job.items) ? job.items : [];
  return {
    label,
    tone,
    finished: isTerminalJob(job),
    percent,
    processed: job.processed,
    total: job.total,
    succeeded: job.succeeded,
    failed: job.failed,
    manualReview: job.manual_review_count,
    itemErrors: items
      .filter((item) => item && item.error)
      .map((item) => ({ revisionId: item.revision_id, code: item.error.code, message: item.error.message })),
    jobError: job.error ? job.error.message : null,
    evaluationIds: items.map((item) => item.evaluation_id).filter(Boolean),
  };
}
