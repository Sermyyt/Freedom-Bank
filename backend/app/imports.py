"""Import preserves raw conversations and appends immutable revisions."""
from collections import Counter
import json
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen
from .errors import APIError
from .ingestion import parse_dataset, prepare_record
from .service import history
from .storage import new_id, now
from scripts.fetch_dataset import with_group


def decode_json(raw):
    try:
        return json.loads(raw.decode("utf-8-sig"), parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (ValueError, UnicodeError):
        raise APIError(400, "INVALID_JSON", "Файл не содержит корректный UTF-8 JSON.") from None


def _download_bytes(settings, group):
    # Preserve the signed query while preventing group IDs from injecting parameters.
    url = with_group(settings.dataset_url, quote(group, safe=""))
    with urlopen(Request(url, headers={"Accept": "application/json"}), timeout=settings.dataset_timeout) as response:
        raw = response.read(settings.max_upload_bytes + 1)
    if len(raw) > settings.max_upload_bytes:
        raise APIError(413, "PAYLOAD_TOO_LARGE", "Набор превышает лимит загрузки.")
    return raw


def _decode_upstream(raw):
    try:
        return decode_json(raw)
    except APIError:
        raise APIError(502, "DATASET_UPSTREAM_ERROR", "Источник вернул некорректный ответ.") from None


def _transport_error(exc):
    if isinstance(getattr(exc, "reason", exc), TimeoutError):
        return APIError(504, "DATASET_TIMEOUT", "Источник данных не ответил вовремя.", retryable=True)
    return APIError(502, "DATASET_UPSTREAM_ERROR", "Не удалось получить набор от источника.", retryable=True)


def fetch_dataset(settings, group):
    if not settings.dataset_url:
        raise APIError(503, "DATASET_NOT_CONFIGURED", "Источник данных не настроен.")
    try:
        return _decode_upstream(_download_bytes(settings, group))
    except (HTTPError, URLError, OSError) as exc:
        raise _transport_error(exc) from None


def _prepare_unique(record, index, seen):
    external = record.get("conversation_id") if isinstance(record, dict) else None
    if isinstance(external, str):
        try:
            external.encode("utf-8")
        except UnicodeEncodeError:
            # Let record validation report a null ID before duplicate diagnostics can echo it.
            return prepare_record(record, index)
    if isinstance(external, str) and external in seen:
        error = dict(record_index=index, conversation_id=external, message_id=None,
                     code="DUPLICATE_CONVERSATION_IN_PAYLOAD", message="Повторный ID внутри набора.",
                     path=["records", index, "conversation_id"])
        return None, [error], [], []
    if isinstance(external, str):
        seen.add(external)
    return prepare_record(record, index)


def _append_revision(tx, group, detail, current, old_revision):
    timestamp, revision_id = now(), new_id()
    external = detail["conversation_id"]
    identifier = current["id"] if current else new_id()
    revision_number = old_revision["ref"]["revision"] + 1 if old_revision else 1
    detail.update(ref=dict(id=identifier, group_id=group, conversation_id=external,
                           revision_id=revision_id, revision=revision_number), created_at=timestamp)
    tx.put("revisions", revision_id, detail)
    conversation = dict(id=identifier, group_id=group, conversation_id=external, revision_id=revision_id,
                        created_at=current["created_at"] if current else timestamp, updated_at=timestamp)
    tx.put("conversations", identifier, conversation)
    history(tx, "conversation_revised" if current else "conversation_created", "conversation", identifier,
            "Сохранена ревизия разговора.", conversation_id=identifier)
    return conversation


def _store_record(tx, group, detail, known):
    external = detail["conversation_id"]
    current = known.get(external)
    old_revision = tx.get("revisions", current["revision_id"]) if current else None
    if old_revision and old_revision["content_hash"] == detail["content_hash"]:
        return "unchanged"
    known[external] = _append_revision(tx, group, detail, current, old_revision)
    return "revised" if current else "created"


def import_payload(tx, payload, requested_group=None):
    group, records, warnings = parse_dataset(payload, requested_group)
    report = dict(import_id=new_id(), group_id=group, received=len(records), created=0, unchanged=0,
                  revised=0, skipped=0, errors=[], warnings=list(warnings), unknown_system_phrases=[], created_at=now())
    seen, phrases = set(), Counter()
    known = {c["conversation_id"]: c for c in tx.all("conversations") if c["group_id"] == group}
    for index, record in enumerate(records):
        detail, errors, issues, unknown = _prepare_unique(record, index, seen)
        report["errors"].extend(errors)
        report["warnings"].extend(issues)
        phrases.update(unknown)
        if detail is None:
            report["skipped"] += 1
            continue
        report[_store_record(tx, group, detail, known)] += 1
    report["unknown_system_phrases"] = [dict(text=text, count=count) for text, count in sorted(phrases.items())]
    tx.put("imports", report["import_id"], report)
    history(tx, "dataset_imported", "import", report["import_id"], "Импорт набора завершён.", "demo_operator")
    return report
