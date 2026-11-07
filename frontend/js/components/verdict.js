// Ответ критерия: значок и подпись. Смысл несёт подпись, цвет и значок только помогают.
import { h } from '../dom.js';
import { answerTone, formatAnswer } from '../lib/answers.js';

const VERDICT_MARKS = { good: '✓', bad: '✕', partial: '◐', na: '–', invalid: '?' };

export function verdict(answer, criterion) {
  const tone = answerTone(answer, criterion);
  return h(
    'span',
    { class: `cqa-verdict cqa-verdict--${tone}` },
    h('span', { class: 'cqa-verdict-mark', 'aria-hidden': 'true', text: VERDICT_MARKS[tone] }),
    h('span', { class: 'cqa-verdict-text', text: formatAnswer(answer, criterion) }),
  );
}
