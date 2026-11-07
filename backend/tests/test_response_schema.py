"""Exercise the provider schema offline using only its supported JSON keywords."""
from copy import deepcopy

import pytest

from app.evaluation import response_schema


def _same_enum(left, right):
    if isinstance(left, bool) or isinstance(right, bool):
        return type(left) is type(right) and left == right
    return left == right


def _has_type(value, kind):
    kinds = {"null": (type(None),), "boolean": (bool,), "number": (int, float),
             "integer": (int,), "object": (dict,), "array": (list,), "string": (str,)}
    return type(value) in kinds[kind]


def _matches(schema, value):
    """Small test oracle for these keywords, not a general JSON Schema validator."""
    assert not set(schema) - {"anyOf", "type", "enum", "properties", "required", "additionalProperties", "items", "minItems"}
    if "anyOf" in schema and not any(_matches(branch, value) for branch in schema["anyOf"]):
        return False
    if "type" in schema:
        kinds = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
        if not any(_has_type(value, kind) for kind in kinds):
            return False
    if "enum" in schema and not any(_same_enum(value, item) for item in schema["enum"]):
        return False
    if "properties" in schema:
        properties = schema["properties"]
        if not set(schema["required"]) <= set(value):
            return False
        if schema["additionalProperties"] is False and set(value) - set(properties):
            return False
        return all(_matches(properties[key], item) for key, item in value.items() if key in properties)
    if "items" in schema:
        if len(value) < schema.get("minItems", 0):
            return False
        return all(_matches(schema["items"], item) for item in value)
    return True


def _criterion(identifier="custom-binary", kind="binary", na_allowed=True):
    values = [False, True] if kind != "scale" else [0, 2, 5]
    return {"id": identifier, "answer_type": kind, "na_allowed": na_allowed,
            "options": [{"value": value} for value in values]}


def _answer(identifier="custom-binary", value=True):
    return {"criterion_id": identifier, "answer": {"status": "answered", "value": value},
            "rationale": "Synthetic support #1", "evidence_message_ids": [1], "checked_range": None,
            "expected_action": None, "na_reason": None, "manual_review": False, "manual_review_reasons": []}


def _accepts(result, criteria=None):
    return _matches(response_schema(criteria or [_criterion()]), {"criteria": [result]})


@pytest.mark.parametrize("checked, expected", [
    (None, None), ({"start_id": 1, "end_id": 3}, "Synthetic expected action"),
])
def test_schema_accepts_only_complete_support_pairs(checked, expected):
    result = _answer()
    result.update(checked_range=checked, expected_action=expected)
    assert _accepts(result)


@pytest.mark.parametrize("checked, expected", [
    ({"start_id": 1, "end_id": 3}, None), (None, "Synthetic expected action"),
])
def test_schema_rejects_half_populated_pair_even_with_valid_evidence(checked, expected):
    result = _answer()
    result.update(checked_range=checked, expected_action=expected)
    assert not _accepts(result)


@pytest.mark.parametrize("field", ["checked_range", "expected_action", "rationale", "na_reason", "manual_review"])
def test_schema_keeps_all_fields_required(field):
    result = _answer()
    result.pop(field)
    assert not _accepts(result)


@pytest.mark.parametrize("bounds", [
    {"start_id": 1}, {"start_id": True, "end_id": 3}, {"start_id": 1, "end_id": "3"},
    {"start_id": 1, "end_id": 3, "extra": True},
])
def test_nonnull_pair_retains_strict_range_shape(bounds):
    result = _answer()
    result.update(checked_range=bounds, expected_action="Synthetic expected action")
    assert not _accepts(result)


def test_dynamic_criterion_types_options_and_na_are_preserved_in_both_pair_variants():
    criteria = [_criterion(), _criterion("custom-scale", "scale"), _criterion("custom-flag", "flag", False)]
    for checked, expected in ((None, None), ({"start_id": 1, "end_id": 1}, "Synthetic action")):
        scale = _answer("custom-scale", 2)
        scale.update(checked_range=checked, expected_action=expected)
        assert _accepts(scale, criteria)
        scale["answer"]["value"] = 3
        assert not _accepts(scale, criteria)
        scale["answer"] = {"status": "not_applicable", "value": None}
        scale["na_reason"] = "Synthetic condition"
        assert _accepts(scale, criteria)
        scale["criterion_id"] = "custom-flag"
        assert not _accepts(scale, criteria)
        scale["answer"] = {"status": "answered", "value": True}
        assert _accepts(scale, criteria)
        scale["answer"]["value"] = 1
        assert not _accepts(scale, criteria)


def test_dynamic_ids_and_closed_objects_are_preserved():
    result = _answer()
    original = deepcopy(result)
    result["criterion_id"] = "unknown-rule"
    assert not _accepts(result)
    original["extra"] = "Synthetic unsupported field"
    assert not _accepts(original)


@pytest.mark.parametrize("status,value", [("answered", True), ("not_applicable", None)])
def test_nested_answers_remain_closed_objects(status, value):
    result = _answer()
    result["answer"] = {"status": status, "value": value, "extra": "Synthetic unsupported field"}
    assert not _accepts(result)


def test_root_response_remains_closed_object():
    payload = {"criteria": [_answer()], "extra": "Synthetic unsupported field"}
    assert not _matches(response_schema([_criterion()]), payload)


def test_answered_without_checked_range_requires_at_least_one_evidence_id():
    result = _answer()
    result["evidence_message_ids"] = []
    assert not _accepts(result)
    result["evidence_message_ids"] = [1]
    assert _accepts(result)


@pytest.mark.parametrize("status,value", [("answered", False), ("not_applicable", None)])
def test_checked_pair_can_support_answer_without_message_evidence(status, value):
    result = _answer(value=value)
    result.update(answer={"status": status, "value": value}, evidence_message_ids=[],
                  checked_range={"start_id": 1, "end_id": 3}, expected_action="Synthetic expected action")
    assert _accepts(result)


def test_na_with_null_pair_does_not_require_message_evidence():
    result = _answer()
    result.update(answer={"status": "not_applicable", "value": None}, evidence_message_ids=[],
                  na_reason="Synthetic inapplicability condition")
    assert _accepts(result)


def test_dynamic_schema_limits_variants_to_three_per_criterion():
    schema = response_schema([_criterion(), _criterion("custom-flag", "flag", False)])
    variants = schema["properties"]["criteria"]["items"]["anyOf"]
    identifiers = [variant["properties"]["criterion_id"]["enum"][0] for variant in variants]
    assert set(identifiers) == {"custom-binary", "custom-flag"}
    assert all(identifiers.count(identifier) <= 3 for identifier in set(identifiers))
