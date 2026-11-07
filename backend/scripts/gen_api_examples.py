"""Generate API examples from real requests against an isolated FakeLLM application.

Run from backend/: python scripts/gen_api_examples.py
Only synthetic conversations are used. The application's persistent database is untouched.
"""
from __future__ import annotations

import argparse
from copy import deepcopy
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.run_batch import wait_job  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]


def synthetic_dataset(group: str = "SYNTHETIC") -> dict:
    records = [
        {"conversation_id": "demo-ru", "channel": "agent chat", "language": "RU", "audio_url": None,
         "transcript": [
             {"timestamp": "00:00", "speaker": "client", "text": "Здравствуйте! Как открыть демонстрационный счёт?"},
             {"timestamp": "00:03", "speaker": "operator", "text": "Здравствуйте! Я Демо. Выберите раздел демонстрационного счёта."},
             {"timestamp": "00:10", "speaker": "client", "text": "Спасибо, раздел найден."},
             {"timestamp": "00:12", "speaker": "operator", "text": "Рад помочь. До свидания!"},
         ]},
        {"conversation_id": "demo-en", "channel": "agent chat", "language": "EN", "audio_url": None,
         "transcript": [
             {"timestamp": "00:00", "speaker": "client", "text": "Hello, where is the demo account?"},
             {"timestamp": "00:02", "speaker": "operator", "text": "Hello, I am Demo. Please open the demo account section."},
             {"timestamp": "00:08", "speaker": "client", "text": "Thank you."},
             {"timestamp": "00:10", "speaker": "operator", "text": "You are welcome. Goodbye!"},
         ]},
    ]
    return {"isSuccess": True, "error": "", "data": {
        "dataset_group_id": group, "total_records": len(records), "records": records}}


def collect_examples() -> tuple[dict[str, dict], dict]:
    """Return HTTP response bodies and OpenAPI without writing output files."""
    from fastapi.testclient import TestClient
    from app.config import Settings
    from app.main import create_app

    examples: dict[str, dict] = {}
    with TemporaryDirectory(prefix="cqa-api-examples-") as directory:
        settings = Settings(database_path=Path(directory) / "examples.db", llm_provider="fake")
        app = create_app(settings=settings)
        with TestClient(app) as client:
            def capture(name, method, path, expected=200, **kwargs):
                response = client.request(method, path, **kwargs)
                if response.status_code != expected:
                    raise RuntimeError(f"Example {name} returned HTTP {response.status_code}, expected {expected}")
                body = response.json()
                examples[name] = body
                return body.get("data")

            health = capture("health", "GET", "/api/health")
            active_id = health["active_checklist_version_id"]
            seed = capture("seed_version", "GET", f"/api/checklist-versions/{active_id}")
            capture("checklists", "GET", "/api/checklists")
            raw = json.dumps(synthetic_dataset(), ensure_ascii=False).encode("utf-8")
            capture("import_file", "POST", "/api/imports/file",
                    files={"file": ("synthetic.json", raw, "application/json")})
            with patch("app.imports.fetch_dataset", return_value=synthetic_dataset("SYNTHETIC_REMOTE")):
                capture("import_dataset", "POST", "/api/imports/dataset", json={"group_id": "SYNTHETIC_REMOTE"})
            conversations = capture("conversations", "GET", "/api/conversations", params={"group_id": "SYNTHETIC"})
            ref = conversations["items"][0]["ref"]
            capture("conversation", "GET", f"/api/conversations/{ref['id']}", params={"revision_id": ref["revision_id"]})
            capture("conversation_revisions", "GET", f"/api/conversations/{ref['id']}/revisions")

            definition = deepcopy(seed["definition"])
            definition["name"] = "Демонстрационный чек-лист редактора"
            for criterion in definition["criteria"]:
                if criterion["answer_type"] == "scale":
                    for option in criterion["options"]:
                        option.pop("normalized", None)
            capture("checklist_validation", "POST", "/api/checklists/validate", json=definition)
            created = capture("checklist_created", "POST", "/api/checklists", expected=201, json=definition)
            checklist_id = created["checklist_id"]
            definition["criteria"][0]["weight"] += 1
            next_version = capture("checklist_version_created", "POST", f"/api/checklists/{checklist_id}/versions", expected=201,
                                   json={**definition, "expected_latest_version_id": created["id"], "activate": True,
                                         "expected_active_version_id": active_id})
            capture("checklist", "GET", f"/api/checklists/{checklist_id}")
            capture("checklist_versions", "GET", f"/api/checklists/{checklist_id}/versions")
            capture("checklist_version", "GET", f"/api/checklist-versions/{next_version['id']}")
            capture("checklist_activation", "POST", f"/api/checklist-versions/{active_id}/activate",
                    json={"expected_active_version_id": next_version["id"]})

            queued = capture("evaluation_started", "POST", "/api/evaluations", expected=202, json={"group_id": "SYNTHETIC"})
            wait_job(client, queued["id"], timeout=30, poll_interval=0.01)
            job = capture("job_completed", "GET", f"/api/jobs/{queued['id']}")
            if job["status"] != "completed":
                raise RuntimeError("Synthetic FakeLLM job did not complete successfully")
            evaluation_id = next(item["evaluation_id"] for item in job["items"] if item["revision_id"] == ref["revision_id"])
            evaluation = capture("evaluation", "GET", f"/api/evaluations/{evaluation_id}")
            capture("evaluations", "GET", "/api/evaluations", params={"revision_id": ref["revision_id"]})
            again = capture("reevaluation_started", "POST", "/api/evaluations", expected=202,
                            json={"revision_ids": [ref["revision_id"]], "checklist_version_id": next_version["id"]})
            comparison_job = wait_job(client, again["id"], timeout=30, poll_interval=0.01)
            comparison_id = comparison_job["items"][0]["evaluation_id"]
            capture("evaluation_comparison", "GET", "/api/evaluations/compare",
                    params={"left_id": evaluation_id, "right_id": comparison_id})

            appeal = capture("appeal_created", "POST", "/api/appeals", expected=201, json={
                "evaluation_id": evaluation_id, "criterion_id": evaluation["original"]["criteria"][0]["criterion_id"],
                "comment": "Синтетическая апелляция для демонстрации интерфейса."})
            capture("appeals", "GET", "/api/appeals", params={"evaluation_id": evaluation_id})
            capture("appeal", "GET", f"/api/appeals/{appeal['id']}")
            capture("appeal_decision", "POST", f"/api/appeals/{appeal['id']}/decision", json={
                "action": "change", "reason": "Синтетическое решение проверяющего без дополнительных ссылок.",
                "expected_final_revision": 0, "new_answer": {"status": "answered", "value": False}})
            capture("history", "GET", "/api/history", params={"evaluation_id": evaluation_id})
            capture("validation_error", "POST", "/api/evaluations", expected=422,
                    json={"group_id": "SYNTHETIC", "revision_ids": [ref["revision_id"]]})
            capture("version_conflict", "POST", f"/api/checklists/{checklist_id}/versions", expected=409,
                    json={**definition, "expected_latest_version_id": created["id"]})
            openapi = client.get("/openapi.json").json()
    return examples, openapi


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "docs/examples")
    parser.add_argument("--openapi", type=Path, default=ROOT / "docs/openapi.json")
    args = parser.parse_args(argv)
    try:
        examples, openapi = collect_examples()
        args.output.mkdir(parents=True, exist_ok=True)
        for name, body in examples.items():
            (args.output / f"{name}.json").write_text(json.dumps(body, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        args.openapi.parent.mkdir(parents=True, exist_ok=True)
        args.openapi.write_text(json.dumps(openapi, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"Generated {len(examples)} synthetic API response examples and OpenAPI.")
        return 0
    except (OSError, RuntimeError, ValueError):
        print("Example generation failed; output is not ready. Check the API tests.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())
