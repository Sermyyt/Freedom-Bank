"""Import an altered local DEV as a new group and rehearse a batch on a running API.

Run from backend/: python scripts/rehearse_control.py
The source file stays unchanged. Only aggregate statistics are printed.
"""
from __future__ import annotations

import argparse
from copy import deepcopy
import json
import math
from pathlib import Path
import sys
from uuid import uuid4

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.run_batch import DEFAULT_TIMEOUT, BatchError, request_data, run_group  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]


def _records(payload: dict | list) -> list:
    if isinstance(payload, list):
        return payload
    if not isinstance(payload, dict) or payload.get("isSuccess") is not True:
        raise ValueError("Expected an organizer envelope or records array")
    data = payload.get("data")
    if not isinstance(data, dict) or not isinstance(data.get("records"), list):
        raise ValueError("Expected an organizer records array")
    return data["records"]


def _has_id(record) -> bool:
    return isinstance(record, dict) and isinstance(record.get("conversation_id"), str)


def _usable_record(record) -> bool:
    return _has_id(record) and isinstance(record.get("transcript"), list) and bool(record["transcript"])


def altered_dataset(payload: dict | list, group: str) -> list:
    records = deepcopy(_records(payload))
    first = next((record for record in records if _usable_record(record)), None)
    if first is None:
        raise ValueError("No usable records for rehearsal")
    for index, record in enumerate(records):
        if _has_id(record):
            record["conversation_id"] = f"{group}-{index + 1}"
    first.pop("audio_url", None)
    first["transcript"].append({"timestamp": "1:02:03", "speaker": "system",
                                   "text": "Synthetic control rehearsal: a previously unknown system event."})
    records.append({"conversation_id": f"{group}-malformed", "channel": "agent chat", "language": "RU",
                    "transcript": [{"timestamp": "00:01", "text": "Synthetic malformed message without speaker."}]})
    return records


def rehearse(client, payload: dict | list, *, group: str | None = None, timeout: float = DEFAULT_TIMEOUT,
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
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT, help="Maximum polling time in seconds (default: 2400)")
    args = parser.parse_args(argv)
    if not math.isfinite(args.timeout) or args.timeout <= 0:
        parser.error("timeout must be finite and positive")
    try:
        payload = json.loads(args.file.read_text(encoding="utf-8-sig"))
        with httpx.Client(base_url=args.api_url, timeout=60) as client:
            result = rehearse(client, payload, timeout=args.timeout)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["evaluation"]["failed"] == 0 else 1
    except (OSError, ValueError, BatchError, httpx.InvalidURL):
        print("Rehearsal failed: check local JSON, API availability and provider readiness. "
              "If a job ID was printed, resume with run_batch.py --job-id; do not import another rehearsal. "
              "Source content omitted.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())
