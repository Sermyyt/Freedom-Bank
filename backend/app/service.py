"""Shared projections and transactional history for the application services."""
from .errors import APIError, require
from .storage import new_id, now


def history(tx, event_type, entity_type, entity_id, summary, actor="system", **links):
    entry = dict(id=new_id(), event_type=event_type, entity_type=entity_type, entity_id=entity_id,
                 conversation_id=None, evaluation_id=None, appeal_id=None, checklist_version_id=None,
                 decision_id=None, final_revision=None, summary=summary, actor=actor, created_at=now())
    entry.update(links)
    tx.put("history", entry["id"], entry)


def active_id(tx):
    return (tx.get("settings", "main") or {}).get("active_version_id")


def version(tx, identifier):
    result = require(tx.get("versions", identifier))
    return dict(result, is_active=identifier == active_id(tx))


def conflict():
    raise APIError(409, "VERSION_CONFLICT", "Данные изменились. Загрузите актуальную версию.")


def page(items, limit, offset, key=None):
    if key is None:
        items = sorted(items, key=lambda x: x["id"])
        items.sort(key=lambda x: x["created_at"], reverse=True)
    else:
        items = sorted(items, key=key)
    return dict(items=items[offset:offset + limit], total=len(items), limit=limit, offset=offset)


def filtered(items, filters):
    return [item for item in items if all(value is None or item.get(key) == value for key, value in filters.items())]


def filter_evaluation_state(items, status, has_gross_error):
    if status is not None:
        items = [c for c in items if (c["latest_evaluation"] or {}).get("status", "not_evaluated") == status]
    if has_gross_error is not None:
        items = [c for c in items if (c["latest_evaluation"] or {}).get("gross_error") is has_gross_error]
    return items


def open_appeals(tx, evaluation_id):
    return any(a["status"] == "open" and a["evaluation_id"] == evaluation_id for a in tx.all("appeals"))


def evaluation_summary(tx, item):
    return {"id": item["id"], "conversation": item["conversation"],
            "checklist_version_id": item["checklist_version_id"], "status": item["final"]["status"],
            "is_demo": item["is_demo"], "original_total": item["original"]["total"],
            "final_total": item["final"]["total"], "gross_error": item["final"]["gross_error"],
            "has_open_appeals": open_appeals(tx, evaluation_id=item["id"]), "created_at": item["created_at"],
            "scoring_policy": item.get("scoring_policy")}


def conversation_detail(revision):
    return {k: v for k, v in revision.items() if k not in {"content_hash", "conversation_id"}}


def revision_summary(revision):
    return {"ref": revision["ref"], "channel": revision["channel"], "language": revision["language"],
            "message_count": len(revision["transcript"]), "content_hash": revision["content_hash"],
            "created_at": revision["created_at"]}


def conversation_summary(tx, conversation):
    revision = require(tx.get("revisions", conversation["revision_id"]))
    evaluations = [e for e in tx.all("evaluations") if e["conversation"]["revision_id"] == conversation["revision_id"]]
    latest = sorted(evaluations, key=lambda e: (e["created_at"], e["id"]), reverse=True)
    return dict(ref=revision["ref"], channel=revision["channel"], language=revision["language"],
                message_count=len(revision["transcript"]), has_audio=bool(revision["audio_url"]),
                latest_evaluation=evaluation_summary(tx, latest[0]) if latest else None,
                has_open_appeals=open_appeals(tx, evaluation_id=latest[0]["id"]) if latest else False,
                created_at=conversation["created_at"], updated_at=conversation["updated_at"])
