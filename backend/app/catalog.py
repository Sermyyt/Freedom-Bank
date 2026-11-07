"""Versioned checklists, with compare-and-set activation and first-run bootstrap."""
from hashlib import sha256
import json
from pathlib import Path
from .checklist_validation import normalize_definition
from .errors import APIError, require
from .service import active_id, conflict, history, version
from .storage import canonical, new_id, now


def checked_definition(definition):
    normalized, errors, _ = normalize_definition(definition)
    if errors:
        raise APIError(422, "VALIDATION_ERROR", "Чек-лист содержит ошибки.", errors)
    return normalized


def activate(tx, identifier, expected):
    require(tx.get("versions", identifier))
    previous = active_id(tx)
    if previous != expected:
        conflict()
    if previous != identifier:
        tx.put("settings", "main", {"active_version_id": identifier})
        history(tx, "checklist_version_activated", "checklist_version", identifier,
                "Активирована версия чек-листа.", "demo_operator", checklist_version_id=identifier)
    return {"active_version_id": identifier, "previous_version_id": previous}


def create_version(tx, definition, checklist_id=None, expected_latest=None,
                   should_activate=False, expected_active=None):
    normalized = checked_definition(definition)
    timestamp = now()
    if checklist_id:
        checklist = require(tx.get("checklists", checklist_id))
        if checklist["latest_version_id"] != expected_latest:
            conflict()
        number = checklist["latest_version"] + 1
    else:
        checklist_id, number = new_id(), 1
        checklist = dict(id=checklist_id, created_at=timestamp)
    identifier = new_id()
    result = dict(id=identifier, checklist_id=checklist_id, version=number, definition=normalized,
                  content_hash=sha256(canonical(normalized).encode("utf-8")).hexdigest(), created_at=timestamp)
    tx.put("versions", identifier, result)
    checklist.update(name=normalized["name"], description=normalized["description"],
                     latest_version_id=identifier, latest_version=number)
    tx.put("checklists", checklist_id, checklist)
    history(tx, "checklist_version_created", "checklist_version", identifier,
            "Создана версия чек-листа.", "demo_operator", checklist_version_id=identifier)
    if should_activate:
        activate(tx, identifier, expected_active)
    return version(tx, identifier)


def bootstrap(tx):
    # A persistent marker prevents later deletion/migration from silently resetting user state.
    if tx.get("settings", "initialized") is None:
        if not tx.all("checklists"):
            definition = json.loads((Path(__file__).parent / "data/checklist_seed.json").read_text(encoding="utf-8"))
            create_version(tx, definition, should_activate=True, expected_active=None)
        tx.put("settings", "initialized", {"at": now()})
