// Карточка разговора — главный экран защиты: переписка с фазами слева, оценка по чек-листу справа.
// Доказательства раскрываются в той ревизии, к которой относится оценка.
import { api } from '../api.js';
import { badge } from '../components/badge.js';
import { emptyState } from '../components/empty-state.js';
import { createJobProgress } from '../components/job-progress.js';
import { showError, showToast } from '../components/toast.js';
import { append, clear, h } from '../dom.js';
import { answerTone, formatAnswer } from '../lib/answers.js';
import { isAbortError } from '../lib/errors.js';
import {
  chooseEvaluation,
  comparableWith,
  criterionRows,
  groupBySection,
  rangeIds,
  sectionTitle,
  totalsDiffer,
  violatedFlags,
} from '../lib/evaluation.js';
import { DASH, displayTimestamp, formatDateTime, formatNumber, formatPercent } from '../lib/format.js';
import {
  CHANNEL_LABELS,
  EVALUATION_STATUS_LABELS,
  EVALUATION_STATUS_TONES,
  EVENT_LABELS,
  IMPORT_WARNING_LABELS,
  ROLE_LABELS,
  labelFor,
  messageFlagLabel,
} from '../lib/labels.js';
import { groupTranscript, isClientFacingPhase, isHiddenFromClientPhase, phaseLabel } from '../lib/phases.js';
import { describeJob, pollJob } from '../lib/poll.js';
import { buildHash } from '../lib/route.js';
import { getChecklistVersion, setViewDemo, state, subscribe } from '../state.js';

const KNOWN_ROLES = ['client', 'operator', 'bot', 'system'];
const KNOWN_PHASES = ['pre_operator', 'client', 'hold', 'internal_consult', 'after_end'];
const VERDICT_MARKS = { good: '✓', bad: '✕', partial: '◐', na: '–', invalid: '?' };
const FLAG_TONES = { duplicate_of_prev: 'neutral', after_end: 'neutral', pii_masked: 'info', unknown_event: 'partial' };
const EXCERPT = 160;

function excerpt(text) {
  const value = String(text || '');
  return value.length > EXCERPT ? `${value.slice(0, EXCERPT - 1)}…` : value;
}

function prefersReducedMotion() {
  return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

function healthDecimals() {
  return state.health && state.health.scoring_policy ? state.health.scoring_policy.decimals : undefined;
}

export function mount(container, route) {
  const conversationId = route.params[0];
  let params = { evaluationId: route.query.evaluation || null, revisionId: route.query.revision || null };
  const controller = new AbortController();
  let pollController = null;
  let loadSeq = 0;
  let current = null;
  let shown = null;
  let evaluation = null;
  let summaries = [];
  let summariesTotal = 0;
  let jobRunning = false;
  let jobEvaluationId = null;
  let audio = null;
  const messageNodes = new Map();

  // ---------- Каркас ----------
  const backLink = h('a', { class: 'cqa-back', href: state.lastListHash || '#/conversations', text: 'К списку разговоров' });
  const title = h('h1', { class: 'cqa-conv-title', text: 'Разговор' });
  const facts = h('dl', { class: 'cqa-facts' });
  const notices = h('div', { class: 'cqa-conv-notices' });
  const transcriptPane = h('section', { class: 'cqa-pane cqa-transcript-pane', 'aria-labelledby': 'cqa-transcript-title' });
  const scorePane = h('section', { class: 'cqa-pane cqa-score-pane', 'aria-labelledby': 'cqa-score-title' });
  const grid = h('div', { class: 'cqa-conv-grid' }, transcriptPane, scorePane);

  const evaluateButton = h('button', { type: 'button', class: 'cqa-button cqa-button--primary', text: 'Оценить', on: { click: startEvaluation } });
  const evaluateHint = h('p', { class: 'cqa-field-hint', hidden: true });
  const evaluateError = h('div', { class: 'cqa-form-error', role: 'alert', hidden: true });
  const jobProgress = createJobProgress();
  const scoreBody = h('div', { class: 'cqa-score-body' });
  scorePane.append(
    h('div', { class: 'cqa-pane-head' }, h('h2', { id: 'cqa-score-title', text: 'Оценка' }), evaluateButton),
    h('div', { class: 'cqa-evaluate' }, evaluateHint, evaluateError, jobProgress.el),
    scoreBody,
  );
  transcriptPane.append(
    h('div', { class: 'cqa-pane-head' }, h('h2', { id: 'cqa-transcript-title', text: 'Переписка' })),
    h('p', { class: 'cqa-loading', text: 'Загрузка разговора…' }),
  );

  container.append(
    h(
      'div',
      { class: 'cqa-page cqa-conv' },
      h('div', { class: 'cqa-conv-head' }, backLink, title, facts),
      notices,
      grid,
    ),
  );

  // ---------- Загрузка ----------
  async function fetchEvaluation(summary, signal) {
    if (!summary) return null;
    try {
      const full = await api.getEvaluation(summary.id, { signal });
      if (!full.conversation || full.conversation.id !== conversationId) {
        showToast('Оценка из адреса относится к другому разговору; показана последняя оценка этого разговора.', { tone: 'error' });
        return null;
      }
      return full;
    } catch (error) {
      if (isAbortError(error) || error.status !== 404) throw error;
      showToast('Оценка из адреса не найдена; показана последняя оценка разговора.', { tone: 'error' });
      return null;
    }
  }

  async function load() {
    const seq = ++loadSeq;
    const { signal } = controller;
    grid.classList.add('is-loading');
    try {
      const [latest, page] = await Promise.all([
        api.getConversation(conversationId, undefined, { signal }),
        api.listEvaluations({ conversation_id: conversationId, limit: 100 }, { signal }),
      ]);
      if (seq !== loadSeq) return;
      let full = await fetchEvaluation(chooseEvaluation(page.items, params), signal);
      if (!full && params.evaluationId) {
        full = await fetchEvaluation(chooseEvaluation(page.items, { revisionId: params.revisionId }), signal);
      }
      const revisionId = full ? full.conversation.revision_id : params.revisionId || latest.ref.revision_id;
      const detail = revisionId === latest.ref.revision_id
        ? latest
        : await api.getConversation(conversationId, revisionId, { signal });
      if (seq !== loadSeq) return;
      current = latest;
      shown = detail;
      evaluation = full;
      summaries = page.items;
      summariesTotal = page.total;
      render();
    } catch (error) {
      if (isAbortError(error) || seq !== loadSeq) return;
      renderLoadError(error);
    } finally {
      if (seq === loadSeq) grid.classList.remove('is-loading');
    }
  }

  function renderLoadError(error) {
    clear(notices).append(
      h(
        'div',
        { class: 'cqa-alert cqa-alert--bad', role: 'alert' },
        h('p', { text: error.message }),
        h('div', { class: 'cqa-actions' },
          h('button', { type: 'button', class: 'cqa-button', text: 'Повторить', on: { click: load } }),
          h('a', { class: 'cqa-button', href: state.lastListHash || '#/conversations', text: 'К списку разговоров' })),
      ),
    );
    if (!shown) {
      grid.hidden = true;
      title.textContent = 'Разговор не загружен';
    }
    showError(error);
  }

  // ---------- Вывод ----------
  function render() {
    grid.hidden = false;
    renderHead();
    renderNotices();
    renderTranscript();
    renderScore();
    setViewDemo(Boolean(evaluation && evaluation.is_demo === true));
  }

  function fact(label, value) {
    return h('div', { class: 'cqa-fact' }, h('dt', { text: label }), h('dd', {}, value));
  }

  function renderHead() {
    title.textContent = shown.ref.conversation_id;
    const revision = shown.ref.revision === current.ref.revision
      ? String(shown.ref.revision)
      : `${shown.ref.revision} из ${current.ref.revision}`;
    clear(facts).append(
      fact('Группа', shown.ref.group_id),
      fact('Канал', labelFor(CHANNEL_LABELS, shown.channel)),
      fact('Язык', shown.language),
      fact('Ревизия', revision),
      fact('Реплик', String(shown.transcript.length)),
    );
  }

  function renderNotices() {
    clear(notices);
    if (shown.ref.revision_id !== current.ref.revision_id) {
      notices.append(h(
        'div',
        { class: 'cqa-alert cqa-alert--info' },
        h('p', { text: `Показана ревизия ${shown.ref.revision}: к ней относится выбранная оценка. Текущая ревизия разговора — ${current.ref.revision}.` }),
        h('a', { href: buildHash('conversation', [conversationId], { revision: current.ref.revision_id }), text: 'Открыть текущую ревизию' }),
      ));
    }
    if (Array.isArray(shown.manual_review_reasons) && shown.manual_review_reasons.length) {
      notices.append(h(
        'div',
        { class: 'cqa-alert cqa-alert--warn' },
        h('p', { text: 'Разговор требует внимания при проверке:' }),
        h('ul', {}, shown.manual_review_reasons.map((reason) => h('li', { text: reason }))),
      ));
    }
    if (Array.isArray(shown.warnings) && shown.warnings.length) {
      notices.append(h('p', {
        class: 'cqa-muted cqa-small',
        text: `Предупреждения импорта: ${shown.warnings.map((code) => labelFor(IMPORT_WARNING_LABELS, code)).join('; ')}.`,
      }));
    }
  }

  // ---------- Переписка ----------
  function legend() {
    return h(
      'ul',
      { class: 'cqa-legend', 'aria-label': 'Обозначения полосы слева' },
      h('li', {}, h('span', { class: 'cqa-legend-swatch cqa-legend-swatch--heard', 'aria-hidden': 'true' }), 'клиент слышит'),
      h('li', {}, h('span', { class: 'cqa-legend-swatch cqa-legend-swatch--unheard', 'aria-hidden': 'true' }), 'клиент не слышит'),
      h('li', {}, h('span', { class: 'cqa-legend-swatch cqa-legend-swatch--after', 'aria-hidden': 'true' }), 'после завершения'),
    );
  }

  function audioBlock(detail) {
    audio = h('audio', { class: 'cqa-audio', controls: true, preload: 'none' });
    audio.src = detail.audio_url;
    return h(
      'div',
      { class: 'cqa-audio-box' },
      audio,
      detail.audio_offset_reliable ? null : h('p', { class: 'cqa-field-hint', text: 'Точное время в записи не гарантировано.' }),
    );
  }

  function seekButton(message) {
    if (!audio || typeof message.audio_offset_sec !== 'number') return null;
    const seconds = Math.max(0, message.audio_offset_sec);
    const label = `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
    return h('button', {
      type: 'button',
      class: 'cqa-seek',
      title: 'Перейти к этому месту записи',
      text: `▶ ${label}`,
      on: {
        click: () => {
          audio.currentTime = seconds;
          audio.play().catch(() => {});
        },
      },
    });
  }

  function tag(text, tone) {
    return h('span', { class: `cqa-tag cqa-tag--${tone}`, text });
  }

  function messageTags(message) {
    const flags = Array.isArray(message.flags) ? message.flags : [];
    const tags = [];
    const phase = phaseLabel(message.phase);
    const duplicatePhase = message.phase === 'after_end' && flags.includes('after_end');
    if (phase && !isHiddenFromClientPhase(message.phase) && !duplicatePhase) tags.push(tag(phase, 'phase'));
    for (const flag of flags) tags.push(tag(messageFlagLabel(flag, message), FLAG_TONES[flag] || 'neutral'));
    return tags;
  }

  function messageItem(message) {
    const role = KNOWN_ROLES.includes(message.speaker) ? message.speaker : 'other';
    const phase = KNOWN_PHASES.includes(message.phase) ? message.phase : 'other';
    const isEvent = message.speaker === 'system' && Boolean(message.system_event);
    const classes = ['cqa-msg', `cqa-msg--${role}`, `cqa-msg--phase-${phase}`];
    if (message.client_facing === false) classes.push('is-unheard');
    if (isEvent) classes.push('cqa-msg--event');

    const gutter = h(
      'div',
      { class: 'cqa-msg-gutter' },
      h('span', { class: 'cqa-msg-num', text: `#${message.id}` }),
      h('time', { class: 'cqa-msg-time', title: message.timestamp, text: displayTimestamp(message.timestamp) }),
    );
    let body;
    if (isEvent) {
      body = h(
        'div',
        { class: 'cqa-msg-body' },
        h('span', { class: 'cqa-msg-event', text: labelFor(EVENT_LABELS, message.system_event) }),
        message.system_event === 'unknown' ? h('span', { class: 'cqa-msg-original', text: message.text }) : null,
        messageTags(message),
      );
    } else {
      const empty = !String(message.text || '').trim();
      body = h(
        'div',
        { class: 'cqa-msg-body' },
        h('div', { class: 'cqa-msg-line' },
          h('span', { class: 'cqa-msg-role', text: labelFor(ROLE_LABELS, message.speaker) }),
          messageTags(message),
          seekButton(message)),
        h('p', { class: `cqa-msg-text${empty ? ' is-empty' : ''}` },
          h('span', { class: 'cqa-msg-text-inner', text: empty ? 'пустая реплика' : message.text })),
      );
    }
    const item = h('li', { class: classes.join(' '), tabindex: '-1', dataset: { messageId: String(message.id) } }, gutter, body);
    messageNodes.set(message.id, item);
    return item;
  }

  function renderTranscript() {
    messageNodes.clear();
    audio = null;
    const head = h('div', { class: 'cqa-pane-head' }, h('h2', { id: 'cqa-transcript-title', text: 'Переписка' }), legend());
    const top = shown.audio_url ? audioBlock(shown) : null;
    const list = h('ol', { class: 'cqa-transcript' });
    for (const segment of groupTranscript(shown.transcript)) {
      if (segment.type === 'message') {
        list.append(messageItem(segment.message));
      } else {
        list.append(h(
          'li',
          { class: `cqa-phase-block cqa-phase-block--${segment.phase}` },
          h('p', { class: 'cqa-phase-caption', text: segment.caption }),
          h('ol', { class: 'cqa-transcript cqa-transcript--nested' }, segment.messages.map(messageItem)),
        ));
      }
    }
    append(clear(transcriptPane), [head, top, list]);
  }

  function clearMarks(className) {
    for (const node of transcriptPane.querySelectorAll(`.${className}`)) node.classList.remove(className);
  }

  function focusMessage(messageId) {
    const node = messageNodes.get(messageId);
    if (!node) {
      showToast(`Реплики #${messageId} нет в показанной ревизии.`, { tone: 'error' });
      return;
    }
    clearMarks('is-target');
    clearMarks('in-range');
    node.classList.remove('is-target');
    void node.offsetWidth; // перезапуск анимации маркера при повторном клике
    node.classList.add('is-target');
    node.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    node.focus({ preventScroll: true });
  }

  function focusRange(range) {
    const ids = rangeIds(range).filter((id) => messageNodes.has(id));
    if (!ids.length) {
      showToast('Проверенного диапазона нет в показанной ревизии.', { tone: 'error' });
      return;
    }
    clearMarks('is-target');
    clearMarks('in-range');
    for (const id of ids) messageNodes.get(id).classList.add('in-range');
    const first = messageNodes.get(ids[0]);
    first.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    first.focus({ preventScroll: true });
  }

  // ---------- Оценка ----------
  function updateEvaluateControls() {
    const outdated = Boolean(shown && current && shown.ref.revision_id !== current.ref.revision_id);
    evaluateButton.textContent = outdated ? 'Оценить текущую ревизию' : 'Оценить';
    evaluateButton.disabled = jobRunning || !current;
    const notReady = Boolean(state.health && state.health.evaluation_ready === false);
    evaluateHint.hidden = !notReady;
    evaluateHint.textContent = notReady
      ? 'Сервер сообщает, что оценка сейчас недоступна. Нажмите «Оценить», чтобы увидеть причину.'
      : '';
  }

  async function startEvaluation() {
    if (jobRunning || !current) return;
    evaluateError.hidden = true;
    jobRunning = true;
    updateEvaluateControls();
    let job;
    try {
      job = await api.startEvaluation({ revision_ids: [current.ref.revision_id] });
    } catch (error) {
      jobRunning = false;
      updateEvaluateControls();
      evaluateError.textContent = error.message;
      evaluateError.hidden = false;
      showError(error);
      return;
    }
    await trackJob(job);
  }

  async function trackJob(job) {
    pollController = new AbortController();
    try {
      const finished = await pollJob({
        job,
        getJob: (id, signal) => api.getJob(id, { signal }),
        signal: pollController.signal,
        onUpdate: (update) => {
          jobProgress.update(update);
          if (update.is_demo === true) setViewDemo(true);
        },
      });
      jobRunning = false;
      const summary = describeJob(finished);
      const evaluationId = summary.evaluationIds[0];
      jobEvaluationId = evaluationId || null;
      if (evaluationId) {
        showToast(finished.status === 'completed' ? 'Оценка готова.' : 'Оценка сохранена с ошибками: проверьте результат.', {
          tone: finished.status === 'completed' ? 'success' : 'error',
        });
        location.hash = buildHash('conversation', [conversationId], { evaluation: evaluationId });
      } else {
        evaluateError.textContent = (summary.itemErrors[0] && summary.itemErrors[0].message) || summary.jobError || 'Оценка не выполнена.';
        evaluateError.hidden = false;
        updateEvaluateControls();
      }
    } catch (error) {
      if (isAbortError(error)) return;
      jobRunning = false;
      updateEvaluateControls();
      evaluateError.textContent = error.message;
      evaluateError.hidden = false;
      showError(error);
    }
  }

  function versionLabel(versionId, node) {
    getChecklistVersion(versionId)
      .then((version) => {
        node.textContent = `Чек-лист v${version.version}`;
        node.title = version.definition ? version.definition.name : '';
      })
      .catch(() => {
        node.textContent = 'Чек-лист: версия не загружена';
      });
    return node;
  }

  function evaluationMeta() {
    const status = evaluation.final.status;
    return h(
      'div',
      { class: 'cqa-eval-meta' },
      h('span', { text: `Оценка от ${formatDateTime(evaluation.created_at)}` }),
      versionLabel(evaluation.checklist_version_id, h('span', { text: 'Чек-лист…' })),
      badge(labelFor(EVALUATION_STATUS_LABELS, status), EVALUATION_STATUS_TONES[status] || 'neutral'),
      evaluation.is_demo ? badge('Демо', 'demo', 'Синтетическая оценка демо-провайдера') : null,
    );
  }

  function compositionBar(final, decimals) {
    const sections = (final.sections || []).filter((section) => typeof section.contribution === 'number' && section.contribution > 0);
    const description = sections.map((section) => `${sectionTitle(section.section)} ${formatNumber(section.contribution, decimals)}`).join(', ');
    const bar = h('div', { class: 'cqa-composition', role: 'img', 'aria-label': `Из чего сложился итог: ${description || 'нет набранных баллов'}` });
    sections.forEach((section, index) => {
      const part = h('span', {
        class: `cqa-composition-part cqa-tint-${index % 4}`,
        title: `${sectionTitle(section.section)}: вклад в итог ${formatNumber(section.contribution, decimals)}`,
      });
      part.style.width = `${Math.min(100, section.contribution)}%`;
      bar.append(part);
    });
    return bar;
  }

  function totalBlock(decimals) {
    const final = evaluation.final;
    const hasTotal = typeof final.total === 'number';
    const block = h(
      'div',
      { class: 'cqa-total' },
      h('p', { class: 'cqa-total-label', text: 'Итоговый балл' }),
      h('p', { class: 'cqa-total-figure' },
        h('span', { class: 'cqa-total-value', text: formatNumber(final.total, decimals) }),
        hasTotal ? h('span', { class: 'cqa-total-of', text: 'из 100' }) : null),
    );
    if (final.total_reason) block.append(h('p', { class: 'cqa-total-reason', text: final.total_reason }));
    if (totalsDiffer(evaluation)) {
      block.append(h(
        'p',
        { class: 'cqa-total-change' },
        'исходно ',
        h('strong', { text: formatNumber(evaluation.original.total, decimals) }),
        ' → после апелляций ',
        h('strong', { text: formatNumber(final.total, decimals) }),
      ));
    }
    if (hasTotal && typeof final.total_before_override === 'number' && final.total_before_override !== final.total) {
      block.append(h('p', { class: 'cqa-total-reason', text: `До обнуления по политике оценки: ${formatNumber(final.total_before_override, decimals)}` }));
    }
    if (hasTotal) block.append(compositionBar(final, decimals));
    return block;
  }

  function banners() {
    const final = evaluation.final;
    const result = [];
    if (final.gross_error === true) {
      const flags = violatedFlags(evaluation);
      result.push(h(
        'div',
        { class: 'cqa-alert cqa-alert--gross', role: 'status' },
        h('p', { class: 'cqa-alert-title', text: 'Грубое нарушение' }),
        flags.length ? h('p', { text: `Отмечено: ${flags.join(', ')}.` }) : null,
      ));
    } else if (final.gross_error === null && (final.flags || []).length) {
      result.push(h('div', { class: 'cqa-alert' }, h('p', { text: 'Грубое нарушение не определено: по одному из флагов нет ответа.' })));
    }
    if (final.status === 'manual_review') {
      result.push(h(
        'div',
        { class: 'cqa-alert cqa-alert--warn' },
        h('p', { class: 'cqa-alert-title', text: 'Нужна ручная проверка' }),
        (final.manual_review_reasons || []).length ? h('ul', {}, final.manual_review_reasons.map((reason) => h('li', { text: reason }))) : null,
      ));
    } else if (final.status === 'failed') {
      result.push(h(
        'div',
        { class: 'cqa-alert cqa-alert--bad' },
        h('p', { class: 'cqa-alert-title', text: 'Оценка завершилась ошибкой' }),
        (final.manual_review_reasons || []).length ? h('ul', {}, final.manual_review_reasons.map((reason) => h('li', { text: reason }))) : null,
      ));
    }
    return result;
  }

  function sectionsTable(decimals) {
    const sections = evaluation.final.sections || [];
    if (!sections.length) return null;
    let tint = 0;
    return h(
      'table',
      { class: 'cqa-table cqa-table--compact cqa-sections' },
      h('caption', { class: 'cqa-table-caption', text: 'Секции' }),
      h('thead', {}, h('tr', {},
        h('th', { scope: 'col', text: 'Секция' }),
        h('th', { scope: 'col', class: 'cqa-num', text: 'Выполнение секции' }),
        h('th', { scope: 'col', class: 'cqa-num', text: 'Вклад в итог' }))),
      h('tbody', {}, sections.map((section) => {
        const visible = typeof section.contribution === 'number' && section.contribution > 0;
        const swatch = visible
          ? h('span', { class: `cqa-swatch cqa-tint-${tint++ % 4}`, 'aria-hidden': 'true' })
          : h('span', { class: 'cqa-swatch cqa-swatch--empty', 'aria-hidden': 'true' });
        return h('tr', {},
          h('th', { scope: 'row' }, swatch, sectionTitle(section.section)),
          h('td', { class: 'cqa-num', text: formatPercent(section.completion_percent, decimals) }),
          h('td', { class: 'cqa-num', text: formatNumber(section.contribution, decimals) }));
      })),
    );
  }

  function scoreLine(criterion, final, decimals) {
    if (criterion.answer_type === 'flag') return null;
    const parts = [];
    if (typeof final.weighted_points === 'number') {
      parts.push(h('span', {},
        'Баллы ',
        h('strong', { text: formatNumber(final.weighted_points, decimals) }),
        ` из ${formatNumber(final.original_weight, decimals)}`));
    } else if (final.answer && final.answer.status === 'not_applicable') {
      parts.push(h('span', { text: `Не учитывается в итоге, вес ${formatNumber(final.original_weight, decimals)}` }));
    } else {
      parts.push(h('span', { text: 'Баллы не рассчитаны' }));
    }
    if (typeof final.effective_weight === 'number') {
      parts.push(h('span', {}, 'Эффективный вес ', h('strong', { text: formatPercent(final.effective_weight, decimals) })));
    }
    return h('p', { class: 'cqa-criterion-score' }, parts);
  }

  function evidenceLine(final) {
    const evidence = Array.isArray(final.evidence) ? final.evidence : [];
    if (!evidence.length) return null;
    return h(
      'div',
      { class: 'cqa-evidence' },
      h('span', { class: 'cqa-note-label', text: 'Доказательства' }),
      evidence.map((item) => h(
        'button',
        {
          type: 'button',
          class: 'cqa-chip',
          title: `${labelFor(ROLE_LABELS, item.speaker)}: ${excerpt(item.text)}`,
          on: { click: () => focusMessage(item.message_id) },
        },
        `#${item.message_id}`,
        isClientFacingPhase(item.phase) ? null : h('span', { class: 'cqa-chip-phase', text: phaseLabel(item.phase) }),
      )),
    );
  }

  function rangeLine(final) {
    const range = final.checked_range;
    if (!range) return null;
    const label = range.start_id === range.end_id ? `#${range.start_id}` : `#${range.start_id}–#${range.end_id}`;
    return h(
      'div',
      { class: 'cqa-evidence' },
      h('span', { class: 'cqa-note-label', text: 'Проверено' }),
      h('button', { type: 'button', class: 'cqa-chip cqa-chip--range', title: 'Показать проверенные реплики', on: { click: () => focusRange(range) } }, label),
      final.expected_action ? h('span', { class: 'cqa-expected' }, 'Ожидалось: ', final.expected_action) : null,
    );
  }

  function notesList(final) {
    const notes = [];
    if (final.answer && final.answer.status === 'not_applicable' && final.na_reason) {
      notes.push(h('li', {}, h('span', { class: 'cqa-note-label', text: 'Причина N/A' }), ' ', final.na_reason));
    }
    for (const reason of final.manual_review_reasons || []) {
      notes.push(h('li', { class: 'cqa-note--warn' }, h('span', { class: 'cqa-note-label', text: 'Ручная проверка' }), ' ', reason));
    }
    for (const warning of final.warnings || []) {
      notes.push(h('li', { class: 'cqa-note--warn' }, h('span', { class: 'cqa-note-label', text: 'Предупреждение' }), ' ', warning));
    }
    if (final.reused) {
      notes.push(h('li', {},
        'Переиспользовано из прошлой оценки',
        final.reused_from_evaluation_id
          ? [' (', h('a', { href: buildHash('conversation', [conversationId], { evaluation: final.reused_from_evaluation_id }), text: 'открыть' }), ')']
          : null));
    }
    return notes.length ? h('ul', { class: 'cqa-criterion-notes' }, notes) : null;
  }

  function criterionItem(row, decimals) {
    const { criterion, final, original, changedByAppeal } = row;
    if (!final) {
      return h('li', { class: 'cqa-criterion' },
        h('div', { class: 'cqa-criterion-head' },
          h('span', { class: 'cqa-criterion-name', text: criterion.name }),
          h('span', { class: 'cqa-muted', text: 'Нет результата' })));
    }
    const tone = answerTone(final.answer, criterion);
    return h(
      'li',
      { class: `cqa-criterion cqa-criterion--${tone}` },
      h('div', { class: 'cqa-criterion-head' },
        h('span', { class: 'cqa-criterion-name', text: criterion.name }),
        h('span', { class: `cqa-verdict cqa-verdict--${tone}` },
          h('span', { class: 'cqa-verdict-mark', 'aria-hidden': 'true', text: VERDICT_MARKS[tone] }),
          h('span', { class: 'cqa-verdict-text', text: formatAnswer(final.answer, criterion) }))),
      scoreLine(criterion, final, decimals),
      changedByAppeal
        ? h('p', { class: 'cqa-criterion-change' },
          'было: ', h('strong', { text: formatAnswer(original.answer, criterion) }),
          ' → стало: ', h('strong', { text: formatAnswer(final.answer, criterion) }),
          ' (апелляция)')
        : null,
      final.rationale ? h('p', { class: 'cqa-criterion-rationale', text: final.rationale }) : null,
      evidenceLine(final),
      rangeLine(final),
      notesList(final),
    );
  }

  function criteriaBlock(rows, decimals) {
    if (!rows.length) return null;
    return h(
      'section',
      { class: 'cqa-criteria', 'aria-labelledby': 'cqa-criteria-title' },
      h('h3', { id: 'cqa-criteria-title', text: 'Критерии' }),
      groupBySection(rows).map((group) => h(
        'div',
        { class: 'cqa-criteria-group' },
        h('h4', { class: 'cqa-criteria-section', text: sectionTitle(group.section) }),
        h('ol', { class: 'cqa-criteria-list' }, group.rows.map((row) => criterionItem(row, decimals))),
      )),
    );
  }

  function flagsBlock(rows, decimals) {
    if (!rows.length) return null;
    return h(
      'section',
      { class: 'cqa-criteria cqa-flags', 'aria-labelledby': 'cqa-flags-title' },
      h('h3', { id: 'cqa-flags-title', text: 'Флаги' }),
      h('ol', { class: 'cqa-criteria-list' }, rows.map((row) => criterionItem(row, decimals))),
    );
  }

  function pastEvaluations() {
    const block = h('section', { class: 'cqa-past', 'aria-labelledby': 'cqa-past-title' }, h('h3', { id: 'cqa-past-title', text: 'Оценки этого разговора' }));
    if (!summaries.length) {
      block.append(h('p', { class: 'cqa-muted', text: 'Оценок пока нет.' }));
      return block;
    }
    const decimals = healthDecimals();
    const rows = summaries.map((summary) => {
      const isShown = Boolean(evaluation && summary.id === evaluation.id);
      let action;
      if (isShown) {
        action = h('span', { class: 'cqa-muted', text: 'показана' });
      } else {
        const open = h('a', { href: buildHash('conversation', [conversationId], { evaluation: summary.id }), text: 'Открыть' });
        let compare;
        if (comparableWith(summary, evaluation)) {
          compare = h('a', { href: buildHash('compare', [], { left: summary.id, right: evaluation.id }), text: 'Сравнить с текущей' });
        } else if (evaluation) {
          compare = h('span', { class: 'cqa-muted', title: 'Сравнивать можно оценки одной ревизии разговора', text: 'другая ревизия' });
        }
        action = h('span', { class: 'cqa-row-actions' }, open, compare || null);
      }
      return h('tr', { class: isShown ? 'is-current' : null },
        h('td', { text: formatDateTime(summary.created_at) }),
        h('td', {}, versionLabel(summary.checklist_version_id, h('span', { text: '…' }))),
        h('td', { class: 'cqa-num' }, h('strong', { text: formatNumber(summary.final_total, decimals) })),
        h('td', {}, badge(labelFor(EVALUATION_STATUS_LABELS, summary.status), EVALUATION_STATUS_TONES[summary.status] || 'neutral')),
        h('td', {}, action));
    });
    block.append(h(
      'table',
      { class: 'cqa-table cqa-table--compact' },
      h('thead', {}, h('tr', {},
        h('th', { scope: 'col', text: 'Дата' }),
        h('th', { scope: 'col', text: 'Чек-лист' }),
        h('th', { scope: 'col', class: 'cqa-num', text: 'Итог' }),
        h('th', { scope: 'col', text: 'Статус' }),
        h('th', { scope: 'col', text: 'Действия' }))),
      h('tbody', {}, rows),
    ));
    if (summariesTotal > summaries.length) {
      block.append(h('p', { class: 'cqa-muted cqa-small', text: `Показаны последние ${summaries.length} из ${summariesTotal}.` }));
    }
    return block;
  }

  function renderScore() {
    updateEvaluateControls();
    // Итог задания остаётся рядом с оценкой, которую оно создало; у других оценок он лишний.
    if (!jobRunning && jobEvaluationId && (!evaluation || evaluation.id !== jobEvaluationId)) {
      jobProgress.hide();
      jobEvaluationId = null;
    }
    clear(scoreBody);
    if (!evaluation) {
      scoreBody.append(
        emptyState({
          title: 'Разговор ещё не оценён.',
          hint: 'Нажмите «Оценить»: баллы по критериям появятся здесь, а доказательства будут вести к репликам слева.',
        }),
        pastEvaluations(),
      );
      return;
    }
    const decimals = evaluation.scoring_policy ? evaluation.scoring_policy.decimals : healthDecimals();
    const rows = criterionRows(evaluation);
    append(scoreBody, [
      evaluationMeta(),
      totalBlock(decimals),
      banners(),
      sectionsTable(decimals),
      criteriaBlock(rows.filter((row) => !row.isFlag), decimals),
      flagsBlock(rows.filter((row) => row.isFlag), decimals),
      pastEvaluations(),
    ]);
  }

  const unsubscribe = subscribe(() => updateEvaluateControls());
  updateEvaluateControls();
  load();

  return {
    update(nextRoute) {
      if (nextRoute.params[0] !== conversationId) return false;
      params = { evaluationId: nextRoute.query.evaluation || null, revisionId: nextRoute.query.revision || null };
      load();
      return true;
    },
    destroy() {
      controller.abort();
      if (pollController) pollController.abort();
      unsubscribe();
    },
  };
}
