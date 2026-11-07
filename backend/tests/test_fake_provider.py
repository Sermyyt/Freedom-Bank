"""The demo provider must exercise the UI without pretending to assess quality."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy

import pytest

from app.evaluation import cache_key, validate_results
from app.providers import FakeLLM


def criterion(identifier, kind="binary", na_allowed=False):
    values = [False, True] if kind != "scale" else [0, 4, 9]
    normalized = [None, None] if kind == "flag" else ([0, 0.4, 1] if kind == "scale" else [0, 1])
    return {"id": identifier, "name": "Synthetic", "description": "Synthetic rule", "answer_type": kind,
            "na_allowed": na_allowed, "options": [{"value": value, "normalized": score} for value, score in zip(values, normalized)]}


@pytest.fixture
def transcript():
    return [{"id": 1, "timestamp": "00:00", "speaker": "client", "text": "Synthetic request",
             "phase": "client", "client_facing": True},
            {"id": 2, "timestamp": "00:01", "speaker": "operator", "text": "Synthetic response",
             "phase": "client", "client_facing": True}]


def generate(provider, rules, transcript):
    return provider.generate(rules, transcript, {}, {}, errors=[{"code": "SYNTHETIC_RETRY"}])["criteria"]


@pytest.mark.parametrize("kind", ["binary", "scale", "flag"])
def test_demo_answers_cover_valid_options_including_failures(kind, transcript):
    rules = [criterion(f"arbitrary-{index}", kind) for index in range(80)]
    provider = FakeLLM()
    results = generate(provider, rules, transcript)
    assert {item["answer"]["value"] for item in results} == {option["value"] for option in rules[0]["options"]}
    assert all(item["answer"]["status"] == "answered" for item in results)
    assert all(item["evidence_message_ids"] == [2] for item in results)
    assert len(validate_results(rules, results, transcript)) == len(rules)
    assert provider.is_demo is True and provider.model is None


def test_demo_can_show_na_and_manual_review_with_explicit_reasons(transcript):
    rules = [criterion(f"optional-{index}", na_allowed=True) for index in range(80)]
    results = generate(FakeLLM(), rules, transcript)
    na = [item for item in results if item["answer"]["status"] == "not_applicable"]
    manual = [item for item in results if item["manual_review"]]
    assert na and manual
    assert len(na) < len(results) and len(manual) < len(results)
    assert all(item["answer"]["value"] is None and item["na_reason"].strip() for item in na)
    assert all(item["manual_review_reasons"] for item in manual)
    assert len(validate_results(rules, results, transcript)) == len(rules)


def test_choice_survives_batching_retries_reordering_and_weight_edits(transcript):
    rules = [criterion(f"stable-{index}", "scale", True) for index in range(16)]
    original = deepcopy((rules, transcript))
    provider = FakeLLM()
    baseline = {item["criterion_id"]: item for item in generate(provider, rules, transcript)}
    assert {item["criterion_id"]: item for item in generate(provider, list(reversed(rules)), transcript)} == baseline
    for rule in rules:
        changed = {**rule, "weight": 57}
        changed["options"] = list(reversed(rule["options"]))
        assert generate(FakeLLM(), [changed], transcript)[0] == baseline[rule["id"]]
    reordered_transcript = [{key: message[key] for key in reversed(message)} for message in transcript]
    assert generate(FakeLLM(), rules, reordered_transcript) == list(baseline.values())
    assert (rules, transcript) == original


def test_changed_transcript_changes_the_demo_but_not_call_history(transcript):
    rules = [criterion(f"content-{index}", na_allowed=True) for index in range(32)]
    provider = FakeLLM()
    first = generate(provider, rules, transcript)
    changed = deepcopy(transcript)
    changed[0]["text"] = "A different synthetic revision"
    assert generate(provider, rules, changed) != first
    assert generate(provider, rules, transcript) == first
    assert provider.calls == 3 and provider.requested_criteria == [[rule["id"] for rule in rules]] * 3


@pytest.mark.parametrize("phase", ["hold", "internal_consult"])
def test_hold_evidence_triggers_domain_nonclient_warning(transcript, phase):
    transcript.append({"id": 3, "timestamp": "00:02", "speaker": "operator", "text": "Synthetic hold note",
                       "phase": phase, "client_facing": False})
    rules = [criterion("arbitrary-hold-rule")]
    raw = generate(FakeLLM(), rules, transcript)
    result = validate_results(rules, raw, transcript)[0]
    assert result["evidence_message_ids"] == [3]
    assert result["manual_review"] is True
    assert result["warnings"] and result["manual_review_reasons"]


def test_no_operator_falls_back_to_real_message_id(transcript):
    rules = [criterion("arbitrary-no-operator")]
    result = generate(FakeLLM(), rules, transcript[:1])
    assert result[0]["evidence_message_ids"] == [1]
    assert validate_results(rules, result, transcript[:1])


def test_concurrent_calls_remain_deterministic_and_counted(transcript):
    provider = FakeLLM()
    rules = [criterion("parallel-demo", na_allowed=True)]
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: generate(provider, rules, transcript), range(20)))
    assert all(result == results[0] for result in results)
    assert provider.calls == 20 and len(provider.requested_criteria) == 20


def test_demo_behavior_version_invalidates_old_perfect_answer_cache(transcript):
    provider = FakeLLM()
    rule = criterion("cache-demo")
    conversation = {"ref": {"revision_id": "synthetic-revision"}, "transcript": transcript}
    previous = FakeLLM()
    previous.cache_settings = {}
    assert cache_key(rule, conversation, provider) != cache_key(rule, conversation, previous)


def test_after_end_message_does_not_replace_available_client_facing_operator_evidence(transcript):
    transcript.append({"id": 3, "timestamp": "00:02", "speaker": "operator", "text": "Synthetic after-end note",
                       "phase": "after_end", "client_facing": False})
    result = generate(FakeLLM(), [criterion("arbitrary-after-end")], transcript)[0]
    assert result["evidence_message_ids"] == [2]


def test_versioned_demo_reference_keeps_existing_cached_choices_compatible(transcript):
    """An intentional mapping change must also change the demo cache version."""
    transcript[0]["text"] = "Синтетический вопрос"
    rules = [criterion(f"vector-{index}", ("binary", "scale", "flag")[index % 3], True) for index in range(24)]
    provider = FakeLLM()
    results = generate(provider, rules, transcript)
    assert provider.cache_settings == {"behavior": "deterministic-varied-v1"}
    assert [item["answer"]["value"] for item in results] == [
        False, 4, False, True, 9, False, False, 9, False, False, 0, False,
        False, 4, True, True, 0, False, True, None, False, True, 9, True]
    assert [index for index, item in enumerate(results) if item["answer"]["status"] == "not_applicable"] == [19]
    assert [index for index, item in enumerate(results) if item["manual_review"]] == [1, 6, 11, 14]
