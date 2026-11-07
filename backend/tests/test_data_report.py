"""Synthetic, offline checks for the section 1 audit; no model-quality claims."""
from copy import deepcopy
import json
from pathlib import Path

import pytest

from scripts import data_report


SYSTEM_PHRASES = [
    ("Эскалация на оператора.", "escalation"),
    ("Чат операторға жіберілді.", "escalation"),
    ("Chat transferred to an agent.", "escalation"),
    ("Личность клиента подтверждена.", "identity_verified"),
    ("Клиенттің жеке басы расталды.", "identity_verified"),
    ("Customer identity verified.", "identity_verified"),
    ("Соединение с клиентом прервано.", "connection_lost"),
    ("Клиентпен байланыс үзілді.", "connection_lost"),
    ("Connection to customer lost.", "connection_lost"),
    ("Оператор закрыл чат.", "operator_closed"),
    ("Оператор чатты жапты.", "operator_closed"),
    ("Agent closed the chat.", "operator_closed"),
    ("Клиент покинул чат.", "client_left"),
    ("Клиент завершил разговор.", "client_ended"),
    ("Агент присоединился к разговору с клиентом.", "agent_joined"),
    ("Запись и транскрибирование запущены.", "recording_started"),
    ("Жазу және транскрипция басталды.", "recording_started"),
    ("Запись и транскрибирование приостановлены.", "recording_paused"),
    ("Запись и транскрибирование возобновлены.", "recording_resumed"),
    ("Инициирована консультация с агентом.", "consult_initiated"),
    ("Началась консультация с агентом.", "consult_started"),
    ("Клиент находится на удержании.", "hold_start"),
    ("Клиент больше не находится на удержании.", "hold_end"),
    ("Агент вышел из разговора.", "agent_left"),
    ("Клиент переведен от агента на представителя службы поддержки", "transfer_to_support"),
    ("Bot dialog and transcription languages have been updated. RU -> EN", "language_changed"),
]


@pytest.fixture
def definitions():
    return json.loads(data_report.EVENTS_FILE.read_text(encoding="utf-8"))


def message(text, speaker="operator", timestamp="00:01"):
    return {"timestamp": timestamp, "speaker": speaker, "text": text}


def record(messages, cid="synthetic-conversation", **changes):
    return {
        "conversation_id": cid,
        "channel": "agent chat",
        "language": "RU",
        "audio_url": None,
        "transcript": messages,
        **changes,
    }


def envelope(records, group="SYNTHETIC"):
    return {
        "error": "", "isSuccess": True,
        "data": {"dataset_group_id": group, "total_records": len(records), "records": records},
    }


@pytest.mark.parametrize("phrase,expected", SYSTEM_PHRASES)
def test_all_known_event_phrases_are_recognized_after_normalization(definitions, phrase, expected):
    altered = " \n" + phrase.upper().replace(" ", " \t ") + "  "
    assert data_report.event_code(altered, definitions) == expected


def test_exact_event_rule_has_priority_over_prefix_and_unknown_is_retained(definitions):
    rules = {"exact": {"specific": ["Status done."]}, "prefix": {"generic": ["Status"]}}
    assert data_report.event_code("STATUS DONE", rules) == "specific"
    assert data_report.event_code("Status pending", rules) == "generic"
    report = data_report.build_report([record([message("New event from organizer.", "system")])])
    assert report["events"] == {"unknown": 1}
    assert report["unrecognized_system_phrases"] == [
        {"text": "New event from organizer.", "code": "unknown", "count": 1}
    ]


@pytest.mark.parametrize("timestamp,expected", [
    ("00:02", "MM:SS"), ("125:59", "MM:SS"),
    ("1:02:03", "H:MM:SS"), ("125:59:59", "H:MM:SS"),
    ("2026-11-07T10:30:05+05:00", "ISO8601_TZ"),
    ("2026-11-07T10:30:05.250Z", "ISO8601_TZ"),
    ("2026-11-07T10:30:05-03:30", "ISO8601_TZ"),
    ("2026-11-07T10:30:05", "unknown"), ("2026-11-07", "unknown"),
    ("2026-02-30T10:30:05Z", "unknown"), ("1:60:00", "unknown"),
    ("01:60", "unknown"), ("01:01:60", "unknown"),
    ("-01:02", "unknown"), ("1:2:3", "unknown"), ("", "unknown"),
])
def test_time_formats_reject_bad_ranges_and_timezone_less_dates(timestamp, expected):
    assert data_report.time_format(timestamp) == expected


def test_unknown_values_missing_audio_and_bad_record_do_not_lose_good_data():
    unknown = record([message("Sample", "observer", "1:02:03")], channel="new channel", language="FR")
    del unknown["audio_url"]
    broken = record([{"speaker": "operator", "timestamp": "00:02"}], cid="broken")
    report = data_report.build_report(envelope([unknown, broken]))
    assert (report["received_records"], report["valid_records"], report["skipped_records"]) == (2, 1, 1)
    assert report["roles"] == {"observer": 1}
    assert report["channels"] == {"new channel": 1}
    assert report["languages"] == {"FR": 1}
    assert report["unknown_values"] == {
        "speaker": {"observer": 1}, "channel": {"new channel": 1}, "language": {"FR": 1}
    }
    assert report["audio"] == [{"channel": "new channel", "state": "missing", "count": 1}]
    assert report["time_formats"] == {"H:MM:SS": 1}
    assert len(report["errors"]) == 1


def test_duplicate_detection_preserves_source_and_requires_identical_role_and_text():
    source = envelope([record([
        message("Echo", timestamp="00:01"),
        message("Echo", timestamp="00:02"),
        message("Echo", speaker="client", timestamp="00:02"),
        message("echo", speaker="client", timestamp="00:03"),
        message("echo ", speaker="client", timestamp="00:04"),
        message("echo ", speaker="client", timestamp="00:05"),
    ])])
    original = deepcopy(source)
    report = data_report.build_report(source)
    assert source == original
    assert report["message_count"] == 6
    assert [(d["message_id"], d["duplicate_of"]) for d in report["duplicates"]] == [(2, 1), (6, 5)]


@pytest.mark.parametrize("ending", [
    "Клиент завершил разговор.", "Оператор закрыл чат.",
    "Клиент покинул чат.", "Соединение с клиентом прервано.",
])
def test_after_end_excludes_end_message_and_ignores_same_words_from_operator(ending):
    report = data_report.build_report([record([
        message(ending),
        message("Before ending", "client"),
        message(ending, "system"),
        message("After ending"),
        message(ending, "system"),
    ])])
    assert report["after_end"][0]["end_message_id"] == 3
    assert report["after_end"][0]["message_ids"] == [4, 5]
    assert report["without_end_event"] == []


def test_without_end_event_and_text_statistics_do_not_imply_synthesized_event():
    report = data_report.build_report([record([
        message("", "client"), message("[Имя скрыто]", "operator"), message("тест", "bot"),
    ])])
    assert report["events"] == {}
    assert len(report["without_end_event"]) == 1
    assert report["empty_texts"] == 1
    assert report["max_text_characters"] == len("[Имя скрыто]")
    assert report["text_characters"] == len("[Имя скрыто]") + len("тест")
    assert report["pii_masked_messages"] == 1


@pytest.mark.parametrize("payload", [
    None, "text", {}, {"isSuccess": False}, {"isSuccess": 1},
    {"isSuccess": True, "data": []},
    {"isSuccess": True, "data": {"records": {}}},
    {"isSuccess": True, "data": {"records": [], "dataset_group_id": " "}},
    {"isSuccess": True, "data": {"records": [], "dataset_group_id": "TEST", "total_records": True}},
])
def test_invalid_envelope_is_rejected(payload):
    with pytest.raises(ValueError):
        data_report.build_report(payload)


def test_group_mismatch_is_rejected_and_declared_count_mismatch_is_warning():
    payload = envelope([record([message("Test")])])
    with pytest.raises(ValueError, match="group"):
        data_report.build_report(payload, "OTHER")
    payload["data"]["total_records"] = 3
    report = data_report.build_report(payload, "SYNTHETIC")
    assert report["received_records"] == 1
    assert report["declared_records"] == 3
    assert {"code": "declared_count_mismatch"} in report["warnings"]


def test_full_report_omits_audio_links_and_redacts_system_message_urls():
    private_url = "https://example.invalid/private?token=synthetic-secret"
    source = [record([
        message("Unknown event " + private_url, "system"),
        message("Other " + private_url.upper(), "system"),
    ], audio_url=private_url)]
    output = json.dumps(data_report.build_report(source), ensure_ascii=False)
    assert "synthetic-secret" not in output.lower()
    assert "example.invalid" not in output.lower()
    assert "[URL omitted]" in output
    assert source[0]["audio_url"] == private_url


def test_cli_handles_utf8_bom_and_writes_private_report(tmp_path, capsys):
    source, target = tmp_path / "input.json", tmp_path / "audit.json"
    source.write_text(json.dumps(envelope([record([message("Тест", "client")])]), ensure_ascii=False), encoding="utf-8-sig")
    result = data_report.main(["--file", str(source), "--group", "SYNTHETIC", "--output", str(target)])
    assert result == 0
    assert json.loads(target.read_text(encoding="utf-8"))["message_count"] == 1
    displayed = json.loads(capsys.readouterr().out)
    assert displayed["message_count"] == 1
    assert "system_phrases" not in displayed


def test_cli_error_does_not_echo_bad_source_content(tmp_path, capsys):
    source = tmp_path / "broken.json"
    source.write_text("sensitive-unparseable-source", encoding="utf-8")
    assert data_report.main(["--file", str(source)]) == 2
    captured = capsys.readouterr()
    assert "sensitive-unparseable-source" not in captured.err + captured.out
    assert "Source content omitted" in captured.err


DEV = Path(__file__).resolve().parents[2] / "data/raw/DEV.json"


@pytest.mark.skipif(not DEV.is_file(), reason="Local DEV dataset has not been provided")
def test_dev_structural_counts_from_section_13():
    """Checks supplied count claims only, not semantic scoring or model accuracy."""
    report = data_report.build_report(json.loads(DEV.read_text(encoding="utf-8-sig")), "DEV")
    assert report["valid_records"] == 65
    assert report["skipped_records"] == 0
    assert report["roles"] == {"client": 505, "operator": 339, "bot": 315, "system": 109}
    assert report["channels"] == {"agent chat": 60, "voice call": 5}
    assert report["languages"] == {"RU": 35, "KZ": 15, "EN": 15}
    assert report["time_formats"] == {"MM:SS": 882, "ISO8601_TZ": 386}
    assert report["distinct_system_phrases"] == 26
    assert report["unrecognized_system_phrases"] == []
