"""CLI workflow checks with synthetic data and an isolated FakeLLM API."""
from copy import deepcopy

from fastapi.testclient import TestClient
import httpx

from app.config import Settings
from app.main import create_app
from scripts.gen_api_examples import synthetic_dataset
from scripts.rehearse_control import rehearse
from scripts.run_batch import aggregate_usage, run_group


def test_usage_totals_keep_unknown_tokens_and_incompatible_currencies_unknown():
    evaluations = [
        {"usage": {"calls": 2, "input_tokens": 10, "output_tokens": 5, "cost": 0.1, "currency": "USD"}},
        {"usage": {"calls": 1, "input_tokens": None, "output_tokens": 6, "cost": 0.2, "currency": "USD"}},
    ]
    totals = aggregate_usage(evaluations)
    assert totals == {"calls": 3, "input_tokens": None, "output_tokens": 11, "cost": 0.3, "currency": "USD"}
    evaluations[1]["usage"]["currency"] = "EUR"
    assert aggregate_usage(evaluations)["cost"] is None
    evaluations[1]["usage"]["cost"] = None
    assert aggregate_usage(evaluations)["currency"] is None


def test_failed_batch_does_not_report_unrecorded_provider_usage_as_zero():
    def transport(request):
        if request.method == "POST":
            return httpx.Response(202, json={"data": {"id": "synthetic-job"}})
        return httpx.Response(200, json={"data": {
            "id": "synthetic-job", "status": "failed", "provider": "fake", "is_demo": True,
            "total": 1, "succeeded": 0, "failed": 1, "manual_review_count": 0,
            "items": [{"status": "failed", "evaluation_id": None}],
        }})

    with httpx.Client(base_url="http://example.invalid", transport=httpx.MockTransport(transport)) as client:
        result = run_group(client, "SYNTHETIC", poll_interval=0.01)
    assert result["status"] == "failed"
    assert result["usage_complete"] is False
    assert all(result[field] is None for field in ("calls", "input_tokens", "output_tokens", "cost", "currency"))


def test_control_rehearsal_preserves_source_and_processes_new_group_end_to_end(tmp_path):
    source = synthetic_dataset()
    untouched = deepcopy(source)
    with TestClient(create_app(Settings(database_path=tmp_path / "rehearsal.db", llm_provider="fake"))) as client:
        result = rehearse(client, source, group="SYNTHETIC_CONTROL", poll_interval=0.01)
        assert result["import"] == {"received": 3, "created": 2, "unchanged": 0, "revised": 0, "skipped": 1}
        assert result["import_error_count"] == 1
        assert result["unknown_system_phrase_count"] == 1
        assert result["evaluation"]["succeeded"] == 2
        assert result["evaluation"]["failed"] == 0
        assert result["evaluation"]["is_demo"] is True
        assert result["evaluation"]["usage_complete"] is True
        original = client.get("/api/conversations", params={"group_id": "SYNTHETIC"}).json()["data"]
        assert original["total"] == 0
        imported = client.get("/api/conversations", params={"group_id": "SYNTHETIC_CONTROL"}).json()["data"]
        assert imported["total"] == 2
    assert source == untouched
