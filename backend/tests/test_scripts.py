"""CLI workflow checks with synthetic data and an isolated FakeLLM API."""
from copy import deepcopy
import json
from types import SimpleNamespace

from fastapi.testclient import TestClient
import httpx
import pytest

from app.config import Settings
from app.main import create_app
from scripts.gen_api_examples import synthetic_dataset
from scripts.rehearse_control import rehearse
from scripts.run_batch import aggregate_usage, run_group
from scripts import gen_api_examples, rehearse_control, run_batch


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


def test_example_cli_writes_real_demo_responses_and_openapi(tmp_path, capsys):
    output, schema = tmp_path / "examples", tmp_path / "openapi.json"
    assert gen_api_examples.main(["--output", str(output), "--openapi", str(schema)]) == 0
    responses = {path.stem: json.loads(path.read_text(encoding="utf-8")) for path in output.glob("*.json")}
    assert responses["health"]["data"]["is_demo"] is True
    assert responses["job_completed"]["data"]["status"] == "completed"
    assert responses["evaluation"]["data"]["final_revision"] == 0
    assert responses["appeal_decision"]["data"]["evaluation"]["final_revision"] == 1
    assert responses["validation_error"]["error"]["code"] == "VALIDATION_ERROR"
    assert responses["version_conflict"]["error"]["code"] == "VERSION_CONFLICT"
    assert all(body["meta"]["request_id"] for body in responses.values())
    paths = json.loads(schema.read_text(encoding="utf-8"))["paths"]
    assert "/api/evaluations" in paths and "/api/appeals/{id}/decision" in paths
    assert "Generated" in capsys.readouterr().out


def test_batch_cli_reports_failure_safely_without_provider_details(monkeypatch, capsys):
    def offline(request):
        return httpx.Response(503, json={"private": "secret transport internals"})

    client = httpx.Client(base_url="http://example.invalid", transport=httpx.MockTransport(offline))
    monkeypatch.setattr(run_batch.httpx, "Client", lambda **kwargs: client)
    assert run_batch.main(["--group", "SYNTHETIC"]) == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "Batch failed" in captured.err
    assert "secret" not in captured.err


def test_batch_cli_success_prints_usage_and_demo_marker(monkeypatch, capsys):
    def transport(request):
        if request.method == "POST":
            body = {"id": "synthetic-job"}
        elif request.url.path.startswith("/api/jobs/"):
            body = {"id": "synthetic-job", "status": "completed", "provider": "fake", "is_demo": True,
                    "total": 1, "succeeded": 1, "failed": 0, "manual_review_count": 0,
                    "items": [{"evaluation_id": "synthetic-evaluation"}]}
        else:
            body = {"usage": {"calls": 1, "input_tokens": None, "output_tokens": None, "cost": None, "currency": None}}
        return httpx.Response(200, json={"data": body})

    client = httpx.Client(base_url="http://example.invalid", transport=httpx.MockTransport(transport))
    monkeypatch.setattr(run_batch.httpx, "Client", lambda **kwargs: client)
    assert run_batch.main(["--group", "SYNTHETIC", "--force"]) == 0
    report = json.loads(capsys.readouterr().out)
    assert report["is_demo"] is True and report["calls"] == 1
    assert report["cost"] is None and report["usage_complete"] is True


def test_rehearsal_cli_rejects_bad_local_json_without_echoing_it(tmp_path, capsys):
    source = tmp_path / "private.json"
    source.write_text("sensitive source that is not JSON", encoding="utf-8")
    assert rehearse_control.main(["--file", str(source)]) == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "Rehearsal failed" in captured.err
    assert "sensitive source" not in captured.err


@pytest.mark.parametrize("payload", [None, {}, {"isSuccess": True, "data": None},
                                    {"isSuccess": True, "data": {"records": {}}}, [], [{"conversation_id": "empty"}]])
def test_rehearsal_refuses_invalid_or_unusable_source_before_import(payload):
    with pytest.raises(ValueError):
        rehearse_control.altered_dataset(payload, "CONTROL")


def test_rehearsal_accepts_bare_array_and_preserves_unrecognized_records():
    source = synthetic_dataset()["data"]["records"] + [None, {"unknown": "preserved"}]
    edited = rehearse_control.altered_dataset(source, "CONTROL")
    assert len(edited) == len(source) + 1
    assert edited[-3:-1] == [None, {"unknown": "preserved"}]
    assert source[0]["conversation_id"] == "demo-ru"


@pytest.mark.parametrize("selection", [["--group", "SYNTHETIC"], ["--job-id", "synthetic-job"]])
def test_batch_default_waits_past_ten_minutes_and_resume_never_posts(selection, monkeypatch, capsys):
    calls, poll_count = [], []
    clock = {"now": 0}
    monkeypatch.setattr(run_batch, "time", SimpleNamespace(monotonic=lambda: clock["now"], sleep=lambda _: None))

    def transport(request):
        calls.append(request.method)
        if request.method == "POST":
            body = {"id": "synthetic-job"}
        elif request.url.path.startswith("/api/jobs/"):
            poll_count.append(1)
            clock["now"] = 637
            body = {"id": "synthetic-job", "status": "running" if len(poll_count) == 1 else "completed",
                    "provider": "fake", "is_demo": True, "total": 1, "succeeded": 1, "failed": 0,
                    "manual_review_count": 0, "items": [{"evaluation_id": "synthetic-evaluation"}]}
        else:
            body = {"usage": {"calls": 1, "input_tokens": 10, "output_tokens": 2, "cost": None, "currency": None}}
        return httpx.Response(200, json={"data": body})

    client = httpx.Client(base_url="http://example.invalid", transport=httpx.MockTransport(transport))
    monkeypatch.setattr(run_batch.httpx, "Client", lambda **kwargs: client)
    assert run_batch.main(selection) == 0
    captured = capsys.readouterr()
    assert json.loads(captured.out)["job_id"] == "synthetic-job"
    assert "Job ID: synthetic-job" in captured.err
    assert calls.count("POST") == (0 if selection[0] == "--job-id" else 1)
    assert len(poll_count) == 2


def test_batch_prints_created_job_before_polling_and_retains_resume_hint_on_timeout(monkeypatch, capsys):
    clock = {"now": 0}
    monkeypatch.setattr(run_batch, "time", SimpleNamespace(monotonic=lambda: clock["now"], sleep=lambda _: None))

    def transport(request):
        if request.method == "POST":
            return httpx.Response(202, json={"data": {"id": "already-created"}})
        assert "Job ID: already-created" in capsys.readouterr().err
        clock["now"] = 2
        return httpx.Response(200, json={"data": {"status": "running"}})

    client = httpx.Client(base_url="http://example.invalid", transport=httpx.MockTransport(transport))
    monkeypatch.setattr(run_batch.httpx, "Client", lambda **kwargs: client)
    assert run_batch.main(["--group", "SYNTHETIC", "--timeout", "1"]) == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "--job-id to resume" in captured.err


@pytest.mark.parametrize("arguments", [["--group", ""], ["--job-id", "../jobs"],
    ["--job-id", "existing", "--force"], ["--group", "G", "--timeout", "nan"],
    ["--group", "G", "--timeout", "inf"]])
def test_batch_rejects_unsafe_or_ambiguous_cli_arguments(arguments):
    with pytest.raises(SystemExit) as error:
        run_batch.main(arguments)
    assert error.value.code == 2
