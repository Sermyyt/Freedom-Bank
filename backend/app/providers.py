"""Provider boundary. Fake results are synthetic and never claim model accuracy."""
import hashlib
import json
from threading import Lock


class ProviderError(Exception):
    def __init__(self, code="PROVIDER_ERROR", message="Провайдер не смог выполнить оценку.", retryable=False,
                 usage=None, raw_response=None, retry_after=None):
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        self.usage = usage or {}
        self.raw_response = raw_response or {"error_code": code}
        self.retry_after = retry_after


def _fake_revision(transcript):
    canonical = json.dumps(transcript, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _fake_evidence(transcript):
    internal = next((message for message in transcript if message.get("phase") in {"hold", "internal_consult"}
                     and not message.get("client_facing", True)), None)
    if internal is not None:
        return internal
    return next((message for message in transcript
                 if message["speaker"] == "operator" and message.get("client_facing", True)), transcript[0])


def _fake_answer(criterion, draw):
    if criterion["na_allowed"] and draw[0] % 7 == 0:
        return {"status": "not_applicable", "value": None}
    options = sorted((item["value"] for item in criterion["options"]), key=lambda value: json.dumps(value))
    index = int(draw[2] % 4 == 0) if criterion["answer_type"] == "flag" else draw[2] % len(options)
    return {"status": "answered", "value": options[index]}


def _fake_result(criterion, revision, evidence):
    draw = hashlib.sha256(f"{revision}\0{criterion['id']}".encode("utf-8")).digest()
    answer = _fake_answer(criterion, draw)
    is_na, manual = answer["status"] == "not_applicable", draw[1] % 11 == 0
    return {
        "criterion_id": criterion["id"], "answer": answer,
        "rationale": "Демо: синтетический ответ для проверки интерфейса, не оценка качества разговора.",
        "evidence_message_ids": [] if is_na else [evidence["id"]], "checked_range": None, "expected_action": None,
        "na_reason": "Демо: синтетический пример неприменимости разрешённого критерия." if is_na else None,
        "manual_review": manual,
        "manual_review_reasons": ["Демо: синтетический пример неопределённости для ручной проверки."] if manual else [],
    }


class FakeLLM:
    name = "fake"
    model = None
    is_demo = True
    ready = True
    cache_settings = {"behavior": "deterministic-varied-v1"}

    def __init__(self):
        self.calls = 0
        self.requested_criteria = []
        self._lock = Lock()

    def generate(self, criteria, transcript, prompt, response_schema, errors=None):
        with self._lock:
            self.calls += 1
            self.requested_criteria.append([criterion["id"] for criterion in criteria])
        revision, evidence = _fake_revision(transcript), _fake_evidence(transcript)
        answers = [_fake_result(criterion, revision, evidence) for criterion in criteria]
        return {"criteria": answers, "usage": {"input_tokens": None, "output_tokens": None,
                                                "cost": None, "currency": None}}


def make_provider(settings, *, transport=None):
    """Explicit fake mode; an unconfigured real provider never silently becomes fake."""
    if settings.llm_provider == "fake":
        return FakeLLM()
    if not settings.llm_model or not settings.llm_api_key:
        return None
    from app.provider_http import AnthropicProvider, OpenAIProvider
    provider_type = {"openai": OpenAIProvider, "anthropic": AnthropicProvider}.get(settings.llm_provider)
    if provider_type is None:
        return None
    try:
        return provider_type(settings, transport=transport)
    except ValueError:
        return None
