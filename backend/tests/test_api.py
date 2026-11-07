"""HTTP contract and durable workflow checks; all conversations are synthetic."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from dataclasses import replace
import io
import json
from threading import Barrier
import time
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from app import schemas


def data(response, status=200, model=None):
    assert response.status_code == status, response.text
    body = response.json()
    assert set(body) == {"data", "meta"}
    assert isinstance(body["meta"]["request_id"], str) and body["meta"]["request_id"]
    if model is not None:
        model.model_validate(body["data"])
    return body["data"]


def error(response, status, code=None):
    assert response.status_code == status, response.text
    parsed = schemas.Failure.model_validate(response.json())
    assert parsed.meta.request_id
    if code is not None:
        assert parsed.error.code == code
    return parsed.error


def upload(client, payload, group=None):
    return client.post("/api/imports/file", data={} if group is None else {"group_id": group},
                       files={"file": ("synthetic.json", json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                                       "application/json")})


def active_version(client):
    health = data(client.get("/api/health"), model=schemas.Health)
    return data(client.get(f"/api/checklist-versions/{health['active_checklist_version_id']}"),
                model=schemas.ChecklistVersion)


def finish(client, job):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        result = data(client.get(f"/api/jobs/{job['id']}"), model=schemas.Job)
        if result["status"] in {"completed", "failed"}:
            return result
        time.sleep(0.01)
    raise AssertionError(f"Job did not finish: {job['id']}")


def evaluate(client, **request):
    job = finish(client, data(client.post("/api/evaluations", json=request), 202, schemas.Job))
    assert job["status"] == "completed", job
    return data(client.get(f"/api/evaluations/{job['items'][0]['evaluation_id']}"), model=schemas.Evaluation)


def appeal(client, evaluation, criterion_id=None):
    return data(client.post("/api/appeals", json={
        "evaluation_id": evaluation["id"],
        "criterion_id": criterion_id or evaluation["checklist_snapshot"]["criteria"][0]["id"],
        "comment": "Пожалуйста, проверьте синтетический ответ.",
    }), 201, schemas.Appeal)


def test_bootstrap_exposes_one_active_seed_version(client):
    health = data(client.get("/api/health"), model=schemas.Health)
    assert health["status"] == "ok" and health["database_ready"]
    assert health["provider"] == "fake" and health["is_demo"] and health["evaluation_ready"]
    assert not health["dataset_ready"]
    checklists = data(client.get("/api/checklists"), model=schemas.Page[schemas.Checklist])
    assert checklists["total"] == 1
    checklist = data(client.get(f"/api/checklists/{checklists['items'][0]['id']}"), model=schemas.Checklist)
    versions = data(client.get(f"/api/checklists/{checklist['id']}/versions"),
                    model=schemas.Page[schemas.ChecklistVersion])
    assert versions["total"] == 1
    initial = active_version(client)
    assert initial["id"] == checklist["latest_version_id"] == health["active_checklist_version_id"]
    assert initial["version"] == 1 and initial["is_active"]
    assert len(initial["definition"]["criteria"]) == 8


def test_frontend_roundtrip_and_all_workflow_routes(client, dataset):
    report = data(upload(client, dataset), model=schemas.ImportReport)
    assert report["created"] == 1 and report["skipped"] == 0
    conversations = data(client.get("/api/conversations"), model=schemas.Page[schemas.ConversationSummary])
    conversation = conversations["items"][0]
    cid = conversation["ref"]["id"]
    detail = data(client.get(f"/api/conversations/{cid}"), model=schemas.ConversationDetail)
    assert [m["id"] for m in detail["transcript"]] == [1, 2, 3, 4]
    revisions = data(client.get(f"/api/conversations/{cid}/revisions"),
                     model=schemas.Page[schemas.ConversationRevision])
    assert revisions["total"] == 1 and revisions["items"][0]["ref"] == detail["ref"]

    initial = active_version(client)
    definition = deepcopy(initial["definition"])
    definition["name"] = "Новый учебный чек-лист"
    validation = data(client.post("/api/checklists/validate", json=definition), model=schemas.ValidationReport)
    assert validation["valid"]
    created = data(client.post("/api/checklists", json=definition), 201, schemas.ChecklistVersion)
    assert created["version"] == 1 and not created["is_active"]
    activation = data(client.post(f"/api/checklist-versions/{created['id']}/activate",
                                  json={"expected_active_version_id": initial["id"]}),
                      model=schemas.ActivationResult)
    assert activation["previous_version_id"] == initial["id"]
    assert activation["active_version_id"] == created["id"]
    definition["description"] += " Изменённое описание."
    version = data(client.post(f"/api/checklists/{created['checklist_id']}/versions", json={
        **definition, "expected_latest_version_id": created["id"], "activate": True,
        "expected_active_version_id": created["id"],
    }), 201, schemas.ChecklistVersion)
    assert version["version"] == 2 and version["is_active"]

    first = evaluate(client, group_id="TEST")
    assert first["is_demo"] and first["checklist_version_id"] == version["id"]
    assert first["original"] == first["final"] and first["final_revision"] == 0
    evaluations = data(client.get("/api/evaluations", params={"conversation_id": cid}),
                       model=schemas.Page[schemas.EvaluationSummary])
    assert evaluations["total"] == 1
    second = evaluate(client, revision_ids=[detail["ref"]["revision_id"]], force=True)
    comparison = data(client.get("/api/evaluations/compare", params={"left_id": first["id"], "right_id": second["id"]}),
                      model=schemas.EvaluationComparison)
    assert comparison["total_delta"] == 0
    assert all(c["change"] == "unchanged" for c in comparison["criteria"])

    opened = appeal(client, first)
    assert data(client.get(f"/api/appeals/{opened['id']}"), model=schemas.Appeal) == opened
    listed = data(client.get("/api/appeals", params={"evaluation_id": first["id"], "status": "open"}),
                  model=schemas.Page[schemas.Appeal])
    assert listed["total"] == 1
    decided = data(client.post(f"/api/appeals/{opened['id']}/decision", json={
        "action": "confirm", "reason": "Ответ проверен вручную.", "expected_final_revision": 0,
    }), model=schemas.AppealDecisionResult)
    assert decided["appeal"]["status"] == "resolved" and decided["evaluation"]["final_revision"] == 1
    assert decided["evaluation"]["original"] == first["original"]
    events = data(client.get("/api/history", params={"evaluation_id": first["id"]}),
                  model=schemas.Page[schemas.HistoryEvent])
    assert {e["event_type"] for e in events["items"]} >= {"evaluation_created", "appeal_created", "appeal_resolved"}
    assert all(e["evaluation_id"] == first["id"] for e in events["items"])


def test_openapi_contains_all_24_contract_operations(client):
    document = client.get("/openapi.json").json()
    expected = {
        ("get", "/api/health"), ("post", "/api/imports/dataset"), ("post", "/api/imports/file"),
        ("get", "/api/conversations"), ("get", "/api/conversations/{id}"),
        ("get", "/api/conversations/{id}/revisions"), ("get", "/api/checklists"),
        ("post", "/api/checklists"), ("get", "/api/checklists/{id}"),
        ("get", "/api/checklists/{id}/versions"), ("post", "/api/checklists/{id}/versions"),
        ("post", "/api/checklists/validate"), ("get", "/api/checklist-versions/{id}"),
        ("post", "/api/checklist-versions/{id}/activate"), ("post", "/api/evaluations"),
        ("get", "/api/jobs/{id}"), ("get", "/api/evaluations"),
        ("get", "/api/evaluations/{id}"), ("get", "/api/evaluations/compare"),
        ("post", "/api/appeals"), ("get", "/api/appeals"), ("get", "/api/appeals/{id}"),
        ("post", "/api/appeals/{id}/decision"), ("get", "/api/history"),
    }
    present = {(method, path) for path, item in document["paths"].items() for method in item}
    assert expected <= present
    for method, path in expected:
        operation = document["paths"][path][method]
        success = "202" if (method, path) == ("post", "/api/evaluations") else (
            "201" if (method, path) in {("post", "/api/checklists"), ("post", "/api/checklists/{id}/versions"),
                                        ("post", "/api/appeals")} else "200")
        assert "schema" in operation["responses"][success]["content"]["application/json"]


@pytest.mark.parametrize("payload", [
    {}, {"group_id": "TEST", "revision_ids": ["anything"]}, {"group_id": ""},
    {"revision_ids": []}, {"revision_ids": ["same", "same"]}, {"revision_ids": [""]},
    {"revision_ids": [str(i) for i in range(1001)]}, {"group_id": "TEST", "force": 1},
    {"group_id": "TEST", "unexpected": "sensitive-input-must-not-be-echoed"},
])
def test_evaluation_selector_and_request_shape_are_validated(client, payload):
    response = client.post("/api/evaluations", json=payload)
    error(response, 422, "VALIDATION_ERROR")
    assert "sensitive-input-must-not-be-echoed" not in response.text


@pytest.mark.parametrize("method,path,status", [
    ("get", "/api/does-not-exist", 404), ("put", "/api/health", 405),
    ("get", "/api/conversations/missing", 404), ("get", "/api/jobs/missing", 404),
    ("get", "/api/appeals/missing", 404), ("get", "/api/evaluations/missing", 404),
    ("get", "/api/checklists/missing", 404), ("get", "/api/checklist-versions/missing", 404),
    ("get", "/api/conversations?limit=0", 422), ("get", "/api/history?offset=-1", 422),
])
def test_errors_have_the_shared_safe_envelope(client, method, path, status):
    error(client.request(method, path), status)


def test_unknown_group_and_revision_are_not_found(client):
    error(client.post("/api/evaluations", json={"group_id": "MISSING"}), 404, "NOT_FOUND")
    error(client.post("/api/evaluations", json={"revision_ids": ["missing"]}), 404, "NOT_FOUND")


def test_group_evaluation_includes_all_conversations_above_explicit_revision_limit(client, api, synthetic_record, monkeypatch):
    records = [{**synthetic_record, "conversation_id": f"large-group-{index:04d}"} for index in range(1001)]
    assert data(upload(client, records, group="LARGE"))["created"] == 1001
    monkeypatch.setattr(api.state.runner, "submit", lambda job_id: None)
    job = data(client.post("/api/evaluations", json={"group_id": "LARGE"}), 202, schemas.Job)
    assert job["total"] == len(job["items"]) == 1001
    assert len({item["revision_id"] for item in job["items"]}) == 1001


def test_scale_normalization_defaults_are_persisted_but_explicit_values_are_kept(client):
    definition = {
        "name": "Шкала", "description": "Пользовательская проверка", "criteria": [{
            "id": "custom-scale", "name": "Динамическое правило", "description": "Оценить понятность объяснения.",
            "section": "", "answer_type": "scale", "weight": 10, "na_allowed": False, "na_condition": None,
            "options": [{"value": 0, "label": "нет", "description": "Нет объяснения"},
                        {"value": 5, "label": "частично", "description": "Частично", "normalized": None},
                        {"value": 10, "label": "да", "description": "Полностью", "normalized": 0.9}],
        }],
    }
    assert data(client.post("/api/checklists/validate", json=definition))["valid"]
    saved = data(client.post("/api/checklists", json=definition), 201, schemas.ChecklistVersion)
    assert [o["normalized"] for o in saved["definition"]["criteria"][0]["options"]] == [0, 0.5, 0.9]
    assert data(client.get(f"/api/checklist-versions/{saved['id']}"))["definition"] == saved["definition"]
    definition["criteria"][0]["options"] = [{"value": 0, "label": "ноль", "description": "Ноль"}]
    invalid = data(client.post("/api/checklists/validate", json=definition), model=schemas.ValidationReport)
    assert not invalid["valid"] and invalid["errors"]
    error(client.post("/api/checklists", json=definition), 422, "VALIDATION_ERROR")


def test_validation_distinguishes_semantic_errors_and_wrong_json_types(client):
    definition = active_version(client)["definition"]
    invalid = deepcopy(definition)
    invalid["criteria"][0]["weight"] = -1
    assert not data(client.post("/api/checklists/validate", json=invalid))["valid"]
    error(client.post("/api/checklists", json=invalid), 422)
    invalid["criteria"][0]["weight"] = True
    error(client.post("/api/checklists/validate", json=invalid), 422)
    invalid["criteria"][0]["weight"] = "10"
    error(client.post("/api/checklists/validate", json=invalid), 422)


def test_version_activation_conflict_rolls_back_creation(client):
    initial = active_version(client)
    path = f"/api/checklists/{initial['checklist_id']}/versions"
    request = {**initial["definition"], "expected_latest_version_id": initial["id"], "activate": True}
    error(client.post(path, json=request), 422)
    error(client.post(path, json={**request, "expected_active_version_id": "stale"}), 409, "VERSION_CONFLICT")
    assert data(client.get(path))["total"] == 1
    assert active_version(client)["id"] == initial["id"]
    created = data(client.post(path, json={**request, "expected_active_version_id": initial["id"]}), 201)
    assert created["version"] == 2 and created["is_active"]
    error(client.post(path, json={**request, "expected_active_version_id": created["id"]}), 409)
    assert data(client.get(path))["total"] == 2


def test_concurrent_version_writers_have_one_winner(client):
    initial = active_version(client)
    path = f"/api/checklists/{initial['checklist_id']}/versions"
    request = {**initial["definition"], "expected_latest_version_id": initial["id"],
               "activate": True, "expected_active_version_id": initial["id"]}
    barrier = Barrier(2)

    def write():
        barrier.wait(timeout=3)
        return client.post(path, json=request)

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: write(), range(2)))
    assert sorted(r.status_code for r in responses) == [201, 409]
    assert data(client.get(path))["total"] == 2
    assert active_version(client)["version"] == 2


def test_group_selects_current_revisions_and_freezes_them_at_enqueue(client, api, dataset, monkeypatch):
    data(upload(client, dataset))
    first = data(client.get("/api/conversations"))["items"][0]
    submitted = []
    monkeypatch.setattr(api.state.runner, "submit", submitted.append)
    job = data(client.post("/api/evaluations", json={"group_id": "TEST"}), 202)
    dataset["data"]["records"][0]["transcript"][0]["text"] = "Изменённый учебный запрос."
    assert data(upload(client, dataset))["revised"] == 1
    current = data(client.get("/api/conversations"))["items"][0]
    assert current["ref"]["revision_id"] != first["ref"]["revision_id"]
    assert submitted == [job["id"]]
    assert job["items"][0]["revision_id"] == first["ref"]["revision_id"]
    api.state.runner.run(job["id"])
    completed = finish(client, job)
    result = data(client.get(f"/api/evaluations/{completed['items'][0]['evaluation_id']}"))
    assert result["conversation"]["revision_id"] == first["ref"]["revision_id"]
    next_job = data(client.post("/api/evaluations", json={"group_id": "TEST"}), 202)
    assert next_job["items"][0]["revision_id"] == current["ref"]["revision_id"]


def test_import_is_tolerant_idempotent_and_keeps_old_revisions(client, dataset):
    record = dataset["data"]["records"][0]
    record.pop("audio_url")
    record["language"] = "NEW_LANGUAGE"
    record["channel"] = "NEW_CHANNEL"
    record["transcript"].append({"timestamp": "unknown", "speaker": "new_role", "text": "Учебная реплика"})
    record["transcript"].append({"timestamp": "00:10", "speaker": "system", "text": "Неизвестное учебное событие"})
    dataset["data"]["records"].append({"conversation_id": "broken"})
    dataset["data"]["total_records"] = 2
    report = data(upload(client, dataset))
    assert (report["received"], report["created"], report["skipped"]) == (2, 1, 1)
    assert {w["code"] for w in report["warnings"]} >= {"UNKNOWN_ROLE", "UNKNOWN_CHANNEL", "UNKNOWN_LANGUAGE", "UNPARSEABLE_TIMESTAMP"}
    assert report["unknown_system_phrases"] == [{"text": "Неизвестное учебное событие", "count": 1}]
    original = data(client.get("/api/conversations"))["items"][0]["ref"]
    old = data(client.get(f"/api/conversations/{original['id']}"))
    assert old["audio_url"] is None and old["transcript"][4]["offset_sec"] is None
    assert old["transcript"][4]["speaker"] == "new_role"
    assert data(upload(client, dataset))["unchanged"] == 1
    dataset["data"]["records"][0]["transcript"][0]["text"] += " Дополнение."
    assert data(upload(client, dataset))["revised"] == 1
    assert data(client.get(f"/api/conversations/{original['id']}", params={"revision_id": original["revision_id"]})) == old
    versions = data(client.get(f"/api/conversations/{original['id']}/revisions"))["items"]
    assert [v["ref"]["revision"] for v in versions] == [2, 1]


def test_same_external_id_in_two_groups_is_independent_and_bad_envelopes_are_safe(client, dataset):
    data(upload(client, dataset))
    error(upload(client, dataset, group="OTHER"), 409, "GROUP_MISMATCH")
    data(upload(client, dataset["data"]["records"], group="OTHER"))
    conversations = data(client.get("/api/conversations"))["items"]
    assert len(conversations) == 2 and len({c["ref"]["id"] for c in conversations}) == 2
    assert {c["ref"]["group_id"] for c in conversations} == {"TEST", "OTHER"}
    error(upload(client, dataset["data"]["records"]), 400)
    error(upload(client, {"isSuccess": False, "error": "private-error-marker", "data": None}), 400)
    invalid = client.post("/api/imports/file", files={"file": ("broken.json", b'{"private-error-marker":', "application/json")})
    error(invalid, 400, "INVALID_JSON")
    assert "private-error-marker" not in invalid.text


def test_dataset_import_uses_server_configuration_and_mocked_network(settings, dataset, monkeypatch):
    from app import imports
    from app.main import create_app

    requested = []

    def fake_urlopen(request, timeout):
        requested.append((request.full_url, timeout))
        return io.BytesIO(json.dumps(dataset).encode("utf-8"))

    monkeypatch.setattr(imports, "urlopen", fake_urlopen)
    configured = replace(settings, dataset_url="https://example.invalid/invoke?api-version=1&group_id=OLD")
    with TestClient(create_app(configured)) as client:
        assert data(client.get("/api/health"))["dataset_ready"]
        assert data(client.post("/api/imports/dataset", json={"group_id": "TEST"}))["created"] == 1
        assert parse_qs(urlsplit(requested[0][0]).query) == {"api-version": ["1"], "group_id": ["TEST"]}
        assert requested[0][1] == settings.dataset_timeout


def test_dataset_and_real_provider_without_configuration_fail_explicitly(client, settings, dataset):
    from app.main import create_app

    error(client.post("/api/imports/dataset", json={"group_id": "TEST"}), 503, "DATASET_NOT_CONFIGURED")
    configured = replace(settings, database_path=settings.database_path.parent / "real.db", llm_provider="openai")
    with TestClient(create_app(configured)) as real_client:
        health = data(real_client.get("/api/health"))
        assert not health["is_demo"] and not health["evaluation_ready"] and health["provider"] == "openai"
        data(upload(real_client, dataset))
        error(real_client.post("/api/evaluations", json={"group_id": "TEST"}), 503, "PROVIDER_NOT_CONFIGURED")
        assert data(real_client.get("/api/checklists"))["total"] == 1


def test_cached_results_reuse_weights_but_replacement_calls_only_new_criterion(client, api, dataset):
    data(upload(client, dataset))
    initial = active_version(client)
    first = evaluate(client, group_id="TEST")
    assert first["usage"]["calls"] == 1
    changed = deepcopy(initial["definition"])
    changed["criteria"][0]["weight"] *= 2
    weighted = data(client.post(f"/api/checklists/{initial['checklist_id']}/versions", json={
        **changed, "expected_latest_version_id": initial["id"],
    }), 201)
    second = evaluate(client, group_id="TEST", checklist_version_id=weighted["id"])
    assert second["usage"]["calls"] == 0
    assert all(result["reused"] for result in second["original"]["criteria"])
    assert api.state.provider.calls == 1
    changed["criteria"][0]["id"] = "new-dynamic-rule"
    changed["criteria"][0]["description"] = "Проверить новое правило в учебном разговоре."
    replaced = data(client.post(f"/api/checklists/{initial['checklist_id']}/versions", json={
        **changed, "expected_latest_version_id": weighted["id"],
    }), 201)
    third = evaluate(client, group_id="TEST", checklist_version_id=replaced["id"])
    assert third["usage"]["calls"] == 1
    assert api.state.provider.requested_criteria[-1] == ["new-dynamic-rule"]
    assert not third["original"]["criteria"][0]["reused"]
    assert all(c["reused"] for c in third["original"]["criteria"][1:])
    assert data(client.get(f"/api/evaluations/{first['id']}"))["checklist_snapshot"] == initial["definition"]
    comparison = data(client.get("/api/evaluations/compare", params={"left_id": first["id"], "right_id": third["id"]}))
    by_id = {c["criterion_id"]: c for c in comparison["criteria"]}
    assert by_id["new-dynamic-rule"]["change"] == "added"
    assert by_id[initial["definition"]["criteria"][0]["id"]]["change"] == "removed"


def test_human_change_without_evidence_uses_reason_and_preserves_original(client, dataset):
    data(upload(client, dataset))
    original = evaluate(client, group_id="TEST")
    opened = appeal(client, original)
    request = {"action": "change", "reason": "Решение человека без цитаты.", "expected_final_revision": 0,
               "new_answer": {"status": "answered", "value": False}}
    result = data(client.post(f"/api/appeals/{opened['id']}/decision", json=request), model=schemas.AppealDecisionResult)
    final = result["evaluation"]
    after = result["appeal"]["decision"]["after"]
    assert after["rationale"] == request["reason"] and after["warnings"]
    assert after["evidence_message_ids"] == [] and after["checked_range"] is None
    assert final["original"] == original["original"] and final["final_revision"] == 1
    assert final["final"]["total"] < final["original"]["total"]
    error(client.post(f"/api/appeals/{opened['id']}/decision", json=request), 409, "APPEAL_ALREADY_RESOLVED")
    assert data(client.get(f"/api/evaluations/{original['id']}"))["final_revision"] == 1


def test_supplied_human_evidence_is_still_checked(client, dataset):
    data(upload(client, dataset))
    evaluated = evaluate(client, group_id="TEST")
    opened = appeal(client, evaluated)
    request = {"action": "change", "reason": "Проверка ссылки", "expected_final_revision": 0,
               "new_answer": {"status": "answered", "value": False}, "evidence_message_ids": [9999]}
    error(client.post(f"/api/appeals/{opened['id']}/decision", json=request), 422)
    assert data(client.get(f"/api/appeals/{opened['id']}"))["status"] == "open"
    assert data(client.get(f"/api/evaluations/{evaluated['id']}"))["final_revision"] == 0


def test_concurrent_appeal_decisions_detect_final_revision_conflict(client, dataset):
    data(upload(client, dataset))
    evaluated = evaluate(client, group_id="TEST")
    criteria = evaluated["checklist_snapshot"]["criteria"]
    appeals = [appeal(client, evaluated, criterion["id"]) for criterion in criteria[:2]]
    barrier = Barrier(2)

    def decide(item):
        barrier.wait(timeout=3)
        return client.post(f"/api/appeals/{item['id']}/decision", json={
            "action": "confirm", "reason": "Проверено", "expected_final_revision": 0,
        })

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(decide, appeals))
    assert sorted(r.status_code for r in responses) == [200, 409]
    error(next(r for r in responses if r.status_code == 409), 409, "VERSION_CONFLICT")
    assert data(client.get(f"/api/evaluations/{evaluated['id']}"))["final_revision"] == 1
    assert data(client.get("/api/appeals", params={"status": "open"}))["total"] == 1


def test_duplicate_open_appeal_is_rejected_and_can_be_reopened_after_resolution(client, dataset):
    data(upload(client, dataset))
    evaluated = evaluate(client, group_id="TEST")
    first = appeal(client, evaluated)
    payload = {"evaluation_id": evaluated["id"], "criterion_id": first["criterion_id"], "comment": "Повтор"}
    error(client.post("/api/appeals", json=payload), 409, "DUPLICATE_OPEN_APPEAL")
    data(client.post(f"/api/appeals/{first['id']}/decision", json={
        "action": "confirm", "reason": "Проверено", "expected_final_revision": 0,
    }))
    reopened = data(client.post("/api/appeals", json=payload), 201)
    assert reopened["id"] != first["id"] and reopened["opened_at_final_revision"] == 1


def test_batch_failure_retains_successful_items_and_never_leaks_provider_error(client, api, dataset, monkeypatch):
    failing = deepcopy(dataset["data"]["records"][0])
    failing["conversation_id"] = "synthetic-002"
    failing["transcript"][0]["text"] = "FAIL_ITEM"
    dataset["data"]["records"].append(failing)
    dataset["data"]["total_records"] = 2
    data(upload(client, dataset))
    original_generate = api.state.provider.generate

    def generate(criteria, transcript, prompt, response_schema, errors=None):
        if any(m["text"] == "FAIL_ITEM" for m in transcript):
            raise RuntimeError("private-provider-error-marker")
        return original_generate(criteria, transcript, prompt, response_schema, errors)

    monkeypatch.setattr(api.state.provider, "generate", generate)
    job = finish(client, data(client.post("/api/evaluations", json={"group_id": "TEST"}), 202))
    assert job["status"] == "failed"
    assert (job["total"], job["processed"], job["succeeded"], job["failed"], job["progress_percent"]) == (2, 2, 1, 1, 100)
    assert "private-provider-error-marker" not in json.dumps(job)
    assert len([item for item in job["items"] if item["evaluation_id"]]) == 1
    assert data(client.get("/api/evaluations"))["total"] == 1


def test_restart_preserves_history_evaluations_seed_and_active_choice(settings, dataset):
    from app.main import create_app

    with TestClient(create_app(settings)) as client:
        initial = active_version(client)
        created = data(client.post("/api/checklists", json={**initial["definition"], "name": "Сохранить выбор"}), 201)
        data(client.post(f"/api/checklist-versions/{created['id']}/activate", json={"expected_active_version_id": initial["id"]}))
        data(upload(client, dataset))
        evaluated = evaluate(client, group_id="TEST")
        opened = appeal(client, evaluated)
        history = data(client.get("/api/history", params={"limit": 100}))
    with TestClient(create_app(settings)) as client:
        assert active_version(client)["id"] == created["id"]
        assert data(client.get("/api/checklists"))["total"] == 2
        assert data(client.get(f"/api/evaluations/{evaluated['id']}")) == evaluated
        assert data(client.get(f"/api/appeals/{opened['id']}")) == opened
        assert data(client.get("/api/history", params={"limit": 100})) == history


def test_restart_marks_only_unfinished_items_failed(settings, dataset):
    from app.main import create_app

    app = create_app(settings)
    with TestClient(app) as client:
        data(upload(client, dataset))
        evaluated = evaluate(client, group_id="TEST")
        revision_id = evaluated["conversation"]["revision_id"]
        interrupted_id = str(uuid4())
        with app.state.store.transaction() as tx:
            completed = next(job for job in tx.all("jobs") if job["status"] == "completed")
            interrupted = deepcopy(completed)
            interrupted.update(id=interrupted_id, status="running", total=2, processed=1, succeeded=1, failed=0,
                               progress_percent=50, finished_at=None)
            interrupted["items"].append({"revision_id": revision_id, "status": "queued", "evaluation_id": None, "error": None})
            tx.put("jobs", interrupted_id, interrupted)
    with TestClient(create_app(settings)) as client:
        recovered = data(client.get(f"/api/jobs/{interrupted_id}"), model=schemas.Job)
        assert recovered["status"] == "failed" and recovered["processed"] == 2
        assert recovered["succeeded"] == recovered["failed"] == 1
        assert recovered["error"]["code"] == "INTERRUPTED_BY_RESTART"
        assert recovered["items"][0]["evaluation_id"] == evaluated["id"]
        assert recovered["items"][0]["status"] == "completed"
        assert recovered["items"][1]["error"]["code"] == "INTERRUPTED_BY_RESTART"


def test_filters_pagination_and_history_do_not_expose_transcript(client, dataset):
    for index, language in enumerate(("RU", "KZ", "EN")):
        record = deepcopy(dataset["data"]["records"][0])
        record.update(conversation_id=f"item-{index}", language=language)
        record["transcript"][0]["text"] = "private-transcript-marker"
        data(upload(client, [record], group="FILTER"))
    subset = data(client.get("/api/conversations", params={"group_id": "FILTER", "language": "KZ", "q": "item-"}))
    assert subset["total"] == 1 and subset["items"][0]["language"] == "KZ"
    page = data(client.get("/api/conversations", params={"group_id": "FILTER", "limit": 1, "offset": 1}))
    assert (page["total"], page["limit"], page["offset"]) == (3, 1, 1)
    assert page["items"][0]["ref"]["conversation_id"] == "item-1"
    assert "private-transcript-marker" not in client.get("/api/history").text
    assert data(client.get("/api/conversations", params={"evaluation_status": "not_evaluated"}))["total"] == 3
