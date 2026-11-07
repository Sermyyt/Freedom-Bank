"""Read projections stay bounded and WAL readers do not reserve the writer lock."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import sqlite3

import pytest

from app.storage import Store


POLICY = dict(rounding="half_up", decimals=2, gross_error_zeroes_total=False)
EARLY = "2026-01-01T00:00:00Z"
LATE = "2026-01-02T00:00:00Z"


def add_conversation(tx, identifier, *, group="GROUP-A", external=None, language="RU", revision=1):
    ref = dict(id=identifier, group_id=group, conversation_id=external or identifier,
               revision_id=f"{identifier}-r{revision}", revision=revision)
    tx.put("revisions", ref["revision_id"], dict(ref=ref, channel="agent chat", language=language,
                                                transcript=[{}], audio_url=None))
    tx.put("conversations", identifier, dict(id=identifier, group_id=group, conversation_id=ref["conversation_id"],
                                             revision_id=ref["revision_id"], created_at=EARLY, updated_at=LATE))
    return ref


def add_evaluation(tx, identifier, ref, *, created=LATE, status="completed", gross=False,
                   total=80, demo=True, checklist="version-a"):
    tx.put("evaluations", identifier, dict(id=identifier, conversation=ref, checklist_version_id=checklist,
        is_demo=demo, original=dict(total=100), final=dict(total=total, status=status, gross_error=gross),
        scoring_policy=POLICY, created_at=created))


def trace_reads(monkeypatch):
    statements = []
    connect = sqlite3.connect

    def traced_connect(*args, **kwargs):
        connection = connect(*args, **kwargs)
        connection.set_trace_callback(statements.append)
        return connection

    monkeypatch.setattr(sqlite3, "connect", traced_connect)
    return statements


@pytest.mark.parametrize("count", [1, 25])
def test_conversation_page_scans_evaluations_and_appeals_once(client, api, monkeypatch, count):
    with api.state.store.transaction() as tx:
        for index in range(count):
            ref = add_conversation(tx, f"conversation-{index:03}")
            for generation in range(3):
                identifier = f"evaluation-{index:03}-{generation}"
                add_evaluation(tx, identifier, ref)
                tx.put("appeals", identifier, dict(evaluation_id=identifier, status="open"))
    statements = trace_reads(monkeypatch)
    response = client.get("/api/conversations", params={"limit": 1})
    assert response.status_code == 200
    assert response.json()["data"]["total"] == count
    selects = [sql for sql in statements if sql.startswith("SELECT")]
    assert sum("kind='evaluations'" in sql for sql in selects) == 1
    assert sum("kind='appeals'" in sql for sql in selects) == 1
    assert len(selects) == count + 3  # Conversations, evaluations, appeals, one current revision per row.
    assert "BEGIN" in statements and "BEGIN IMMEDIATE" not in statements


def test_evaluation_page_scans_appeals_once(client, api, monkeypatch):
    with api.state.store.transaction() as tx:
        ref = add_conversation(tx, "conversation-a")
        for index in range(30):
            add_evaluation(tx, f"evaluation-{index:03}", ref)
    statements = trace_reads(monkeypatch)
    response = client.get("/api/evaluations", params={"limit": 1})
    assert response.status_code == 200
    assert response.json()["data"]["total"] == 30
    selects = [sql for sql in statements if sql.startswith("SELECT")]
    assert len(selects) == 2
    assert sum("kind='appeals'" in sql for sql in selects) == 1


@pytest.fixture
def projection_records(client, api):
    with api.state.store.transaction() as tx:
        a = add_conversation(tx, "conversation-a", external="Alpha")
        old_b = add_conversation(tx, "conversation-b", external="Beta")
        b = add_conversation(tx, "conversation-b", external="Beta", revision=2)
        c = add_conversation(tx, "conversation-c", external="Gamma", group="GROUP-B", language="EN")
        add_evaluation(tx, "a-old", a, created=EARLY, total=50)
        add_evaluation(tx, "a-tie-a", a, total=70)
        add_evaluation(tx, "a-tie-z", a, total=80)
        add_evaluation(tx, "b-old-revision", old_b, gross=True)
        add_evaluation(tx, "c-latest", c, status="manual_review", gross=True, demo=False, checklist="version-b")
        for identifier, evaluation_id, status in [("appeal-a", "a-old", "open"),
                ("appeal-b", "b-old-revision", "open"), ("appeal-c", "c-latest", "open"),
                ("appeal-z", "a-tie-z", "resolved")]:
            tx.put("appeals", identifier, dict(evaluation_id=evaluation_id, status=status))
    return a, b, c


def test_conversation_projection_preserves_latest_tie_break_and_response(client, projection_records):
    a, b, c = projection_records
    response = client.get("/api/conversations")
    assert response.status_code == 200
    data = response.json()["data"]
    assert (data["total"], data["limit"], data["offset"]) == (3, 25, 0)
    assert [item["ref"] for item in data["items"]] == [a, b, c]
    assert data["items"][0] == dict(ref=a, channel="agent chat", language="RU", message_count=1, has_audio=False,
        latest_evaluation=dict(id="a-tie-z", conversation=a, checklist_version_id="version-a", status="completed",
            is_demo=True, original_total=100, final_total=80, gross_error=False, has_open_appeals=False,
            created_at=LATE, scoring_policy=POLICY), has_open_appeals=False, created_at=EARLY, updated_at=LATE)
    assert data["items"][1]["latest_evaluation"] is None
    assert data["items"][1]["has_open_appeals"] is False
    assert data["items"][2]["latest_evaluation"]["id"] == "c-latest"
    assert data["items"][2]["has_open_appeals"] is True


@pytest.mark.parametrize("params,expected,total", [
    ({"group_id": "GROUP-A"}, ["a", "b"], 2),
    ({"language": "EN", "channel": "agent chat"}, ["c"], 1),
    ({"q": "ALP"}, ["a"], 1),
    ({"evaluation_status": "completed"}, ["a"], 1),
    ({"evaluation_status": "manual_review"}, ["c"], 1),
    ({"evaluation_status": "not_evaluated"}, ["b"], 1),
    ({"has_gross_error": "false"}, ["a"], 1),
    ({"has_gross_error": "true"}, ["c"], 1),
    ({"has_open_appeals": "false"}, ["a", "b"], 2),
    ({"has_open_appeals": "true"}, ["c"], 1),
    ({"limit": 1, "offset": 1}, ["b"], 3),
])
def test_conversation_filters_and_pagination_use_current_revision(client, projection_records, params, expected, total):
    response = client.get("/api/conversations", params=params)
    assert response.status_code == 200
    data = response.json()["data"]
    assert [item["ref"]["id"] for item in data["items"]] == [f"conversation-{suffix}" for suffix in expected]
    assert data["total"] == total


@pytest.mark.parametrize("params,expected,total", [
    ({"conversation_id": "conversation-a"}, ["a-tie-a", "a-tie-z", "a-old"], 3),
    ({"conversation_id": "conversation-a", "offset": 1, "limit": 1}, ["a-tie-z"], 3),
    ({"revision_id": "conversation-b-r1"}, ["b-old-revision"], 1),
    ({"status": "manual_review", "is_demo": "false", "checklist_version_id": "version-b"}, ["c-latest"], 1),
])
def test_evaluation_list_preserves_filters_order_and_appeal_state(client, projection_records, params, expected, total):
    response = client.get("/api/evaluations", params=params)
    assert response.status_code == 200
    data = response.json()["data"]
    assert [item["id"] for item in data["items"]] == expected
    assert data["total"] == total
    for item in data["items"]:
        assert item["has_open_appeals"] is (item["id"] in {"a-old", "b-old-revision", "c-latest"})


def test_all_database_get_routes_use_readonly_transactions(client, api, monkeypatch):
    modes = []
    transaction = api.state.store.transaction

    @contextmanager
    def checked_transaction(*, readonly=False):
        modes.append(readonly)
        with transaction(readonly=readonly) as tx:
            yield tx

    monkeypatch.setattr(api.state.store, "transaction", checked_transaction)
    for path in ["/api/health", "/api/conversations", "/api/conversations/missing",
                 "/api/conversations/missing/revisions", "/api/checklists", "/api/checklists/missing",
                 "/api/checklists/missing/versions", "/api/checklist-versions/missing", "/api/jobs/missing",
                 "/api/evaluations", "/api/evaluations/missing", "/api/evaluations/compare?left_id=a&right_id=b",
                 "/api/appeals", "/api/appeals/missing", "/api/history"]:
        modes.clear()
        assert client.get(path).status_code in {200, 404}, path
        assert modes and all(modes), path


def test_wal_reader_keeps_snapshot_while_writer_commits(tmp_path):
    store = Store(tmp_path / "wal.db")
    store.initialize()
    with store.transaction() as tx:
        tx.put("synthetic", "counter", {"value": 1})

    def write():
        with store.transaction() as tx:
            tx.put("synthetic", "counter", {"value": 2})

    with ThreadPoolExecutor(max_workers=1) as pool:
        with store.transaction(readonly=True) as reader:
            assert reader.get("synthetic", "counter") == {"value": 1}
            pool.submit(write).result(timeout=3)
            assert reader.get("synthetic", "counter") == {"value": 1}
    with store.transaction(readonly=True) as reader:
        assert reader.get("synthetic", "counter") == {"value": 2}
        with pytest.raises(sqlite3.OperationalError, match="readonly"):
            reader.put("synthetic", "counter", {"value": 3})
