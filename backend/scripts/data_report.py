"""Read-only dataset audit. Full reports belong in ignored data/, never in Git.

Run from backend/: python scripts/data_report.py --file ../data/raw/DEV.json
--group selects an already downloaded local data/raw/<group>.json (no network).
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime
import json
from pathlib import Path
import re
import sys
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
EVENTS_FILE = ROOT / "backend/app/data/system_events.json"
KNOWN = {"speaker": {"client", "operator", "bot", "system"},
         "channel": {"agent chat", "voice call"}, "language": {"RU", "KZ", "EN"}}


def normalize(text: str) -> str:
    return " ".join(text.strip().lower().split()).removesuffix(".")


def event_code(text: str, definitions: dict) -> str:
    normalized = normalize(text)
    for code, phrases in definitions["exact"].items():
        if any(normalized == normalize(phrase) for phrase in phrases):
            return code
    for code, phrases in definitions["prefix"].items():
        if any(normalized.startswith(normalize(phrase)) for phrase in phrases):
            return code
    return "unknown"


def time_format(value: str) -> str:
    if re.fullmatch(r"\d{2,}:[0-5]\d", value):
        return "MM:SS"
    if re.fullmatch(r"\d+:[0-5]\d:[0-5]\d", value):
        return "H:MM:SS"
    if "T" in value:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.utcoffset() is not None:
                return "ISO8601_TZ"
        except ValueError:
            pass
    return "unknown"


def safe_text(text: str) -> str:
    # Never include any URL, including signed links embedded in a system event.
    return re.sub(r"https?://\S+", "[URL omitted]", text, flags=re.IGNORECASE)


def unpack(payload: Any, group_id: str | None) -> tuple[str, list, int | None]:
    if isinstance(payload, list):
        return group_id or "UNSPECIFIED", payload, None
    if not isinstance(payload, dict) or payload.get("isSuccess") is not True:
        raise ValueError("Expected a successful organizer envelope or records array.")
    data = payload.get("data")
    if not isinstance(data, dict) or not isinstance(data.get("records"), list):
        raise ValueError("Missing data.records array.")
    source_group = data.get("dataset_group_id")
    if not isinstance(source_group, str) or not source_group.strip():
        raise ValueError("Missing dataset_group_id.")
    if group_id is not None and source_group != group_id:
        raise ValueError("Requested group differs from the dataset group.")
    declared = data.get("total_records")
    if declared is not None and (type(declared) is not int or declared < 0):
        raise ValueError("Invalid total_records.")
    return source_group, data["records"], declared


def valid_record(record: Any) -> bool:
    if not isinstance(record, dict):
        return False
    if any(not isinstance(record.get(k), str) or not record[k].strip()
           for k in ("conversation_id", "channel", "language")):
        return False
    if record.get("audio_url") is not None and not isinstance(record["audio_url"], str):
        return False
    messages = record.get("transcript")
    return isinstance(messages, list) and all(
        isinstance(m, dict) and all(isinstance(m.get(k), str) for k in ("timestamp", "speaker", "text"))
        and bool(m["speaker"].strip()) for m in messages)


def build_report(payload: Any, group_id: str | None = None) -> dict:
    group, records, declared = unpack(payload, group_id)
    definitions = json.loads(EVENTS_FILE.read_text(encoding="utf-8"))
    roles, channels, languages, channel_languages = Counter(), Counter(), Counter(), Counter()
    formats, formats_by_channel, events, phrases = Counter(), Counter(), Counter(), Counter()
    record_fields, message_fields, audio = Counter(), Counter(), Counter()
    unknown = {k: Counter() for k in KNOWN}
    invalid, warnings, duplicates, after_end, no_end, summaries = [], [], [], [], [], []
    seen_ids: set[str] = set()
    empty = longest = characters = masked = 0
    for index, record in enumerate(records, start=1):
        if not valid_record(record):
            invalid.append({"record_index": index, "code": "invalid_record"})
            continue
        cid, channel, language = (record[k] for k in ("conversation_id", "channel", "language"))
        if cid in seen_ids:
            warnings.append({"record_index": index, "code": "duplicate_conversation_id"})
        seen_ids.add(cid)
        record_fields[tuple(sorted(record))] += 1
        channels[channel] += 1
        languages[language] += 1
        channel_languages[(channel, language)] += 1
        for k in ("channel", "language"):
            if record[k] not in KNOWN[k]:
                unknown[k][record[k]] += 1
        if "audio_url" not in record:
            audio[(channel, "missing")] += 1
        elif record["audio_url"] is None:
            audio[(channel, "null")] += 1
        elif record["audio_url"]:
            audio[(channel, "present")] += 1
        else:
            audio[(channel, "empty")] += 1
        messages, end_at, previous, text_length = record["transcript"], None, None, 0
        after_ids = []
        for mid, message in enumerate(messages, start=1):
            role, text = message["speaker"], message["text"]
            roles[role] += 1
            if role not in KNOWN["speaker"]:
                unknown["speaker"][role] += 1
            message_fields[tuple(sorted(message))] += 1
            fmt = time_format(message["timestamp"])
            formats[fmt] += 1
            formats_by_channel[(channel, fmt)] += 1
            empty += not text.strip()
            longest = max(longest, len(text))
            text_length += len(text)
            masked += any(mask in text for mask in ("[Имя скрыто]", "[Персональные данные скрыты]"))
            if previous is not None and (role, text) == (previous["speaker"], previous["text"]):
                duplicates.append({"conversation_id": cid, "record_index": index,
                                   "message_id": mid, "duplicate_of": mid - 1})
            if end_at is not None:
                after_ids.append(mid)
            if role == "system":
                code = event_code(text, definitions)
                events[code] += 1
                phrases[(text, code)] += 1
                if code in definitions["ending_codes"] and end_at is None:
                    end_at = mid
            previous = message
        if end_at is None:
            no_end.append({"conversation_id": cid, "channel": channel, "record_index": index})
        if after_ids:
            after_end.append({"conversation_id": cid, "record_index": index,
                              "end_message_id": end_at, "message_ids": after_ids})
        characters += text_length
        summaries.append({"conversation_id": cid, "record_index": index, "channel": channel,
                          "message_count": len(messages), "text_characters": text_length})
    lengths = [c["message_count"] for c in summaries]
    system_phrases = [{"text": safe_text(t), "code": c, "count": count}
                      for (t, c), count in sorted(phrases.items())]
    report = {
        "group_id": group, "declared_records": declared, "received_records": len(records),
        "valid_records": len(summaries), "skipped_records": len(invalid), "errors": invalid,
        "warnings": warnings, "roles": dict(sorted(roles.items())), "channels": dict(sorted(channels.items())),
        "languages": dict(sorted(languages.items())),
        "channel_languages": [{"channel": c, "language": l, "count": n} for (c, l), n in sorted(channel_languages.items())],
        "message_count": sum(roles.values()), "empty_texts": empty, "max_text_characters": longest,
        "text_characters": characters, "message_count_min": min(lengths, default=0),
        "message_count_max": max(lengths, default=0), "pii_masked_messages": masked,
        "time_formats": dict(sorted(formats.items())),
        "time_formats_by_channel": [{"channel": c, "format": f, "count": n} for (c, f), n in sorted(formats_by_channel.items())],
        "record_field_sets": [{"fields": list(f), "count": n} for f, n in sorted(record_fields.items())],
        "message_field_sets": [{"fields": list(f), "count": n} for f, n in sorted(message_fields.items())],
        "audio": [{"channel": c, "state": s, "count": n} for (c, s), n in sorted(audio.items())],
        "events": dict(sorted(events.items())), "distinct_system_phrases": len(phrases),
        "system_phrases": system_phrases,
        "unrecognized_system_phrases": [p for p in system_phrases if p["code"] == "unknown"],
        "unknown_values": {k: dict(sorted(v.items())) for k, v in unknown.items()},
        "duplicates": duplicates, "after_end": after_end, "without_end_event": no_end,
        "conversations": summaries,
    }
    if declared is not None and declared != len(records):
        warnings.append({"code": "declared_count_mismatch"})
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", type=Path)
    parser.add_argument("--group", help="Select local data/raw/<group>.json; verify envelope group")
    parser.add_argument("--output", type=Path, help="Full JSON audit; keep in ignored data/ directory")
    args = parser.parse_args(argv)
    if args.group and not re.fullmatch(r"[A-Za-z0-9_-]+", args.group):
        parser.error("Invalid group: use letters, digits, underscore or hyphen.")
    source = args.file or ROOT / "data/raw" / f"{args.group or 'DEV'}.json"
    try:
        payload = json.loads(source.read_text(encoding="utf-8-sig"))
        report = build_report(payload, args.group)
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            # Summary only: never print arbitrary transcript content by default.
            summary = {k: report[k] for k in ("received_records", "valid_records", "skipped_records", "message_count", "roles", "channels", "languages", "time_formats", "distinct_system_phrases")}
            summary.update(unknown_system_phrases=len(report["unrecognized_system_phrases"]),
                           duplicate_messages=len(report["duplicates"]), conversations_with_after_end=len(report["after_end"]))
            print(json.dumps(summary, ensure_ascii=False, indent=2))
        else:
            print(json.dumps(report, ensure_ascii=False, indent=2))
    except (OSError, ValueError, TypeError):
        print("Cannot analyze dataset: check local file, JSON envelope and group. Source content omitted.", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())
