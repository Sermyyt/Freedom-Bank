"""API fixtures use temporary SQLite stores, synthetic text and the fake provider."""
from copy import deepcopy

from fastapi.testclient import TestClient
import pytest

from app.config import Settings


@pytest.fixture
def settings(tmp_path):
    return Settings(database_path=tmp_path / "test.db", llm_provider="fake", llm_max_attempts=1)


@pytest.fixture
def positive_provider():
    """Explicit full-score fixture for arithmetic and downward-appeal assertions."""
    from app.providers import FakeLLM

    provider = FakeLLM()
    original_generate = provider.generate

    def generate(criteria, transcript, *args, **kwargs):
        response = original_generate(criteria, transcript, *args, **kwargs)
        evidence = next((item for item in transcript if item["speaker"] == "operator"), transcript[0])
        for criterion, result in zip(criteria, response["criteria"]):
            value = False if criterion["answer_type"] == "flag" else max(criterion["options"], key=lambda item: item["normalized"])["value"]
            result.update(answer={"status": "answered", "value": value}, evidence_message_ids=[evidence["id"]],
                          na_reason=None, manual_review=False, manual_review_reasons=[])
        return response

    provider.generate = generate
    return provider


@pytest.fixture
def positive_client(settings, positive_provider):
    from app.main import create_app

    with TestClient(create_app(settings, provider=positive_provider)) as test_client:
        yield test_client


@pytest.fixture
def api(settings):
    from app.main import create_app

    return create_app(settings)


@pytest.fixture
def client(api):
    with TestClient(api) as test_client:
        yield test_client


@pytest.fixture
def synthetic_record():
    return {
        "conversation_id": "synthetic-001",
        "channel": "agent chat",
        "language": "RU",
        "transcript": [
            {"timestamp": "00:00", "speaker": "client", "text": "Как открыть учебный счёт?"},
            {"timestamp": "00:02", "speaker": "operator", "text": "Здравствуйте, я Анна. Откройте учебную форму."},
            {"timestamp": "00:04", "speaker": "client", "text": "Спасибо, форма открылась."},
            {"timestamp": "00:06", "speaker": "operator", "text": "Рада помочь. До свидания!"},
        ],
        "audio_url": None,
    }


@pytest.fixture
def dataset(synthetic_record):
    return {"isSuccess": True, "error": "", "data": {
        "dataset_group_id": "TEST", "total_records": 1, "records": [deepcopy(synthetic_record)],
    }}
