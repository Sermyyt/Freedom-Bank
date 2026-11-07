"""Defense tools read synthetic API data; never call external providers."""
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.evaluation import PROMPT_VERSION
from scripts import make_gold_template, preflight
from scripts.eval_gold import GoldCase, GoldDocument
from scripts.gen_api_examples import synthetic_dataset
from scripts.api_read import items
from scripts.run_batch import BatchError


def test_templates_keep_revision_rules_and_blank_answers_without_model_labels(tmp_path):
    with TestClient(create_app(Settings(database_path=tmp_path / 'test.db'))) as client:
        client.post('/api/imports/file', data={'group_id': 'G'}, files={
            'file': ('sample.json', json.dumps(synthetic_dataset('G')), 'application/json')})
        refs = client.get('/api/conversations', params={'group_id': 'G'}).json()['data']['items']
        identifier = refs[0]['ref']['conversation_id']
        result = make_gold_template.make_templates(client, [identifier], 'G', tmp_path/'gold', 'Human')
        path = tmp_path/'gold'/f'{identifier}.json'
        document = json.loads(path.read_text(encoding='utf-8'))
        assert result == {'created': [identifier], 'skipped': []}
        assert GoldDocument.model_validate(document).provenance.reviewer == 'Human'
        case = document['cases'][0]
        assert case['revision_id'] == refs[0]['ref']['revision_id']
        assert 'total' not in case
        with pytest.raises(ValueError):
            GoldCase.model_validate(case)
        for criterion in case['criteria']:
            assert criterion['answer'] == {'status': None, 'value': None}
            assert criterion['guidance']['description']
            assert criterion['guidance']['allowed_answers']
            criterion['answer'] = criterion['guidance']['allowed_answers'][0]['answer']
        GoldCase.model_validate(case)
        path.write_text('human work', encoding='utf-8')
        assert make_gold_template.make_templates(client, [identifier], 'G', tmp_path/'gold', 'Human')['skipped'] == [identifier]
        assert path.read_text(encoding='utf-8') == 'human work'


@pytest.mark.parametrize('identifier', ['../escape', 'a/b', 'a\\b', 'CON', 'name.', 'a:b', ''])
def test_template_filename_cannot_escape_or_use_windows_device(tmp_path, identifier):
    with pytest.raises(ValueError):
        make_gold_template.safe_path(tmp_path, identifier)


@pytest.fixture
def preflight_api():
    state = {'health': {'provider': 'openai', 'model': 'synthetic-model', 'is_demo': False,
        'evaluation_ready': True, 'dataset_ready': True, 'database_ready': True,
        'active_checklist_version_id': 'active', 'prompt_version': PROMPT_VERSION},
        'revisions': ['r1', 'r2'], 'evaluations': [], 'root_status': 200, 'root_type': 'text/html', 'calls': []}
    for i in (1, 2):
        state['evaluations'].append({'id': f'e{i}', 'conversation': {'revision_id': f'r{i}'},
            'checklist_version_id': 'active', 'is_demo': False, 'status': 'completed',
            'usage': {'provider': 'openai', 'model': 'synthetic-model', 'prompt_version': PROMPT_VERSION}})
    def handler(request):
        state['calls'].append(request)
        path = request.url.path
        if path == '/':
            return httpx.Response(state['root_status'], text='<html><div id="cqa-root"></div></html>',
                                  headers={'content-type': state['root_type']})
        if path == '/api/health': data = state['health']
        elif path == '/api/checklist-versions/active': data = {'id': 'active', 'definition': {'criteria': [{'id': 'rule'}]}}
        elif path == '/api/conversations':
            items = [{'ref': {'revision_id': r}} for r in state['revisions']]
            offset = int(request.url.params.get('offset', 0))
            data = {'items': items[offset:offset+1], 'total': len(items)}
        elif path == '/api/evaluations':
            offset = int(request.url.params.get('offset', 0))
            data = {'items': state['evaluations'][offset:offset+1], 'total': len(state['evaluations'])}
        else: data = next(e for e in state['evaluations'] if path.endswith('/'+e['id']))
        return httpx.Response(200, json={'data': data})
    state['client'] = httpx.Client(base_url='http://example.invalid', transport=httpx.MockTransport(handler))
    yield state
    state['client'].close()


def test_preflight_paginates_and_accepts_all_current_real_evaluations(preflight_api):
    checks = preflight.check(preflight_api['client'])
    assert all(row['ok'] for row in checks)
    assert next(row for row in checks if row['name'] == 'DEV evaluations')['detail'] == '2/2 current prompt, checklist, revision and provider/model'
    assert all(request.method == 'GET' for request in preflight_api['calls'])


@pytest.mark.parametrize('field,value', [('is_demo', True), ('checklist_version_id', 'old'),
    ('status', 'failed'), ('conversation', {'revision_id': 'old'})])
def test_preflight_does_not_count_wrong_evaluation(preflight_api, field, value):
    preflight_api['evaluations'][0][field] = value
    checks = preflight.check(preflight_api['client'])
    assert not next(row for row in checks if row['name'] == 'DEV evaluations')['ok']


@pytest.mark.parametrize('field', ['prompt_version', 'provider', 'model'])
def test_preflight_requires_current_usage_identity(preflight_api, field):
    preflight_api['evaluations'][0]['usage'][field] = 'old'
    assert not next(row for row in preflight.check(preflight_api['client']) if row['name'] == 'DEV evaluations')['ok']


def test_preflight_reports_fake_missing_source_and_static_failure(preflight_api, capsys, monkeypatch):
    preflight_api['health'].update(provider='fake', is_demo=True, dataset_ready=False)
    preflight_api['root_status'] = 404
    monkeypatch.setattr(preflight.httpx, 'Client', lambda **kwargs: preflight_api['client'])
    assert preflight.main([]) == 1
    output = capsys.readouterr().out
    assert 'FAIL provider' in output and 'DEMO' in output
    assert 'FAIL dataset_ready' in output and 'FAIL interface' in output
    assert 'RESULT FAIL' in output


def test_preflight_missing_prompt_or_empty_group_is_failure(preflight_api):
    preflight_api['health'].pop('prompt_version')
    preflight_api['revisions'] = []
    checks = preflight.check(preflight_api['client'])
    assert not next(row for row in checks if row['name'] == 'prompt_version')['ok']
    assert not next(row for row in checks if row['name'] == 'DEV conversations')['ok']


def test_preflight_offline_fails_without_echoing_private_error(monkeypatch, capsys):
    def fail(request):
        raise httpx.ConnectError('PRIVATE transport URL', request=request)
    client = httpx.Client(base_url='http://example.invalid', transport=httpx.MockTransport(fail))
    monkeypatch.setattr(preflight.httpx, 'Client', lambda **kwargs: client)
    assert preflight.main([]) == 1
    output = capsys.readouterr().out
    assert 'RESULT FAIL' in output and 'PRIVATE' not in output


def test_health_reports_running_prompt(client):
    assert client.get('/api/health').json()['data']['prompt_version'] == PROMPT_VERSION


@pytest.mark.parametrize('page', [None, [], {'items': [], 'total': 1}, {'items': [1], 'total': 1},
    {'items': [], 'total': True}, {'items': [], 'total': -1}, {'items': None, 'total': 1}])
def test_pagination_rejects_malformed_or_stalled_pages(page):
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json={'data': page}))
    with httpx.Client(base_url='http://example.invalid', transport=transport) as client:
        with pytest.raises(BatchError):
            list(items(client, '/api/conversations'))


def test_preflight_checks_root_content_type_and_active_version(preflight_api):
    preflight_api['root_type'] = 'application/json'
    preflight_api['health']['active_checklist_version_id'] = None
    checks = preflight.check(preflight_api['client'])
    assert not next(row for row in checks if row['name'] == 'active checklist')['ok']
    assert not next(row for row in checks if row['name'] == 'interface')['ok']


def test_template_cli_error_is_safe(tmp_path, monkeypatch, capsys):
    client = httpx.Client(base_url='http://example.invalid', transport=httpx.MockTransport(
        lambda request: httpx.Response(500, text='PRIVATE response')))
    monkeypatch.setattr(make_gold_template.httpx, 'Client', lambda **kwargs: client)
    assert make_gold_template.main(['example', '--reviewer', 'Human', '--output', str(tmp_path)]) == 1
    assert 'PRIVATE' not in capsys.readouterr().err


@pytest.mark.parametrize('identifiers,group,reviewer', [(['Case', 'case'], 'G', 'Human'),
    ([], 'G', 'Human'), (['case'], ' ', 'Human'), (['case'], 'G', ' ')])
def test_template_rejects_ambiguous_or_empty_identity_before_api(tmp_path, identifiers, group, reviewer):
    with pytest.raises(ValueError):
        make_gold_template.make_templates(None, identifiers, group, tmp_path, reviewer)


def test_template_cli_creates_fillable_document(tmp_path, monkeypatch, capsys):
    with TestClient(create_app(Settings(database_path=tmp_path/'test.db'))) as client:
        client.post('/api/imports/file', data={'group_id': 'G'}, files={
            'file': ('sample.json', json.dumps(synthetic_dataset('G')), 'application/json')})
        # Retain the enclosing TestClient lifespan while the CLI uses a separate context.
        class CLIClient:
            def __enter__(self): return client
            def __exit__(self, *args): pass
        monkeypatch.setattr(make_gold_template.httpx, 'Client', lambda **kwargs: CLIClient())
        assert make_gold_template.main(['demo-en', '--group', 'G', '--reviewer', 'Human', '--output', str(tmp_path/'gold')]) == 0
        assert json.loads(capsys.readouterr().out)['created'] == ['demo-en']


def test_preflight_missing_demo_flag_is_not_real_result(preflight_api):
    preflight_api['evaluations'][0].pop('is_demo')
    assert not next(row for row in preflight.check(preflight_api['client']) if row['name'] == 'DEV evaluations')['ok']
