// Данные главной без DOM: показатели из ответов API и подпись провайдера.

// Каждое число — total страницы API с limit=1. «Оценено» — разговоры, у текущей ревизии которых есть оценка.
export function homeStats({ all, notEvaluated, manual, openAppeals, events }) {
  const total = (page) => (page && Number.isInteger(page.total) ? page.total : null);
  const conversations = total(all);
  const waiting = total(notEvaluated);
  return {
    conversations,
    evaluated: conversations === null || waiting === null ? null : Math.max(0, conversations - waiting),
    manualReview: total(manual),
    openAppeals: total(openAppeals),
    events: total(events),
  };
}

export function providerLabel(health) {
  if (!health) return { value: null, note: '' };
  if (health.is_demo === true) return { value: 'Демо', note: 'оценки синтетические' };
  return { value: health.model || health.provider || '—', note: health.model ? health.provider : '' };
}
