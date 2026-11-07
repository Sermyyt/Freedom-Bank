"""Provider boundary. Fake results are synthetic and never claim model accuracy."""
from threading import Lock


class ProviderError(Exception):
    def __init__(self, code="PROVIDER_ERROR", message="Провайдер не смог выполнить оценку.", retryable=False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


class FakeLLM:
    name = "fake"
    model = None
    is_demo = True
    ready = True

    def __init__(self):
        self.calls = 0
        self.requested_criteria = []
        self._lock = Lock()

    def generate(self, criteria, transcript, prompt, response_schema, errors=None):
        with self._lock:
            self.calls += 1
            self.requested_criteria.append([criterion["id"] for criterion in criteria])
        evidence = next((message for message in transcript
                         if message["speaker"] == "operator" and message.get("client_facing", True)), transcript[0])
        answers = []
        for criterion in criteria:
            if criterion["answer_type"] == "flag":
                value = False
                ids = []
                checked = {"start_id": transcript[0]["id"], "end_id": transcript[-1]["id"]}
                expected = "Проверка описанного нарушения по диапазону (синтетическая демонстрация)."
            else:
                value = max(criterion["options"], key=lambda item: item["normalized"])["value"]
                ids = [evidence["id"]]
                checked, expected = None, None
            answers.append({
                "criterion_id": criterion["id"], "answer": {"status": "answered", "value": value},
                "rationale": "Демо: синтетический ответ для проверки интерфейса, не оценка качества разговора.",
                "evidence_message_ids": ids, "checked_range": checked, "expected_action": expected,
                "na_reason": None, "manual_review": False, "manual_review_reasons": [],
            })
        return {"criteria": answers, "usage": {"input_tokens": None, "output_tokens": None,
                                                "cost": None, "currency": None}}
