import assert from 'node:assert/strict';
import { test } from 'node:test';

import { groupTranscript, isClientFacingPhase, phaseLabel } from '../js/lib/phases.js';

const message = (id, phase) => ({ id, phase, speaker: 'operator', text: `m${id}`, client_facing: isClientFacingPhase(phase) });

test('подряд идущие hold и internal_consult собираются в отдельные блоки', () => {
  const segments = groupTranscript([
    message(1, 'pre_operator'),
    message(2, 'client'),
    message(3, 'hold'),
    message(4, 'hold'),
    message(5, 'internal_consult'),
    message(6, 'internal_consult'),
    message(7, 'hold'),
    message(8, 'client'),
    message(9, 'after_end'),
  ]);
  assert.deepEqual(
    segments.map((segment) => (segment.type === 'block' ? `${segment.phase}:${segment.messages.map((m) => m.id).join(',')}` : segment.message.id)),
    [1, 2, 'hold:3,4', 'internal_consult:5,6', 'hold:7', 8, 9],
  );
  assert.equal(segments[2].caption, 'Клиент на удержании — не слышит');
  assert.equal(segments[3].caption, 'Внутренняя консультация — клиент не слышит');
});

test('неизвестная фаза не ломает группировку и показывается как есть', () => {
  const segments = groupTranscript([message(1, 'client'), message(2, 'whisper'), message(3, 'hold'), message(4, undefined)]);
  assert.equal(segments.length, 4);
  assert.equal(segments[1].type, 'message');
  assert.equal(segments[2].type, 'block');
  assert.equal(phaseLabel('whisper'), 'whisper');
  assert.equal(phaseLabel(undefined), '');
  assert.deepEqual(groupTranscript(null), []);
});

test('подписи фаз', () => {
  assert.equal(phaseLabel('pre_operator'), 'До оператора');
  assert.equal(phaseLabel('client'), '');
  assert.equal(phaseLabel('hold'), 'Удержание');
  assert.equal(phaseLabel('internal_consult'), 'Внутренняя консультация');
  assert.equal(phaseLabel('after_end'), 'После завершения');
  assert.equal(isClientFacingPhase('client'), true);
  assert.equal(isClientFacingPhase('hold'), false);
});
