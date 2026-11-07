"""Gold tooling tests use hypothetical labels for synthetic API responses only."""
from copy import deepcopy
import json

import httpx
import pytest

from scripts import eval_gold


def answer(value=True, status="answered"):
    return {"status": status, "value": value}


def definition(kind="binary", identifier="rule"):
    return {"id": identifier, "answer_type": kind, "na_allowed": True, "options": [
        {"value": False}, {"value": True}]}


def result(identifier="rule", value=True, status="answered"):
    return {"criterion_id": identifier, "answer": answer(value, status), "rationale": "PRIVATE_RATIONALE"}


@pytest.fixture
def gold(tmp_path):
    case = {"group_id": "SYNTHETIC", "conversation_id": "external", "revision_id": "revision-current",
            "checklist_version_id": "checklist-current", "criteria": [{"criterion_id": "rule", "answer": answer()}]}
    document = {"schema_version": 1, "provenance": {"kind": "human", "reviewer": "HYPOTHETICAL_REVIEWER"}, "cases": [case]}
    path = tmp_path / "labels.json"

    def write(value=None):
        path.write_text(json.dumps(document if value is None else value, ensure_ascii=False), encoding="utf-8")
        return path

    return document, case, write


@pytest.fixture
def api():
    state = {"requests": [], "evaluations": [{
        "id": "evaluation-latest", "conversation": {"revision_id": "revision-current"},
        "checklist_version_id": "checklist-current", "is_demo": False,
        "checklist_snapshot": {"criteria": [definition()]},
        "original": {"criteria": [result()], "total": 100},
        "final": {"criteria": [result(value=False)], "total": 0}}]}

    def handler(request):
        state["requests"].append(request)
        if request.url.path == "/api/conversations":
            data = {"items": [{"ref": {"id": "conversation-internal", "group_id": "SYNTHETIC",
                    "conversation_id": "external", "revision_id": "revision-current"}}], "total": 1}
        elif request.url.path == "/api/conversations/conversation-internal/revisions":
            data = {"items": [{"ref": {"revision_id": "revision-current"}, "content_hash": "a" * 64}], "total": 1}
        elif request.url.path == "/api/evaluations":
            items = state["evaluations"]
            if request.url.params.get("is_demo") == "false":
                items = [item for item in items if not item["is_demo"]]
            limit, offset = int(request.url.params.get("limit", 100)), int(request.url.params.get("offset", 0))
            if limit < 1 or offset < 0:
                return httpx.Response(422, json={"error": {"message": "Invalid synthetic pagination"}})
            data = {"items": items[offset:offset + limit], "total": len(items)}
        elif request.url.path.startswith("/api/evaluations/"):
            data = next(item for item in state["evaluations"] if item["id"] == request.url.path.rsplit("/", 1)[-1])
        else:
            return httpx.Response(404, json={"error": {"message": "Synthetic missing endpoint"}})
        return httpx.Response(200, json={"data": data})

    state["transport"] = httpx.MockTransport(handler)
    state["handler"] = handler
    return state


def compare(api, path, **kwargs):
    with httpx.Client(base_url="http://example.invalid", transport=api["transport"]) as client:
        return eval_gold.evaluate_gold(client, [path], **kwargs)


def test_original_snapshot_is_measured_and_report_contains_no_private_text(gold, api):
    report = compare(api, gold[2]())
    assert report["cases_compared"] == 1 and report["criteria_correct"] == 1
    assert report["accuracy"] == 1 and report["label_coverage"] == 1
    assert report["snapshot"] == "original"
    serialized = json.dumps(report)
    assert "PRIVATE_RATIONALE" not in serialized and "HYPOTHETICAL_REVIEWER" not in serialized


def test_latest_real_evaluation_is_selected_before_version_check(gold, api):
    old = deepcopy(api["evaluations"][0])
    old["id"] = "older-matching-version"
    api["evaluations"][0]["checklist_version_id"] = "newer-different-version"
    api["evaluations"].append(old)
    report = compare(api, gold[2]())
    assert report["cases_excluded"] == 1 and report["accuracy"] is None
    assert report["errors"][0]["code"] == "VERSION_MISMATCH"
    request = next(item for item in api["requests"] if item.url.path == "/api/evaluations")
    assert "checklist_version_id" not in request.url.params


@pytest.mark.parametrize("guard", [{"revision_id": "old-revision"}, {"content_hash": "b" * 64}])
def test_stale_revision_guards_exclude_cases(gold, api, guard):
    gold[1].pop("revision_id")
    gold[1].update(guard)
    report = compare(api, gold[2]())
    assert report["cases_excluded"] == 1 and report["criteria_compared"] == 0
    assert report["errors"][0]["code"] == "REVISION_MISMATCH"


def test_content_hash_guard_can_replace_revision_id(gold, api):
    gold[1].pop("revision_id")
    gold[1]["content_hash"] = "a" * 64
    assert compare(api, gold[2]())["criteria_correct"] == 1


def test_demo_requires_explicit_opt_in(gold, api):
    api["evaluations"][0]["is_demo"] = True
    assert compare(api, gold[2]())["cases_excluded"] == 1
    allowed = compare(api, gold[2](), include_demo=True)
    assert allowed["cases_compared"] == 1 and allowed["includes_demo"] is True


def test_partial_gold_exposes_coverage_and_does_not_invent_labels(gold, api):
    api["evaluations"][0]["checklist_snapshot"]["criteria"].append(definition(identifier="another-rule"))
    api["evaluations"][0]["original"]["criteria"].append(result(identifier="another-rule", value=False))
    report = compare(api, gold[2]())
    assert report["criteria_labeled"] == 1 and report["criteria_available"] == 2
    assert report["label_coverage"] == 0.5 and report["accuracy"] == 1


@pytest.mark.parametrize("bad_label", [
    {"criterion_id": "unknown", "answer": answer()},
    {"criterion_id": "rule", "answer": answer(1)},
    {"criterion_id": "rule", "answer": answer(True, "not_applicable")},
])
def test_invalid_gold_is_an_error_not_a_wrong_prediction(gold, api, bad_label):
    gold[1]["criteria"] = [bad_label]
    report = compare(api, gold[2]())
    assert report["accuracy"] is None and report["criteria_compared"] == 0
    assert report["cases_excluded"] == 1 and report["errors"]


def test_missing_or_invalid_model_answer_is_excluded_not_counted_wrong(gold, api):
    api["evaluations"][0]["original"]["criteria"] = []
    missing = compare(api, gold[2]())
    assert missing["criteria_compared"] == 0 and missing["criteria_excluded"] == 1
    api["evaluations"][0]["original"]["criteria"] = [result(value=None, status="invalid")]
    invalid = compare(api, gold[2]())
    assert invalid["criteria_compared"] == 0 and invalid["accuracy"] is None


def test_na_and_false_are_distinct_exact_answers(gold, api):
    gold[1]["criteria"][0]["answer"] = answer(None, "not_applicable")
    api["evaluations"][0]["original"]["criteria"] = [result(value=False)]
    report = compare(api, gold[2]())
    assert report["criteria_compared"] == 1 and report["criteria_correct"] == 0
    assert report["accuracy"] == 0


def test_flag_missed_and_false_positive_counts_are_generic(gold, api):
    gold[1]["criteria"] = [{"criterion_id": "custom-a", "answer": answer(True)},
                           {"criterion_id": "custom-b", "answer": answer(False)}]
    api["evaluations"][0]["checklist_snapshot"]["criteria"] = [definition("flag", "custom-a"), definition("flag", "custom-b")]
    api["evaluations"][0]["original"]["criteria"] = [result("custom-a", False), result("custom-b", True)]
    report = compare(api, gold[2]())
    assert report["missed_violations"] == 1 and report["false_positive_violations"] == 1
    assert {item["criterion_id"] for item in report["criteria"]} == {"custom-a", "custom-b"}


def test_duplicate_cases_exclude_both_conflicting_labels(gold, api):
    duplicate = deepcopy(gold[1])
    duplicate["criteria"][0]["answer"] = answer(False)
    gold[0]["cases"].append(duplicate)
    report = compare(api, gold[2]())
    assert report["cases_received"] == 2 and report["cases_excluded"] == 2
    assert report["criteria_compared"] == 0 and report["accuracy"] is None


def test_total_omission_null_and_numeric_comparison_are_different(gold, api):
    assert compare(api, gold[2]())["total_labels"] == 0
    gold[1]["total"] = None
    explicit_null = compare(api, gold[2]())
    assert explicit_null["total_labels"] == 1 and explicit_null["total_mae"] is None
    assert explicit_null["total_null_mismatches"] == 1
    gold[1]["total"] = 85.38
    numeric = compare(api, gold[2]())
    assert numeric["total_compared"] == 1 and numeric["total_mae"] == 14.62


def test_cli_writes_safe_report_and_returns_error_when_no_labels(tmp_path, gold, api, capsys):
    factory = lambda **kwargs: httpx.Client(transport=api["transport"], **kwargs)
    output = tmp_path / "report.json"
    status = eval_gold.main(["--gold", str(gold[2]()), "--output", str(output)], client_factory=factory)
    assert status == 0
    assert json.loads(output.read_text(encoding="utf-8"))["accuracy"] == 1
    assert "HYPOTHETICAL_REVIEWER" not in capsys.readouterr().out
    assert eval_gold.main(["--gold", str(tmp_path / "missing*.json")], client_factory=factory) == 2


def test_bad_json_and_missing_guard_are_reported_without_private_input(gold, api):
    path = gold[2]()
    path.write_text("not-json PRIVATE_RATIONALE", encoding="utf-8")
    report = compare(api, path)
    assert report["cases_compared"] == 0 and report["errors"]
    assert "PRIVATE_RATIONALE" not in json.dumps(report)
    gold[1].pop("revision_id")
    assert compare(api, gold[2]())["cases_excluded"] == 1


def test_cli_refuses_to_overwrite_the_human_gold_file(gold, api, capsys):
    path = gold[2]()
    untouched = path.read_bytes()
    factory = lambda **kwargs: httpx.Client(transport=api["transport"], **kwargs)
    assert eval_gold.main(["--gold", str(path), "--output", str(path)], client_factory=factory) == 2
    assert path.read_bytes() == untouched
    assert "HYPOTHETICAL_REVIEWER" not in capsys.readouterr().err


def test_numeric_total_mae_aggregates_multiple_conversations(gold, api):
    gold[1]["total"] = 85.38
    second_case = deepcopy(gold[1])
    second_case.update(conversation_id="external-second", revision_id="revision-second", total=40)
    gold[0]["cases"].append(second_case)
    second = deepcopy(api["evaluations"][0])
    second.update(id="evaluation-second", conversation={"revision_id": "revision-second"})
    second["original"]["total"] = 50

    def handler(request):
        if request.url.path == "/api/conversations" and request.url.params.get("q") == "external-second":
            data = {"items": [{"ref": {"id": "conversation-second", "group_id": "SYNTHETIC",
                    "conversation_id": "external-second", "revision_id": "revision-second"}}], "total": 1}
        elif request.url.path == "/api/evaluations" and request.url.params.get("revision_id") == "revision-second":
            data = {"items": [second], "total": 1}
        elif request.url.path == "/api/evaluations/evaluation-second":
            data = second
        else:
            return api["handler"](request)
        return httpx.Response(200, json={"data": data})

    api["transport"] = httpx.MockTransport(handler)
    report = compare(api, gold[2]())
    assert report["cases_compared"] == 2 and report["total_compared"] == 2
    assert report["total_mae"] == 12.31


def test_lookup_uses_exact_external_id_after_pagination(gold, api):
    def handler(request):
        if request.url.path == "/api/conversations" and request.url.params.get("offset") == "0":
            return httpx.Response(200, json={"data": {"items": [{"ref": {"group_id": "SYNTHETIC",
                "conversation_id": "external-suffix", "id": "wrong", "revision_id": "wrong"}}], "total": 101}})
        return api["handler"](request)

    api["transport"] = httpx.MockTransport(handler)
    assert compare(api, gold[2]())["criteria_correct"] == 1


def test_unavailable_api_does_not_expose_response_content(gold, api):
    api["transport"] = httpx.MockTransport(lambda request: httpx.Response(503, text="PRIVATE_RATIONALE"))
    report = compare(api, gold[2]())
    assert report["cases_excluded"] == 1 and report["accuracy"] is None
    assert report["errors"][0]["code"] == "API_UNAVAILABLE"
    assert "PRIVATE_RATIONALE" not in json.dumps(report)


@pytest.mark.parametrize("change", [lambda doc: doc.update(cases=[]),
                                    lambda doc: doc["provenance"].update(reviewer=" "),
                                    lambda doc: doc.update(schema_version=2)])
def test_invalid_document_never_produces_successful_quality_metric(gold, api, change):
    change(gold[0])
    report = compare(api, gold[2]())
    assert report["cases_compared"] == 0 and report["accuracy"] is None
    assert report["errors"][0]["code"] == "INVALID_GOLD_FILE"


def test_cli_directory_input_reports_partial_exclusions(gold, api, capsys):
    invalid = deepcopy(gold[1])
    invalid.pop("revision_id")
    gold[0]["cases"].append(invalid)
    path = gold[2]()
    factory = lambda **kwargs: httpx.Client(transport=api["transport"], **kwargs)
    status = eval_gold.main(["--gold", str(path.parent)], client_factory=factory)
    report = json.loads(capsys.readouterr().out)
    assert status == 1 and report["cases_compared"] == 1 and report["cases_excluded"] == 1


def test_unavailable_total_and_explicit_null_matches_are_separate(gold, api):
    api["evaluations"][0]["original"]["total"] = None
    gold[1]["total"] = 75
    numeric = compare(api, gold[2]())
    assert numeric["total_unavailable"] == 1 and numeric["total_compared"] == 0
    gold[1]["total"] = None
    empty = compare(api, gold[2]())
    assert empty["total_null_matches"] == 1 and empty["total_labels"] == 1


def test_model_boolean_number_mismatch_is_invalid_answer_not_false_match(gold, api):
    api["evaluations"][0]["original"]["criteria"] = [result(value=1)]
    report = compare(api, gold[2]())
    assert report["criteria_compared"] == 0 and report["criteria_excluded"] == 1


@pytest.mark.parametrize("expected, actual, false_positive_na, missed_na", [
    (answer(False), answer(None, "not_applicable"), 1, 0),
    (answer(None, "not_applicable"), answer(False), 0, 1),
    (answer(None, "not_applicable"), answer(None, "not_applicable"), 0, 0),
    (answer(True), answer(False), 0, 0),
])
def test_na_error_directions_have_separate_metrics(gold, api, expected, actual, false_positive_na, missed_na):
    gold[1]["criteria"][0]["answer"] = expected
    api["evaluations"][0]["original"]["criteria"][0]["answer"] = actual
    report = compare(api, gold[2]())
    for metrics in (report, report["criteria"][0], report["cases"][0]["metrics"][0]):
        assert metrics["false_positive_na"] == false_positive_na
        assert metrics["missed_na"] == missed_na


def test_missing_and_invalid_answers_do_not_count_as_na_errors(gold, api):
    gold[1]["criteria"][0]["answer"] = answer(None, "not_applicable")
    for results in ([], [result(value=None)]):
        api["evaluations"][0]["original"]["criteria"] = results
        report = compare(api, gold[2]())
        assert report["false_positive_na"] == 0
        assert report["missed_na"] == 0
        assert report["criteria_excluded"] == 1


def test_newest_demo_does_not_hide_the_latest_real_evaluation(gold, api):
    demo = deepcopy(api["evaluations"][0])
    demo.update(id="newer-demo", is_demo=True)
    api["evaluations"].insert(0, demo)
    report = compare(api, gold[2]())
    assert report["cases_compared"] == 1
    assert report["cases"][0]["evaluation_id"] == "evaluation-latest"
    assert report["includes_demo"] is False


@pytest.mark.parametrize("kind, expected, actual", [
    ("flag", answer(True), answer(True)),
    ("flag", answer(False), answer(False)),
    ("flag", answer(None, "not_applicable"), answer(None, "not_applicable")),
    ("binary", answer(True), answer(False)),
    ("binary", answer(False), answer(True)),
])
def test_matching_flags_and_binary_answers_do_not_invent_flag_violations(gold, api, kind, expected, actual):
    gold[1]["criteria"][0]["answer"] = expected
    api["evaluations"][0]["checklist_snapshot"]["criteria"][0]["answer_type"] = kind
    api["evaluations"][0]["original"]["criteria"][0]["answer"] = actual
    report = compare(api, gold[2]())
    assert report["criteria_compared"] == 1
    assert report["missed_violations"] == 0
    assert report["false_positive_violations"] == 0
