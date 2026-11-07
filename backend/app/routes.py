"""Public API routes. Business state belongs to the request application's services."""
from typing import Annotated, Literal
from fastapi import APIRouter, File, Form, Query, Request, UploadFile
from . import catalog, imports, reviews, schemas as s
from .checklist_validation import normalize_definition
from .errors import APIError, require
from .evaluation import PROMPT_VERSION
from .ingestion import IngestionError
from .service import (active_id, conversation_detail, conversation_summaries, evaluation_summary, filter_evaluation_state,
                      filtered, open_appeal_evaluation_ids, page, revision_summary, version)
from .http import StrictQueryRoute, success

Limit = Annotated[int, Query(ge=1, le=100)]
Offset = Annotated[int, Query(ge=0)]
router = APIRouter(route_class=StrictQueryRoute)



def register_document_route(path, kind, model, name):
    def endpoint(id: str, request: Request):
        with request.app.state.store.transaction(readonly=True) as tx:
            result = require(tx.get(kind, id))
        return success(request, result)
    endpoint.__name__ = name
    router.add_api_route(path, endpoint, methods=["GET"], response_model=s.Success[model])


@router.get("/api/health", response_model=s.Success[s.Health])
def health(request: Request):
    with request.app.state.store.transaction(readonly=True) as tx:
        active = active_id(tx)
    ready = request.app.state.provider is not None and active is not None
    return success(request, dict(status="ok" if ready else "degraded", api_version="1", database_ready=True,
                                provider=request.app.state.settings.llm_provider, model=request.app.state.settings.llm_model, is_demo=request.app.state.settings.llm_provider == "fake",
                                evaluation_ready=ready, dataset_ready=bool(request.app.state.settings.dataset_url), active_checklist_version_id=active,
                                scoring_policy=request.app.state.settings.scoring_policy, prompt_version=PROMPT_VERSION))


@router.post("/api/imports/dataset", response_model=s.Success[s.ImportReport])
def import_dataset(body: s.DatasetImportRequest, request: Request):
    payload = imports.fetch_dataset(request.app.state.settings, body.group_id)
    try:
        with request.app.state.store.transaction() as tx:
            result = imports.import_payload(tx, payload, body.group_id)
    except IngestionError as exc:
        if exc.status == 400:
            raise APIError(502, "DATASET_UPSTREAM_ERROR", "Источник вернул некорректный набор.") from None
        raise
    return success(request, result)


@router.post("/api/imports/file", response_model=s.Success[s.ImportReport])
async def import_file(request: Request, file: UploadFile = File(...), group_id: str | None = Form(None)):
    form = await request.form()
    if set(form) - {"file", "group_id"} or len(form.getlist("file")) != 1 or len(form.getlist("group_id")) > 1:
        raise APIError(422, "VALIDATION_ERROR", "Неизвестные или повторные поля формы.")
    payload = imports.decode_json(await file.read(request.app.state.settings.max_upload_bytes + 1))
    with request.app.state.store.transaction() as tx:
        result = imports.import_payload(tx, payload, group_id)
    return success(request, result)


@router.get("/api/conversations", response_model=s.Success[s.Page[s.ConversationSummary]])
def conversations(request: Request, limit: Limit = 25, offset: Offset = 0, group_id: str | None = None,
                  language: str | None = None, channel: str | None = None, q: str | None = None,
                  evaluation_status: Literal["not_evaluated", "completed", "manual_review", "failed"] | None = None,
                  has_gross_error: bool | None = None, has_open_appeals: bool | None = None):
    with request.app.state.store.transaction(readonly=True) as tx:
        items = conversation_summaries(tx, filtered(tx.all("conversations"), dict(group_id=group_id)))
        items = filtered(items, dict(language=language, channel=channel, has_open_appeals=has_open_appeals))
        if q is not None:
            items = [c for c in items if q.casefold() in c["ref"]["conversation_id"].casefold()]
        items = filter_evaluation_state(items, evaluation_status, has_gross_error)
        result = page(items, limit, offset, key=lambda c: (c["ref"]["group_id"], c["ref"]["conversation_id"], c["ref"]["id"]))
    return success(request, result)


@router.get("/api/conversations/{id}", response_model=s.Success[s.ConversationDetail])
def conversation(id: str, request: Request, revision_id: str | None = None):
    with request.app.state.store.transaction(readonly=True) as tx:
        current = require(tx.get("conversations", id))
        result = require(tx.get("revisions", revision_id or current["revision_id"]))
        if result["ref"]["id"] != id:
            require(None)
    return success(request, conversation_detail(result))


@router.get("/api/conversations/{id}/revisions", response_model=s.Success[s.Page[s.ConversationRevision]])
def revisions(id: str, request: Request, limit: Limit = 25, offset: Offset = 0):
    with request.app.state.store.transaction(readonly=True) as tx:
        require(tx.get("conversations", id))
        items = [revision_summary(r) for r in tx.all("revisions") if r["ref"]["id"] == id]
    return success(request, page(items, limit, offset, key=lambda r: -r["ref"]["revision"]))


@router.get("/api/checklists", response_model=s.Success[s.Page[s.Checklist]])
def checklists(request: Request, limit: Limit = 25, offset: Offset = 0):
    with request.app.state.store.transaction(readonly=True) as tx:
        result = page(tx.all("checklists"), limit, offset)
    return success(request, result)


@router.post("/api/checklists", status_code=201, response_model=s.Success[s.ChecklistVersion])
def create_checklist(body: s.CreateChecklistRequest, request: Request):
    with request.app.state.store.transaction() as tx:
        result = catalog.create_version(tx, body.model_dump())
    return success(request, result)


@router.post("/api/checklists/validate", response_model=s.Success[s.ValidationReport])
def validate_checklist(body: s.ChecklistDefinition, request: Request):
    _, errors, warnings = normalize_definition(body.model_dump())
    return success(request, dict(valid=not errors, errors=errors, warnings=warnings))


register_document_route("/api/checklists/{id}", "checklists", s.Checklist, "checklist")


@router.get("/api/checklists/{id}/versions", response_model=s.Success[s.Page[s.ChecklistVersion]])
def versions(id: str, request: Request, limit: Limit = 25, offset: Offset = 0):
    with request.app.state.store.transaction(readonly=True) as tx:
        require(tx.get("checklists", id))
        items = [version(tx, v["id"]) for v in tx.all("versions") if v["checklist_id"] == id]
        result = page(items, limit, offset)
    return success(request, result)


@router.post("/api/checklists/{id}/versions", status_code=201, response_model=s.Success[s.ChecklistVersion])
def create_version(id: str, body: s.CreateVersionRequest, request: Request):
    definition = body.model_dump(exclude={"expected_latest_version_id", "activate", "expected_active_version_id"})
    with request.app.state.store.transaction() as tx:
        result = catalog.create_version(tx, definition, id, body.expected_latest_version_id, body.activate, body.expected_active_version_id)
    return success(request, result)


@router.get("/api/checklist-versions/{id}", response_model=s.Success[s.ChecklistVersion])
def checklist_version(id: str, request: Request):
    with request.app.state.store.transaction(readonly=True) as tx:
        result = version(tx, id)
    return success(request, result)


@router.post("/api/checklist-versions/{id}/activate", response_model=s.Success[s.ActivationResult])
def activate(id: str, body: s.ActivationRequest, request: Request):
    with request.app.state.store.transaction() as tx:
        result = catalog.activate(tx, id, body.expected_active_version_id)
    return success(request, result)


@router.post("/api/evaluations", status_code=202, response_model=s.Success[s.Job])
def start_evaluation(body: s.EvaluationRequest, request: Request):
    with request.app.state.store.transaction() as tx:
        result = request.app.state.runner.enqueue(tx, body.model_dump())
    request.app.state.runner.submit(result["id"])
    return success(request, result)


register_document_route("/api/jobs/{id}", "jobs", s.Job, "job")


@router.get("/api/evaluations", response_model=s.Success[s.Page[s.EvaluationSummary]])
def evaluations(request: Request, limit: Limit = 25, offset: Offset = 0, conversation_id: str | None = None,
                revision_id: str | None = None, checklist_version_id: str | None = None,
                status: s.EvaluationStatus | None = None, is_demo: bool | None = None):
    with request.app.state.store.transaction(readonly=True) as tx:
        open_appeal_ids = open_appeal_evaluation_ids(tx)
        items = [evaluation_summary(tx, e, open_appeal_ids) for e in tx.all("evaluations")
                 if (conversation_id is None or e["conversation"]["id"] == conversation_id)
                 and (revision_id is None or e["conversation"]["revision_id"] == revision_id)]
        result = page(filtered(items, dict(checklist_version_id=checklist_version_id, status=status, is_demo=is_demo)), limit, offset)
    return success(request, result)


@router.get("/api/evaluations/compare", response_model=s.Success[s.EvaluationComparison])
def compare(request: Request, left_id: str, right_id: str):
    with request.app.state.store.transaction(readonly=True) as tx:
        result = reviews.compare(tx, left_id, right_id)
    return success(request, result)


register_document_route("/api/evaluations/{id}", "evaluations", s.Evaluation, "evaluation")


@router.post("/api/appeals", status_code=201, response_model=s.Success[s.Appeal])
def create_appeal(body: s.CreateAppealRequest, request: Request):
    with request.app.state.store.transaction() as tx:
        result = reviews.create_appeal(tx, body.model_dump())
    return success(request, result)


@router.get("/api/appeals", response_model=s.Success[s.Page[s.Appeal]])
def appeals(request: Request, limit: Limit = 25, offset: Offset = 0,
            evaluation_id: str | None = None, status: Literal["open", "resolved"] | None = None):
    with request.app.state.store.transaction(readonly=True) as tx:
        result = page(filtered(tx.all("appeals"), dict(evaluation_id=evaluation_id, status=status)), limit, offset)
    return success(request, result)


register_document_route("/api/appeals/{id}", "appeals", s.Appeal, "appeal")


@router.post("/api/appeals/{id}/decision", response_model=s.Success[s.AppealDecisionResult])
def decision(id: str, body: s.AppealDecisionRequest, request: Request):
    with request.app.state.store.transaction() as tx:
        result = reviews.decide(tx, id, body.model_dump())
    return success(request, result)


@router.get("/api/history", response_model=s.Success[s.Page[s.HistoryEvent]])
def events(request: Request, limit: Limit = 25, offset: Offset = 0, conversation_id: str | None = None,
           evaluation_id: str | None = None, appeal_id: str | None = None, checklist_version_id: str | None = None,
           event_type: str | None = None):
    with request.app.state.store.transaction(readonly=True) as tx:
        result = page(filtered(tx.all("history"), dict(conversation_id=conversation_id, evaluation_id=evaluation_id,
                                                       appeal_id=appeal_id, checklist_version_id=checklist_version_id,
                                                       event_type=event_type)), limit, offset)
    return success(request, result)
