import pytest
from fastapi.testclient import TestClient
from app.config import Settings
from app.main import create_app


def test_output_budget_is_configured_and_secrets_are_not_in_repr(monkeypatch):
    monkeypatch.setenv("LLM_MAX_OUTPUT_TOKENS", "4096")
    monkeypatch.setenv("LLM_API_KEY", "synthetic-private-configuration")
    settings = Settings.from_env()
    assert settings.llm_max_output_tokens == 4096
    assert "synthetic-private-configuration" not in repr(settings)
    monkeypatch.setenv("LLM_MAX_OUTPUT_TOKENS", "0")
    with pytest.raises(ValueError):
        Settings.from_env()


def test_configured_real_provider_health_is_ready_without_calling_model(tmp_path):
    settings = Settings(database_path=tmp_path / "provider.db", llm_provider="openai",
                        llm_model="synthetic-model", llm_api_key="synthetic-key")
    with TestClient(create_app(settings)) as client:
        health = client.get("/api/health").json()["data"]
        assert health["evaluation_ready"] is True
        assert health["is_demo"] is False
        assert health["provider"] == "openai"
