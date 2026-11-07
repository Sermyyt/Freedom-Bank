import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CHANNEL_LABELS,
  EVENT_LABELS,
  ROLE_LABELS,
  describeIssueLocation,
  labelFor,
  messageFlagLabel,
} from '../js/lib/labels.js';

test('известные значения получают подпись, неизвестные показываются как есть', () => {
  assert.equal(labelFor(ROLE_LABELS, 'operator'), 'Оператор');
  assert.equal(labelFor(ROLE_LABELS, 'supervisor'), 'supervisor');
  assert.equal(labelFor(CHANNEL_LABELS, 'voice call'), 'Звонок');
  assert.equal(labelFor(CHANNEL_LABELS, 'email'), 'email');
  assert.equal(labelFor(EVENT_LABELS, 'hold_start'), 'Клиент поставлен на удержание');
  assert.equal(labelFor(EVENT_LABELS, 'new_event_code'), 'new_event_code');
  assert.equal(labelFor(EVENT_LABELS, 'toString'), 'toString');
  assert.equal(labelFor(EVENT_LABELS, null), '');
});

test('флаги сообщений', () => {
  assert.equal(messageFlagLabel('duplicate_of_prev', { duplicate_of_message_id: 15 }), 'дубль #15');
  assert.equal(messageFlagLabel('duplicate_of_prev', { duplicate_of_message_id: null }), 'дубль');
  assert.equal(messageFlagLabel('after_end', {}), 'после завершения');
  assert.equal(messageFlagLabel('pii_masked', {}), 'данные скрыты');
  assert.equal(messageFlagLabel('unknown_event', {}), 'неизвестное событие');
  assert.equal(messageFlagLabel('brand_new_flag', {}), 'brand_new_flag');
});

test('место проблемы импорта: запись с единицы, реплика как есть', () => {
  assert.equal(
    describeIssueLocation({ record_index: 4, conversation_id: 'syn-1', message_id: 8 }),
    'Запись №5 · syn-1 · реплика №8',
  );
  assert.equal(describeIssueLocation({ record_index: 0, conversation_id: null, message_id: null }), 'Запись №1');
  assert.equal(describeIssueLocation({ record_index: null, conversation_id: null, message_id: null }), '');
});
