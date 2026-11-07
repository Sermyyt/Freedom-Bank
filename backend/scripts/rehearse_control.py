"""Import an altered local DEV as a new group and rehearse a batch on a running API.

Run from backend/: python scripts/rehearse_control.py
The source file stays unchanged. Only aggregate statistics are printed.
"""
from __future__ import annotations

import argparse
from copy import deepcopy
import json
from pathlib import Path
import sys
from uuid import uuid4

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.run_batch import BatchError, request_data, run_group  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]


def altered_dataset(payload: dict | list, group: str) -> list:
    if isinstance(payload, list):
        source = payload
    elif (isinstance(payload, dict) and payload.get("isSuccess") is True
          and isinstance(payload.get("data"), dict) and isinstance(payload["data"].get("records"), list)):
        source = payload["data"]["records"]
    else:
        raise ValueError("Expected an organizer envelope or records array")
    records = deepcopy(source)
    valid = [r for r in records if isinstance(r, dict) and isinstance(r.get("conversation_id"), str)
             and isinstance(r.get("transcript"), list) and r["transcript"]]
    if not valid:
        raise ValueError("No usable records for rehearsal")
    for index, record in enumerate(records):
        if isinstance(record, dict) and isinstance(record.get("conversation_id"), str):
            record["conversation_id"] = f"{group}-{index + 1}"
    valid[0].pop("audio_url", None)
    valid[0]["transcript"].append({"timestamp": "1:02:03", "speaker": "system",
                                   "text": "Synthetic control rehearsal: a previously unknown system event."})
    records.append({"conversation_id": f"{group}-malformed", "channel": "agent chat", "language": "RU",
                    "transcript": [{"timestamp": "00:01", "text": "Synthetic malformed message without speaker."}]})
    return records


def rehearse(client, payload: dict | list, *, group: str | None = None, timeout: float = 600,
             poll_interval: float = 1) -> dict:
    group = group or "REHEARSAL_" + uuid4().hex[:12]
    records = altered_dataset(payload, group)
    raw = json.dumps(records, ensure_ascii=False).encode("utf-8")
    imported = request_data(client, "POST", "/api/imports/file", data={"group_id": group},
                            files={"file": ("rehearsal.json", raw, "application/json")})
    batch = run_group(client, group, timeout=timeout, poll_interval=poll_interval)
    return {
        "group_id": group,
        "import": {key: imported[key] for key in ("received", "created", "unchanged", "revised", "skipped")},
        "import_error_count": len(imported["errors"]), "import_warning_count": len(imported["warnings"]),
        "unknown_system_phrase_count": len(imported["unknown_system_phrases"]),
        "evaluation": batch,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", type=Path, default=ROOT / "data/raw/DEV.json")
    parser.add_argument("--api-url", default="http://127.0.0.1:8000")
    parser.add_argument("--timeout", type=float, default=600)
    args = parser.parse_args(argv)
    if args.timeout <= 0:
        parser.error("timeout must be positive")
    try:
        payload = json.loads(args.file.read_text(encoding="utf-8-sig"))
        with httpx.Client(base_url=args.api_url, timeout=60) as client:
            result = rehearse(client, payload, timeout=args.timeout)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["evaluation"]["failed"] == 0 else 1
    except (OSError, ValueError, BatchError, httpx.InvalidURL):
        print("Rehearsal failed: check local JSON, API availability and provider readiness. Source content omitted.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())
