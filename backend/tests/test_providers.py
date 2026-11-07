"""Provider contracts use MockTransport only: no network and no real credentials."""
import json

import httpx
import pytest

from app.config import Settings
from app.evaluation import DomainError, evaluate
from app.providers import FakeLLM, make_provider

POLICY = {"rounding": "half_up", "decimals": 2, "gross_error_zeroes_total": False}
SYNTHETIC_KEY = "synthetic-provider-key"


@pytest.fixture
def domain():
    definition = {"name": "Test", "description": "Synthetic", "criteria": [
        {"id": "custom-provider-rule", "name": "Test", "description": "Synthetic rule", "section": "",
         "answer_type": "binary", "weight": 1, "na_allowed": False, "na_condition": None,
         "options": [{"value": False, "normalized": 0, "label": "No", "description": "No"},
                     {"value": True, "normalized": 1, "label": "Yes", "description": "Yes"}]}]}
    conversation = {"ref": {"revision_id": "synthetic-revision"}, "manual_review_reasons": [], "transcript": [
        {"id": 1, "timestamp": "00:00", "speaker": "operator", "text": "Synthetic message",
         "phase": "client", "client_facing": True, "flags": [], "system_event": None}]}
    return definition, conversation


def output_text():
    return json.dumps({"criteria": [{"criterion_id": "custom-provider-rule", "answer": {
        "status": "answered", "value": True}, "rationale": "Проверено #1", "evidence_message_ids": [1]}]},
        ensure_ascii=False)


def openai_response(text=None, **changes):
    payload = {"status": "completed", "output": [{"type": "message", "role": "assistant", "content": [
        {"type": "output_text", "text": output_text() if text is None else text}]}],
        "usage": {"input_tokens": 11, "output_tokens": 5}}
    return {**payload, **changes}


def provider(kind, handler, **settings):
    configuration = Settings(llm_provider=kind, llm_model="chosen-by-user", llm_api_key=SYNTHETIC_KEY, **settings)
    return make_provider(configuration, transport=httpx.MockTransport(handler))


@pytest.mark.parametrize("kind", ["openai", "anthropic"])
def test_factory_never_substitutes_fake_for_missing_real_settings(kind):
    assert make_provider(Settings(llm_provider=kind)) is None
    assert make_provider(Settings(llm_provider=kind, llm_api_key=SYNTHETIC_KEY)) is None
    assert make_provider(Settings(llm_provider=kind, llm_model="chosen-by-user")) is None
    assert isinstance(make_provider(Settings(llm_provider="fake")), FakeLLM)


def test_openai_uses_responses_strict_dynamic_schema_and_counts_usage(domain):
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(200, json=openai_response())

    selected = provider("openai", handler, llm_base_url="https://example.invalid/v1", llm_timeout=17)
    snapshot, usage, raw, _ = evaluate(*domain, selected, POLICY)
    request = requests[0]
    body = json.loads(request.content)
    assert str(request.url) == "https://example.invalid/v1/responses"
    assert request.headers["authorization"] == f"Bearer {SYNTHETIC_KEY}"
    assert request.extensions["timeout"]["read"] == 17
    assert body["model"] == "chosen-by-user" and body["store"] is False
    assert body["text"]["format"]["strict"] is True
    assert_strict_schema(body["text"]["format"]["schema"])
    assert "custom-provider-rule" in json.dumps(body["text"]["format"]["schema"])
    assert snapshot["total"] == 100
    assert usage["input_tokens"] == 11 and usage["output_tokens"] == 5
    assert usage["calls"] == 1 and usage["cost"] is None
    assert raw[0]["provider_response"]["status"] == "completed"


def assert_strict_schema(value):
    """The provider rejects open objects or optional object fields in strict mode."""
    if isinstance(value, dict):
        if value.get("type") == "object":
            assert value["additionalProperties"] is False
            assert set(value["required"]) == set(value["properties"])
        for child in value.values():
            assert_strict_schema(child)
    elif isinstance(value, list):
        for child in value:
            assert_strict_schema(child)


def test_anthropic_uses_messages_schema_and_counts_all_input_token_kinds(domain):
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(200, json={"stop_reason": "end_turn", "content": [
            {"type": "text", "text": output_text()}], "usage": {
                "input_tokens": 10, "cache_creation_input_tokens": 2, "cache_read_input_tokens": 3,
                "output_tokens": 7}})

    selected = provider("anthropic", handler, llm_base_url="https://example.invalid")
    snapshot, usage, _, _ = evaluate(*domain, selected, POLICY)
    request = requests[0]
    body = json.loads(request.content)
    assert request.url.path == "/v1/messages"
    assert request.headers["anthropic-version"] == "2026-10-21"
    assert request.headers["authorization"] == f"Bearer {SYNTHETIC_KEY}"
    assert body["output_config"]["format"]["type"] == "json_schema"
    assert body["system"] and body["max_tokens"] > 0
    assert snapshot["total"] == 100
    assert usage["input_tokens"] == 15 and usage["output_tokens"] == 7


def test_optional_na_schema_remains_acceptable_to_strict_provider(domain):
    domain[0]["criteria"][0].update(na_allowed=True, na_condition="Synthetic applicability condition")

    def handler(request):
        schema = json.loads(request.content)["text"]["format"]["schema"]
        assert_strict_schema(schema)
        assert "not_applicable" in json.dumps(schema)
        return httpx.Response(200, json=openai_response())

    snapshot, _, _, _ = evaluate(*domain, provider("openai", handler), POLICY)
    assert snapshot["total"] == 100


def test_default_http_backoff_increases_between_transient_failures(domain, monkeypatch):
    requests, delays = [], []
    monkeypatch.setattr("app.evaluation.time.sleep", delays.append)

    def handler(request):
        requests.append(request)
        if len(requests) < 3:
            return httpx.Response(503, json={"error": {"message": "Temporary synthetic error"}})
        return httpx.Response(200, json=openai_response())

    snapshot, usage, _, _ = evaluate(*domain, provider("openai", handler), POLICY, max_attempts=3)
    assert snapshot["total"] == 100 and usage["calls"] == 3
    assert delays == [0.25, 0.5]


def test_rate_limit_retry_waits_the_full_server_requested_interval(domain):
    attempts = []

    def handler(request):
        attempts.append(request)
        if len(attempts) == 1:
            return httpx.Response(429, json={"error": {}}, headers={"Retry-After": "60"})
        return httpx.Response(200, json=openai_response())

    delays = []
    snapshot, usage, _, _ = evaluate(*domain, provider("openai", handler), POLICY, sleeper=delays.append)
    assert delays == [60.0]
    assert usage["calls"] == 2
    assert snapshot["status"] == "completed"


@pytest.mark.parametrize("header", ["not-a-delay", "NaN", "Infinity", "-Infinity", "1e9999", ""])
def test_invalid_retry_after_uses_finite_default_backoff(domain, header):
    attempts, delays = [], []

    def handler(request):
        attempts.append(request)
        if len(attempts) == 1:
            return httpx.Response(429, json={"error": {}}, headers={"Retry-After": header})
        return httpx.Response(200, json=openai_response())

    snapshot, usage, _, _ = evaluate(*domain, provider("openai", handler), POLICY, sleeper=delays.append)
    assert delays == [0.25]
    assert usage["calls"] == 2
    assert snapshot["status"] == "completed"


def test_zero_retry_after_allows_immediate_retry(domain):
    attempts, delays = [], []

    def handler(request):
        attempts.append(request)
        if len(attempts) == 1:
            return httpx.Response(429, json={"error": {}}, headers={"Retry-After": "0"})
        return httpx.Response(200, json=openai_response())

    snapshot, _, _, _ = evaluate(*domain, provider("openai", handler), POLICY, sleeper=delays.append)
    assert delays == [0.0]
    assert snapshot["status"] == "completed"


@pytest.mark.parametrize("status", [429, 500, 503])
def test_retryable_http_errors_retry_once_with_bounded_backoff(domain, status):
    requests, delays = [], []

    def handler(request):
        requests.append(request)
        if len(requests) == 1:
            return httpx.Response(status, json={"error": {"message": SYNTHETIC_KEY}}, headers={"Retry-After": "1"})
        return httpx.Response(200, json=openai_response())

    selected = provider("openai", handler)
    _, usage, raw, _ = evaluate(*domain, selected, POLICY, sleeper=delays.append)
    assert len(requests) == 2 and delays == [1]
    assert usage["calls"] == 2 and usage["input_tokens"] is None
    assert SYNTHETIC_KEY not in json.dumps(raw)


@pytest.mark.parametrize("status", [400, 401, 403])
def test_permanent_http_errors_do_not_retry_or_leak_response(domain, status):
    requests, delays = [], []

    def handler(request):
        requests.append(request)
        return httpx.Response(status, json={"error": {"message": SYNTHETIC_KEY}})

    selected = provider("openai", handler)
    with pytest.raises(DomainError) as caught:
        evaluate(*domain, selected, POLICY, sleeper=delays.append)
    assert len(requests) == 1 and not delays
    assert SYNTHETIC_KEY not in str(caught.value)
    assert SYNTHETIC_KEY not in json.dumps(caught.value.raw_response)
    assert caught.value.usage["calls"] == 1


def test_timeout_retries_without_exposing_request_or_secret(domain):
    requests, delays = [], []

    def handler(request):
        requests.append(request)
        raise httpx.ReadTimeout(f"Request contained {SYNTHETIC_KEY}", request=request)

    with pytest.raises(DomainError) as caught:
        evaluate(*domain, provider("openai", handler), POLICY, max_attempts=2, sleeper=delays.append)
    assert len(requests) == 2 and len(delays) == 1
    assert caught.value.code == "PROVIDER_TIMEOUT"
    assert SYNTHETIC_KEY not in str(caught.value)
    assert caught.value.usage["input_tokens"] is None


def test_invalid_model_json_retries_and_preserves_both_usage_and_raw(domain):
    requests, delays = [], []

    def handler(request):
        requests.append(request)
        if len(requests) == 1:
            return httpx.Response(200, json=openai_response("{not JSON", usage={"input_tokens": 3, "output_tokens": 7}))
        return httpx.Response(200, json=openai_response())

    _, usage, raw, _ = evaluate(*domain, provider("openai", handler), POLICY, sleeper=delays.append)
    assert usage["calls"] == 2 and usage["input_tokens"] == 14 and usage["output_tokens"] == 12
    assert len(raw) == 2 and "{not JSON" in json.dumps(raw[0])
    second_body = json.loads(requests[1].content)
    assert "INVALID_ANSWER" in json.dumps(second_body)


@pytest.mark.parametrize("changes", [
    {"status": "incomplete"},
    {"output": [{"type": "message", "content": [{"type": "refusal", "refusal": "No"}]}]},
])
def test_incomplete_or_refused_output_never_becomes_success(domain, changes):
    with pytest.raises(DomainError) as caught:
        evaluate(*domain, provider("openai", lambda request: httpx.Response(200, json=openai_response(**changes))),
                 POLICY, max_attempts=1)
    assert caught.value.usage["input_tokens"] == 11


def test_non_json_http_body_fails_without_losing_attempt_count(domain):
    with pytest.raises(DomainError) as caught:
        evaluate(*domain, provider("openai", lambda request: httpx.Response(200, text="not JSON " + SYNTHETIC_KEY)),
                 POLICY, max_attempts=1)
    assert caught.value.usage["calls"] == 1
    assert SYNTHETIC_KEY not in json.dumps(caught.value.raw_response)


@pytest.mark.parametrize(("kind", "payload"), [
    ("openai", {"status": "completed", "output": None, "usage": {"input_tokens": 4, "output_tokens": 2}}),
    ("openai", {"status": "completed", "output": [{"type": "message", "content": None}]}),
    ("anthropic", {"stop_reason": "end_turn", "content": None, "usage": {"input_tokens": 4, "output_tokens": 2}}),
])
def test_malformed_provider_structure_is_a_validated_failure_with_audit(domain, kind, payload):
    with pytest.raises(DomainError) as caught:
        evaluate(*domain, provider(kind, lambda request: httpx.Response(200, json=payload)), POLICY, max_attempts=1)
    assert caught.value.code == "MODEL_OUTPUT_INVALID"
    assert caught.value.raw_response[0]["provider_response"] == payload


def test_provider_identity_and_cache_never_expose_secrets():
    selected = provider("openai", lambda request: httpx.Response(500), llm_base_url="https://example.invalid/proxy/v1")
    assert SYNTHETIC_KEY not in repr(selected)
    assert SYNTHETIC_KEY not in json.dumps(selected.cache_settings)
    assert "example.invalid" not in json.dumps(selected.cache_settings)
    another = provider("openai", lambda request: httpx.Response(500), llm_base_url="https://elsewhere.invalid/v1")
    assert selected.cache_settings != another.cache_settings


@pytest.mark.parametrize("url", ["ftp://example.invalid", "https://user:password@example.invalid", "https://example.invalid?key=secret"])
def test_invalid_base_url_disables_provider_without_showing_configuration(url):
    assert make_provider(Settings(llm_provider="openai", llm_model="chosen", llm_api_key=SYNTHETIC_KEY,
                                  llm_base_url=url)) is None
