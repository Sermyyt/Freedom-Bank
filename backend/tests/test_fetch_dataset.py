"""Offline checks for the manual dataset downloader: no network, synthetic link and data."""
import io
import json

import pytest

from scripts import data_report, fetch_dataset

LINK = ("https://example.invalid/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun"
        "&sig=synthetic-sig&group_id=DEV")


def envelope(group, records=1):
    return {"error": "", "isSuccess": True,
            "data": {"dataset_group_id": group, "total_records": records,
                     "records": [{"conversation_id": f"c{i}"} for i in range(records)]}}


class Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


@pytest.fixture
def organizer(tmp_path, monkeypatch):
    """Hidden input gives LINK; the organizer answers with state['payload']."""
    state = {"payload": envelope("DEV"), "requested": [], "raw": tmp_path / "data" / "raw"}

    def fake_urlopen(request, timeout):
        state["requested"].append(request.full_url)
        return Response(json.dumps(state["payload"]).encode("utf-8"))

    monkeypatch.setattr(data_report, "ROOT", tmp_path)
    monkeypatch.setattr(fetch_dataset.getpass, "getpass", lambda prompt: LINK)
    monkeypatch.setattr(fetch_dataset, "urlopen", fake_urlopen)
    return state


def test_dev_answer_is_saved_as_dev_and_count_is_reported(organizer, capsys):
    assert fetch_dataset.main([]) == 0
    saved = json.loads((organizer["raw"] / "DEV.json").read_text(encoding="utf-8"))
    assert saved == organizer["payload"]
    assert capsys.readouterr().out.strip() == "Saved data/raw/DEV.json: 1 records"


def test_other_group_gets_its_own_file_and_dev_is_left_alone(organizer):
    organizer["raw"].mkdir(parents=True)
    (organizer["raw"] / "DEV.json").write_text("previous DEV", encoding="utf-8")
    organizer["payload"] = envelope("CONTROL", records=3)
    assert fetch_dataset.main([]) == 0
    assert (organizer["raw"] / "DEV.json").read_text(encoding="utf-8") == "previous DEV"
    control = json.loads((organizer["raw"] / "CONTROL.json").read_text(encoding="utf-8"))
    assert len(control["data"]["records"]) == 3


def test_group_option_changes_only_the_group_parameter(organizer):
    organizer["payload"] = envelope("CONTROL")
    assert fetch_dataset.main(["--group", "CONTROL"]) == 0
    assert organizer["requested"] == [
        "https://example.invalid/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun"
        "&sig=synthetic-sig&group_id=CONTROL"
    ]


def test_group_option_adds_the_parameter_when_the_link_has_none(organizer, monkeypatch):
    monkeypatch.setattr(fetch_dataset.getpass, "getpass", lambda prompt: "https://example.invalid/invoke?sig=s")
    organizer["payload"] = envelope("CONTROL")
    assert fetch_dataset.main(["--group", "CONTROL"]) == 0
    assert organizer["requested"] == ["https://example.invalid/invoke?sig=s&group_id=CONTROL"]


def test_answer_for_another_group_is_refused_and_nothing_is_saved(organizer, capsys):
    organizer["payload"] = envelope("DEV")
    assert fetch_dataset.main(["--group", "CONTROL"]) == 1
    assert not organizer["raw"].exists()
    assert "another group" in capsys.readouterr().err


@pytest.mark.parametrize("group", ["../../outside", "a/b", "a\\b", "", " ", "CON TROL", None])
def test_unsafe_group_id_in_the_answer_never_becomes_a_path(organizer, group):
    organizer["payload"] = envelope(group)
    assert fetch_dataset.main([]) == 1
    assert list(data_report.ROOT.rglob("*.json")) == []


def test_invalid_group_option_is_refused_before_asking_for_the_link(organizer, monkeypatch):
    def must_not_ask(prompt):
        raise AssertionError("link was requested")

    monkeypatch.setattr(fetch_dataset.getpass, "getpass", must_not_ask)
    assert fetch_dataset.main(["--group", "../x"]) == 2
    assert organizer["requested"] == []


def test_refusal_output_never_contains_the_link(organizer, capsys):
    organizer["payload"] = {"error": "boom", "isSuccess": False, "data": None}
    assert fetch_dataset.main([]) == 1
    captured = capsys.readouterr()
    assert "synthetic-sig" not in captured.out + captured.err
    assert "example.invalid" not in captured.out + captured.err
    assert not organizer["raw"].exists()
