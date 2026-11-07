"""Small durable queue; one server process owns a bounded worker pool."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from threading import Lock
from .errors import APIError, require
from .evaluation import evaluate
from .service import active_id, conversation_detail, history
from .storage import new_id, now


def operation_error(code, message, retryable=False):
    return dict(code=code, message=message, retryable=retryable)


def progress(job):
    job["succeeded"] = sum(i["status"] == "completed" for i in job["items"])
    job["failed"] = sum(i["status"] == "failed" for i in job["items"])
    job["processed"] = job["succeeded"] + job["failed"]
    job["progress_percent"] = 100 * job["processed"] / job["total"]


def interrupt_unfinished(tx):
    error = operation_error("INTERRUPTED_BY_RESTART", "Обработка прервана перезапуском.", True)
    for job in tx.all("jobs"):
        if job["status"] in {"queued", "running"}:
            for item in job["items"]:
                if item["status"] in {"queued", "running"}:
                    item.update(status="failed", error=error)
            progress(job)
            job.update(status="failed", error=error, finished_at=now())
            tx.put("jobs", job["id"], job)


class JobRunner:
    def __init__(self, store, settings, provider):
        self.store, self.settings, self.provider = store, settings, provider
        self.pool = ThreadPoolExecutor(max_workers=settings.llm_max_concurrency, thread_name_prefix="cqa")
        self.lock = Lock()
        self.futures = set()

    def close(self):
        self.pool.shutdown(wait=True)

    def submit(self, job_id):
        future = self.pool.submit(self.run, job_id)
        with self.lock:
            self.futures.add(future)
        future.add_done_callback(self._finished)

    def _finished(self, future):
        with self.lock:
            self.futures.discard(future)

    def enqueue(self, tx, request):
        if self.provider is None:
            raise APIError(503, "PROVIDER_NOT_CONFIGURED", "Настройте провайдера и модель для оценки.")
        if sum(j["status"] in {"queued", "running"} for j in tx.all("jobs")) >= self.settings.max_queued_jobs:
            raise APIError(429, "BUSY", "Очередь заполнена. Повторите позже.", retryable=True)
        version_id = request.get("checklist_version_id") or active_id(tx)
        if version_id is None:
            raise APIError(422, "NO_ACTIVE_CHECKLIST", "Нет активного чек-листа.")
        require(tx.get("versions", version_id))
        if request.get("group_id") is not None:
            conversations = sorted([c for c in tx.all("conversations") if c["group_id"] == request["group_id"]],
                                   key=lambda c: (c["conversation_id"], c["id"]))
            identifiers = [c["revision_id"] for c in conversations]
            if not identifiers:
                raise APIError(404, "NOT_FOUND", "В группе нет импортированных разговоров.")
        else:
            identifiers = request["revision_ids"]
        if not identifiers or len(identifiers) > 1000:
            raise APIError(422, "VALIDATION_ERROR", "Для задания требуется от 1 до 1000 ревизий.")
        for identifier in identifiers:
            require(tx.get("revisions", identifier))
        job = dict(id=new_id(), status="queued", checklist_version_id=version_id,
                   is_demo=self.settings.llm_provider == "fake", provider=self.settings.llm_provider,
                   total=len(identifiers), processed=0, succeeded=0, failed=0, manual_review_count=0, progress_percent=0,
                   items=[dict(revision_id=i, status="queued", evaluation_id=None, error=None) for i in identifiers],
                   error=None, created_at=now(), started_at=None, finished_at=None)
        tx.put("jobs", job["id"], job)
        tx.put("job_config", job["id"], dict(policy=self.settings.scoring_policy,
                                              force=request.get("force", False), rationale_language=self.settings.rationale_language))
        return job

    def run(self, identifier):
        try:
            with self.store.transaction() as tx:
                job = require(tx.get("jobs", identifier))
                job.update(status="running", started_at=now())
                tx.put("jobs", identifier, job)
                config = tx.get("job_config", identifier)
                definition = tx.get("versions", job["checklist_version_id"])["definition"]
            for index in range(job["total"]):
                self.run_item(identifier, index, definition, config)
            with self.store.transaction() as tx:
                job = tx.get("jobs", identifier)
                job.update(status="failed" if job["failed"] else "completed", finished_at=now())
                if job["failed"]:
                    job["error"] = operation_error("ITEMS_FAILED", "Некоторые разговоры не удалось оценить.")
                tx.put("jobs", identifier, job)
        except Exception:
            # Recovery metadata is safe even if a provider exception embeds secrets.
            with self.store.transaction() as tx:
                job = require(tx.get("jobs", identifier))
                for item in job["items"]:
                    if item["status"] in {"queued", "running"}:
                        item.update(status="failed", error=operation_error("PROCESSING_FAILED", "Не удалось завершить обработку."))
                progress(job)
                job.update(status="failed", finished_at=now(), error=operation_error("PROCESSING_FAILED", "Задание завершилось с ошибкой."))
                tx.put("jobs", identifier, job)

    def run_item(self, job_id, index, definition, config):
        with self.store.transaction() as tx:
            job = tx.get("jobs", job_id)
            item = job["items"][index]
            item["status"] = "running"
            tx.put("jobs", job_id, job)
            revision = require(tx.get("revisions", item["revision_id"]))
            cache = {entry["key"]: entry["value"] for entry in tx.all("cache")}
        try:
            snapshot, usage, raw, entries = evaluate(definition, conversation_detail(revision), self.provider,
                                                     config["policy"], cached_results=cache, force=config["force"],
                                                     rationale_language=config["rationale_language"],
                                                     max_attempts=self.settings.llm_max_attempts)
            timestamp, evaluation_id = now(), new_id()
            evaluation = dict(id=evaluation_id, conversation=revision["ref"], checklist_version_id=job["checklist_version_id"],
                              checklist_snapshot=definition, scoring_policy=config["policy"], is_demo=job["is_demo"],
                              original=snapshot, final=deepcopy(snapshot), final_revision=0, applied_decision_ids=[],
                              usage=usage, created_at=timestamp, updated_at=timestamp)
            with self.store.transaction() as tx:
                tx.put("evaluations", evaluation_id, evaluation)
                tx.put("model_audit", evaluation_id, {"responses": raw})
                for key, entry in entries.items():
                    if not entry.get("evaluation_id"):
                        entry["evaluation_id"] = evaluation_id
                    tx.put("cache", key, {"key": key, "value": entry})
                job = tx.get("jobs", job_id)
                job["items"][index].update(status="completed", evaluation_id=evaluation_id)
                job["manual_review_count"] += snapshot["status"] == "manual_review"
                progress(job)
                tx.put("jobs", job_id, job)
                history(tx, "evaluation_created", "evaluation", evaluation_id, "Сохранена оценка разговора.",
                        conversation_id=revision["ref"]["id"], evaluation_id=evaluation_id,
                        checklist_version_id=job["checklist_version_id"], final_revision=0)
        except Exception as exc:
            with self.store.transaction() as tx:
                job = tx.get("jobs", job_id)
                tx.put("model_audit", f"{job_id}:{index}", {
                    "responses": getattr(exc, "raw_response", []), "usage": getattr(exc, "usage", None)})
                job["items"][index].update(status="failed", error=operation_error("EVALUATION_FAILED", "Не удалось получить допустимую оценку.", True))
                progress(job)
                tx.put("jobs", job_id, job)
