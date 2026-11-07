// Сравнение двух оценок одной ревизии разговора: итоги, разница и таблица по критериям.
// Числа приходят с сервера; разница — справа минус слева; null — «—», а не 0.
import { api } from '../api.js';
import { badge } from '../components/badge.js';
import { emptyState } from '../components/empty-state.js';
import { loadingState } from '../components/loading-state.js';
import { showError } from '../components/toast.js';
import { clear, h } from '../dom.js';
import { comparisonRows, deltaTone } from '../lib/compare.js';
import { isAbortError } from '../lib/errors.js';
import { DASH, formatDateTime, formatDelta, formatNumber } from '../lib/format.js';
import { EVALUATION_STATUS_LABELS, EVALUATION_STATUS_TONES, labelFor } from '../lib/labels.js';
import { buildHash } from '../lib/route.js';
import { getChecklistVersion, setViewDemo, state } from '../state.js';

// Минус как знак, а не дефис: «−0,15».
function signed(value, decimals) {
  return formatDelta(value, decimals).replace('-', '−');
}

function versionText(versionId, node, prefix = '') {
  getChecklistVersion(versionId)
    .then((version) => {
      node.textContent = `${prefix}Чек-лист v${version.version}`;
    })
    .catch(() => {
      node.textContent = `${prefix}версия чек-листа не загружена`;
    });
  return node;
}

export function mount(container, route) {
  const controller = new AbortController();
  let query = { left: route.query.left || null, right: route.query.right || null };
  let loadSeq = 0;

  const backLinks = h('div', { class: 'cqa-back-links' }, h('a', { class: 'cqa-back', href: state.lastListHash || '#/conversations', text: 'К списку разговоров' }));
  const facts = h('dl', { class: 'cqa-facts' });
  const body = h('div', { class: 'cqa-compare-body' }, loadingState('Загрузка сравнения…'));
  container.append(h(
    'section',
    { class: 'cqa-page cqa-compare' },
    h('div', { class: 'cqa-conv-head' }, backLinks, h('h1', { text: 'Сравнение оценок' }), facts),
    body,
  ));

  function fact(label, value) {
    return h('div', { class: 'cqa-fact' }, h('dt', { text: label }), h('dd', {}, value));
  }

  function renderEmpty() {
    setViewDemo(false);
    clear(facts);
    clear(body).append(emptyState({
      title: 'Выберите две оценки одного разговора.',
      hint: 'В карточке разговора в списке «Оценки этого разговора» нажмите «Сравнить с текущей». После новой версии чек-листа то же предлагает экран «Чек-лист».',
      action: h('a', { class: 'cqa-button', href: state.lastListHash || '#/conversations', text: 'К списку разговоров' }),
    }));
  }

  function renderError(error) {
    clear(facts);
    const hint = error.code === 'INCOMPARABLE_EVALUATIONS'
      ? 'Сравнивать можно только оценки одной ревизии разговора. Откройте карточку и выберите оценку той же ревизии.'
      : 'Проверьте ссылку или вернитесь к разговору.';
    clear(body).append(h(
      'div',
      { class: 'cqa-alert cqa-alert--bad', role: 'alert' },
      h('p', { class: 'cqa-alert-title', text: error.message }),
      h('p', { text: hint }),
      h('div', { class: 'cqa-actions' },
        h('button', { type: 'button', class: 'cqa-button', text: 'Повторить', on: { click: load } }),
        h('a', { class: 'cqa-button', href: state.lastListHash || '#/conversations', text: 'К списку разговоров' })),
    ));
  }

  function side(summary, label, finalRevision, decimals, ref) {
    const status = summary.status;
    const changedByAppeals = summary.original_total !== summary.final_total;
    return h(
      'section',
      { class: 'cqa-compare-side', 'aria-label': `Оценка ${label.toLowerCase()}` },
      h('p', { class: 'cqa-compare-side-label', text: label }),
      h('p', { class: 'cqa-compare-version' }, versionText(summary.checklist_version_id, h('span', { text: 'Чек-лист…' }))),
      h('p', { class: 'cqa-total-figure' },
        h('span', { class: 'cqa-compare-total', text: formatNumber(summary.final_total, decimals) }),
        typeof summary.final_total === 'number' ? h('span', { class: 'cqa-total-of', text: 'из 100' }) : null),
      changedByAppeals ? h('p', { class: 'cqa-muted cqa-small', text: `исходно ${formatNumber(summary.original_total, decimals)}, после апелляций` }) : null,
      h('p', { class: 'cqa-compare-meta' },
        h('span', { text: formatDateTime(summary.created_at) }),
        badge(labelFor(EVALUATION_STATUS_LABELS, status), EVALUATION_STATUS_TONES[status] || 'neutral'),
        summary.is_demo ? badge('Демо', 'demo') : null),
      finalRevision > 0 ? h('p', { class: 'cqa-muted cqa-small', text: `Решений по апелляциям: ${finalRevision}` }) : null,
      h('a', { href: buildHash('conversation', [ref.id], { evaluation: summary.id }), text: 'Открыть оценку' }),
    );
  }

  function deltaBlock(value, decimals) {
    const tone = deltaTone(value, decimals);
    return h(
      'div',
      { class: `cqa-compare-delta cqa-delta--${tone}` },
      h('p', { class: 'cqa-compare-side-label', text: 'Разница итога' }),
      h('p', { class: 'cqa-compare-delta-value', text: signed(value, decimals) }),
      h('p', { class: 'cqa-muted cqa-small', text: value === null || value === undefined ? 'итог одной из оценок не рассчитан' : 'справа минус слева' }),
    );
  }

  function answerCell(text, missingTitle, emphasise) {
    if (text === null) return h('td', { class: 'cqa-muted', title: missingTitle, text: DASH });
    return h('td', { class: emphasise ? 'cqa-compare-answer is-changed' : 'cqa-compare-answer' }, text);
  }

  function table(rows, decimals, leftLabel, rightLabel) {
    return h(
      'div',
      { class: 'cqa-table-wrap', role: 'region', tabindex: '0', 'aria-label': 'Сравнение критериев, прокручиваемая таблица' },
      h(
        'table',
        { class: 'cqa-table cqa-compare-table' },
        h('caption', { class: 'cqa-table-caption', text: 'Критерии: сначала в порядке правой версии, затем удалённые' }),
        h('thead', {}, h('tr', {},
          h('th', { scope: 'col', text: 'Критерий' }),
          h('th', { scope: 'col', text: 'Правило' }),
          h('th', { scope: 'col' }, leftLabel),
          h('th', { scope: 'col' }, rightLabel),
          h('th', { scope: 'col', class: 'cqa-num', text: 'Вклад в итог, разница' }))),
        h('tbody', {}, rows.map((row) => {
          const tone = deltaTone(row.delta, decimals);
          return h(
            'tr',
            { class: `cqa-compare-row cqa-compare-row--${row.change}` },
            h('th', { scope: 'row' }, h('span', { class: 'cqa-compare-name', text: row.name }), h('code', { class: 'cqa-compare-id', text: row.id })),
            h('td', {},
              badge(`${row.change === 'added' ? '+ ' : row.change === 'removed' ? '− ' : ''}${row.changeLabel}`, row.changeTone),
              row.weights ? h('div', { class: 'cqa-muted cqa-small', text: `вес ${formatNumber(row.weights.left, decimals)} → ${formatNumber(row.weights.right, decimals)}` }) : null),
            answerCell(row.left, 'Критерия нет в версии слева', false),
            answerCell(row.right, 'Критерия нет в версии справа', row.answerChanged),
            h('td', {
              class: `cqa-num cqa-delta--${tone}`,
              title: row.isFlag ? 'У флага нет вклада в итог' : (row.delta === null ? 'Нет второго результата для сравнения' : ''),
              text: signed(row.delta, decimals),
            }),
          );
        })),
      ),
    );
  }

  function render(comparison) {
    const ref = comparison.conversation;
    const policy = comparison.right.scoring_policy || comparison.left.scoring_policy || (state.health && state.health.scoring_policy) || null;
    const decimals = policy ? policy.decimals : undefined;
    setViewDemo(comparison.left.is_demo === true || comparison.right.is_demo === true);

    clear(backLinks).append(
      h('a', { class: 'cqa-back', href: buildHash('conversation', [ref.id], { evaluation: comparison.right.id }), text: 'К разговору' }),
      h('a', { class: 'cqa-back', href: state.lastListHash || '#/conversations', text: 'К списку разговоров' }),
    );
    clear(facts).append(
      fact('Разговор', h('a', { href: buildHash('conversation', [ref.id]), text: ref.conversation_id })),
      fact('Группа', ref.group_id),
      fact('Ревизия', String(ref.revision)),
    );

    const rows = comparisonRows(comparison);
    const changedRules = rows.filter((row) => row.change !== 'unchanged').length;
    const changedAnswers = rows.filter((row) => row.answerChanged).length;
    const leftHead = versionText(comparison.left.checklist_version_id, h('span', { text: 'Слева' }), 'Слева, ');
    const rightHead = versionText(comparison.right.checklist_version_id, h('span', { text: 'Справа' }), 'Справа, ');

    clear(body).append(
      h('div', { class: 'cqa-compare-summary' },
        side(comparison.left, 'Слева', comparison.left_final_revision, decimals, ref),
        deltaBlock(comparison.total_delta, decimals),
        side(comparison.right, 'Справа', comparison.right_final_revision, decimals, ref)),
      h('p', { class: 'cqa-compare-note', text: `Правил изменено: ${changedRules}, ответов изменилось: ${changedAnswers}. Сравнивается текущий итог каждой оценки с учётом решений по апелляциям.` }),
      rows.length ? table(rows, decimals, leftHead, rightHead) : emptyState({ title: 'В оценках нет критериев.' }),
    );
  }

  async function load() {
    if (!query.left || !query.right) {
      renderEmpty();
      return;
    }
    const seq = ++loadSeq;
    body.classList.add('is-loading');
    try {
      const comparison = await api.compareEvaluations(query.left, query.right, { signal: controller.signal });
      if (seq !== loadSeq) return;
      render(comparison);
    } catch (error) {
      if (isAbortError(error) || seq !== loadSeq) return;
      renderError(error);
      showError(error);
    } finally {
      if (seq === loadSeq) body.classList.remove('is-loading');
    }
  }

  load();

  return {
    update(nextRoute) {
      query = { left: nextRoute.query.left || null, right: nextRoute.query.right || null };
      load();
      return true;
    },
    destroy() {
      controller.abort();
    },
  };
}
