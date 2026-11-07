"""Snapshot/restore checks on synthetic SQLite files, never the project database."""
from contextlib import closing
import sqlite3

import pytest

from scripts import database_backup


def create_database(path, value="before"):
    with closing(sqlite3.connect(path)) as connection:
        connection.execute("CREATE TABLE sample(value TEXT)")
        connection.execute("INSERT INTO sample VALUES (?)", (value,))
        connection.commit()


def values(path):
    with closing(sqlite3.connect(path)) as connection:
        assert connection.execute("PRAGMA integrity_check").fetchall() == [("ok",)]
        return connection.execute("SELECT value FROM sample").fetchall()


def test_backup_captures_committed_wal_without_changing_source(tmp_path):
    source, output = tmp_path / "live database.db", tmp_path / "snapshot.db"
    create_database(source)
    with closing(sqlite3.connect(source)) as live:
        live.execute("PRAGMA journal_mode=WAL")
        live.execute("PRAGMA wal_autocheckpoint=0")
        live.execute("INSERT INTO sample VALUES ('committed WAL')")
        live.commit()
        assert source.with_name(source.name + "-wal").stat().st_size > 0
        database_backup.backup_database(source, output)
        assert values(output) == [("before",), ("committed WAL",)]
        assert live.execute("SELECT value FROM sample").fetchall() == values(output)


def test_backup_refuses_existing_output_and_same_database(tmp_path):
    source, output = tmp_path / "source.db", tmp_path / "existing.db"
    create_database(source)
    output.write_bytes(b"keep original backup")
    with pytest.raises(FileExistsError):
        database_backup.backup_database(source, output)
    assert output.read_bytes() == b"keep original backup"
    with pytest.raises(FileExistsError):
        database_backup.backup_database(source, source)
    assert values(source) == [("before",)]


def test_backup_failure_removes_only_its_new_incomplete_file(tmp_path, monkeypatch):
    source, output = tmp_path / "source.db", tmp_path / "incomplete.db"
    create_database(source)

    def failed_copy(reader, writer):
        raise database_backup.BackupError("Synthetic failure")

    monkeypatch.setattr(database_backup, "copy_database", failed_copy)
    with pytest.raises(database_backup.BackupError):
        database_backup.backup_database(source, output)
    assert not output.exists()
    assert values(source) == [("before",)]


@pytest.mark.parametrize("suffix", ["-wal", "-shm", "-journal"])
def test_backup_refuses_orphaned_sidecars_at_output(tmp_path, suffix):
    source, output = tmp_path / "source.db", tmp_path / "snapshot.db"
    create_database(source)
    sidecar = tmp_path / (output.name + suffix)
    sidecar.write_bytes(b"preserve unknown sidecar")
    with pytest.raises(database_backup.BackupError):
        database_backup.backup_database(source, output)
    assert not output.exists()
    assert sidecar.read_bytes() == b"preserve unknown sidecar"


def test_restore_preserves_original_backup_and_current_database_in_safety_snapshot(tmp_path):
    backup, target, safety = (tmp_path / name for name in ("chosen.db", "current.db", "safety.db"))
    create_database(backup, "chosen restore point")
    create_database(target, "current work")
    original_backup = backup.read_bytes()
    saved = database_backup.restore_database(backup, target, safety)
    assert saved == safety
    assert values(target) == [("chosen restore point",)]
    assert values(safety) == [("current work",)]
    assert backup.read_bytes() == original_backup


def test_restore_refuses_existing_safety_backup_before_touching_target(tmp_path):
    backup, target, safety = (tmp_path / name for name in ("chosen.db", "current.db", "safety.db"))
    create_database(backup, "chosen restore point")
    create_database(target, "current work")
    safety.write_bytes(b"keep me")
    with pytest.raises(database_backup.BackupError):
        database_backup.restore_database(backup, target, safety)
    assert values(target) == [("current work",)]
    assert safety.read_bytes() == b"keep me"


@pytest.mark.parametrize("invalid", [b"", b"not a database", b"SQLite format 3\x00" + b"broken" * 100])
def test_restore_rejects_invalid_backup_without_touching_target(tmp_path, invalid):
    backup, target, safety = (tmp_path / name for name in ("broken.db", "current.db", "safety.db"))
    backup.write_bytes(invalid)
    create_database(target, "current work")
    with pytest.raises((database_backup.BackupError, sqlite3.Error)):
        database_backup.restore_database(backup, target, safety)
    assert values(target) == [("current work",)]
    assert not safety.exists()


def test_restore_refuses_source_as_target_and_missing_target(tmp_path):
    backup, missing, safety = (tmp_path / name for name in ("chosen.db", "missing.db", "safety.db"))
    create_database(backup)
    with pytest.raises(database_backup.BackupError):
        database_backup.restore_database(backup, backup, safety)
    with pytest.raises(FileNotFoundError):
        database_backup.restore_database(backup, missing, safety)
    assert not missing.exists() and not safety.exists()
    assert values(backup) == [("before",)]


def test_restore_cli_requires_stopped_server_assertion_and_reports_safe_errors(tmp_path, capsys):
    arguments = ["restore", "--backup", str(tmp_path / "private-source.db"),
                 "--database", str(tmp_path / "current.db"), "--safety-backup", str(tmp_path / "safety.db")]
    with pytest.raises(SystemExit) as error:
        database_backup.main(arguments)
    assert error.value.code == 2
    capsys.readouterr()
    assert database_backup.main(arguments + ["--server-stopped"]) == 1
    result = capsys.readouterr()
    assert result.out == ""
    assert "Database operation failed" in result.err
    assert "private-source" not in result.err
