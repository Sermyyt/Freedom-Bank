"""Offline import invariants; no semantic model-quality claims."""
from copy import deepcopy
import json
from pathlib import Path

import pytest

from app.ingestion import IngestionError, parse_dataset, prepare_record


def message(text="Synthetic message", speaker="operator", timestamp="00:01"):
    return {"timestamp": timestamp, "speaker": speaker, "text": text}


def record(messages=None, **fields):
    return {"conversation_id": "synthetic-record", "channel": "agent chat", "language": "RU",
            "transcript": messages if messages is not None else [message()], **fields}


def envelope(records=None, **fields):
    records = [record()] if records is None else records
    return {"isSuccess": True, "data": {"dataset_group_id": "SYNTHETIC", "total_records": len(records),
                                       "records": records, **fields}}


def test_envelope_array_and_declared_count_mismatch():
    group, records, warnings = parse_dataset(envelope(total_records=2))
    assert group == "SYNTHETIC"
    assert len(records) == 1
    assert warnings[0]["code"] == "TOTAL_RECORDS_MISMATCH"
    assert parse_dataset(records, group) == (group, records, [])


@pytest.mark.parametrize("payload", [None, {}, [], {"isSuccess": False},
    envelope(total_records=True), envelope(total_records=-1), envelope(dataset_group_id=" "),
    {"isSuccess": True, "data": {"records": []}}])
def test_invalid_envelopes_do_not_pass(payload):
    with pytest.raises(IngestionError) as exc:
        parse_dataset(payload)
    assert exc.value.code == "INVALID_DATASET"
    assert exc.value.status == 400


def test_group_conflict_is_not_a_partial_import():
    with pytest.raises(IngestionError) as exc:
        parse_dataset(envelope(), "OTHER")
    assert exc.value.code == "GROUP_MISMATCH"
    assert exc.value.status == 409


@pytest.mark.parametrize("bad", [None, [], {}, record([]), record([message(), None]),
    record([message(speaker=" ")]), record(channel=""), record(audio_url=5)])
def test_invalid_record_is_rejected_as_a_whole_without_number_shifts(bad):
    detail, errors, warnings, unknown = prepare_record(bad, 3)
    assert detail is None
    assert errors and errors[0]["record_index"] == 3
    assert warnings == unknown == []


def test_raw_strings_order_and_duplicate_ids_are_preserved():
    source = record([message("  Точный текст\n", "client"), message("  Точный текст\n", "client"),
                     message("[Имя скрыто]", "operator"), message("", "new-role", "not-a-time")],
                    channel="new-channel", language="NEW")
    before = deepcopy(source)
    detail, errors, warnings, _ = prepare_record(source, 0)
    assert source == before
    assert not errors
    assert detail["audio_url"] is None
    assert [(m["timestamp"], m["speaker"], m["text"]) for m in detail["transcript"]] == [
        (m["timestamp"], m["speaker"], m["text"]) for m in before["transcript"]]
    assert [m["id"] for m in detail["transcript"]] == [1, 2, 3, 4]
    assert detail["transcript"][1]["duplicate_of_message_id"] == 1
    assert detail["transcript"][1]["flags"] == ["duplicate_of_prev"]
    assert detail["transcript"][2]["flags"] == ["pii_masked"]
    assert detail["transcript"][3]["offset_sec"] is None
    assert {w["code"] for w in warnings} == {
        "UNKNOWN_ROLE", "UNKNOWN_CHANNEL", "UNKNOWN_LANGUAGE", "EMPTY_TEXT", "UNPARSEABLE_TIMESTAMP"}


def test_synthetic_hold_consultation_and_end_boundaries():
    texts = [message("Synthetic bot", "bot"), message("Synthetic client", "client")]
    texts += [message()] * 13
    texts += [message("Инициирована консультация с агентом.", "system"), message("Synthetic consent", "client")]
    texts += [message("Клиент находится на удержании.", "system")]
    texts += [message("Началась консультация с агентом.", "system")]
    texts += [message()] * 27
    texts += [message("Агент вышел из разговора.", "system")]
    texts += [message()] * 11
    texts += [message("Клиент больше не находится на удержании.", "system")]
    texts += [message()] * 12
    texts += [message("Клиент завершил разговор.", "system"), message("Synthetic trailing speech")]
    detail, errors, _, _ = prepare_record(record(texts), 0)
    assert not errors
    assert len(detail["transcript"]) == 73
    expected = (["pre_operator"] * 2 + ["client"] * 15 + ["hold"] + ["internal_consult"] * 28
                + ["hold"] * 12 + ["client"] * 14 + ["after_end"])
    assert [m["phase"] for m in detail["transcript"]] == expected
    assert [m["client_facing"] for m in detail["transcript"]] == [p in {"client", "pre_operator"} for p in expected]
    assert "after_end" in detail["transcript"][-1]["flags"]
    assert detail["manual_review_reasons"] == []


def test_unclosed_hold_remains_nonclient_even_with_operator_speech():
    detail, _, _, _ = prepare_record(record([message(), message("Клиент находится на удержании.", "system"),
                                            message("Synthetic private explanation")]), 0)
    assert [m["phase"] for m in detail["transcript"]] == ["client", "hold", "hold"]
    assert detail["manual_review_reasons"]


@pytest.mark.parametrize("timestamps,expected", [
    (["00:02", "05:04", "1:02:03"], [2, 304, 3723]),
    (["2026-11-07T10:00:05+05:00", "2026-11-07T05:00:06.500Z"], [0, 1.5]),
    (["unknown", "2026-11-07T10:00:05Z"], [None, None]),
    (["9" * 5000 + ":01"], [None]),
])
def test_transcript_time_is_not_claimed_as_verified_audio_time(timestamps, expected):
    detail, errors, _, _ = prepare_record(record([message(timestamp=t) for t in timestamps]), 0)
    assert not errors
    assert [m["offset_sec"] for m in detail["transcript"]] == expected
    assert all(m["audio_offset_sec"] is None for m in detail["transcript"])
    assert detail["audio_offset_reliable"] is False


def test_unknown_system_phrase_preserves_message_but_redacts_report_urls():
    source = "New event https://example.invalid/private?token=synthetic"
    detail, _, warnings, unknown = prepare_record(record([message(source, "system")]), 0)
    assert detail["transcript"][0]["text"] == source
    assert detail["transcript"][0]["system_event"] == "unknown"
    assert unknown == ["New event [URL omitted]"]
    assert warnings[0]["code"] == "UNKNOWN_SYSTEM_EVENT"
    assert "example.invalid" not in json.dumps(warnings)


def test_hash_changes_only_when_preserved_content_changes():
    first, *_ = prepare_record(record(), 0)
    repeat, *_ = prepare_record(record(audio_url=None), 10)
    edited, *_ = prepare_record(record([message("Changed message")]), 0)
    assert first["content_hash"] == repeat["content_hash"]
    assert first["content_hash"] != edited["content_hash"]


DEV = Path(__file__).resolve().parents[2] / "data/raw/DEV.json"


@pytest.mark.skipif(not DEV.exists(), reason="Local DEV is not available")
def test_local_dev_structure_and_hold_phases_without_exposing_text():
    payload = json.loads(DEV.read_text(encoding="utf-8-sig"))
    _, records, _ = parse_dataset(payload)
    results = [prepare_record(r, i) for i, r in enumerate(records)]
    assert all(detail is not None and not errors for detail, errors, _, _ in results)
    detail = next(detail for detail, _, _, _ in results if detail["conversation_id"] == "p4-ru-002")
    phases = [m["phase"] for m in detail["transcript"]]
    assert phases == (["pre_operator"] * 2 + ["client"] * 15 + ["hold"] + ["internal_consult"] * 28
                      + ["hold"] * 12 + ["client"] * 14 + ["after_end"])
