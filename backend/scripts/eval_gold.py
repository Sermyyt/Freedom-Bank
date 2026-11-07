"""Compare saved original model answers with private, human-supplied gold labels.

Run from backend/: python scripts/eval_gold.py --gold ../data/gold/*.json
This command only reads the API. It never evaluates conversations or creates labels.
"""
from __future__ import annotations

import argparse
from collections import Counter
from decimal import Decimal
import json
import math
from pathlib import Path
import sys
from typing import Annotated, Any, Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictFloat, StrictInt, StrictStr, ValidationError, model_validator

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.scoring import difference, same_value
from scripts.run_batch import BatchError, request_data

ROOT = Path(__file__).resolve().parents[2]
Number = Annotated[StrictInt | StrictFloat, Field(allow_inf_nan=False)]


class GoldError(ValueError):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class GoldAnswer(_Model):
    status: Literal["answered", "not_applicable"]
    value: StrictBool | Number | None

    @model_validator(mode="after")
    def consistent_value(self):
        if (self.status == "not_applicable") != (self.value is None):
            raise ValueError("Answer status and value disagree")
        return self


class GoldCriterion(_Model):
    criterion_id: Annotated[StrictStr, Field(min_length=1)]
    answer: GoldAnswer


class Provenance(_Model):
    kind: Literal["human"]
    reviewer: Annotated[StrictStr, Field(pattern=r"\S")]


class GoldDocument(_Model):
    schema_version: Annotated[StrictInt, Field(ge=1, le=1)]
    provenance: Provenance
    cases: Annotated[list[Any], Field(min_length=1)]


class GoldCase(_Model):
    group_id: StrictStr
    conversation_id: StrictStr
    revision_id: StrictStr | None = None
    content_hash: Annotated[StrictStr, Field(pattern=r"^[0-9a-f]{64}$")] | None = None
    checklist_version_id: StrictStr
    criteria: Annotated[list[GoldCriterion], Field(min_length=1)]
    total: Annotated[Number, Field(ge=0, le=100)] | None = None

    @model_validator(mode="after")
    def identifiable(self):
        names = (self.group_id, self.conversation_id, self.checklist_version_id)
        if any(not value.strip() for value in names):
            raise ValueError("Identifiers required")
        if not self.revision_id and not self.content_hash:
            raise ValueError("Immutable revision guard required")
        if self.revision_id is not None and not self.revision_id.strip():
            raise ValueError("Revision identifier required")
        identifiers = [item.criterion_id for item in self.criteria]
        if len(identifiers) != len(set(identifiers)):
            raise ValueError("Duplicate criterion labels")
        return self


def _issue(source_index, case_index, code, criterion_id=None):
    return {"source_index": source_index, "case_index": case_index, "code": code,
            "criterion_id": criterion_id}


def _read_document(path):
    def reject_constant(_):
        raise ValueError("Non-finite JSON")
    payload = json.loads(path.read_text(encoding="utf-8-sig"), parse_constant=reject_constant)
    return GoldDocument.model_validate(payload)


def _load_cases(paths):
    cases, errors, received = [], [], 0
    for source_index, path in enumerate(paths):
        try:
            document = _read_document(Path(path))
        except (OSError, UnicodeError, ValueError):
            errors.append(_issue(source_index, None, "INVALID_GOLD_FILE"))
            continue
        received += len(document.cases)
        for case_index, raw in enumerate(document.cases):
            try:
                cases.append((source_index, case_index, GoldCase.model_validate(raw)))
            except ValidationError:
                errors.append(_issue(source_index, case_index, "INVALID_GOLD_CASE"))
    return cases, errors, received


def _case_identity(case):
    return case.group_id, case.conversation_id, case.checklist_version_id


def _unique_cases(cases, errors):
    counts = Counter(_case_identity(case) for _, _, case in cases)
    unique = []
    for source, index, case in cases:
        if counts[_case_identity(case)] > 1:
            errors.append(_issue(source, index, "DUPLICATE_GOLD_CASE"))
        else:
            unique.append((source, index, case))
    return unique


def _get(client, path, **params):
    try:
        data = request_data(client, "GET", path, params=params)
    except BatchError:
        raise GoldError("API_UNAVAILABLE") from None
    if not isinstance(data, dict):
        raise GoldError("INVALID_API_RESPONSE")
    return data


def _items(page):
    items = page.get("items")
    if not isinstance(items, list) or any(not isinstance(item, dict) for item in items):
        raise GoldError("INVALID_API_RESPONSE")
    return items


def _conversation(client, case):
    offset = 0
    while True:
        page = _get(client, "/api/conversations", group_id=case.group_id, q=case.conversation_id, limit=100, offset=offset)
        for item in _items(page):
            ref = item.get("ref", {})
            if ref.get("group_id") == case.group_id and ref.get("conversation_id") == case.conversation_id:
                return ref
        offset += 100
        if offset >= page.get("total", 0):
            raise GoldError("CONVERSATION_NOT_FOUND")


def _guard_revision(client, case, ref):
    if case.revision_id is not None and case.revision_id != ref["revision_id"]:
        raise GoldError("REVISION_MISMATCH")
    if case.content_hash is not None:
        revisions = _items(_get(client, f"/api/conversations/{ref['id']}/revisions", limit=1))
        current = next((item for item in revisions if item["ref"]["revision_id"] == ref["revision_id"]), None)
        if current is None or current.get("content_hash") != case.content_hash:
            raise GoldError("REVISION_MISMATCH")


def _latest_evaluation(client, case, ref, include_demo):
    filters = {"revision_id": ref["revision_id"], "limit": 1, "offset": 0}
    if not include_demo:
        filters["is_demo"] = False
    evaluations = _items(_get(client, "/api/evaluations", **filters))
    if not evaluations:
        raise GoldError("EVALUATION_NOT_FOUND")
    evaluation = _get(client, f"/api/evaluations/{evaluations[0]['id']}")
    if evaluation["conversation"]["revision_id"] != ref["revision_id"]:
        raise GoldError("REVISION_MISMATCH")
    if evaluation["checklist_version_id"] != case.checklist_version_id:
        raise GoldError("VERSION_MISMATCH")
    if evaluation["is_demo"] and not include_demo:
        raise GoldError("DEMO_EXCLUDED")
    return evaluation


def _answers_match(expected, actual):
    return expected.status == actual.status and same_value(expected.value, actual.value)


def _valid_answer(definition, answer):
    if answer.status == "not_applicable":
        return definition["na_allowed"]
    return any(same_value(answer.value, option["value"]) for option in definition["options"])


def _definitions(evaluation, case):
    definitions = {item["id"]: item for item in evaluation["checklist_snapshot"]["criteria"]}
    for label in case.criteria:
        if label.criterion_id not in definitions:
            raise GoldError("UNKNOWN_GOLD_CRITERION")
        if not _valid_answer(definitions[label.criterion_id], label.answer):
            raise GoldError("INVALID_GOLD_ANSWER")
    return definitions


def _model_answer(results, label, definition):
    if label.criterion_id not in results:
        raise GoldError("MISSING_MODEL_ANSWER")
    try:
        answer = GoldAnswer.model_validate(results[label.criterion_id]["answer"])
    except ValidationError:
        raise GoldError("INVALID_MODEL_ANSWER") from None
    if not _valid_answer(definition, answer):
        raise GoldError("INVALID_MODEL_ANSWER")
    return answer


def _flag_errors(expected, actual, definition):
    if definition["answer_type"] != "flag":
        return {"missed_violations": 0, "false_positive_violations": 0}
    return {"missed_violations": int(expected.value is True and actual.value is not True),
            "false_positive_violations": int(actual.value is True and expected.value is not True)}


def _na_errors(expected, actual):
    return {"false_positive_na": int(expected.status == "answered" and actual.status == "not_applicable"),
            "missed_na": int(expected.status == "not_applicable" and actual.status == "answered")}


def _criterion_metric(label, actual, definition):
    return {"criterion_id": label.criterion_id, "compared": 1, "correct": int(_answers_match(label.answer, actual)),
            **_flag_errors(label.answer, actual, definition), **_na_errors(label.answer, actual)}


def _total_result(case, original):
    if "total" not in case.model_fields_set:
        return {"kind": "omitted", "delta": None}
    if "total" not in original:
        return {"kind": "unavailable", "delta": None}
    actual = original["total"]
    if case.total is None:
        return {"kind": "both_null" if actual is None else "null_mismatch", "delta": None}
    if type(actual) not in (int, float) or not math.isfinite(actual):
        return {"kind": "unavailable", "delta": None}
    return {"kind": "numeric", "delta": difference(actual, case.total)}


def _compare_case(client, case, include_demo):
    ref = _conversation(client, case)
    _guard_revision(client, case, ref)
    evaluation = _latest_evaluation(client, case, ref, include_demo)
    definitions = _definitions(evaluation, case)
    original = evaluation["original"]
    results = {item["criterion_id"]: item for item in original["criteria"]}
    if len(results) != len(original["criteria"]):
        raise GoldError("INVALID_API_RESPONSE")
    metrics, errors = [], []
    for label in case.criteria:
        try:
            actual = _model_answer(results, label, definitions[label.criterion_id])
            metrics.append(_criterion_metric(label, actual, definitions[label.criterion_id]))
        except GoldError as exc:
            errors.append({"criterion_id": label.criterion_id, "code": exc.code})
    return {"evaluation_id": evaluation["id"], "revision_id": ref["revision_id"], "is_demo": evaluation["is_demo"],
            "available": len(definitions), "labeled": len(case.criteria), "metrics": metrics,
            "errors": errors, "total": _total_result(case, original)}


def _ratio(numerator, denominator):
    return numerator / denominator if denominator else None


def _aggregate_criteria(cases):
    counts = {}
    for case in cases:
        for item in case["metrics"]:
            current = counts.setdefault(item["criterion_id"], Counter())
            current.update({key: value for key, value in item.items() if key != "criterion_id"})
    return [{"criterion_id": identifier, **values, "accuracy": _ratio(values["correct"], values["compared"])}
            for identifier, values in sorted(counts.items())]


def _aggregate_totals(cases):
    totals = [case["total"] for case in cases]
    counts = Counter(item["kind"] for item in totals)
    differences = [Decimal(str(abs(item["delta"]))) for item in totals if item["kind"] == "numeric"]
    return {"total_labels": len(totals) - counts["omitted"], "total_compared": len(differences),
            "total_mae": float(sum(differences) / len(differences)) if differences else None,
            "total_null_matches": counts["both_null"], "total_null_mismatches": counts["null_mismatch"],
            "total_unavailable": counts["unavailable"]}


def _report(paths, cases, errors, received, include_demo):
    criteria = _aggregate_criteria(cases)
    compared = sum(item["compared"] for item in criteria)
    correct = sum(item["correct"] for item in criteria)
    labeled = sum(case["labeled"] for case in cases)
    available = sum(case["available"] for case in cases)
    count = sum(bool(case["metrics"]) for case in cases)
    return {"schema_version": 1, "snapshot": "original", "mode": "include_demo" if include_demo else "real_only",
            "includes_demo": any(case["is_demo"] for case in cases), "files_read": len(paths),
            "cases_received": received, "cases_compared": count, "cases_excluded": received - count,
            "criteria_labeled": labeled, "criteria_available": available, "criteria_compared": compared,
            "criteria_correct": correct, "criteria_excluded": labeled - compared,
            "accuracy": _ratio(correct, compared), "label_coverage": _ratio(labeled, available),
            "missed_violations": sum(item["missed_violations"] for item in criteria),
            "false_positive_violations": sum(item["false_positive_violations"] for item in criteria),
            "false_positive_na": sum(item["false_positive_na"] for item in criteria),
            "missed_na": sum(item["missed_na"] for item in criteria),
            **_aggregate_totals(cases), "criteria": criteria, "cases": cases, "errors": errors}


def evaluate_gold(client, paths, *, include_demo=False):
    loaded, errors, received = _load_cases(paths)
    cases = []
    for source, index, case in _unique_cases(loaded, errors):
        try:
            compared = _compare_case(client, case, include_demo)
            compared.update(source_index=source, case_index=index)
            cases.append(compared)
            errors.extend(_issue(source, index, item["code"], item["criterion_id"]) for item in compared["errors"])
        except GoldError as exc:
            errors.append(_issue(source, index, exc.code))
        except (KeyError, TypeError, ValueError):
            errors.append(_issue(source, index, "INVALID_API_RESPONSE"))
    if not paths:
        errors.append(_issue(None, None, "NO_GOLD_FILES"))
    return _report(paths, cases, errors, received, include_demo)


def _paths(patterns):
    result = set()
    for pattern in patterns:
        path = Path(pattern)
        if path.is_dir():
            result.update(path.glob("*.json"))
        elif any(character in path.name for character in "*?["):
            result.update(path.parent.glob(path.name))
        else:
            result.add(path)
    return sorted(result)


def _exit_code(report):
    if not report["cases_compared"]:
        return 2
    return 1 if report["errors"] else 0


def _protect_labels(output, paths):
    if output is not None and output.resolve() in {path.resolve() for path in paths}:
        raise GoldError("OUTPUT_IS_GOLD_FILE")


def main(argv=None, *, client_factory=httpx.Client):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gold", nargs="+", default=[str(ROOT / "data/gold/*.json")])
    parser.add_argument("--api-url", default="http://127.0.0.1:8000")
    parser.add_argument("--include-demo", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    try:
        paths = _paths(args.gold)
        _protect_labels(args.output, paths)
        with client_factory(base_url=args.api_url, timeout=60) as client:
            report = evaluate_gold(client, paths, include_demo=args.include_demo)
        text = json.dumps(report, ensure_ascii=False, allow_nan=False, indent=2)
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(text + "\n", encoding="utf-8")
        print(text)
        return _exit_code(report)
    except (OSError, ValueError, httpx.HTTPError):
        print("Gold evaluation failed. Check local files and API availability; source content omitted.", file=sys.stderr)
        return 2


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())
