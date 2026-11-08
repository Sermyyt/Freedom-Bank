"""Export completed real evaluations in the organizer's production JSON format."""
from __future__ import annotations

import argparse
from decimal import Decimal
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import sys
from tempfile import NamedTemporaryFile

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.api_read import items
from scripts.preflight import current_evaluation
from scripts.run_batch import BatchError, request_data
from app.evaluation import PROMPT_VERSION
from app.storage import Store

ROOT = Path(__file__).resolve().parents[2]
# Appendix serialization vocabulary, not model/scoring rules.
CRITERIA = [('contact', 'contact'), ('needs', 'discovery'), ('identity', 'identification'),
            ('consultation', 'consultation'), ('empathy', 'empathy'), ('dialogue', 'dialogue'),
            ('closing', 'closure'), ('gross_violation', 'critical')]
NULLABLE = {'discovery', 'identification', 'consultation', 'closure'}
SCALES = {'consultation': {0, 5, 10, 15, 20}, 'dialogue': {0, 4, 7, 10}}
UNSAFE = re.compile(r'\b(?:https?|ftp|file)://|www\.|mailto:|[A-Za-z]:[\\/]|'
                    r'\\\\|/(?:Users|home|tmp|var)/|\bsig=|\bsk-[A-Za-z0-9_-]{12,}', re.I)


class ExportError(ValueError):
    def __init__(self, identifiers=()):
        super().__init__('No export: missing or invalid real evaluations.')
        self.identifiers = sorted(set(identifiers))


def safe_text(value):
    if not isinstance(value, str) or not value.strip() or UNSAFE.search(value):
        raise ExportError()
    value.encode('utf-8')
    return value


def criterion_result(source, target):
    answer = source['answer']
    value = answer['value']
    if answer['status'] == 'not_applicable':
        valid = value is None and target in NULLABLE
    elif answer['status'] == 'answered' and target in SCALES:
        valid = type(value) in (int, float) and value in SCALES[target]
    else:
        valid = answer['status'] == 'answered' and type(value) is bool and target not in SCALES
    evidence = source['evidence_message_ids']
    if not valid or not isinstance(evidence, list) or any(type(x) is not int or x < 1 for x in evidence):
        raise ExportError()
    return {'criterion_id': target, 'value': value, 'rationale': safe_text(source['rationale']),
            'evidence_turns': evidence}


def result_record(evaluation, external_id):
    final = evaluation['original']
    if final['status'] not in {'completed', 'manual_review'}:
        raise ExportError()
    source = {item['criterion_id']: item for item in final['criteria']}
    if len(final['criteria']) != len(CRITERIA) or set(source) != {x for x, _ in CRITERIA}:
        raise ExportError()
    criteria = [criterion_result(source[internal], external) for internal, external in CRITERIA]
    total, critical = final['total'], final['gross_error']
    if (type(total) not in (int, float) or not math.isfinite(total) or not 0 <= total <= 100
            or Decimal(str(total)).as_tuple().exponent < -2 or type(critical) is not bool
            or critical is not criteria[-1]['value']):
        raise ExportError()
    return {'conversation_id': safe_text(external_id), 'status': 'ok', 'criteria': criteria,
            'score': {'final_score': total, 'critical_flag': critical}}


def revision_map(client, group):
    conversations = list(items(client, '/api/conversations', group_id=group))
    refs = [entry['ref'] for entry in conversations]
    if not refs or any(ref['group_id'] != group for ref in refs):
        raise ExportError()
    result = {ref['revision_id']: ref['conversation_id'] for ref in refs}
    if len(result) != len(refs) or len(set(result.values())) != len(refs):
        raise ExportError()
    return result


def collect_results(client, group, team_name):
    team_name = safe_text(team_name)
    health = request_data(client, 'GET', '/api/health')
    if (health.get('provider') not in {'openai', 'anthropic'} or health.get('is_demo') is not False
            or not health.get('active_checklist_version_id') or not health.get('prompt_version')):
        raise ExportError()
    version = request_data(client, 'GET', f"/api/checklist-versions/{health['active_checklist_version_id']}")
    active_ids = [criterion['id'] for criterion in version['definition']['criteria']]
    if len(active_ids) != len(CRITERIA) or set(active_ids) != {internal for internal, _ in CRITERIA}:
        raise ExportError()
    revisions = revision_map(client, group)
    candidates = {}
    summaries = items(client, '/api/evaluations', checklist_version_id=health['active_checklist_version_id'], is_demo=False)
    for summary in summaries:
        revision = summary['conversation']['revision_id']
        if revision not in revisions:
            continue
        evaluation = request_data(client, 'GET', f"/api/evaluations/{summary['id']}")
        if (evaluation['conversation']['revision_id'] != revision or
                evaluation['conversation']['conversation_id'] != revisions[revision] or
                evaluation['conversation']['group_id'] != group or evaluation.get('is_demo') is not False
                or not current_evaluation(evaluation, health)):
            continue
        previous = candidates.get(revision)
        if previous is None or (evaluation['created_at'], evaluation['id']) > (previous['created_at'], previous['id']):
            candidates[revision] = evaluation
    results = []
    for revision, external_id in revisions.items():
        try:
            results.append(result_record(candidates[revision], external_id))
        except (KeyError, TypeError, ValueError, UnicodeError):
            results.append({'conversation_id': safe_text(external_id), 'status': 'error', 'criteria': [],
                            'score': None, 'error': 'missing_completed_real_evaluation' if revision not in candidates
                            else 'invalid_original_evaluation'})
    after = request_data(client, 'GET', '/api/health')
    if any(after.get(key) != health.get(key) for key in ('active_checklist_version_id', 'provider', 'model', 'prompt_version', 'is_demo')):
        raise ExportError(revisions.values())
    if revision_map(client, group) != revisions:
        raise ExportError(revisions.values())
    return {'schema_version': '1.0', 'team_name': team_name,
            'model': {'mode': 'external_api', 'name': safe_text(health['model'])},
            'results': sorted(results, key=lambda entry: entry['conversation_id'])}


def write_results(document, output):
    serialized = json.dumps(document, ensure_ascii=False, indent=2, allow_nan=False) + '\n'
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with NamedTemporaryFile(mode='w', encoding='utf-8', newline='\n', dir=output.parent,
                                prefix='.results-', suffix='.tmp', delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(serialized)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(output)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def collect_database(database, group, team_name):
    """Read one consistent SQLite snapshot without startup, migrations or writes."""
    team_name = safe_text(team_name)
    with Store(database).transaction(readonly=True) as tx:
        active = (tx.get('settings', 'main') or {}).get('active_version_id')
        version = tx.get('versions', active) if active else None
        if version is None:
            raise ExportError()
        active_ids = [criterion['id'] for criterion in version['definition']['criteria']]
        if len(active_ids) != len(CRITERIA) or set(active_ids) != {internal for internal, _ in CRITERIA}:
            raise ExportError()
        conversations = [entry for entry in tx.all('conversations') if entry['group_id'] == group]
        revisions = {entry['revision_id']: entry['conversation_id'] for entry in conversations}
        if not revisions or len(revisions) != len(conversations) or len(set(revisions.values())) != len(revisions):
            raise ExportError()
        candidates = {}
        for evaluation in tx.all('evaluations'):
            ref, usage = evaluation['conversation'], evaluation.get('usage', {})
            revision = ref['revision_id']
            if (revision not in revisions or ref['group_id'] != group or ref['conversation_id'] != revisions[revision]
                    or evaluation.get('is_demo') is not False or evaluation['checklist_version_id'] != active
                    or evaluation.get('original', {}).get('status') not in {'completed', 'manual_review'}
                    or usage.get('provider') not in {'openai', 'anthropic'} or not usage.get('model')
                    or usage.get('prompt_version') != PROMPT_VERSION):
                continue
            previous = candidates.get(revision)
            if previous is None or (evaluation['created_at'], evaluation['id']) > (previous['created_at'], previous['id']):
                candidates[revision] = evaluation
        models = {(entry['usage']['provider'], entry['usage']['model']) for entry in candidates.values()}
        if len(models) != 1:
            raise ExportError(revisions.values())
        results = []
        for revision, external_id in revisions.items():
            try:
                results.append(result_record(candidates[revision], external_id))
            except (KeyError, TypeError, ValueError, UnicodeError):
                results.append({'conversation_id': safe_text(external_id), 'status': 'error', 'criteria': [],
                                'score': None, 'error': 'missing_completed_real_evaluation' if revision not in candidates
                                else 'invalid_original_evaluation'})
        return {'schema_version': '1.0', 'team_name': team_name,
                'model': {'mode': 'external_api', 'name': safe_text(next(iter(models))[1])},
                'results': sorted(results, key=lambda entry: entry['conversation_id'])}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group()
    source.add_argument('--api-url', help='API URL (default: http://127.0.0.1:8000)')
    source.add_argument('--database', type=Path, help='Read an existing SQLite database without starting the API')
    parser.add_argument('--group', required=True)
    parser.add_argument('--team-name', required=True)
    parser.add_argument('--expected-count', type=int)
    parser.add_argument('--output', type=Path, default=ROOT / 'results/prod/results.json')
    args = parser.parse_args(argv)
    if args.expected_count is not None and args.expected_count <= 0:
        parser.error('expected-count must be positive')
    try:
        if not args.group.strip():
            raise ExportError()
        if args.database is not None:
            document = collect_database(args.database, args.group, args.team_name)
        else:
            with httpx.Client(base_url=args.api_url or 'http://127.0.0.1:8000', timeout=60) as client:
                document = collect_results(client, args.group, args.team_name)
        if args.expected_count is not None and len(document['results']) != args.expected_count:
            raise ExportError()
        write_results(document, args.output)
        errors = [item['conversation_id'] for item in document['results'] if item['status'] == 'error']
        print(f"Export written: {len(document['results'])} records; errors: {len(errors)}.")
        for identifier in errors:
            print(json.dumps(identifier, ensure_ascii=True), file=sys.stderr)
        return 1 if errors else 0
    except ExportError as error:
        print(str(error), file=sys.stderr)
        for identifier in error.identifiers:
            # JSON escaping prevents control characters from changing terminal output.
            print(json.dumps(identifier, ensure_ascii=True), file=sys.stderr)
    except (BatchError, httpx.HTTPError, OSError, sqlite3.Error, ValueError, KeyError, TypeError):
        print('Export failed; API, format or output validation failed. Details omitted.', file=sys.stderr)
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
