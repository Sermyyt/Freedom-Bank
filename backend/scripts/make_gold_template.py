"""Create blank private human-label templates from the active checklist and current revisions."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.api_read import items
from scripts.run_batch import BatchError, request_data

ROOT = Path(__file__).resolve().parents[2]
DEVICES = {'CON', 'PRN', 'AUX', 'NUL', *(f'COM{i}' for i in range(1, 10)), *(f'LPT{i}' for i in range(1, 10))}


def safe_path(folder, identifier):
    if not re.fullmatch(r'[A-Za-z0-9_-][A-Za-z0-9_.-]{0,119}', identifier):
        raise ValueError('Unsafe conversation filename.')
    if identifier.endswith('.') or identifier.split('.')[0].upper() in DEVICES:
        raise ValueError('Unsafe Windows filename.')
    return Path(folder) / f'{identifier}.json'


def blank_criterion(criterion):
    allowed = [{'answer': {'status': 'answered', 'value': option['value']},
                'hint': option['description'], 'label': option['label']} for option in criterion['options']]
    if criterion['na_allowed']:
        allowed.append({'answer': {'status': 'not_applicable', 'value': None},
                        'hint': criterion['na_condition'], 'label': 'N/A'})
    return {'criterion_id': criterion['id'], 'answer': {'status': None, 'value': None},
            'guidance': {'name': criterion['name'], 'description': criterion['description'],
                         'allowed_answers': allowed}}


def make_templates(client, identifiers, group, folder, reviewer):
    paths = {identifier: safe_path(folder, identifier) for identifier in identifiers}
    if len({name.casefold() for name in paths}) != len(paths):
        raise ValueError('Filenames collide on Windows.')
    if not paths or not group.strip() or not reviewer.strip():
        raise ValueError('Identifiers, group and human reviewer are required.')
    health = request_data(client, 'GET', '/api/health')
    active = health.get('active_checklist_version_id')
    if not active:
        raise BatchError('No active checklist.')
    version = request_data(client, 'GET', f'/api/checklist-versions/{active}')
    refs = {row['ref']['conversation_id']: row['ref']
            for row in items(client, '/api/conversations', group_id=group)}
    if any(identifier not in refs for identifier in paths):
        raise BatchError('Some conversations were not found in the selected group.')
    return write_templates(paths, refs, version, group, reviewer)


def write_templates(paths, refs, version, group, reviewer):
    result = {'created': [], 'skipped': []}
    for identifier, path in paths.items():
        case = {'group_id': group, 'conversation_id': identifier, 'revision_id': refs[identifier]['revision_id'],
                'checklist_version_id': version['id'],
                'criteria': [blank_criterion(c) for c in version['definition']['criteria']]}
        document = {'schema_version': 1, 'provenance': {'kind': 'human', 'reviewer': reviewer}, 'cases': [case]}
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            with path.open('x', encoding='utf-8') as stream:
                stream.write(json.dumps(document, ensure_ascii=False, indent=2) + '\n')
            result['created'].append(identifier)
        except FileExistsError:
            result['skipped'].append(identifier)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('conversation_ids', nargs='+')
    parser.add_argument('--group', default='DEV')
    parser.add_argument('--reviewer', required=True, help='Name of the human who will fill the answers')
    parser.add_argument('--output', type=Path, default=ROOT/'data/gold')
    parser.add_argument('--api-url', default='http://127.0.0.1:8000')
    args = parser.parse_args(argv)
    try:
        with httpx.Client(base_url=args.api_url, timeout=60) as client:
            result = make_templates(client, args.conversation_ids, args.group, args.output, args.reviewer)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (BatchError, OSError, ValueError, KeyError, TypeError, httpx.InvalidURL):
        print('Template creation failed: check API, IDs, reviewer and output directory. Private content omitted.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    raise SystemExit(main())
