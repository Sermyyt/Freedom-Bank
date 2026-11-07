"""Validate and annotate imported conversations without changing source messages."""
from __future__ import annotations

from dataclasses import dataclass
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


def _utf8_string(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def _nonempty_string(value: Any) -> bool:
    return _utf8_string(value) and bool(value.strip())


def _required_group(value: Any) -> str:
    if not _nonempty_string(value):
        raise IngestionError("INVALID_DATASET", "Не задана группа набора.")
    return value


def _envelope_data(payload: Any) -> dict:
    if not isinstance(payload, dict) or payload.get("isSuccess") is not True:
        raise IngestionError("INVALID_DATASET", "Ожидается успешный ответ организаторов или массив записей.")
    data = payload.get("data")
    if not isinstance(data, dict) or not isinstance(data.get("records"), list):
        raise IngestionError("INVALID_DATASET", "В ответе отсутствует массив data.records.")
    return data


def _count_warnings(data: dict) -> list:
    declared = data.get("total_records")
    if type(declared) is not int or declared < 0:
        raise IngestionError("INVALID_DATASET", "Неверное значение total_records.")
    warnings = []
    if declared != len(data["records"]):
        warnings.append(issue("TOTAL_RECORDS_MISMATCH", "Заявленное количество отличается от числа записей.",
                              path=["data", "total_records"]))
    return warnings


def parse_dataset(payload: Any, group_id: str | None = None) -> tuple[str, list, list]:
    """Accept a complete organizer envelope or an explicitly grouped records array."""
    if group_id is not None:
        _required_group(group_id)
    if isinstance(payload, list):
        return _required_group(group_id), payload, []
    data = _envelope_data(payload)
    source_group = _required_group(data.get("dataset_group_id"))
    if group_id is not None and source_group != group_id:
        raise IngestionError("GROUP_MISMATCH", "Группа файла не совпадает с запрошенной.", 409)
    return source_group, data["records"], _count_warnings(data)


def _record_error(record, index, code, message, path, mid=None):
    cid = record.get("conversation_id") if isinstance(record, dict) else None
    cid = cid if _utf8_string(cid) else None
    return [issue(code, message, index, cid, mid, path)]


def _header_errors(record: Any, index: int) -> list:
    if not isinstance(record, dict):
        return _record_error(record, index, "INVALID_RECORD", "Запись должна быть объектом.", [])
    for key in ("conversation_id", "channel", "language"):
        if not _nonempty_string(record.get(key)):
            return _record_error(record, index, "INVALID_RECORD", "Обязательное поле должно быть непустой строкой.", [key])
    if record.get("audio_url") is not None and not _utf8_string(record["audio_url"]):
        return _record_error(record, index, "INVALID_RECORD", "Неверный тип ссылки на аудио.", ["audio_url"])
    return []


def _message_errors(message: Any, record: dict, index: int, n: int) -> list:
    if not isinstance(message, dict):
        return _record_error(record, index, "INVALID_MESSAGE", "Реплика должна быть объектом.", ["transcript", n], n + 1)
    for key in ("timestamp", "speaker", "text"):
        if not _utf8_string(message.get(key)) or (key == "speaker" and not message[key].strip()):
            return _record_error(record, index, "INVALID_MESSAGE", "Неверное обязательное поле реплики.",
                                 ["transcript", n, key], n + 1)
    return []


def _invalid(record: Any, index: int) -> list[dict]:
    errors = _header_errors(record, index)
    if errors:
        return errors
    messages = record.get("transcript")
    if not isinstance(messages, list):
        return _record_error(record, index, "INVALID_RECORD", "Транскрипт должен быть массивом.", ["transcript"])
    if not messages:
        return _record_error(record, index, "EMPTY_TRANSCRIPT", "Транскрипт пуст.", ["transcript"])
    for n, message in enumerate(messages):
        errors = _message_errors(message, record, index, n)
        if errors:
            return errors
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


@dataclass
class _PhaseState:
    phase: str = "pre_operator"
    held: bool = False
    ended: bool = False

    def advance(self, role: str, event: str | None) -> str:
        if self.ended:
            self.phase = "after_end"
        elif event in {"hold_start", "hold_end"}:
            self.held = event == "hold_start"
            self.phase = {"hold_start": "hold", "hold_end": "client"}[event]
        elif self.held and event in {"consult_started", "agent_left"}:
            self.phase = {"consult_started": "internal_consult", "agent_left": "hold"}[event]
        elif self.phase == "pre_operator" and role == "operator":
            self.phase = "client"
        return self.phase


def _flags(original: dict, phase: str, event: str | None, previous: dict | None) -> list[str]:
    flags = []
    if previous is not None and (original["speaker"], original["text"]) == (previous["speaker"], previous["text"]):
        flags.append("duplicate_of_prev")
    if phase == "after_end":
        flags.append("after_end")
    if any(mask in original["text"] for mask in ("[Имя скрыто]", "[Персональные данные скрыты]")):
        flags.append("pii_masked")
    if event == "unknown":
        flags.append("unknown_event")
    return flags


def _message_warnings(message: dict, previous_offset) -> list[tuple[str, str, str]]:
    warnings = []
    if message["system_event"] == "unknown":
        warnings.append(("UNKNOWN_SYSTEM_EVENT", "Системная фраза не распознана.", "text"))
    if message["speaker"] not in KNOWN["speaker"]:
        warnings.append(("UNKNOWN_ROLE", "Неизвестная роль сохранена без изменения.", "speaker"))
    if not message["text"].strip():
        warnings.append(("EMPTY_TEXT", "Пустой текст сохранён без изменения.", "text"))
    offset = message["offset_sec"]
    if offset is None:
        warnings.append(("UNPARSEABLE_TIMESTAMP", "Не удалось определить время от начала разговора.", "timestamp"))
    elif previous_offset is not None and offset < previous_offset:
        warnings.append(("NON_MONOTONIC_TIMESTAMP", "Время реплики меньше времени предыдущей реплики.", "timestamp"))
    return warnings


def _annotated_message(original, mid, phase, event, previous, first_timestamp):
    flags = _flags(original, phase, event, previous)
    return {"id": mid, "timestamp": original["timestamp"], "speaker": original["speaker"], "text": original["text"],
            "offset_sec": _offset(original["timestamp"], first_timestamp), "audio_offset_sec": None,
            "phase": phase, "client_facing": phase in {"pre_operator", "client"}, "system_event": event,
            "flags": flags, "duplicate_of_message_id": mid - 1 if "duplicate_of_prev" in flags else None}


def _annotate_transcript(record: dict, index: int, definitions: dict) -> tuple[list, list, bool]:
    messages, state, previous, previous_offset = record["transcript"], _PhaseState(), None, None
    annotated, warnings = [], []
    for mid, original in enumerate(messages, 1):
        event = event_code(original["text"], definitions) if original["speaker"] == "system" else None
        phase = state.advance(original["speaker"], event)
        message = _annotated_message(original, mid, phase, event, previous, messages[0]["timestamp"])
        annotated.append(message)
        for code, text, field in _message_warnings(message, previous_offset):
            warnings.append(issue(code, text, index, record["conversation_id"], mid, ["transcript", mid - 1, field]))
        if message["offset_sec"] is not None:
            previous_offset = message["offset_sec"]
        if event in definitions["ending_codes"]:
            state.ended = True
        previous = original
    return annotated, warnings, state.held


def _record_warnings(record, index):
    return [issue("UNKNOWN_" + field.upper(), "Неизвестное значение сохранено без изменения.",
                  index, record["conversation_id"], path=[field])
            for field in ("channel", "language") if record[field] not in KNOWN[field]]


def _review_reasons(held: bool, warning_codes: list[str]) -> list[str]:
    reasons = []
    if held:
        reasons.append("Удержание не завершено событием возврата к клиенту.")
    if {"UNPARSEABLE_TIMESTAMP", "NON_MONOTONIC_TIMESTAMP"}.intersection(warning_codes):
        reasons.append("Временная шкала транскрипта требует проверки.")
    if {"UNKNOWN_ROLE", "UNKNOWN_SYSTEM_EVENT"}.intersection(warning_codes):
        reasons.append("Неизвестная роль или системное событие требует проверки контекста.")
    return reasons


def _content_hash(record: dict) -> str:
    source = {key: record[key] for key in ("conversation_id", "channel", "language")}
    source["audio_url"] = record.get("audio_url")
    source["transcript"] = [{key: m[key] for key in ("timestamp", "speaker", "text")} for m in record["transcript"]]
    return hashlib.sha256(json.dumps(source, ensure_ascii=False, sort_keys=True,
                                    separators=(",", ":")).encode("utf-8")).hexdigest()


def prepare_record(record: Any, index: int) -> tuple[dict | None, list, list, list[str]]:
    """Return a source-preserving detail, errors, warnings, and unknown system phrases.

    Logical IDs, revisions and dates are assigned by the transactional persistence layer.
    Invalid messages reject the whole record, so positional message IDs never shift.
    """
    errors = _invalid(record, index)
    if errors:
        return None, errors, [], []
    definitions = json.loads((Path(__file__).parent / "data/system_events.json").read_text(encoding="utf-8"))
    annotated, message_warnings, held = _annotate_transcript(record, index, definitions)
    warnings = _record_warnings(record, index) + message_warnings
    warning_codes = list(dict.fromkeys(item["code"] for item in warnings))
    unknown = [safe_text(m["text"]) for m in annotated if m["system_event"] == "unknown"]
    detail = {"conversation_id": record["conversation_id"], "channel": record["channel"], "language": record["language"],
              "transcript": annotated, "audio_url": record.get("audio_url"), "content_hash": _content_hash(record),
              "audio_offset_reliable": False, "manual_review_reasons": _review_reasons(held, warning_codes), "warnings": warning_codes}
    return detail, [], warnings, unknown
