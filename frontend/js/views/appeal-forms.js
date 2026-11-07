// Апелляции в карточке разговора. Подача и решение — два отдельных действия:
// оператор оспаривает критерий (модальное окно), проверяющий решает (панель под критерием,
// пока она открыта, реплики переписки можно добавлять в доказательства решения).
import { api } from '../api.js';
import { field } from '../components/field.js';
import { openModal } from '../components/modal.js';
import { verdict } from '../components/verdict.js';
import { clear, h } from '../dom.js';
import {
  NA_CHOICE,
  answerChoices,
  buildAppealRequest,
  buildDecisionRequest,
  choiceKeyFor,
  findChoice,
  toggleEvidenceId,
  validateAppeal,
  validateDecision,
} from '../lib/appeals.js';
import { fieldErrors } from '../lib/errors.js';
import { formatDateTime } from '../lib/format.js';
import { ROLE_LABELS, labelFor } from '../lib/labels.js';
import { isClientFacingPhase, phaseLabel } from '../lib/phases.js';
import { buildHash } from '../lib/route.js';

export function appealHash(conversationId, appeal) {
  return buildHash('conversation', [conversationId], { evaluation: appeal.evaluation_id, appeal: appeal.id });
}

// ---------- Подача: «Оспорить» ----------

export function openAppealModal({ evaluation, criterion, result, onCreated, onDuplicate, onClose }) {
  const comment = field({
    id: 'cqa-appeal-comment',
    label: 'Комментарий оператора',
    control: h('textarea', { rows: 4 }),
    hint: 'Что, по мнению оператора, оценено неверно. Решение примет проверяющий отдельным действием.',
  });
  const duplicate = h('div', { class: 'cqa-alert cqa-alert--warn', role: 'status', hidden: true });
  const formError = h('div', { class: 'cqa-form-error', role: 'alert', hidden: true });
  const submit = h('button', { type: 'submit', class: 'cqa-button cqa-button--primary', text: 'Подать апелляцию' });
  const cancel = h('button', { type: 'button', class: 'cqa-button', text: 'Отмена' });
  let busy = false;

  const form = h(
    'form',
    { class: 'cqa-appeal-form', novalidate: true },
    h(
      'div',
      { class: 'cqa-appeal-subject' },
      h('p', { class: 'cqa-appeal-criterion', text: criterion.name }),
      h('p', { class: 'cqa-appeal-current' }, h('span', { class: 'cqa-note-label', text: 'Текущий ответ' }), verdict(result.answer, criterion)),
      result.rationale ? h('p', { class: 'cqa-appeal-rationale', text: result.rationale }) : null,
    ),
    comment.el,
    duplicate,
    formError,
    h('div', { class: 'cqa-modal-actions' }, submit, cancel),
  );

  const modal = openModal({ title: 'Оспорить оценку критерия', body: form, onClose });
  cancel.addEventListener('click', modal.close);
  comment.control.focus();

  async function showDuplicate() {
    clear(duplicate).append(h('p', { text: 'По этому критерию уже есть открытая апелляция.' }));
    duplicate.hidden = false;
    if (onDuplicate) onDuplicate();
    try {
      const page = await api.listAppeals({ evaluation_id: evaluation.id, status: 'open', limit: 100 });
      const existing = page.items.find((item) => item.criterion_id === criterion.id);
      if (existing) {
        duplicate.append(h('a', {
          href: appealHash(evaluation.conversation.id, existing),
          text: 'Открыть открытую апелляцию',
          on: { click: () => modal.close() },
        }));
      }
    } catch {
      // Ссылка — дополнение: сообщение о дубле уже показано.
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    comment.clearError();
    formError.hidden = true;
    duplicate.hidden = true;
    const errors = validateAppeal({ comment: comment.control.value });
    if (errors.comment) {
      comment.setError(errors.comment);
      comment.control.focus();
      return;
    }
    busy = true;
    submit.disabled = true;
    submit.textContent = 'Отправка…';
    try {
      const appeal = await api.createAppeal(buildAppealRequest({
        evaluationId: evaluation.id,
        criterionId: criterion.id,
        comment: comment.control.value,
      }));
      modal.close();
      onCreated(appeal);
    } catch (error) {
      if (error.code === 'DUPLICATE_OPEN_APPEAL') {
        await showDuplicate();
      } else {
        const byField = fieldErrors(error.details);
        if (byField.comment) comment.setError(byField.comment);
        formError.textContent = error.message;
        formError.hidden = false;
      }
    } finally {
      busy = false;
      submit.disabled = false;
      submit.textContent = 'Подать апелляцию';
    }
  });

  return modal;
}

// ---------- Решение проверяющего ----------

const ACTION_TEXT = { confirm: 'Подтвердить ответ', change: 'Изменить ответ' };
const SUBMIT_TEXT = { confirm: 'Подтвердить ответ', change: 'Сохранить новый ответ' };
const REASON_HINT = {
  confirm: 'Почему ответ остаётся прежним. Сохранится в истории решения.',
  change: 'Сохранится как обоснование нового ответа и в истории решения.',
};

// Панель решения. Карточка передаёт свежую оценку через setEvaluation: из неё берётся
// expected_final_revision и текущий ответ. Пока выбран «Изменить ответ», карточка включает выбор реплик.
export function createDecisionPanel({
  appeal,
  criterion,
  getMessage,
  onShowMessage,
  onEvidenceChange,
  onPickingChange,
  onDecided,
  onConflict,
  onAlreadyResolved,
  onCancel,
}) {
  const base = `cqa-decision-${appeal.id}`;
  const choices = answerChoices(criterion);
  let expectedRevision = null;
  let currentAnswer = null;
  let action = null;
  let evidence = [];
  let busy = false;
  let picking = false;

  // Действие
  const actionInputs = {};
  const actionError = h('div', { class: 'cqa-field-error', hidden: true });
  const actionHint = h('p', { class: 'cqa-field-hint', hidden: true });
  const actionFieldset = h(
    'fieldset',
    { class: 'cqa-fieldset' },
    h('legend', { text: 'Решение' }),
    h('div', { class: 'cqa-segmented' }, ['confirm', 'change'].map((value) => {
      const input = h('input', { type: 'radio', name: `${base}-action`, value });
      input.addEventListener('change', () => setAction(value));
      actionInputs[value] = input;
      return h('label', { class: 'cqa-segment' }, input, h('span', { text: ACTION_TEXT[value] }));
    })),
    actionHint,
    actionError,
  );

  // Новый ответ: опции критерия из снимка этой оценки
  const choiceNodes = new Map();
  const answerError = h('div', { class: 'cqa-field-error', hidden: true });
  const answerFieldset = h(
    'fieldset',
    { class: 'cqa-fieldset', hidden: true },
    h('legend', { text: 'Новый ответ' }),
    h('div', { class: 'cqa-choices' }, choices.map((choice) => {
      const input = h('input', { type: 'radio', name: `${base}-answer`, value: choice.key });
      input.addEventListener('change', syncChoice);
      const now = h('span', { class: 'cqa-tag cqa-tag--neutral', text: 'сейчас', hidden: true });
      choiceNodes.set(choice.key, { input, now });
      return h(
        'label',
        { class: 'cqa-choice' },
        input,
        h('span', { class: 'cqa-choice-main' }, h('span', { class: 'cqa-choice-label', text: choice.label }), now),
        choice.description ? h('span', { class: 'cqa-choice-desc', text: choice.description }) : null,
      );
    })),
    answerError,
  );

  const naReason = field({
    id: `${base}-na`,
    label: 'Причина N/A',
    control: h('textarea', { rows: 2 }),
    hint: 'Почему критерий неприменим к этому разговору.',
  });
  naReason.el.hidden = true;

  // Доказательства: реплики, выбранные в переписке
  const evidenceList = h('div', { class: 'cqa-evidence cqa-evidence-picked' });
  const evidenceBox = h(
    'div',
    { class: 'cqa-decision-evidence', hidden: true },
    h('p', { class: 'cqa-decision-label', text: 'Доказательства, необязательно' }),
    h('p', { class: 'cqa-field-hint', text: 'Щёлкните по реплике в переписке слева, чтобы добавить её в решение; повторный щелчок уберёт её.' }),
    evidenceList,
  );

  const reason = field({ id: `${base}-reason`, label: 'Причина решения', control: h('textarea', { rows: 3 }), hint: REASON_HINT.confirm });

  const currentLine = h('p', { class: 'cqa-decision-current' }, h('span', { class: 'cqa-muted', text: 'Загрузка актуальной оценки…' }));
  const notice = h('div', { class: 'cqa-alert cqa-alert--info', role: 'status', hidden: true });
  const formError = h('div', { class: 'cqa-form-error', role: 'alert', hidden: true });
  const submit = h('button', { type: 'submit', class: 'cqa-button cqa-button--primary', text: 'Сохранить решение', disabled: true });
  const cancel = h('button', { type: 'button', class: 'cqa-button', text: 'Отмена', on: { click: () => onCancel() } });

  const el = h(
    'form',
    { class: 'cqa-decision', novalidate: true, 'aria-label': `Решение по апелляции: ${criterion.name}` },
    h(
      'div',
      { class: 'cqa-decision-head' },
      h('h4', { text: 'Решение по апелляции' }),
      h('span', { class: 'cqa-muted cqa-small', text: `подана ${formatDateTime(appeal.created_at)}` }),
    ),
    h('div', { class: 'cqa-appeal-quote' }, h('p', { class: 'cqa-decision-label', text: 'Комментарий оператора' }), h('p', { class: 'cqa-appeal-quote-text', text: appeal.comment })),
    currentLine,
    actionFieldset,
    answerFieldset,
    naReason.el,
    evidenceBox,
    reason.el,
    notice,
    formError,
    h('div', { class: 'cqa-actions' }, submit, cancel),
  );

  function selectedKey() {
    for (const [key, node] of choiceNodes) if (node.input.checked) return key;
    return null;
  }

  function setPicking(on) {
    if (picking === on) return;
    picking = on;
    onPickingChange(on);
  }

  function setAction(value) {
    action = value;
    actionError.hidden = true;
    answerFieldset.hidden = value !== 'change';
    evidenceBox.hidden = value !== 'change';
    reason.setHint(REASON_HINT[value]);
    submit.textContent = SUBMIT_TEXT[value];
    syncChoice();
    syncActionHint();
    setPicking(value === 'change');
  }

  function syncChoice() {
    const key = selectedKey();
    const choice = findChoice(choices, key);
    naReason.el.hidden = !(action === 'change' && choice && choice.key === NA_CHOICE);
    for (const [nodeKey, node] of choiceNodes) node.input.closest('.cqa-choice').classList.toggle('is-checked', nodeKey === key);
    if (choice) answerError.hidden = true;
  }

  function syncActionHint() {
    const invalid = !currentAnswer || currentAnswer.status === 'invalid';
    actionHint.hidden = !(action === 'confirm' && invalid);
    actionHint.textContent = 'Валидного ответа нет: подтверждение оставит критерий без ответа и на ручной проверке. Чтобы засчитать критерий, выберите «Изменить ответ».';
  }

  function renderEvidence() {
    clear(evidenceList);
    if (!evidence.length) {
      evidenceList.append(h('span', { class: 'cqa-muted', text: 'Реплики не выбраны: решение сохранится с предупреждением «без доказательств».' }));
      return;
    }
    for (const id of evidence) {
      const message = getMessage(id);
      const phase = message && !isClientFacingPhase(message.phase) ? phaseLabel(message.phase) : '';
      evidenceList.append(h(
        'span',
        { class: 'cqa-chip cqa-chip--picked' },
        h('button', {
          type: 'button',
          class: 'cqa-chip-show',
          title: message ? `${labelFor(ROLE_LABELS, message.speaker)}: ${String(message.text || '').slice(0, 160)}` : '',
          on: { click: () => onShowMessage(id) },
        }, `#${id}`, phase ? h('span', { class: 'cqa-chip-phase', text: phase }) : null),
        h('button', { type: 'button', class: 'cqa-chip-remove', 'aria-label': `Убрать #${id} из доказательств`, text: '×', on: { click: () => toggleEvidence(id) } }),
      ));
    }
  }

  function toggleEvidence(id) {
    evidence = toggleEvidenceId(evidence, id);
    renderEvidence();
    onEvidenceChange(evidence);
  }

  function clearErrors() {
    actionError.hidden = true;
    answerError.hidden = true;
    reason.clearError();
    naReason.clearError();
    formError.hidden = true;
    notice.hidden = true;
  }

  function showErrors(errors) {
    let first = null;
    for (const [key, message] of Object.entries(errors)) {
      if (key === 'action') {
        actionError.textContent = message;
        actionError.hidden = false;
        first = first || actionInputs.confirm;
      } else if (key === 'reason') {
        reason.setError(message);
        first = first || reason.control;
      } else if (key === 'na_reason') {
        naReason.setError(message);
        first = first || naReason.control;
      } else if (key.startsWith('new_answer')) {
        answerError.textContent = message;
        answerError.hidden = false;
        first = first || (choiceNodes.size ? choiceNodes.values().next().value.input : null);
      }
    }
    if (first) first.focus();
  }

  function setBusy(value) {
    busy = value;
    submit.disabled = value || expectedRevision === null;
    cancel.disabled = value;
    if (value) submit.textContent = 'Сохранение…';
    else submit.textContent = action ? SUBMIT_TEXT[action] : 'Сохранить решение';
  }

  el.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy || expectedRevision === null) return;
    clearErrors();
    const choice = action === 'change' ? findChoice(choices, selectedKey()) : null;
    const errors = validateDecision({ action, reason: reason.control.value, choice, naReason: naReason.control.value });
    if (Object.keys(errors).length) {
      showErrors(errors);
      return;
    }
    const body = buildDecisionRequest({
      action,
      reason: reason.control.value,
      expectedFinalRevision: expectedRevision,
      choice,
      naReason: naReason.control.value,
      evidenceIds: evidence,
    });
    setBusy(true);
    try {
      const result = await api.decideAppeal(appeal.id, body);
      busy = false;
      onDecided(result);
    } catch (error) {
      setBusy(false);
      if (error.code === 'VERSION_CONFLICT') {
        notice.textContent = 'Оценка изменилась, данные обновлены. Проверьте текущий ответ и отправьте решение ещё раз.';
        notice.hidden = false;
        expectedRevision = null;
        submit.disabled = true;
        onConflict();
      } else if (error.code === 'APPEAL_ALREADY_RESOLVED') {
        onAlreadyResolved(error);
      } else {
        showErrors(fieldErrors(error.details));
        formError.textContent = error.message;
        formError.hidden = false;
      }
    }
  });

  renderEvidence();

  return {
    el,
    criterionId: criterion.id,
    // Свежая оценка: номер финальной ревизии для expected_final_revision и текущий ответ критерия.
    setEvaluation(evaluation) {
      expectedRevision = evaluation.final_revision;
      const result = (evaluation.final.criteria || []).find((item) => item.criterion_id === criterion.id) || null;
      currentAnswer = result ? result.answer : null;
      clear(currentLine).append(h('span', { class: 'cqa-note-label', text: 'Сейчас засчитано' }), verdict(currentAnswer, criterion));
      const nowKey = choiceKeyFor(currentAnswer, choices);
      for (const [key, node] of choiceNodes) node.now.hidden = key !== nowKey;
      syncActionHint();
      submit.disabled = busy;
    },
    setLoadError(message) {
      clear(currentLine).append(h('span', { class: 'cqa-form-error', text: `Актуальная оценка не загружена: ${message}` }));
    },
    toggleEvidence,
    focus() {
      (actionInputs.confirm || el).focus({ preventScroll: true });
    },
    destroy() {
      setPicking(false);
      if (evidence.length) {
        evidence = [];
        onEvidenceChange(evidence);
      }
    },
  };
}
