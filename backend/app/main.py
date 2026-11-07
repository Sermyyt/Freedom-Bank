"""HTTP composition root. Run: python -m uvicorn app.main:app --host 127.0.0.1 --port 8000."""
from contextlib import asynccontextmanager
import sqlite3
from typing import Annotated, Literal

from fastapi import FastAPI, File, Form, Query, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException

from . import catalog, imports, reviews, schemas as s
from .checklist_validation import normalize_definition
from .config import ROOT, Settings
from .errors import APIError, require
from .evaluation import DomainError
from .ingestion import IngestionError
from .jobs import JobRunner, interrupt_unfinished
from .providers import FakeLLM
from .service import (active_id, conversation_detail, conversation_summary, evaluation_summary,
                      filtered, page, revision_summary, version)
from .storage import Store, new_id

Limit = Annotated[int, Query(ge=1, le=100)]
Offset = Annotated[int, Query(ge=0)]


class StrictQueryRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()
        allowed = {parameter.alias for parameter in self.dependant.query_params}

        async def checked(request):
            if set(request.query_params) - allowed or any(len(request.query_params.getlist(key)) > 1 for key in allowed):
                raise APIError(422, "VALIDATION_ERROR", "Неизвестные или повторные параметры запроса.")
            return await handler(request)
        return checked


def failure(request_id, status, code, message, details=None, retryable=False):
    return JSONResponse(status_code=status, content=dict(
        error=dict(code=code, message=message, details=details or [], retryable=retryable),
        meta=dict(request_id=request_id)), headers={"Retry-After": "1"} if status == 429 else None)


class RequestMiddleware:
    def __init__(self, app, max_bytes):
        self.app, self.max_bytes = app, max_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        identifier = new_id()
        scope.setdefault("state", {})["request_id"] = identifier
        if scope["method"] in {"POST", "PUT", "PATCH"}:
            chunks, size = [], 0
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    return
                size += len(message.get("body", b""))
                if size > self.max_bytes:
                    return await failure(identifier, 413, "PAYLOAD_TOO_LARGE", "Превышен лимит тела запроса.")(scope, receive, send)
                chunks.append(message.get("body", b""))
                if not message.get("more_body", False):
                    break
            delivered = False
            original_receive = receive

            async def buffered_receive():
                nonlocal delivered
                if not delivered:
                    delivered = True
                    return {"type": "http.request", "body": b"".join(chunks), "more_body": False}
                return await original_receive()
            receive = buffered_receive
        started = False

        async def safe_send(message):
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
                message.setdefault("headers", []).append((b"x-request-id", identifier.encode("ascii")))
            await send(message)
        try:
            await self.app(scope, receive, safe_send)
        except Exception:
            if not started:
                await failure(identifier, 500, "INTERNAL_ERROR", "Внутренняя ошибка сервера.")(scope, receive, safe_send)


def create_app(settings=None, provider=None):
    settings = settings or Settings.from_env()
    store = Store(settings.database_path)
    selected_provider = provider if provider is not None else (FakeLLM() if settings.llm_provider == "fake" else None)

    @asynccontextmanager
    async def lifespan(application):
        store.initialize()
        with store.transaction() as tx:
            catalog.bootstrap(tx)
            interrupt_unfinished(tx)
        application.state.runner = JobRunner(store, settings, selected_provider)
        try:
            yield
        finally:
            application.state.runner.close()

    app = FastAPI(title="CQA API", version="1", lifespan=lifespan,
                  responses={code: {"model": s.Failure} for code in (400, 404, 405, 409, 413, 422, 429, 500, 502, 503, 504)})
    app.state.settings, app.state.store, app.state.provider = settings, store, selected_provider
    app.router.route_class = StrictQueryRoute
    app.add_middleware(RequestMiddleware, max_bytes=settings.max_upload_bytes)
    if settings.cors_origins:
        app.add_middleware(CORSMiddleware, allow_origins=list(settings.cors_origins),
                           allow_methods=["GET", "POST", "OPTIONS"], allow_headers=["Content-Type"],
                           expose_headers=["X-Request-ID", "Retry-After"])

    @app.exception_handler(APIError)
    async def api_error(request, exc):
        return failure(request.state.request_id, exc.status, exc.code, exc.message, exc.details, exc.retryable)

    @app.exception_handler(DomainError)
    async def domain_error(request, exc):
        return failure(request.state.request_id, 422, exc.code, "Проверьте ответ и доказательства.", exc.details)

    @app.exception_handler(IngestionError)
    async def ingestion_error(request, exc):
        return failure(request.state.request_id, exc.status, exc.code, exc.message)

    @app.exception_handler(sqlite3.Error)
    async def storage_error(request, exc):
        return failure(request.state.request_id, 503, "SERVICE_UNAVAILABLE", "Хранилище временно недоступно.", retryable=True)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, exc):
        if any(e["type"] == "json_invalid" for e in exc.errors()):
            return failure(request.state.request_id, 400, "INVALID_JSON", "Не удалось прочитать JSON запроса.")
        details = [dict(path=list(e["loc"]), code=e["type"], message="Неверное или отсутствующее значение.") for e in exc.errors()]
        return failure(request.state.request_id, 422, "VALIDATION_ERROR", "Проверьте поля запроса.", details)

    @app.exception_handler(HTTPException)
    async def http_error(request, exc):
        code, message = {404: ("NOT_FOUND", "Объект не найден."), 405: ("METHOD_NOT_ALLOWED", "Метод не поддерживается."),
                         400: ("INVALID_JSON", "Не удалось прочитать запрос.")}.get(exc.status_code, ("VALIDATION_ERROR", "Некорректный запрос."))
        return failure(request.state.request_id, exc.status_code, code, message)

    def success(request, data):
        return dict(data=data, meta=dict(request_id=request.state.request_id))

    @app.get("/api/health", response_model=s.Success[s.Health])
    def health(request: Request):
        with store.transaction() as tx:
            active = active_id(tx)
        ready = selected_provider is not None and active is not None
        return success(request, dict(status="ok" if ready else "degraded", api_version="1", database_ready=True,
                                    provider=settings.llm_provider, model=settings.llm_model, is_demo=settings.llm_provider == "fake",
                                    evaluation_ready=ready, dataset_ready=bool(settings.dataset_url), active_checklist_version_id=active,
                                    scoring_policy=settings.scoring_policy))

    @app.post("/api/imports/dataset", response_model=s.Success[s.ImportReport])
    def import_dataset(body: s.DatasetImportRequest, request: Request):
        payload = imports.fetch_dataset(settings, body.group_id)
        try:
            with store.transaction() as tx:
                result = imports.import_payload(tx, payload, body.group_id)
        except IngestionError as exc:
            if exc.status == 400:
                raise APIError(502, "DATASET_UPSTREAM_ERROR", "Источник вернул некорректный набор.") from None
            raise
        return success(request, result)

    @app.post("/api/imports/file", response_model=s.Success[s.ImportReport])
    async def import_file(request: Request, file: UploadFile = File(...), group_id: str | None = Form(None)):
        form = await request.form()
        if set(form) - {"file", "group_id"} or len(form.getlist("file")) != 1 or len(form.getlist("group_id")) > 1:
            raise APIError(422, "VALIDATION_ERROR", "Неизвестные или повторные поля формы.")
        payload = imports.decode_json(await file.read(settings.max_upload_bytes + 1))
        with store.transaction() as tx:
            result = imports.import_payload(tx, payload, group_id)
        return success(request, result)

    @app.get("/api/conversations", response_model=s.Success[s.Page[s.ConversationSummary]])
    def conversations(request: Request, limit: Limit = 25, offset: Offset = 0, group_id: str | None = None,
                      language: str | None = None, channel: str | None = None, q: str | None = None,
                      evaluation_status: Literal["not_evaluated", "completed", "manual_review", "failed"] | None = None,
                      has_gross_error: bool | None = None, has_open_appeals: bool | None = None):
        with store.transaction() as tx:
            items = [conversation_summary(tx, c) for c in tx.all("conversations") if group_id is None or c["group_id"] == group_id]
            items = filtered(items, dict(language=language, channel=channel, has_open_appeals=has_open_appeals))
            items = [c for c in items if q is None or q.casefold() in c["ref"]["conversation_id"].casefold()]
            if evaluation_status is not None:
                items = [c for c in items if ((c["latest_evaluation"] or {}).get("status", "not_evaluated")) == evaluation_status]
            if has_gross_error is not None:
                items = [c for c in items if (c["latest_evaluation"] or {}).get("gross_error") is has_gross_error]
            result = page(items, limit, offset, key=lambda c: (c["ref"]["group_id"], c["ref"]["conversation_id"], c["ref"]["id"]))
        return success(request, result)

    @app.get("/api/conversations/{id}", response_model=s.Success[s.ConversationDetail])
    def conversation(id: str, request: Request, revision_id: str | None = None):
        with store.transaction() as tx:
            current = require(tx.get("conversations", id))
            result = require(tx.get("revisions", revision_id or current["revision_id"]))
            if result["ref"]["id"] != id:
                require(None)
        return success(request, conversation_detail(result))

    @app.get("/api/conversations/{id}/revisions", response_model=s.Success[s.Page[s.ConversationRevision]])
    def revisions(id: str, request: Request, limit: Limit = 25, offset: Offset = 0):
        with store.transaction() as tx:
            require(tx.get("conversations", id))
            items = [revision_summary(r) for r in tx.all("revisions") if r["ref"]["id"] == id]
        return success(request, page(items, limit, offset, key=lambda r: -r["ref"]["revision"]))

    @app.get("/api/checklists", response_model=s.Success[s.Page[s.Checklist]])
    def checklists(request: Request, limit: Limit = 25, offset: Offset = 0):
        with store.transaction() as tx:
            result = page(tx.all("checklists"), limit, offset)
        return success(request, result)

    @app.post("/api/checklists", status_code=201, response_model=s.Success[s.ChecklistVersion])
    def create_checklist(body: s.CreateChecklistRequest, request: Request):
        with store.transaction() as tx:
            result = catalog.create_version(tx, body.model_dump())
        return success(request, result)

    @app.post("/api/checklists/validate", response_model=s.Success[s.ValidationReport])
    def validate_checklist(body: s.ChecklistDefinition, request: Request):
        _, errors, warnings = normalize_definition(body.model_dump())
        return success(request, dict(valid=not errors, errors=errors, warnings=warnings))

    @app.get("/api/checklists/{id}", response_model=s.Success[s.Checklist])
    def checklist(id: str, request: Request):
        with store.transaction() as tx:
            result = require(tx.get("checklists", id))
        return success(request, result)

    @app.get("/api/checklists/{id}/versions", response_model=s.Success[s.Page[s.ChecklistVersion]])
    def versions(id: str, request: Request, limit: Limit = 25, offset: Offset = 0):
        with store.transaction() as tx:
            require(tx.get("checklists", id))
            items = [version(tx, v["id"]) for v in tx.all("versions") if v["checklist_id"] == id]
            result = page(items, limit, offset)
        return success(request, result)

    @app.post("/api/checklists/{id}/versions", status_code=201, response_model=s.Success[s.ChecklistVersion])
    def create_version(id: str, body: s.CreateVersionRequest, request: Request):
        definition = body.model_dump(exclude={"expected_latest_version_id", "activate", "expected_active_version_id"})
        with store.transaction() as tx:
            result = catalog.create_version(tx, definition, id, body.expected_latest_version_id, body.activate, body.expected_active_version_id)
        return success(request, result)

    @app.get("/api/checklist-versions/{id}", response_model=s.Success[s.ChecklistVersion])
    def checklist_version(id: str, request: Request):
        with store.transaction() as tx:
            result = version(tx, id)
        return success(request, result)

    @app.post("/api/checklist-versions/{id}/activate", response_model=s.Success[s.ActivationResult])
    def activate(id: str, body: s.ActivationRequest, request: Request):
        with store.transaction() as tx:
            result = catalog.activate(tx, id, body.expected_active_version_id)
        return success(request, result)

    @app.post("/api/evaluations", status_code=202, response_model=s.Success[s.Job])
    def start_evaluation(body: s.EvaluationRequest, request: Request):
        with store.transaction() as tx:
            result = app.state.runner.enqueue(tx, body.model_dump())
        app.state.runner.submit(result["id"])
        return success(request, result)

    @app.get("/api/jobs/{id}", response_model=s.Success[s.Job])
    def job(id: str, request: Request):
        with store.transaction() as tx:
            result = require(tx.get("jobs", id))
        return success(request, result)

    @app.get("/api/evaluations", response_model=s.Success[s.Page[s.EvaluationSummary]])
    def evaluations(request: Request, limit: Limit = 25, offset: Offset = 0, conversation_id: str | None = None,
                    revision_id: str | None = None, checklist_version_id: str | None = None,
                    status: s.EvaluationStatus | None = None, is_demo: bool | None = None):
        with store.transaction() as tx:
            items = [evaluation_summary(tx, e) for e in tx.all("evaluations")
                     if (conversation_id is None or e["conversation"]["id"] == conversation_id)
                     and (revision_id is None or e["conversation"]["revision_id"] == revision_id)]
            result = page(filtered(items, dict(checklist_version_id=checklist_version_id, status=status, is_demo=is_demo)), limit, offset)
        return success(request, result)

    @app.get("/api/evaluations/compare", response_model=s.Success[s.EvaluationComparison])
    def compare(request: Request, left_id: str, right_id: str):
        with store.transaction() as tx:
            result = reviews.compare(tx, left_id, right_id)
        return success(request, result)

    @app.get("/api/evaluations/{id}", response_model=s.Success[s.Evaluation])
    def evaluation(id: str, request: Request):
        with store.transaction() as tx:
            result = require(tx.get("evaluations", id))
        return success(request, result)

    @app.post("/api/appeals", status_code=201, response_model=s.Success[s.Appeal])
    def create_appeal(body: s.CreateAppealRequest, request: Request):
        with store.transaction() as tx:
            result = reviews.create_appeal(tx, body.model_dump())
        return success(request, result)

    @app.get("/api/appeals", response_model=s.Success[s.Page[s.Appeal]])
    def appeals(request: Request, limit: Limit = 25, offset: Offset = 0,
                evaluation_id: str | None = None, status: Literal["open", "resolved"] | None = None):
        with store.transaction() as tx:
            result = page(filtered(tx.all("appeals"), dict(evaluation_id=evaluation_id, status=status)), limit, offset)
        return success(request, result)

    @app.get("/api/appeals/{id}", response_model=s.Success[s.Appeal])
    def appeal(id: str, request: Request):
        with store.transaction() as tx:
            result = require(tx.get("appeals", id))
        return success(request, result)

    @app.post("/api/appeals/{id}/decision", response_model=s.Success[s.AppealDecisionResult])
    def decision(id: str, body: s.AppealDecisionRequest, request: Request):
        with store.transaction() as tx:
            result = reviews.decide(tx, id, body.model_dump())
        return success(request, result)

    @app.get("/api/history", response_model=s.Success[s.Page[s.HistoryEvent]])
    def events(request: Request, limit: Limit = 25, offset: Offset = 0, conversation_id: str | None = None,
               evaluation_id: str | None = None, appeal_id: str | None = None, checklist_version_id: str | None = None,
               event_type: str | None = None):
        with store.transaction() as tx:
            result = page(filtered(tx.all("history"), dict(conversation_id=conversation_id, evaluation_id=evaluation_id,
                                                           appeal_id=appeal_id, checklist_version_id=checklist_version_id,
                                                           event_type=event_type)), limit, offset)
        return success(request, result)

    # Registered last; it cannot shadow API, Swagger or OpenAPI routes.
    if (ROOT / "frontend").is_dir():
        app.mount("/", StaticFiles(directory=ROOT / "frontend", html=True), name="frontend")
    return app


app = create_app()
