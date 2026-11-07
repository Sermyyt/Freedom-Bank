import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DASH,
  displayTimestamp,
  formatDateTime,
  formatDelta,
  formatNumber,
  formatPercent,
  pluralRu,
} from '../js/lib/format.js';

test('числа: 0 и 2 знака по ru-RU', () => {
  assert.equal(formatNumber(100, 2), '100,00');
  assert.equal(formatNumber(90, 2), '90,00');
  assert.equal(formatNumber(100, 0), '100');
  assert.equal(formatNumber(0, 0), '0');
  assert.equal(formatNumber(87.25, 1), '87,3');
  assert.equal(formatNumber(0.891089108910892, 2), '0,89');
});

test('null и нечисловые значения → «—»', () => {
  assert.equal(formatNumber(null, 2), DASH);
  assert.equal(formatNumber(undefined, 2), DASH);
  assert.equal(formatNumber(Number.NaN, 2), DASH);
  assert.equal(formatNumber('100', 2), DASH);
  assert.equal(formatPercent(null, 2), DASH);
  assert.equal(formatDelta(null, 2), DASH);
});

test('неизвестная точность → 2 знака, отрицательный ноль без знака', () => {
  assert.equal(formatNumber(1, undefined), '1,00');
  assert.equal(formatNumber(-0, 2), '0,00');
  assert.equal(formatNumber(-0.001, 2), '0,00');
});

test('разница со знаком', () => {
  assert.equal(formatDelta(0.891089108910892, 2), '+0,89');
  assert.equal(formatDelta(0, 2), '0,00');
  assert.equal(formatDelta(-0.001, 2), '0,00');
  const negative = formatDelta(-0.148514851485148, 2);
  assert.ok(negative.endsWith('0,15') && negative.length === 5, negative);
});

test('проценты с неразрывным пробелом', () => {
  assert.equal(formatPercent(100, 2), '100,00 %');
  assert.equal(formatPercent(62.5, 0), '63 %');
});

test('дата и время сервера в ru-RU', () => {
  assert.equal(formatDateTime('2026-11-07T12:25:52.281451Z', 'UTC'), '07.11.2026, 12:25');
  assert.equal(formatDateTime(null), DASH);
  assert.equal(formatDateTime('не дата'), 'не дата');
});

test('время реплики: MM:SS как есть, у ISO — время суток из строки', () => {
  assert.equal(displayTimestamp('00:02'), '00:02');
  assert.equal(displayTimestamp('1:02:03'), '1:02:03');
  assert.equal(displayTimestamp('2026-11-01T10:00:05+05:00'), '10:00:05');
  assert.equal(displayTimestamp('2026-11-01 23:59:59Z'), '23:59:59');
  assert.equal(displayTimestamp('вчера'), 'вчера');
  assert.equal(displayTimestamp(null), '');
});

test('склонение', () => {
  const forms = ['сообщение', 'сообщения', 'сообщений'];
  assert.equal(pluralRu(1, forms), 'сообщение');
  assert.equal(pluralRu(3, forms), 'сообщения');
  assert.equal(pluralRu(5, forms), 'сообщений');
  assert.equal(pluralRu(11, forms), 'сообщений');
  assert.equal(pluralRu(21, forms), 'сообщение');
  assert.equal(pluralRu(112, forms), 'сообщений');
});
