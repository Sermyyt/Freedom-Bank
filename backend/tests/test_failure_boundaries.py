"""Failures must not create partial decisions or discard completed batch items."""
from copy import deepcopy
import json
import time
import pytest


@pytest.mark.parametrize("body", [
    {"action": "confirm", "reason": " "},
    {"action": "confirm", "reason": "Review", "rationale": "Unexpected change"},
    {"action": "confirm", "reason": "Review", "evidence_message_ids": [1]},
    {"action": "change", "reason": "Review"},
    {"action": "change", "reason": "Review", "new_answer": {"status": "invalid", "value": None}},
    {"action": "change", "reason": "Review", "new_answer": {"status": "answered", "value": True}, "rationale": " "},
])
def test_invalid_human_decisions_are_rejected_before_state_changes(client, body):
    response = client.post('/api/appeals/missing/decision', json={"expected_final_revision": 0, **body})
    assert response.status_code == 422
    assert response.json()['error']['code'] == 'VALIDATION_ERROR'


@pytest.mark.parametrize("payload,status,code", [
    ({"isSuccess": False, "error": "private-upstream-value"}, 502, 'DATASET_UPSTREAM_ERROR'),
    ({"isSuccess": True, "data": {"dataset_group_id": "OTHER", "records": [], "total_records": 0}}, 409, 'GROUP_MISMATCH'),
])
def test_dataset_upstream_failures_have_safe_error_envelopes(client, monkeypatch, payload, status, code):
    monkeypatch.setattr('app.imports.fetch_dataset', lambda *args: payload)
    response = client.post('/api/imports/dataset', json={'group_id': 'TEST'})
    assert response.status_code == status
    assert response.json()['error']['code'] == code
    assert 'private-upstream-value' not in response.text


def test_coordinator_failure_preserves_completed_items(client, api, dataset, monkeypatch):
    records = dataset['data']['records']
    duplicate = deepcopy(records[0])
    duplicate['conversation_id'] += '-second'
    payload = [*records, duplicate]
    response = client.post('/api/imports/file', data={'group_id': 'TEST'},
                           files={'file': ('test.json', json.dumps(payload, ensure_ascii=False).encode('utf-8'), 'application/json')})
    assert response.status_code == 200

    def fail_after_first(identifier, count, definition, config):
        api.state.runner.run_item(identifier, 0, definition, config)
        raise RuntimeError('private-internal-error')

    monkeypatch.setattr(api.state.runner, 'process_items', fail_after_first)
    job = client.post('/api/evaluations', json={'group_id': 'TEST'}).json()['data']
    deadline = time.monotonic() + 5
    while job['status'] in {'queued', 'running'} and time.monotonic() < deadline:
        time.sleep(.01)
        response = client.get('/api/jobs/' + job['id'])
        assert 'private-internal-error' not in response.text
        job = response.json()['data']
    assert job['status'] == 'failed'
    assert job['succeeded'] == 1
    assert job['failed'] == 1
    assert job['progress_percent'] == 100
    completed = next(item for item in job['items'] if item['status'] == 'completed')
    assert client.get('/api/evaluations/' + completed['evaluation_id']).status_code == 200
