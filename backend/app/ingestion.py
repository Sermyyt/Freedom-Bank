"""Validate and annotate imported conversations without changing source messages."""
from __future__ import annotations

from datetime import datetime
import hashlib
import json
import math
from pathlib import Path
from typing import Any

from scripts.data_report import KNOWN, event_code, safe_text, time_format


class IngestionError(ValueError):
    """Safe, public import failure; never contains submitted values."""

    def __init__(self, code: str, message: str, status: int = 400):
        self.code, self.message, self.status = code, message, status
        super().__init__(message)


def issue(code: str, message: str, index: int | None = None,
          conversation_id: str | None = None, message_id: int | None = None,
          path: list | None = None) -> dict:
    return {"record_index": index, "conversation_id": conversation_id,
            "message_id": message_id, "code": code, "message": message,
            "path": path or []}


def parse_dataset(payload: Any, group_id: str | None = None) -> tuple[str, list, list]:
    """Accept a complete organizer envelope or an explicitly grouped records array."""
    if group_id is not None and (not isinstance(group_id, str) or not group_id.strip()):
        raise IngestionError("INVALID_DATASET", "Не задана группа набора.")
    if isinstance(payload, list):
        if group_id is None:
            raise IngestionError("INVALID_DATASET", "Для массива записей требуется group_id.")
        return group_id, payload, []
    if not isinstance(payload, dict) or payload.get("isSuccess") is not True:
        raise IngestionError("INVALID_DATASET", "Ожидается успешный ответ организаторов или массив записей.")
    data = payload.get("data")
    if not isinstance(data, dict) or not isinstance(data.get("records"), list):
        raise IngestionError("INVALID_DATASET", "В ответе отсутствует массив data.records.")
    source_group = data.get("dataset_group_id")
    if not isinstance(source_group, str) or not source_group.strip():
        raise IngestionError("INVALID_DATASET", "В ответе отсутствует dataset_group_id.")
    if group_id is not None and source_group != group_id:
        raise IngestionError("GROUP_MISMATCH", "Группа файла не совпадает с запрошенной.", 409)
    declared = data.get("total_records")
    if type(declared) is not int or declared < 0:
        raise IngestionError("INVALID_DATASET", "Неверное значение total_records.")
    warnings = []
    if declared != len(data["records"]):
        warnings.append(issue("TOTAL_RECORDS_MISMATCH", "Заявленное количество отличается от числа записей.",
                              path=["data", "total_records"]))
    return source_group, data["records"], warnings


def _invalid(record: Any, index: int) -> list[dict]:
    cid = record.get("conversation_id") if isinstance(record, dict) else None
    cid = cid if isinstance(cid, str) else None

    def invalid(code: str, message: str, path: list, mid: int | None = None) -> list[dict]:
        return [issue(code, message, index, cid, mid, path)]

    if not isinstance(record, dict):
        return invalid("INVALID_RECORD", "Запись должна быть объектом.", [])
    for key in ("conversation_id", "channel", "language"):
        if not isinstance(record.get(key), str) or not record[key].strip():
            return invalid("INVALID_RECORD", "Обязательное поле должно быть непустой строкой.", [key])
    if record.get("audio_url") is not None and not isinstance(record["audio_url"], str):
        return invalid("INVALID_RECORD", "Неверный тип ссылки на аудио.", ["audio_url"])
    messages = record.get("transcript")
    if not isinstance(messages, list):
        return invalid("INVALID_RECORD", "Транскрипт должен быть массивом.", ["transcript"])
    if not messages:
        return invalid("EMPTY_TRANSCRIPT", "Транскрипт пуст.", ["transcript"])
    for n, message in enumerate(messages):
        if not isinstance(message, dict):
            return invalid("INVALID_MESSAGE", "Реплика должна быть объектом.", ["transcript", n], n + 1)
        for key in ("timestamp", "speaker", "text"):
            if not isinstance(message.get(key), str) or (key == "speaker" and not message[key].strip()):
                return invalid("INVALID_MESSAGE", "Неверное обязательное поле реплики.",
                               ["transcript", n, key], n + 1)
    return []


def _offset(timestamp: str, first_timestamp: str) -> float | int | None:
    kind = time_format(timestamp)
    if kind in {"MM:SS", "H:MM:SS"}:
        seconds = 0
        try:
            for part in timestamp.split(":"):
                seconds = seconds * 60 + int(part)
            return seconds if math.isfinite(float(seconds)) else None
        except (ValueError, OverflowError):
            return None
    if kind == "ISO8601_TZ" and time_format(first_timestamp) == "ISO8601_TZ":
        current = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        start = datetime.fromisoformat(first_timestamp.replace("Z", "+00:00"))
        return (current - start).total_seconds()
    return None


def prepare_record(record: Any, index: int) -> tuple[dict | None, list, list, list[str]]:
    """Return a source-preserving detail, errors, warnings, and unknown system phrases.

    Logical IDs, revisions and dates are assigned by the transactional persistence layer.
    Invalid messages reject the whole record, so positional message IDs never shift.
    """
    errors = _invalid(record, index)
    if errors:
        return None, errors, [], []
    definitions = json.loads((Path(__file__).parent / "data/system_events.json").read_text(encoding="utf-8"))
    cid, messages = record["conversation_id"], record["transcript"]
    warnings: list[dict] = []
    unknown: list[str] = []
    reasons: list[str] = []

    def warn(code: str, text: str, mid: int | None = None, field: str | None = None):
        path = ["transcript", mid - 1, field] if mid is not None else [field]
        warnings.append(issue(code, text, index, cid, mid, path))

    for field in ("channel", "language"):
        if record[field] not in KNOWN[field]:
            warn("UNKNOWN_" + field.upper(), "Неизвестное значение сохранено без изменения.", field=field)
    annotated = []
    phase, held, ended, previous = "pre_operator", False, False, None
    previous_offset = None
    for mid, original in enumerate(messages, 1):
        role, text = original["speaker"], original["text"]
        event = event_code(text, definitions) if role == "system" else None
        if ended:
            phase = "after_end"
        elif event == "hold_start":
            held, phase = True, "hold"
        elif event == "hold_end":
            held, phase = False, "client"
        elif held and event == "consult_started":
            phase = "internal_consult"
        elif held and event == "agent_left":
            phase = "hold"
        elif phase == "pre_operator" and role == "operator":
            phase = "client"

        flags = []
        duplicate = previous is not None and (role, text) == (previous["speaker"], previous["text"])
        if duplicate:
            flags.append("duplicate_of_prev")
        if phase == "after_end":
            flags.append("after_end")
        if any(mask in text for mask in ("[Имя скрыто]", "[Персональные данные скрыты]")):
            flags.append("pii_masked")
        if event == "unknown":
            flags.append("unknown_event")
            unknown.append(safe_text(text))
            warn("UNKNOWN_SYSTEM_EVENT", "Системная фраза не распознана.", mid, "text")
        if role not in KNOWN["speaker"]:
            warn("UNKNOWN_ROLE", "Неизвестная роль сохранена без изменения.", mid, "speaker")
        if not text.strip():
            warn("EMPTY_TEXT", "Пустой текст сохранён без изменения.", mid, "text")
        offset = _offset(original["timestamp"], messages[0]["timestamp"])
        if offset is None:
            warn("UNPARSEABLE_TIMESTAMP", "Не удалось определить время от начала разговора.", mid, "timestamp")
        elif previous_offset is not None and offset < previous_offset:
            warn("NON_MONOTONIC_TIMESTAMP", "Время реплики меньше времени предыдущей реплики.", mid, "timestamp")
        if offset is not None:
            previous_offset = offset
        annotated.append({"id": mid, "timestamp": original["timestamp"], "speaker": role, "text": text,
                          "offset_sec": offset, "audio_offset_sec": None, "phase": phase,
                          "client_facing": phase in {"pre_operator", "client"}, "system_event": event,
                          "flags": flags, "duplicate_of_message_id": mid - 1 if duplicate else None})
        if event in definitions["ending_codes"]:
            ended = True
        previous = original

    if held:
        reasons.append("Удержание не завершено событием возврата к клиенту.")
    warning_codes = list(dict.fromkeys(item["code"] for item in warnings))
    if "UNPARSEABLE_TIMESTAMP" in warning_codes or "NON_MONOTONIC_TIMESTAMP" in warning_codes:
        reasons.append("Временная шкала транскрипта требует проверки.")
    if "UNKNOWN_ROLE" in warning_codes or "UNKNOWN_SYSTEM_EVENT" in warning_codes:
        reasons.append("Неизвестная роль или системное событие требует проверки контекста.")
    source = {key: record[key] for key in ("conversation_id", "channel", "language")}
    source["audio_url"] = record.get("audio_url")
    source["transcript"] = [{key: m[key] for key in ("timestamp", "speaker", "text")} for m in messages]
    digest = hashlib.sha256(json.dumps(source, ensure_ascii=False, sort_keys=True,
                                      separators=(",", ":")).encode("utf-8")).hexdigest()
    detail = {"conversation_id": cid, "channel": record["channel"], "language": record["language"],
              "transcript": annotated, "audio_url": record.get("audio_url"), "content_hash": digest,
              "audio_offset_reliable": False, "manual_review_reasons": reasons, "warnings": warning_codes}
    return detail, [], warnings, unknown
