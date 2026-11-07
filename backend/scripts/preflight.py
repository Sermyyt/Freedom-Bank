"""Read-only readiness checks before the defense and the control-group release."""
from __future__ import annotations

import argparse
from pathlib import Path
import sys

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.api_read import items
from scripts.run_batch import BatchError, request_data


def row(name, ok, detail=''):
    return {'name': name, 'ok': bool(ok), 'detail': detail}


def current_evaluation(evaluation, health):
    usage = evaluation.get('usage', {})
    return (not evaluation.get('is_demo', True)
            and evaluation.get('original', {}).get('status') in {'completed', 'manual_review'}
            and evaluation.get('checklist_version_id') == health.get('active_checklist_version_id')
            and all(usage.get(key) == health.get(key) and health.get(key)
                    for key in ('prompt_version', 'provider', 'model')))


def coverage(client, health, expected_dev_count=None):
    revisions = {entry['ref']['revision_id'] for entry in items(client, '/api/conversations', group_id='DEV')}
    covered = set()
    active = health.get('active_checklist_version_id')
    if active:
        for summary in items(client, '/api/evaluations', checklist_version_id=active, is_demo=False):
            revision = summary['conversation']['revision_id']
            if revision not in revisions or revision in covered:
                continue
            evaluation = request_data(client, 'GET', f"/api/evaluations/{summary['id']}")
            if current_evaluation(evaluation, health):
                covered.add(revision)
    count_ok = bool(revisions) and (expected_dev_count is None or len(revisions) == expected_dev_count)
    count_detail = str(len(revisions)) + (f' (expected {expected_dev_count})' if expected_dev_count is not None else '')
    return [row('DEV conversations', count_ok, count_detail),
            row('DEV evaluations', bool(revisions) and covered == revisions,
                f'{len(covered)}/{len(revisions)} current prompt, checklist, revision and provider/model')]


def active_check(client, health):
    active = health.get('active_checklist_version_id')
    if not active:
        return row('active checklist', False, 'not configured')
    version = request_data(client, 'GET', f'/api/checklist-versions/{active}')
    return row('active checklist', version.get('id') == active and version.get('definition', {}).get('criteria'), active)


def interface_check(client):
    response = client.get('/')
    valid = response.status_code == 200 and 'text/html' in response.headers.get('content-type', '')
    return row('interface', valid and 'cqa-root' in response.text,
               f'HTTP {response.status_code}; HTML entry point only, not a browser rendering test')


def check(client, *, expected_dev_count=None, expected_prompt_version=None):
    health = request_data(client, 'GET', '/api/health')
    if not isinstance(health, dict):
        raise BatchError('Invalid health response.')
    real = health.get('provider') in {'openai', 'anthropic'} and health.get('is_demo') is False
    prompt = health.get('prompt_version')
    prompt_ok = bool(prompt) and (expected_prompt_version is None or prompt == expected_prompt_version)
    prompt_detail = str(prompt or 'missing') + (f' (expected {expected_prompt_version})' if expected_prompt_version else '')
    checks = [row('provider', real, 'real provider' if real else '!!! DEMO / FAKE OR UNKNOWN PROVIDER !!!'),
              row('evaluation_ready', health.get('evaluation_ready')),
              row('dataset_ready', health.get('dataset_ready'), 'source configured; not a network probe'
                  if health.get('dataset_ready') else 'DATASET_URL is not configured; use local file import'),
              row('database_ready', health.get('database_ready')),
              row('prompt_version', prompt_ok, prompt_detail)]
    for name, operation in [('active checklist', lambda: [active_check(client, health)]),
                            ('DEV coverage', lambda: coverage(client, health, expected_dev_count)),
                            ('interface', lambda: [interface_check(client)])]:
        try:
            checks.extend(operation())
        except (BatchError, httpx.HTTPError, KeyError, TypeError, ValueError):
            checks.append(row(name, False, 'API unavailable or invalid response; details omitted'))
    return checks


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--api-url', default='http://127.0.0.1:8000')
    parser.add_argument('--expected-dev-count', type=int, help='Require this many DEV conversations (optional)')
    parser.add_argument('--expected-prompt-version', help='Require this prompt version (optional)')
    args = parser.parse_args(argv)
    if args.expected_dev_count is not None and args.expected_dev_count <= 0:
        parser.error('expected-dev-count must be positive')
    if args.expected_prompt_version is not None and not args.expected_prompt_version.strip():
        parser.error('expected-prompt-version must be nonempty')
    try:
        with httpx.Client(base_url=args.api_url, timeout=30) as client:
            checks = check(client, expected_dev_count=args.expected_dev_count,
                           expected_prompt_version=args.expected_prompt_version)
    except (BatchError, httpx.HTTPError, ValueError, TypeError):
        checks = [row('API', False, 'unavailable or invalid response; details omitted')]
    for item in checks:
        print(f"{'OK' if item['ok'] else 'FAIL'} {item['name']}: {item['detail']}")
    passed = all(item['ok'] for item in checks)
    print('RESULT ' + ('OK' if passed else 'FAIL'))
    return 0 if passed else 1


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    raise SystemExit(main())
