"""Malformed source strings and numeric bounds fail before persistent work."""
from copy import deepcopy
import json
import math

import pytest

from app.checklist_validation import normalize_definition
from app.scoring import score


def upload(client, records, group="SYNTHETIC"):
    # An escaped surrogate is valid JSON syntax but cannot be preserved as UTF-8.
    payload = {"isSuccess": True, "data": {"dataset_group_id": group,
               "total_records": len(records), "records": records}}
    return client.post("/api/imports/file", files={
        "file": ("synthetic.json", json.dumps(payload, ensure_ascii=True).encode(), "application/json")})


@pytest.mark.parametrize("path", [
    ("conversation_id",), ("channel",), ("language",), ("audio_url",),
    ("transcript", 1, "text"), ("transcript", 1, "speaker"), ("transcript", 1, "timestamp"),
])
def test_invalid_unicode_rejects_only_its_record(client, synthetic_record, path):
    damaged = deepcopy(synthetic_record)
    damaged["conversation_id"] = "damaged"
    target = damaged
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = "\ud800"
    response = upload(client, [damaged, synthetic_record])
    assert response.status_code == 200
    report = response.json()["data"]
    assert (report["received"], report["created"], report["skipped"]) == (2, 1, 1)
    assert report["errors"][0]["path"] == list(path)
    assert report["errors"][0]["record_index"] == 0
    if path == ("conversation_id",):
        assert report["errors"][0]["conversation_id"] is None
    item = client.get("/api/conversations").json()["data"]["items"][0]
    detail = client.get(f"/api/conversations/{item['ref']['id']}").json()["data"]
    assert [(m["id"], m["text"]) for m in detail["transcript"]] == [
        (i, m["text"]) for i, m in enumerate(synthetic_record["transcript"], 1)]


def test_invalid_unicode_group_returns_safe_dataset_error(client, synthetic_record):
    response = upload(client, [synthetic_record], group="\udfff")
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "INVALID_DATASET"
    assert client.get("/api/conversations").json()["data"]["total"] == 0


def test_repeated_invalid_unicode_id_does_not_poison_duplicate_report(client, synthetic_record):
    damaged = deepcopy(synthetic_record)
    damaged["conversation_id"] = "\ud800"
    response = upload(client, [damaged, damaged, synthetic_record])
    assert response.status_code == 200
    report = response.json()["data"]
    assert (report["received"], report["created"], report["skipped"]) == (3, 1, 2)
    assert [error["record_index"] for error in report["errors"]] == [0, 1]
    assert all(error["conversation_id"] is None and error["code"] == "INVALID_RECORD"
               for error in report["errors"])
    assert client.get("/api/conversations").json()["data"]["total"] == 1


def test_valid_supplementary_unicode_is_preserved(client, synthetic_record):
    synthetic_record["transcript"][1]["text"] = "Сәлем 👋 — unchanged"
    assert upload(client, [synthetic_record]).json()["data"]["created"] == 1
    item = client.get("/api/conversations").json()["data"]["items"][0]
    detail = client.get(f"/api/conversations/{item['ref']['id']}").json()["data"]
    assert detail["transcript"][1]["text"] == synthetic_record["transcript"][1]["text"]


def huge_definition(client, weight):
    health = client.get("/api/health").json()["data"]
    active = client.get(f"/api/checklist-versions/{health['active_checklist_version_id']}").json()["data"]
    definition = deepcopy(active["definition"])
    for criterion in definition["criteria"]:
        if criterion["answer_type"] != "flag":
            criterion["weight"] = weight
    return active, definition


def test_aggregate_weight_overflow_cannot_create_or_activate_version(client):
    active, definition = huge_definition(client, 1e308)
    check = client.post("/api/checklists/validate", json=definition).json()["data"]
    assert check["valid"] is False
    assert any(e["path"] == ["body", "criteria"] for e in check["errors"])
    response = client.post(f"/api/checklists/{active['checklist_id']}/versions", json={
        **definition, "activate": True,
        "expected_latest_version_id": active["id"], "expected_active_version_id": active["id"]})
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "VALIDATION_ERROR"
    assert any(item["code"] == "INVALID_CHECKLIST" and item["path"] == ["body", "criteria"]
               for item in error["details"])
    assert client.get("/api/health").json()["data"]["active_checklist_version_id"] == active["id"]
    assert client.get(f"/api/checklists/{active['checklist_id']}/versions").json()["data"]["total"] == 1


def test_large_representable_weight_sum_remains_supported(client):
    _, definition = huge_definition(client, 1e306)
    normalized, errors, _ = normalize_definition(definition)
    assert errors == []
    results = [{"criterion_id": c["id"], "answer": {"status": "answered", "value":
                False if c["answer_type"] == "flag" else max(c["options"], key=lambda o:o["normalized"])["value"]}}
               for c in normalized["criteria"]]
    snapshot = score(normalized, results, {"rounding": "half_up", "decimals": 2, "gross_error_zeroes_total": False})
    assert snapshot["total"] == 100
    assert math.isfinite(snapshot["applicable_weight"])
    json.dumps(snapshot, allow_nan=False)
