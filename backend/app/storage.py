"""SQLite document persistence. Each business operation owns one atomic transaction."""
from contextlib import contextmanager
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
from uuid import uuid4


def now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def new_id():
    return str(uuid4())


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


class Session:
    def __init__(self, connection):
        self.connection = connection

    def get(self, kind, identifier):
        row = self.connection.execute("SELECT body FROM documents WHERE kind=? AND id=?",
                                      (kind, identifier)).fetchone()
        return json.loads(row[0]) if row else None

    def all(self, kind):
        return [json.loads(row[0]) for row in self.connection.execute(
            "SELECT body FROM documents WHERE kind=? ORDER BY id", (kind,))]

    def put(self, kind, identifier, value):
        self.connection.execute(
            "INSERT INTO documents(kind,id,body) VALUES(?,?,?) "
            "ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body", (kind, identifier, canonical(value)))


class Store:
    def __init__(self, path):
        self.path = Path(path)

    def initialize(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(self.path) as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("CREATE TABLE IF NOT EXISTS documents "
                               "(kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id))")
            connection.execute("PRAGMA user_version=1")

    @contextmanager
    def transaction(self, *, readonly=False):
        target = self.path.resolve().as_uri() + "?mode=ro" if readonly else self.path
        connection = sqlite3.connect(target, timeout=30, uri=readonly)
        try:
            # WAL readers keep one snapshot without reserving the writer lock.
            connection.execute("BEGIN" if readonly else "BEGIN IMMEDIATE")
            yield Session(connection)
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()
