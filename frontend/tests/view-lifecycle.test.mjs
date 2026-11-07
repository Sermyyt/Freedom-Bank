import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../js/api.js';
import { state } from '../js/state.js';
import { mount as mountConversation } from '../js/views/conversation.js';
import { mount as mountConversations } from '../js/views/conversations.js';
import { mount as mountChecklist } from '../js/views/checklist.js';
import { button, deferred, flush, viewDocument } from './support/view-dom.mjs';

const ref = { id: 'conversation-a', conversation_id: 'synthetic-a', revision_id: 'revision-a', revision: 1, group_id: 'SYNTHETIC' };
const detail = { ref, transcript: [], language: 'ru', channel: 'chat', warnings: [], manual_review_reasons: [] };
const job = { id: 'job-a', status: 'running', total: 1, processed: 0, succeeded: 0, failed: 0, manual_review_count: 0, progress_percent: 0, items: [] };
const completed = { ...job, status: 'completed', processed: 1, succeeded: 1, progress_percent: 100, items: [{ evaluation_id: 'evaluation-a' }] };
const definition = {
  name: 'Synthetic checklist', description: '', criteria: [{
    id: 'rule', name: 'Rule', description: 'Synthetic rule', section: '', answer_type: 'binary', weight: 1,
    na_allowed: false, na_condition: null,
    options: [{ value: true, label: 'Yes', description: 'Yes', normalized: 1 }, { value: false, label: 'No', description: 'No', normalized: 0 }],
  }],
};
const version = { id: 'version-a', checklist_id: 'checklist-a', version: 1, is_active: true, created_at: '2026-01-01T00:00:00Z', definition };

function setup(t) {
  const dom = viewDocument(t);
  const previous = { ...state };
  Object.assign(state, { health: { dataset_ready: true, evaluation_ready: true }, groupJob: null, lastConversation: null, importOpen: true, recentGroups: [] });
  t.after(() => Object.assign(state, previous));
  t.mock.method(api, 'getConversation', async () => structuredClone(detail));
  t.mock.method(api, 'listEvaluations', async () => ({ items: [], total: 0 }));
  t.mock.method(api, 'listConversations', async () => ({ items: [], total: 0, limit: 25, offset: 0 }));
  return dom;
}

async function conversation(t) {
  const dom = setup(t);
  const view = mountConversation(dom.root, { params: [ref.id], query: {} });
  t.after(() => view.destroy());
  await flush();
  return { ...dom, view };
}

test('leaving before evaluation POST resolves cannot start polling or reopen the old conversation', async t => {
  const { root, view } = await conversation(t);
  const pending = deferred();
  t.mock.method(api, 'startEvaluation', () => pending.promise);
  const reads = t.mock.method(api, 'getJob', async () => completed);
  button(root, 'Оценить').click();
  view.destroy();
  root.replaceChildren();
  location.hash = '#/checklist';
  pending.resolve(completed);
  await flush();
  assert.equal(location.hash, '#/checklist');
  assert.equal(reads.mock.callCount(), 0);
});

for (const kind of ['dataset', 'file']) {
  test(`leaving during ${kind} import does not redirect a new screen`, async t => {
    const { root, doc } = setup(t);
    const view = mountConversations(root, { query: {} });
    t.after(() => view.destroy());
    await flush();
    const pending = deferred();
    t.mock.method(api, kind === 'dataset' ? 'importDataset' : 'importFile', () => pending.promise);
    const control = doc.getElementById(kind === 'dataset' ? 'cqa-dataset-group' : 'cqa-import-file');
    if (kind === 'dataset') control.value = 'SYNTHETIC';
    else control.files = [{ name: 'synthetic.json' }];
    control.closest('form').dispatchEvent(new Event('submit', { cancelable: true }));
    view.destroy();
    root.replaceChildren();
    location.hash = '#/checklist';
    pending.resolve({ group_id: 'SYNTHETIC', received: 1, created: 1, updated: 0, unchanged: 0, errors: [], warnings: [] });
    await flush();
    assert.equal(location.hash, '#/checklist');
    assert.equal(state.recentGroups.length, 0, 'destroyed import view does not mutate filter UI');
  });
}

test('poll failures keep evaluation locked and retry only GET for the existing job', async t => {
  const { root } = await conversation(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const posts = t.mock.method(api, 'startEvaluation', async () => job);
  let attempts = 0;
  const reads = t.mock.method(api, 'getJob', async id => {
    assert.equal(id, job.id);
    if (++attempts <= 5) throw Object.assign(new Error('Temporary network failure'), { status: 0 });
    return completed;
  });
  const evaluate = button(root, 'Оценить');
  evaluate.click();
  await flush();
  for (let i = 0; i < 5; i += 1) { t.mock.timers.tick(1000); await flush(); }
  assert.equal(reads.mock.callCount(), 5);
  assert.equal(evaluate.disabled, true);
  evaluate.click();
  button(root, 'Проверить снова').click();
  await flush();
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(posts.mock.callCount(), 1);
  assert.equal(reads.mock.callCount(), 6);
  assert.equal(location.hash, '#/conversation/conversation-a?evaluation=evaluation-a');
});

test('group POST completed after navigation is retained without polling the detached screen', async t => {
  const { root } = setup(t);
  const view = mountConversations(root, { query: { group_id: 'SYNTHETIC' } });
  t.after(() => view.destroy());
  await flush();
  const pending = deferred();
  t.mock.method(api, 'startEvaluation', () => pending.promise);
  const reads = t.mock.method(api, 'getJob', async () => completed);
  button(root, 'Оценить всю группу').click();
  view.destroy();
  root.replaceChildren();
  location.hash = '#/checklist';
  pending.resolve(job);
  await flush();
  assert.equal(state.groupJob.job.id, job.id, 'returning to the list can resume this job');
  assert.equal(reads.mock.callCount(), 0);
  assert.equal(location.hash, '#/checklist');
});

test('group poll failure does not enable another group POST', async t => {
  const { root } = setup(t);
  const view = mountConversations(root, { query: { group_id: 'SYNTHETIC' } });
  t.after(() => view.destroy());
  await flush();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const posts = t.mock.method(api, 'startEvaluation', async () => job);
  let attempts = 0;
  t.mock.method(api, 'getJob', async () => {
    if (++attempts <= 5) throw Object.assign(new Error('Temporary failure'), { status: 0 });
    return completed;
  });
  const evaluate = button(root, 'Оценить всю группу');
  evaluate.click();
  await flush();
  for (let i = 0; i < 5; i += 1) { t.mock.timers.tick(1000); await flush(); }
  assert.equal(evaluate.disabled, true);
  evaluate.click();
  button(root, 'Проверить снова').click();
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(posts.mock.callCount(), 1);
  assert.equal(state.groupJob.job.status, 'completed');
});

async function checklist(t) {
  const dom = setup(t);
  t.mock.method(api, 'getHealth', async () => ({ active_checklist_version_id: version.id }));
  t.mock.method(api, 'getChecklistVersion', async () => structuredClone(version));
  t.mock.method(api, 'getChecklist', async () => ({ id: version.checklist_id, latest_version_id: version.id }));
  t.mock.method(api, 'listChecklistVersions', async () => ({ items: [structuredClone(version)] }));
  const view = mountChecklist(dom.root);
  t.after(() => view.destroy());
  await flush();
  const name = dom.doc.getElementById('cqa-cl-name');
  name.value = 'Submitted A';
  name.dispatchEvent(new Event('input'));
  return { ...dom, view, name };
}

test('checklist save locks controls and restores their state before focusing a server field error', async t => {
  const { root, name, doc } = await checklist(t);
  const pending = deferred();
  t.mock.method(api, 'createChecklistVersion', () => pending.promise);
  button(root, 'Сохранить новую версию').click();
  await flush();
  const controls = root.querySelector('.cqa-ed-grid').querySelectorAll('input, select, textarea, button');
  assert(controls.length > 10);
  assert(controls.every(control => control.disabled), 'text, options and structural buttons cannot change the submitted draft');
  pending.reject(Object.assign(new Error('Invalid name'), { status: 422, details: [{ path: ['body', 'name'], message: 'Invalid name' }] }));
  await flush();
  assert.equal(name.disabled, false);
  assert.equal(name.value, 'Submitted A');
  assert.equal(button(root, 'Сохранить новую версию').disabled, true, 'invalid server fields still block saving');
  assert.equal(doc.activeElement, name, 'the field is unlocked before focus moves to its error');
  const moves = root.querySelectorAll('button').filter(node => node.getAttribute('aria-label')?.startsWith('Переместить'));
  assert(moves.every(control => control.disabled), 'pre-existing disabled controls remain disabled');
});

test('a checklist save finishing after navigation does not reload or announce the old editor', async t => {
  const { root, view } = await checklist(t);
  const pending = deferred();
  t.mock.method(api, 'createChecklistVersion', () => pending.promise);
  const health = t.mock.method(api, 'getHealth', async () => ({ active_checklist_version_id: version.id }));
  button(root, 'Сохранить новую версию').click();
  await flush();
  view.destroy();
  root.replaceChildren();
  pending.resolve({ ...version, id: 'version-b', version: 2 });
  await flush();
  assert.equal(health.mock.callCount(), 1, 'only the pre-save health request; no detached editor refresh');
  assert.equal(root.childElementCount, 0);
});

test('successful save preserves the submitted draft and unlocks editable controls', async t => {
  const { root, name } = await checklist(t);
  const pending = deferred();
  let saved;
  t.mock.method(api, 'createChecklistVersion', async (id, body) => {
    saved = { ...version, id: 'version-b', version: 2, definition: { name: body.name, description: body.description, criteria: body.criteria } };
    return pending.promise;
  });
  t.mock.method(api, 'getChecklistVersion', async () => saved);
  button(root, 'Сохранить новую версию').click();
  await flush();
  assert.equal(name.disabled, true);
  assert.equal(saved.definition.name, 'Submitted A');
  pending.resolve(saved);
  await flush();
  assert.equal(name.value, 'Submitted A');
  assert.equal(name.disabled, false);
  assert.equal(root.querySelector('.cqa-saved').hidden, false);
});

test('checklist reevaluation retries the existing job after a poll failure', async t => {
  const { root } = await checklist(t);
  state.lastConversation = { id: ref.id, externalId: ref.conversation_id, revisionId: ref.revision_id };
  t.mock.method(api, 'createChecklistVersion', async () => ({ ...version, id: 'version-b', version: 2 }));
  button(root, 'Сохранить новую версию').click();
  await flush();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const posts = t.mock.method(api, 'startEvaluation', async () => job);
  let attempts = 0;
  t.mock.method(api, 'getJob', async () => {
    if (++attempts <= 5) throw Object.assign(new Error('Temporary failure'), { status: 0 });
    return completed;
  });
  button(root, 'Переоценить разговор').click();
  await flush();
  for (let i = 0; i < 5; i += 1) { t.mock.timers.tick(1000); await flush(); }
  button(root, 'Проверить снова').click();
  await flush();
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(posts.mock.callCount(), 1);
  assert.equal(root.querySelector('.cqa-saved-result').hidden, false);
});
