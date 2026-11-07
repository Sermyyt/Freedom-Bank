// Фазы разговора приходят с сервера в каждой реплике. Здесь — только подписи и группировка
// подряд идущих реплик удержания и внутренней консультации в блоки «клиент не слышит».

const PHASE_LABELS = {
  pre_operator: 'До оператора',
  client: '',
  hold: 'Удержание',
  internal_consult: 'Внутренняя консультация',
  after_end: 'После завершения',
};

const BLOCK_CAPTIONS = {
  hold: 'Клиент на удержании — не слышит',
  internal_consult: 'Внутренняя консультация — клиент не слышит',
};

export const CLIENT_FACING_PHASES = ['pre_operator', 'client'];

export function phaseLabel(phase) {
  if (phase === null || phase === undefined) return '';
  return Object.prototype.hasOwnProperty.call(PHASE_LABELS, phase) ? PHASE_LABELS[phase] : String(phase);
}

export function isHiddenFromClientPhase(phase) {
  return Object.prototype.hasOwnProperty.call(BLOCK_CAPTIONS, phase);
}

export function isClientFacingPhase(phase) {
  return CLIENT_FACING_PHASES.includes(phase);
}

export function groupTranscript(messages) {
  const segments = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const phase = message ? message.phase : undefined;
    if (isHiddenFromClientPhase(phase)) {
      const last = segments[segments.length - 1];
      if (last && last.type === 'block' && last.phase === phase) {
        last.messages.push(message);
      } else {
        segments.push({ type: 'block', phase, caption: BLOCK_CAPTIONS[phase], messages: [message] });
      }
    } else {
      segments.push({ type: 'message', message });
    }
  }
  return segments;
}
