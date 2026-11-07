"""Create verified SQLite snapshots, or restore with a mandatory safety snapshot.

Works with PowerShell 5.1: pass paths as ordinary quoted arguments, not Python -c.
Stop the API and every other writer before restoring. Backup can read a live DB.
"""
from __future__ import annotations

import argparse
from contextlib import closing
from pathlib import Path
import sqlite3
import sys
from tempfile import TemporaryDirectory
import time


class BackupError(RuntimeError):
    """An operational error without database contents or connection details."""


def database_path(path: Path) -> Path:
    resolved = path.resolve(strict=True)
    if not resolved.is_file():
        raise BackupError("Source must be an existing SQLite file.")
    with resolved.open("rb") as stream:
        if stream.read(16) != b"SQLite format 3\x00":
            raise BackupError("Source is not a SQLite database.")
    return resolved


def verify(connection: sqlite3.Connection) -> None:
    if connection.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
        raise BackupError("SQLite integrity check failed.")


def copy_database(source: sqlite3.Connection, destination: sqlite3.Connection) -> None:
    deadline = time.monotonic() + 60

    def progress(status, remaining, total):
        if time.monotonic() >= deadline:
            raise BackupError("SQLite snapshot timed out; check for another database writer.")

    source.backup(destination, pages=256, progress=progress)
    verify(destination)


def backup_database(source: Path, output: Path) -> Path:
    """Never replace an existing output; include committed WAL data via SQLite."""
    source = database_path(source)
    output = output.resolve()
    if any(Path(str(output) + suffix).exists() for suffix in ("-wal", "-shm", "-journal")):
        raise BackupError("Output has SQLite sidecar files; choose a new clean path.")
    # Exclusive creation happens before SQLite opens the output. Existing backups stay intact.
    with output.open("xb"):
        pass
    try:
        with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)) as reader:
            with closing(sqlite3.connect(output.as_uri() + "?mode=rw", uri=True)) as writer:
                copy_database(reader, writer)
    except BaseException:
        output.unlink(missing_ok=True)
        raise
    return output


def restore_database(backup: Path, database: Path, safety_backup: Path) -> Path:
    """Restore an existing stopped database only after saving its current contents."""
    backup = database_path(backup)
    database = database_path(database)
    safety_backup = safety_backup.resolve()
    if backup.samefile(database):
        raise BackupError("Backup and restore destination must be different files.")
    if safety_backup.exists():
        raise BackupError("Safety backup already exists; choose a new path.")
    # Validate and pin the chosen backup before touching the target. Never consume/move it.
    with TemporaryDirectory(prefix="cqa-restore-") as temporary:
        checked = backup_database(backup, Path(temporary) / "checked.db")
        saved = backup_database(database, safety_backup)
        with closing(sqlite3.connect(checked.as_uri() + "?mode=ro", uri=True)) as reader:
            with closing(sqlite3.connect(database.as_uri() + "?mode=rw", uri=True)) as writer:
                copy_database(reader, writer)
    return saved


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    backup = commands.add_parser("backup", help="Create a new verified snapshot; refuses to overwrite")
    backup.add_argument("--database", type=Path, required=True)
    backup.add_argument("--output", type=Path, required=True)
    restore = commands.add_parser("restore", help="Restore an existing DB after creating a safety snapshot")
    restore.add_argument("--backup", type=Path, required=True)
    restore.add_argument("--database", type=Path, required=True)
    restore.add_argument("--safety-backup", type=Path, required=True)
    restore.add_argument("--server-stopped", action="store_true", help="Confirm all processes using the database are stopped")
    args = parser.parse_args(argv)
    if args.command == "restore" and not args.server_stopped:
        parser.error("restore requires --server-stopped after stopping every database user")
    try:
        if args.command == "backup":
            backup_database(args.database, args.output)
            print("Backup OK: new snapshot passed SQLite integrity_check.")
        else:
            restore_database(args.backup, args.database, args.safety_backup)
            print("Restore OK: restored database passed integrity_check; safety snapshot preserved.")
        return 0
    except (OSError, sqlite3.Error, BackupError):
        print("Database operation failed. Check paths, free space, database integrity and active writers. "
              "Existing backups are not overwritten; retain the safety snapshot if it was created. "
              "Database contents omitted.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
