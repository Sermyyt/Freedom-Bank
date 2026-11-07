import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../js/api.js';
import { setState, state } from '../js/state.js';
import { mount as mountConversation } from '../js/views/conversation.js';
import { mount as mountConversations } from '../js/views/conversations.js';
import { flush, viewDocument } from './support/view-dom.mjs';

const ref = { id: 'precision-conversation', conversation_id: 'synthetic-precision', revision_id: 'current-revision', revision: 2, group_id: 'SYNTHETIC' };
const detail = { ref, transcript: [], language: 'RU', channel: 'agent chat', warnings: [], manual_review_reasons: [] };
const scores = [
  { final_total: 12, original_total: 11, scoring_policy: { decimals: 0 } },
  { final_total: 12.3, original_total: 11.2, scoring_policy: { decimals: 3 } },
  { final_total: 12.345, original_total: 11.234 },
  { final_total: 12.34567891, original_total: 11.23456789, scoring_policy: null },
];
const expectedFinal = ['12', '12,300', '12,345', '12,34567891'];
const expectedOriginal = ['исходно 11', 'исходно 11,200', 'исходно 11,234', 'исходно 11,23456789'];
const summaries = scores.map((score, index) => ({
  ...score, id: `precision-evaluation-${index}`, status: 'completed', is_demo: false,
  checklist_version_id: 'precision-version', created_at: '2026-01-01T00:00:00Z',
  conversation: { ...ref, revision_id: 'older-revision', revision: 1 },
}));

function setup(t, decimals) {
  const dom = viewDocument(t);
  const previous = { ...state };
  Object.assign(state, { health: { dataset_ready: true, evaluation_ready: true, scoring_policy: { decimals } },
    groupJob: null, lastConversation: null, importOpen: false, recentGroups: [] });
  t.after(() => Object.assign(state, previous));
  t.mock.method(api, 'getConversation', async () => structuredClone(detail));
  t.mock.method(api, 'listEvaluations', async () => ({ items: structuredClone(summaries), total: summaries.length }));
  t.mock.method(api, 'getChecklistVersion', async () => ({ id: 'precision-version', version: 1, definition: { name: 'Synthetic' } }));
  t.mock.method(api, 'listConversations', async () => ({
    items: summaries.map((summary, index) => ({ ...detail, ref: { ...ref, id: `list-${index}` }, message_count: 0, latest_evaluation: summary })),
    total: summaries.length, offset: 0, limit: 25,
  }));
  return dom;
}

for (const healthDecimals of [0, 4]) {
  test(`conversation list keeps each saved precision and legacy digits with health decimals=${healthDecimals}`, async t => {
    const { root } = setup(t, healthDecimals);
    const view = mountConversations(root, { query: {} });
    t.after(() => view.destroy());
    await flush();
    const displayed = () => root.querySelectorAll('.cqa-row-link').map(row => {
      const cell = row.children[5];
      return [cell.querySelector('strong').textContent, cell.querySelector('.cqa-muted').textContent];
    });
    const expected = expectedFinal.map((value, index) => [value, expectedOriginal[index]]);
    assert.deepEqual(displayed(), expected);
    setState({ health: { ...state.health, scoring_policy: { decimals: healthDecimals === 0 ? 4 : 0 } } });
    assert.deepEqual(displayed(), expected, 'refreshing health cannot reformat saved summaries');
  });

  test(`past evaluations keep individual policies and legacy digits with health decimals=${healthDecimals}`, async t => {
    const { root } = setup(t, healthDecimals);
    // The current revision has no evaluation; older summaries remain visible in its history.
    const view = mountConversation(root, { params: [ref.id], query: { revision: ref.revision_id } });
    t.after(() => view.destroy());
    await flush();
    const displayed = () => root.querySelector('.cqa-past').querySelector('tbody').children
      .map(row => row.children[2].querySelector('strong').textContent);
    assert.deepEqual(displayed(), expectedFinal);
    setState({ health: { ...state.health, scoring_policy: { decimals: healthDecimals === 0 ? 4 : 0 } } });
    assert.deepEqual(displayed(), expectedFinal);
  });
}
