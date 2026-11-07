// Карточка разговора — главный экран защиты: переписка с фазами слева, оценка по чек-листу справа.
// Доказательства раскрываются в той ревизии, к которой относится оценка.
import { api } from '../api.js';
import { badge } from '../components/badge.js';
import { emptyState } from '../components/empty-state.js';
import { createJobProgress } from '../components/job-progress.js';
import { showError, showToast } from '../components/toast.js';
import { verdict } from '../components/verdict.js';
import { append, clear, h } from '../dom.js';
import { answerTone, formatAnswer } from '../lib/answers.js';
import { appealsByCriterion, describeDecision } from '../lib/appeals.js';
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
import { displayTimestamp, excerpt, formatDateTime, formatNumber, formatPercent } from '../lib/format.js';
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
import { createDecisionPanel, openAppealModal } from './appeal-forms.js';

const KNOWN_ROLES = ['client', 'operator', 'bot', 'system'];
const KNOWN_PHASES = ['pre_operator', 'client', 'hold', 'internal_consult', 'after_end'];
const FLAG_TONES = { duplicate_of_prev: 'neutral', after_end: 'neutral', pii_masked: 'info', unknown_event: 'partial' };

function prefersReducedMotion() {
  return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

function healthDecimals() {
  return state.health && state.health.scoring_policy ? state.health.scoring_policy.decimals : undefined;
}

function routeParams(route) {
  return {
    evaluationId: route.query.evaluation || null,
    revisionId: route.query.revision || null,
    appealId: route.query.appeal || null,
  };
}

export function mount(container, route) {
  const conversationId = route.params[0];
  let params = routeParams(route);
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
  const messagesById = new Map();
  let renderedRevisionId = null;

  // Апелляции показанной оценки, открытая панель решения и выбор реплик-доказательств для неё.
  let appeals = [];
  let appealsError = null;
  let appealIndex = new Map();
  let decision = null;
  let picking = false;
  let picked = new Set();
  let handledAppealParam = null;
  let cameFromAppeals = Boolean(params.appealId);
  let activeModal = null;
  // Пересчёт после решения: «итог до → после» остаётся у критерия, пока показана та же оценка.
  const decisionNotes = new Map();

  // ---------- Каркас ----------
  const backLink = h('a', { class: 'cqa-back', href: state.lastListHash || '#/conversations', text: 'К списку разговоров' });
  const appealsLink = h('a', { class: 'cqa-back', href: state.lastAppealsHash || '#/appeals', text: 'К апелляциям', hidden: !cameFromAppeals });
  const pickHint = h('p', {
    class: 'cqa-pick-hint',
    role: 'status',
    hidden: true,
    text: 'Выбор доказательств для решения: щёлкните по реплике, чтобы добавить её; повторный щелчок уберёт.',
  });
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
      h('div', { class: 'cqa-conv-head' }, h('div', { class: 'cqa-back-links' }, backLink, appealsLink), title, facts),
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
      const [detail, appealPage] = await Promise.all([
        revisionId === latest.ref.revision_id ? latest : api.getConversation(conversationId, revisionId, { signal }),
        // Апелляции второстепенны для карточки: их ошибка не мешает показать разговор и оценку.
        full
          ? api.listAppeals({ evaluation_id: full.id, limit: 100 }, { signal }).catch((error) => {
            if (isAbortError(error)) throw error;
            return { error };
          })
          : null,
      ]);
      if (seq !== loadSeq) return;
      if (decision && (!full || decision.appeal.evaluation_id !== full.id)) closeDecision({ silent: true });
      current = latest;
      shown = detail;
      evaluation = full;
      summaries = page.items;
      summariesTotal = page.total;
      appeals = appealPage && !appealPage.error ? appealPage.items : [];
      appealsError = appealPage && appealPage.error ? appealPage.error : null;
      if (appealsError) showError(appealsError);
      render();
      openAppealFromRoute();
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
    // Переписку той же ревизии не перестраиваем: после решения апелляции не теряется место прокрутки.
    if (renderedRevisionId !== shown.ref.revision_id) renderTranscript();
    renderScore();
    setViewDemo(Boolean(evaluation && evaluation.is_demo === true));
  }

  function fact(label, value) {
    return h('div', { class: 'cqa-fact' }, h('dt', { text: label }), h('dd', {}, value));
  }

  function renderHead() {
    appealsLink.hidden = !cameFromAppeals;
    appealsLink.setAttribute('href', state.lastAppealsHash || '#/appeals');
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
    messagesById.set(message.id, message);
    return item;
  }

  function renderTranscript() {
    messageNodes.clear();
    messagesById.clear();
    audio = null;
    renderedRevisionId = shown.ref.revision_id;
    const head = h('div', { class: 'cqa-pane-head' }, h('h2', { id: 'cqa-transcript-title', text: 'Переписка' }), legend(), pickHint);
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
    applyPicking();
  }

  // ---------- Выбор реплик-доказательств для решения апелляции ----------
  function applyPicking() {
    transcriptPane.classList.toggle('is-picking', picking);
    pickHint.hidden = !picking;
    for (const [id, node] of messageNodes) {
      node.tabIndex = picking ? 0 : -1;
      node.classList.toggle('is-picked', picked.has(id));
      if (picking) node.title = picked.has(id) ? 'Убрать из доказательств решения' : 'Добавить в доказательства решения';
      else node.removeAttribute('title');
    }
  }

  function setPicking(on) {
    picking = on;
    if (!on) picked = new Set();
    applyPicking();
  }

  function pickMessage(node) {
    if (!picking || !decision || !node) return;
    decision.panel.toggleEvidence(Number(node.dataset.messageId));
  }

  transcriptPane.addEventListener('click', (event) => {
    if (!picking) return;
    if (event.target.closest('button, a, audio, input, textarea, select')) return;
    // Выделение текста мышью — не выбор реплики.
    const selection = window.getSelection ? window.getSelection() : null;
    if (selection && !selection.isCollapsed) return;
    pickMessage(event.target.closest('.cqa-msg'));
  });

  transcriptPane.addEventListener('keydown', (event) => {
    if (!picking || (event.key !== 'Enter' && event.key !== ' ')) return;
    if (!event.target.classList || !event.target.classList.contains('cqa-msg')) return;
    event.preventDefault();
    pickMessage(event.target);
  });

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

  // ---------- Апелляции у критерия ----------
  function resolvedAppealItem(appeal, criterion) {
    const summary = describeDecision(appeal.decision, criterion);
    const outcome = summary
      ? `${summary.actionLabel}: ${summary.answerChanged ? `${summary.before} → ${summary.after}` : summary.after}`
      : 'решение не загружено';
    return h(
      'li',
      {},
      h(
        'details',
        { class: 'cqa-appeal-record' },
        h('summary', {}, h('span', { class: 'cqa-appeal-record-title', text: `Апелляция решена ${formatDateTime(appeal.resolved_at)}` }), h('span', { text: outcome })),
        h(
          'dl',
          { class: 'cqa-appeal-record-body' },
          h('div', {}, h('dt', { text: 'Оператор' }), h('dd', { text: appeal.comment })),
          appeal.decision ? h('div', {}, h('dt', { text: 'Проверяющий' }), h('dd', { text: appeal.decision.reason })) : null,
          h('div', {}, h('dt', { text: 'Подана' }), h('dd', { text: formatDateTime(appeal.created_at) })),
        ),
      ),
    );
  }

  function decisionNoteView(note, criterion, decimals) {
    const summary = describeDecision(note.decision, criterion);
    return h(
      'div',
      { class: 'cqa-alert cqa-decision-note', role: 'status' },
      h('p', { class: 'cqa-alert-title', text: 'Решение сохранено, итог пересчитан' }),
      summary
        ? h('p', {}, `${summary.actionLabel}: `, h('strong', { text: summary.answerChanged ? `${summary.before} → ${summary.after}` : summary.after }), '.')
        : null,
      h('p', {}, 'Итог оценки: ', h('strong', { text: formatNumber(note.beforeTotal, decimals) }), ' → ', h('strong', { text: formatNumber(note.afterTotal, decimals) }), '.'),
    );
  }

  function appealBlock(row, decimals) {
    const { criterion } = row;
    const entry = appealIndex.get(criterion.id) || { open: null, resolved: [] };
    const parts = [];
    const note = decisionNotes.get(criterion.id);
    if (note && note.evaluationId === evaluation.id) parts.push(decisionNoteView(note, criterion, decimals));
    if (entry.open) {
      const reviewing = Boolean(decision && decision.appeal.id === entry.open.id);
      parts.push(h(
        'div',
        { class: 'cqa-appeal-open' },
        badge('Апелляция открыта', 'warn'),
        h('span', { class: 'cqa-appeal-comment', title: entry.open.comment, text: `«${excerpt(entry.open.comment, 140)}»` }),
        reviewing
          ? null
          : h('button', { type: 'button', class: 'cqa-button cqa-button--small', text: 'Рассмотреть', on: { click: () => openDecision(entry.open) } }),
      ));
      if (reviewing) parts.push(decision.panel.el);
    } else if (!appealsError) {
      parts.push(h(
        'div',
        { class: 'cqa-criterion-actions' },
        h('button', { type: 'button', class: 'cqa-button cqa-button--quiet cqa-button--small', text: 'Оспорить', on: { click: () => openAppeal(row) } }),
      ));
    }
    if (entry.resolved.length) {
      parts.push(h('ul', { class: 'cqa-appeal-history', 'aria-label': 'Решённые апелляции по критерию' }, entry.resolved.map((appeal) => resolvedAppealItem(appeal, criterion))));
    }
    return parts.length ? h('div', { class: 'cqa-appeal-block' }, parts) : null;
  }

  function criterionItem(row, decimals) {
    const { criterion, final, original, changedByAppeal } = row;
    if (!final) {
      return h('li', { class: 'cqa-criterion', dataset: { criterionId: criterion.id } },
        h('div', { class: 'cqa-criterion-head' },
          h('span', { class: 'cqa-criterion-name', text: criterion.name }),
          h('span', { class: 'cqa-muted', text: 'Нет результата' })));
    }
    const tone = answerTone(final.answer, criterion);
    const reviewing = Boolean(decision && decision.criterionId === criterion.id);
    return h(
      'li',
      { class: `cqa-criterion cqa-criterion--${tone}${reviewing ? ' is-reviewing' : ''}`, dataset: { criterionId: criterion.id } },
      h('div', { class: 'cqa-criterion-head' },
        h('span', { class: 'cqa-criterion-name', text: criterion.name }),
        verdict(final.answer, criterion)),
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
      appealBlock(row, decimals),
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
    const decimals = evaluationDecimals();
    const rows = criterionRows(evaluation);
    appealIndex = appealsByCriterion(appeals);
    // Панель решения переносится в новую разметку тем же элементом: введённый текст и фокус сохраняются.
    const focused = decision && decision.panel.el.contains(document.activeElement) ? document.activeElement : null;
    append(scoreBody, [
      evaluationMeta(),
      totalBlock(decimals),
      banners(),
      appealsError ? appealsErrorAlert() : null,
      sectionsTable(decimals),
      criteriaBlock(rows.filter((row) => !row.isFlag), decimals),
      flagsBlock(rows.filter((row) => row.isFlag), decimals),
      pastEvaluations(),
    ]);
    if (focused && document.activeElement !== focused) focused.focus({ preventScroll: true });
  }

  function evaluationDecimals() {
    return evaluation && evaluation.scoring_policy ? evaluation.scoring_policy.decimals : healthDecimals();
  }

  function appealsErrorAlert() {
    return h(
      'div',
      { class: 'cqa-alert cqa-alert--bad', role: 'alert' },
      h('p', { text: `Апелляции этой оценки не загружены: ${appealsError.message}` }),
      h('div', { class: 'cqa-actions' }, h('button', { type: 'button', class: 'cqa-button', text: 'Повторить', on: { click: refreshAppeals } })),
    );
  }

  function criterionNode(criterionId) {
    return [...scoreBody.querySelectorAll('.cqa-criterion')].find((node) => node.dataset.criterionId === criterionId) || null;
  }

  function scrollToCriterion(criterionId) {
    const node = criterionNode(criterionId);
    if (node) node.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }

  // ---------- Апелляции: подача ----------
  async function refreshAppeals() {
    if (!evaluation) return;
    const target = evaluation.id;
    try {
      const page = await api.listAppeals({ evaluation_id: target, limit: 100 }, { signal: controller.signal });
      if (!evaluation || evaluation.id !== target) return;
      appeals = page.items;
      appealsError = null;
    } catch (error) {
      if (isAbortError(error)) return;
      appealsError = error;
      showError(error);
    }
    renderScore();
  }

  function openAppeal(row) {
    if (activeModal) activeModal.close();
    activeModal = openAppealModal({
      evaluation,
      criterion: row.criterion,
      result: row.final,
      onCreated: () => {
        showToast('Апелляция подана. Решение принимает проверяющий: кнопка «Рассмотреть» у критерия.', { tone: 'success' });
        refreshAppeals();
      },
      onDuplicate: refreshAppeals,
      onClose: () => {
        activeModal = null;
      },
    });
  }

  // ---------- Апелляции: решение ----------
  function openDecision(appeal) {
    if (!evaluation || appeal.evaluation_id !== evaluation.id) return;
    if (decision && decision.appeal.id === appeal.id) {
      scrollToCriterion(decision.criterionId);
      return;
    }
    closeDecision({ silent: true });
    const criterion = (evaluation.checklist_snapshot.criteria || []).find((item) => item.id === appeal.criterion_id);
    if (!criterion) {
      showToast('Критерия апелляции нет в снимке чек-листа этой оценки.', { tone: 'error' });
      return;
    }
    const panel = createDecisionPanel({
      appeal,
      criterion,
      getMessage: (id) => messagesById.get(id) || null,
      onShowMessage: focusMessage,
      onEvidenceChange: (ids) => {
        picked = new Set(ids);
        applyPicking();
      },
      onPickingChange: setPicking,
      onDecided: (result) => finishDecision(criterion, result),
      onConflict: () => {
        showToast('Оценка изменилась, данные обновлены.', { tone: 'error' });
        refreshForDecision();
      },
      onAlreadyResolved: () => {
        showToast('Решение по этой апелляции уже принято. Данные обновлены.', { tone: 'error' });
        closeDecision({ silent: true });
        load();
      },
      onCancel: () => closeDecision(),
    });
    decision = { appeal, criterionId: criterion.id, panel };
    renderScore();
    scrollToCriterion(criterion.id);
    panel.focus();
    refreshForDecision();
  }

  // Перед решением — свежая оценка: из неё expected_final_revision и текущий ответ критерия.
  async function refreshForDecision() {
    const target = decision;
    if (!target || !evaluation) return;
    try {
      const fresh = await api.getEvaluation(evaluation.id, { signal: controller.signal });
      if (decision !== target) return;
      if (fresh.final_revision !== evaluation.final_revision) {
        evaluation = fresh;
        renderScore();
      }
      target.panel.setEvaluation(fresh);
    } catch (error) {
      if (isAbortError(error) || decision !== target) return;
      target.panel.setLoadError(error.message);
      showError(error);
    }
  }

  function finishDecision(criterion, result) {
    const beforeTotal = evaluation.final.total;
    const after = result.evaluation;
    const decimals = after.scoring_policy ? after.scoring_policy.decimals : evaluationDecimals();
    decisionNotes.set(criterion.id, {
      evaluationId: after.id,
      decision: result.appeal.decision,
      beforeTotal,
      afterTotal: after.final.total,
    });
    closeDecision({ silent: true });
    evaluation = after;
    appeals = appeals.map((item) => (item.id === result.appeal.id ? result.appeal : item));
    renderScore();
    showToast(`Решение сохранено. Итог: ${formatNumber(beforeTotal, decimals)} → ${formatNumber(after.final.total, decimals)}.`, { tone: 'success' });
    // Обновить карточку целиком: список оценок, апелляции; ссылка без ?appeal= не откроет решение повторно.
    if (params.appealId) location.replace(buildHash('conversation', [conversationId], { evaluation: after.id }));
    else load();
  }

  function closeDecision({ silent = false } = {}) {
    if (!decision) return;
    const { panel } = decision;
    decision = null;
    panel.destroy();
    panel.el.remove();
    if (!silent) renderScore();
  }

  // ?appeal=<id> из списка апелляций: открыть решение у нужного критерия.
  function openAppealFromRoute() {
    const appealId = params.appealId;
    if (!appealId || handledAppealParam === appealId) return;
    handledAppealParam = appealId;
    cameFromAppeals = true;
    appealsLink.hidden = false;
    const appeal = appeals.find((item) => item.id === appealId);
    if (!appeal) {
      if (!appealsError) showToast('Апелляции из адреса нет у этой оценки.', { tone: 'error' });
      return;
    }
    if (appeal.status !== 'open') {
      showToast('Решение по этой апелляции уже принято: оно показано у критерия.', { tone: 'info' });
      scrollToCriterion(appeal.criterion_id);
      return;
    }
    openDecision(appeal);
  }

  const unsubscribe = subscribe(() => updateEvaluateControls());
  updateEvaluateControls();
  load();

  return {
    update(nextRoute) {
      if (nextRoute.params[0] !== conversationId) return false;
      params = routeParams(nextRoute);
      if (!params.appealId) handledAppealParam = null;
      load();
      return true;
    },
    destroy() {
      controller.abort();
      if (pollController) pollController.abort();
      if (activeModal) activeModal.close();
      closeDecision({ silent: true });
      unsubscribe();
    },
  };
}
