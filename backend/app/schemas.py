"""Public API v1 models; rule validation belongs to the domain layer."""
from __future__ import annotations

from typing import Annotated, Generic, Literal, TypeVar

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, StrictStr, model_validator


Number = Annotated[float, Field(strict=True, allow_inf_nan=False)]
AnswerValue = StrictBool | Number
CriterionType = Literal["binary", "scale", "flag"]
EvaluationStatus = Literal["completed", "manual_review", "failed"]
JobStatus = Literal["queued", "running", "completed", "failed"]
Phase = Literal["pre_operator", "client", "hold", "internal_consult", "after_end"]
T = TypeVar("T")


class APIModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Meta(APIModel):
    request_id: StrictStr


class Success(APIModel, Generic[T]):
    data: T
    meta: Meta


class Page(APIModel, Generic[T]):
    items: list[T]
    total: StrictInt
    limit: StrictInt
    offset: StrictInt


class ErrorDetail(APIModel):
    path: list[StrictStr | StrictInt]
    code: StrictStr
    message: StrictStr


class ErrorBody(APIModel):
    code: StrictStr
    message: StrictStr
    details: list[ErrorDetail]
    retryable: StrictBool


class Failure(APIModel):
    error: ErrorBody
    meta: Meta


class ScoringPolicy(APIModel):
    rounding: Literal["half_up", "half_even"] = "half_up"
    decimals: Annotated[StrictInt, Field(ge=0, le=10)] = 2
    gross_error_zeroes_total: StrictBool = False


class Health(APIModel):
    status: Literal["ok", "degraded"]
    api_version: Literal["1"]
    database_ready: StrictBool
    provider: Literal["fake", "openai", "anthropic"]
    model: StrictStr | None
    is_demo: StrictBool
    evaluation_ready: StrictBool
    dataset_ready: StrictBool
    active_checklist_version_id: StrictStr | None
    scoring_policy: ScoringPolicy
    prompt_version: StrictStr


class DatasetImportRequest(APIModel):
    group_id: StrictStr

    @model_validator(mode="after")
    def nonempty_group(self) -> DatasetImportRequest:
        if not self.group_id.strip():
            raise ValueError("Укажите непустую группу.")
        return self


class ImportIssue(APIModel):
    record_index: StrictInt | None
    conversation_id: StrictStr | None
    message_id: StrictInt | None
    code: StrictStr
    message: StrictStr
    path: list[StrictStr | StrictInt]


class UnknownPhrase(APIModel):
    text: StrictStr
    count: StrictInt


class ImportReport(APIModel):
    import_id: StrictStr
    group_id: StrictStr
    received: StrictInt
    created: StrictInt
    unchanged: StrictInt
    revised: StrictInt
    skipped: StrictInt
    errors: list[ImportIssue]
    warnings: list[ImportIssue]
    unknown_system_phrases: list[UnknownPhrase]
    created_at: StrictStr


class ConversationRef(APIModel):
    id: StrictStr
    group_id: StrictStr
    conversation_id: StrictStr
    revision_id: StrictStr
    revision: StrictInt


class EvaluationSummary(APIModel):
    id: StrictStr
    conversation: ConversationRef
    checklist_version_id: StrictStr
    status: EvaluationStatus
    is_demo: StrictBool
    original_total: Number | None
    final_total: Number | None
    gross_error: StrictBool | None
    has_open_appeals: StrictBool
    created_at: StrictStr
    scoring_policy: ScoringPolicy | None = None


class ConversationSummary(APIModel):
    ref: ConversationRef
    channel: StrictStr
    language: StrictStr
    message_count: StrictInt
    has_audio: StrictBool
    latest_evaluation: EvaluationSummary | None
    has_open_appeals: StrictBool
    created_at: StrictStr
    updated_at: StrictStr


class ConversationRevision(APIModel):
    ref: ConversationRef
    channel: StrictStr
    language: StrictStr
    message_count: StrictInt
    content_hash: StrictStr
    created_at: StrictStr


class Message(APIModel):
    id: StrictInt
    timestamp: StrictStr
    speaker: StrictStr
    text: StrictStr
    offset_sec: Number | None
    audio_offset_sec: Number | None
    phase: Phase
    client_facing: StrictBool
    system_event: StrictStr | None
    flags: list[StrictStr]
    duplicate_of_message_id: StrictInt | None


class ConversationDetail(APIModel):
    ref: ConversationRef
    channel: StrictStr
    language: StrictStr
    transcript: list[Message]
    audio_url: StrictStr | None
    audio_offset_reliable: StrictBool
    manual_review_reasons: list[StrictStr]
    warnings: list[StrictStr]
    created_at: StrictStr


class AnswerOption(APIModel):
    value: AnswerValue
    label: StrictStr
    description: StrictStr
    normalized: Number | None = None


class Criterion(APIModel):
    id: StrictStr
    name: StrictStr
    description: StrictStr
    section: StrictStr
    answer_type: CriterionType
    weight: Number | None
    options: list[AnswerOption]
    na_allowed: StrictBool
    na_condition: StrictStr | None


class ChecklistDefinition(APIModel):
    name: StrictStr
    description: StrictStr
    criteria: list[Criterion]


class CreateChecklistRequest(ChecklistDefinition):
    pass


class CreateVersionRequest(ChecklistDefinition):
    expected_latest_version_id: StrictStr
    activate: StrictBool = False
    expected_active_version_id: StrictStr | None = None

    @model_validator(mode="after")
    def activation_precondition(self) -> CreateVersionRequest:
        if not self.expected_latest_version_id.strip():
            raise ValueError("Укажите ожидаемую последнюю версию.")
        if self.activate and "expected_active_version_id" not in self.model_fields_set:
            raise ValueError("Для активации передайте expected_active_version_id, включая null.")
        return self


class Checklist(APIModel):
    id: StrictStr
    name: StrictStr
    description: StrictStr
    latest_version_id: StrictStr
    latest_version: StrictInt
    created_at: StrictStr


class ChecklistVersion(APIModel):
    id: StrictStr
    checklist_id: StrictStr
    version: StrictInt
    definition: ChecklistDefinition
    content_hash: StrictStr
    is_active: StrictBool
    created_at: StrictStr


class ValidationReport(APIModel):
    valid: StrictBool
    errors: list[ErrorDetail]
    warnings: list[ErrorDetail]


class ActivationRequest(APIModel):
    expected_active_version_id: StrictStr | None


class ActivationResult(APIModel):
    active_version_id: StrictStr
    previous_version_id: StrictStr | None


class EvaluationRequest(APIModel):
    revision_ids: list[StrictStr] | None = None
    group_id: StrictStr | None = None
    checklist_version_id: StrictStr | None = None
    force: StrictBool = False

    @model_validator(mode="after")
    def exactly_one_selector(self) -> EvaluationRequest:
        if (self.revision_ids is None) == (self.group_id is None):
            raise ValueError("Укажите ровно одно из group_id или revision_ids.")
        if self.group_id is not None and not self.group_id.strip():
            raise ValueError("Укажите непустую группу.")
        if self.revision_ids is not None:
            validate_revision_ids(self.revision_ids)
        if self.checklist_version_id is not None and not self.checklist_version_id.strip():
            raise ValueError("ID версии чек-листа не может быть пустым.")
        return self


def validate_revision_ids(identifiers):
    if not 1 <= len(identifiers) <= 1000:
        raise ValueError("Число ревизий должно быть от 1 до 1000.")
    if any(not item.strip() for item in identifiers):
        raise ValueError("ID ревизии не может быть пустым.")
    if len(set(identifiers)) != len(identifiers):
        raise ValueError("ID ревизий не должны повторяться.")


class OperationError(APIModel):
    code: StrictStr
    message: StrictStr
    retryable: StrictBool


class JobItem(APIModel):
    revision_id: StrictStr
    status: JobStatus
    evaluation_id: StrictStr | None
    error: OperationError | None


class Job(APIModel):
    id: StrictStr
    status: JobStatus
    checklist_version_id: StrictStr
    is_demo: StrictBool
    provider: StrictStr
    total: StrictInt
    processed: StrictInt
    succeeded: StrictInt
    failed: StrictInt
    manual_review_count: StrictInt
    progress_percent: Number
    items: list[JobItem]
    error: OperationError | None
    created_at: StrictStr
    started_at: StrictStr | None
    finished_at: StrictStr | None


class Answer(APIModel):
    status: Literal["answered", "not_applicable", "invalid"]
    value: AnswerValue | None


class MessageRange(APIModel):
    start_id: Annotated[StrictInt, Field(ge=1)]
    end_id: Annotated[StrictInt, Field(ge=1)]

    @model_validator(mode="after")
    def ordered(self) -> MessageRange:
        if self.start_id > self.end_id:
            raise ValueError("Начало диапазона должно предшествовать концу.")
        return self


class Evidence(APIModel):
    message_id: StrictInt
    text: StrictStr
    speaker: StrictStr
    timestamp: StrictStr
    phase: StrictStr


class CriterionResult(APIModel):
    criterion_id: StrictStr
    answer: Answer
    rationale: StrictStr
    evidence_message_ids: list[StrictInt]
    evidence: list[Evidence]
    checked_range: MessageRange | None
    expected_action: StrictStr | None
    na_reason: StrictStr | None
    manual_review: StrictBool
    manual_review_reasons: list[StrictStr]
    warnings: list[StrictStr]
    reused: StrictBool
    reused_from_evaluation_id: StrictStr | None
    original_weight: Number | None
    normalized_answer: Number | None
    effective_weight: Number | None
    weighted_points: Number | None
    contribution: Number | None


class SectionResult(APIModel):
    section: StrictStr
    applicable_weight: Number
    weighted_points: Number | None
    completion_percent: Number | None
    contribution: Number | None


class FlagResult(APIModel):
    criterion_id: StrictStr
    value: StrictBool | None


class ResultSnapshot(APIModel):
    status: EvaluationStatus
    criteria: list[CriterionResult]
    total: Number | None
    total_before_override: Number | None
    total_reason: StrictStr | None
    applicable_weight: Number
    sections: list[SectionResult]
    flags: list[FlagResult]
    gross_error: StrictBool | None
    manual_review_reasons: list[StrictStr]


class Usage(APIModel):
    provider: StrictStr
    model: StrictStr | None
    prompt_version: StrictStr
    duration_ms: StrictInt
    calls: StrictInt
    input_tokens: StrictInt | None
    output_tokens: StrictInt | None
    cost: Number | None
    currency: StrictStr | None


class Evaluation(APIModel):
    id: StrictStr
    conversation: ConversationRef
    checklist_version_id: StrictStr
    checklist_snapshot: ChecklistDefinition
    scoring_policy: ScoringPolicy
    is_demo: StrictBool
    original: ResultSnapshot
    final: ResultSnapshot
    final_revision: StrictInt
    applied_decision_ids: list[StrictStr]
    usage: Usage
    created_at: StrictStr
    updated_at: StrictStr


class CreateAppealRequest(APIModel):
    evaluation_id: StrictStr
    criterion_id: StrictStr
    comment: StrictStr

    @model_validator(mode="after")
    def required_text(self) -> CreateAppealRequest:
        if any(not value.strip() for value in (self.evaluation_id, self.criterion_id, self.comment)):
            raise ValueError("ID и комментарий апелляции должны быть непустыми.")
        return self


class AppealDecisionRequest(APIModel):
    action: Literal["confirm", "change"]
    reason: StrictStr
    expected_final_revision: Annotated[StrictInt, Field(ge=0)]
    new_answer: Answer | None = None
    rationale: StrictStr | None = None
    evidence_message_ids: list[Annotated[StrictInt, Field(ge=1)]] = Field(default_factory=list)
    checked_range: MessageRange | None = None
    expected_action: StrictStr | None = None
    na_reason: StrictStr | None = None

    @model_validator(mode="after")
    def valid_decision(self) -> AppealDecisionRequest:
        if not self.reason.strip():
            raise ValueError("Причина решения обязательна.")
        if self.action == "confirm":
            self.validate_confirmation()
        else:
            if self.new_answer is None or self.new_answer.status == "invalid":
                raise ValueError("Для изменения требуется допустимый новый ответ.")
            if self.rationale is None:
                self.rationale = self.reason
            elif not self.rationale.strip():
                raise ValueError("Обоснование должно быть непустым или null.")
        return self

    def validate_confirmation(self):
        answer_fields = (self.new_answer, self.rationale, self.checked_range, self.expected_action, self.na_reason)
        if any(field is not None for field in answer_fields) or self.evidence_message_ids:
            raise ValueError("Подтверждение не должно содержать новый ответ или доказательства.")


class AppealDecision(APIModel):
    id: StrictStr
    action: Literal["confirm", "change"]
    reason: StrictStr
    before: CriterionResult
    after: CriterionResult
    resulting_final_revision: StrictInt
    created_at: StrictStr


class Appeal(APIModel):
    id: StrictStr
    evaluation_id: StrictStr
    criterion_id: StrictStr
    comment: StrictStr
    status: Literal["open", "resolved"]
    opened_at_final_revision: StrictInt
    decision: AppealDecision | None
    created_at: StrictStr
    resolved_at: StrictStr | None


class AppealDecisionResult(APIModel):
    appeal: Appeal
    evaluation: Evaluation


class CriterionComparison(APIModel):
    criterion_id: StrictStr
    change: Literal["unchanged", "added", "removed", "definition_changed", "weight_changed"]
    left_definition: Criterion | None
    right_definition: Criterion | None
    left_result: CriterionResult | None
    right_result: CriterionResult | None
    contribution_delta: Number | None


class EvaluationComparison(APIModel):
    conversation: ConversationRef
    left: EvaluationSummary
    right: EvaluationSummary
    left_final_revision: StrictInt
    right_final_revision: StrictInt
    total_delta: Number | None
    criteria: list[CriterionComparison]


class HistoryEvent(APIModel):
    id: StrictStr
    event_type: StrictStr
    entity_type: Literal["import", "conversation", "checklist_version", "evaluation", "appeal"]
    entity_id: StrictStr
    conversation_id: StrictStr | None
    evaluation_id: StrictStr | None
    appeal_id: StrictStr | None
    checklist_version_id: StrictStr | None
    decision_id: StrictStr | None
    final_revision: StrictInt | None
    summary: StrictStr
    actor: Literal["system", "demo_operator", "demo_reviewer"]
    created_at: StrictStr
