"""Human review is append-only and updates the final snapshot atomically."""
from copy import deepcopy
from . import scoring
from .errors import APIError, require
from .evaluation import validate_human_result
from .service import conflict, evaluation_summary, history
from .storage import new_id, now


def create_appeal(tx, request):
    evaluation = require(tx.get("evaluations", request["evaluation_id"]))
    if request["criterion_id"] not in {c["id"] for c in evaluation["checklist_snapshot"]["criteria"]}:
        raise APIError(422, "INVALID_ANSWER", "Критерий отсутствует в сохранённой оценке.")
    if any(a["evaluation_id"] == evaluation["id"] and a["criterion_id"] == request["criterion_id"]
           and a["status"] == "open" for a in tx.all("appeals")):
        raise APIError(409, "DUPLICATE_OPEN_APPEAL", "По этому критерию уже открыта апелляция.")
    appeal = dict(id=new_id(), **request, status="open", opened_at_final_revision=evaluation["final_revision"],
                  decision=None, created_at=now(), resolved_at=None)
    tx.put("appeals", appeal["id"], appeal)
    history(tx, "appeal_created", "appeal", appeal["id"], "Подана апелляция.", "demo_operator",
            conversation_id=evaluation["conversation"]["id"], evaluation_id=evaluation["id"], appeal_id=appeal["id"])
    return appeal


def decide(tx, identifier, request):
    appeal = require(tx.get("appeals", identifier))
    if appeal["status"] != "open":
        raise APIError(409, "APPEAL_ALREADY_RESOLVED", "Решение по апелляции уже принято.")
    evaluation = require(tx.get("evaluations", appeal["evaluation_id"]))
    if request["expected_final_revision"] != evaluation["final_revision"]:
        conflict()
    criteria = evaluation["checklist_snapshot"]["criteria"]
    criterion = next(c for c in criteria if c["id"] == appeal["criterion_id"])
    results = deepcopy(evaluation["final"]["criteria"])
    index = next(i for i, result in enumerate(results) if result["criterion_id"] == appeal["criterion_id"])
    before = deepcopy(results[index])
    revision = require(tx.get("revisions", evaluation["conversation"]["revision_id"]))
    if request["action"] == "change":
        results[index] = validate_human_result(criterion, request, revision["transcript"])
    else:
        results[index]["manual_review"] = results[index]["answer"]["status"] == "invalid"
        if not results[index]["manual_review"]:
            results[index]["manual_review_reasons"] = []
    evaluation["final"] = scoring.score(evaluation["checklist_snapshot"], results, evaluation["scoring_policy"],
                                         manual_review_reasons=revision["manual_review_reasons"])
    evaluation["final_revision"] += 1
    timestamp, decision_id = now(), new_id()
    decision = dict(id=decision_id, action=request["action"], reason=request["reason"], before=before,
                    after=deepcopy(evaluation["final"]["criteria"][index]),
                    resulting_final_revision=evaluation["final_revision"], created_at=timestamp)
    appeal.update(status="resolved", decision=decision, resolved_at=timestamp)
    evaluation["applied_decision_ids"].append(decision_id)
    evaluation["updated_at"] = timestamp
    tx.put("appeals", identifier, appeal)
    tx.put("evaluations", evaluation["id"], evaluation)
    history(tx, "appeal_resolved", "appeal", identifier, "Решение проверяющего сохранено.", "demo_reviewer",
            conversation_id=evaluation["conversation"]["id"], evaluation_id=evaluation["id"], appeal_id=identifier,
            decision_id=decision_id, final_revision=evaluation["final_revision"])
    return dict(appeal=appeal, evaluation=evaluation)


def compare(tx, left_id, right_id):
    left, right = require(tx.get("evaluations", left_id)), require(tx.get("evaluations", right_id))
    if left["conversation"]["revision_id"] != right["conversation"]["revision_id"]:
        raise APIError(409, "INCOMPARABLE_EVALUATIONS", "Для сравнения нужна одна ревизия разговора.")
    definitions = [{c["id"]: c for c in e["checklist_snapshot"]["criteria"]} for e in (left, right)]
    results = [{c["criterion_id"]: c for c in e["final"]["criteria"]} for e in (left, right)]
    identifiers = list(definitions[1]) + [key for key in definitions[0] if key not in definitions[1]]
    comparisons = []
    for key in identifiers:
        a, b = definitions[0].get(key), definitions[1].get(key)
        ar, br = results[0].get(key), results[1].get(key)
        if a is None:
            change = "added"
        elif b is None:
            change = "removed"
        elif {k: v for k, v in a.items() if k != "weight"} != {k: v for k, v in b.items() if k != "weight"}:
            change = "definition_changed"
        elif a["weight"] != b["weight"]:
            change = "weight_changed"
        else:
            change = "unchanged"
        comparisons.append(dict(criterion_id=key, change=change, left_definition=a, right_definition=b,
                                left_result=ar, right_result=br,
                                contribution_delta=scoring.difference(br["contribution"], ar["contribution"]) if ar and br else None))
    return dict(conversation=left["conversation"], left=evaluation_summary(tx, left), right=evaluation_summary(tx, right),
                left_final_revision=left["final_revision"], right_final_revision=right["final_revision"],
                total_delta=scoring.difference(right["final"]["total"], left["final"]["total"]), criteria=comparisons)
