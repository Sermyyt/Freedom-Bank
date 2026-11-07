from copy import deepcopy

import pytest

from app.checklist_validation import normalize_definition
from app.scoring import difference, score

POLICY = {"rounding": "half_up", "decimals": 2, "gross_error_zeroes_total": False}


def definition():
    kinds = ["binary", "binary", "binary", "scale", "binary", "scale", "binary", "flag"]
    weights = [10, 15, 20, 20, 15, 15, 5, None]
    criteria = []
    for index, (kind, weight) in enumerate(zip(kinds, weights)):
        values = [0, 5, 10, 15, 20] if index == 3 else [0, 4, 7, 10] if index == 5 else [False, True]
        criteria.append({"id": f"test-{index}", "name": "Синтетическое правило", "description": "Описание",
                         "section": "Общая", "answer_type": kind, "weight": weight,
                         "na_allowed": index in (1, 2, 3, 6), "na_condition": "Не применимо" if index in (1, 2, 3, 6) else None,
                         "options": [{"value": value, "label": str(value), "description": "Ответ",
                                      "normalized": None if kind in ("flag", "scale") else int(value)} for value in values]})
    normalized, errors, _ = normalize_definition({"name": "Тест", "description": "Синтетика", "criteria": criteria})
    assert errors == []
    return normalized


def results(values):
    return [{"criterion_id": f"test-{index}",
             "answer": {"status": "not_applicable" if value is None else "answered", "value": value},
             "manual_review": False, "manual_review_reasons": []} for index, value in enumerate(values)]


@pytest.mark.parametrize(("values", "expected"), [
    ([True, True, True, 20, True, 10, True, False], 100),
    ([True, None, None, 15, True, 7, False, False], 77.69),
    ([True, None, None, 15, True, 7, True, False], 85.38),
    ([True, True, None, 15, False, 7, False, False], 63.13),
])
def test_required_arithmetic(values, expected):
    snapshot = score(definition(), results(values), POLICY)
    assert snapshot["total"] == expected
    assert snapshot["status"] == "completed"


def test_scale_points_na_weights_and_inputs_are_preserved():
    rules, answers = definition(), results([True, None, None, 15, True, 7, False, False])
    original_rules, original_answers = deepcopy(rules), deepcopy(answers)
    snapshot = score(rules, answers, POLICY)
    assert snapshot["criteria"][5]["weighted_points"] == 10.5
    assert snapshot["criteria"][1]["original_weight"] == 15
    assert snapshot["criteria"][1]["effective_weight"] is None
    assert snapshot["applicable_weight"] == 65
    assert rules == original_rules and answers == original_answers


def test_rounding_and_zero_override_are_policy_not_constants():
    answers = results([True, True, None, 15, False, 7, False, True])
    assert score(definition(), answers, POLICY)["total"] == 63.13
    even = score(definition(), answers, {**POLICY, "rounding": "half_even"})
    assert even["total"] == 63.12
    zeroed = score(definition(), answers, {**POLICY, "gross_error_zeroes_total": True})
    assert zeroed["gross_error"] is True
    assert zeroed["total"] == 0
    assert zeroed["total_before_override"] == 63.13


def test_flags_only_has_no_total():
    rules = definition()
    rules["criteria"] = rules["criteria"][-1:]
    snapshot = score(rules, results([True] * 8)[-1:], POLICY)
    assert snapshot["total"] is None
    assert snapshot["applicable_weight"] == 0
    assert snapshot["gross_error"] is True
    assert snapshot["criteria"][0]["original_weight"] is None


def test_incomplete_weighted_answer_does_not_produce_partial_total():
    answers = results([True, True, True, 20, True, 10, True, False])
    answers[2]["answer"] = {"status": "invalid", "value": None}
    snapshot = score(definition(), answers, POLICY)
    assert snapshot["total"] is None
    assert snapshot["status"] == "manual_review"
    assert all(item["contribution"] is None for item in snapshot["criteria"])
    assert snapshot["criteria"][0]["weighted_points"] == 10
    assert snapshot["sections"][0]["weighted_points"] is None


def test_sections_distinguish_completion_and_contribution():
    rules = definition()
    rules["criteria"][0]["section"] = "Начало"
    snapshot = score(rules, results([True, True, True, 20, True, 10, True, False]), POLICY)
    first = snapshot["sections"][0]
    assert first["completion_percent"] == 100
    assert first["contribution"] == 10


def test_zero_weight_section_after_na_has_zero_contribution():
    rules = definition()
    rules["criteria"][1]["section"] = "N/A"
    snapshot = score(rules, results([True, None, True, 20, True, 10, True, False]), POLICY)
    section = next(item for item in snapshot["sections"] if item["section"] == "N/A")
    assert section["completion_percent"] is None
    assert section["contribution"] == 0


def test_renormalized_weights_and_contributions_are_server_values():
    snapshot = score(definition(), results([True, None, None, 15, True, 7, False, False]), POLICY)
    criterion = snapshot["criteria"][5]
    assert criterion["effective_weight"] == pytest.approx(23.076923076923077)
    assert criterion["contribution"] == pytest.approx(16.153846153846153)
    assert snapshot["sections"][0]["contribution"] == pytest.approx(77.6923076923077)
    assert snapshot["gross_error"] is False


@pytest.mark.parametrize(("decimals", "expected"), [(0, 63), (1, 63.1), (3, 63.125)])
def test_configured_decimal_count_is_applied_only_to_total(decimals, expected):
    snapshot = score(definition(), results([True, True, None, 15, False, 7, False, False]),
                     {**POLICY, "decimals": decimals})
    assert snapshot["total"] == expected
    assert snapshot["criteria"][5]["weighted_points"] == 10.5


def test_unknown_flag_preserves_weighted_total_but_requires_review():
    answers = results([True, True, True, 20, True, 10, True, False])
    answers[-1]["answer"] = {"status": "invalid", "value": None}
    snapshot = score(definition(), answers, POLICY)
    assert snapshot["total"] == 100
    assert snapshot["gross_error"] is None
    assert snapshot["status"] == "manual_review"
    assert snapshot["manual_review_reasons"]


def test_no_flags_means_no_gross_error():
    rules = definition()
    rules["criteria"] = rules["criteria"][:-1]
    snapshot = score(rules, results([True, True, True, 20, True, 10, True, False])[:-1], POLICY)
    assert snapshot["gross_error"] is False and snapshot["flags"] == []


@pytest.mark.parametrize("source", ["conversation", "criterion"])
def test_review_reasons_do_not_discard_valid_score(source):
    answers = results([True, True, True, 20, True, 10, True, False])
    reasons = ["Удержание без завершения"] if source == "conversation" else []
    if source == "criterion":
        answers[0]["manual_review"] = True
    snapshot = score(definition(), answers, POLICY, reasons)
    assert snapshot["status"] == "manual_review" and snapshot["total"] == 100


def test_all_weighted_answers_na_have_no_section_contribution():
    snapshot = score(definition(), results([None, None, None, None, None, None, None, False]), POLICY)
    assert snapshot["total"] is None and snapshot["applicable_weight"] == 0
    assert all(section["completion_percent"] is None and section["contribution"] is None
               for section in snapshot["sections"])


@pytest.mark.parametrize(("right", "left", "expected"), [(0.3, 0.1, 0.2), (12, 20, -8),
                                                           (None, 10, None), (10, None, None)])
def test_comparison_delta_preserves_direction_and_missing_values(right, left, expected):
    assert difference(right, left) == expected
