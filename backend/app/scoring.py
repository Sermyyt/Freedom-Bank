"""All score arithmetic, including normalization and comparison, lives here."""
from copy import deepcopy
from decimal import Decimal, ROUND_HALF_EVEN, ROUND_HALF_UP, localcontext


def decimal(value):
    return Decimal(str(value))


def scale_normalized(value, maximum):
    if maximum <= 0:
        raise ValueError("Для автоматического нормирования максимум шкалы должен быть положительным.")
    with localcontext() as context:
        context.prec = 50
        return float(decimal(value) / decimal(maximum))


def difference(right, left):
    return None if right is None or left is None else float(decimal(right) - decimal(left))


def sum_cost(previous, value):
    return float(decimal(previous or 0) + decimal(value))


def same_value(left, right):
    if isinstance(left, bool) or isinstance(right, bool):
        return type(left) is bool and type(right) is bool and left == right
    return left == right


def _number(value):
    return None if value is None else float(value)


def score(definition, results, policy, manual_review_reasons=None):
    """Return a new snapshot; never mutate the persisted answers or definition."""
    with localcontext() as context:
        context.prec = 50
        return _score(definition, results, policy, manual_review_reasons or [])


def _score(definition, results, policy, manual_review_reasons):
    by_id = {result["criterion_id"]: result for result in results}
    prepared, flags, sections = [], [], {}
    applicable_weight = Decimal(0)
    weighted_sum = Decimal(0)
    incomplete = False
    reasons = list(manual_review_reasons)
    for criterion in definition["criteria"]:
        result = deepcopy(by_id[criterion["id"]])
        result.update(original_weight=None, normalized_answer=None, effective_weight=None,
                      weighted_points=None, contribution=None)
        prepared.append(result)
        reasons.extend(result.get("manual_review_reasons", []))
        answer = result["answer"]
        if answer["status"] == "invalid":
            reasons.append("Есть критерий без допустимого ответа.")
        if criterion["answer_type"] == "flag":
            flags.append({"criterion_id": criterion["id"],
                          "value": answer["value"] if answer["status"] == "answered" else None})
            continue
        weight = decimal(criterion["weight"])
        result["original_weight"] = float(weight)
        section = sections.setdefault(criterion["section"],
                                      {"weight": Decimal(0), "points": Decimal(0), "invalid": False})
        if answer["status"] == "not_applicable":
            continue
        applicable_weight += weight
        section["weight"] += weight
        option = next((option for option in criterion["options"]
                       if answer["status"] == "answered" and same_value(option["value"], answer["value"])), None)
        if option is None:
            incomplete = True
            section["invalid"] = True
            continue
        normalized = decimal(option["normalized"])
        points = weight * normalized
        weighted_sum += points
        section["points"] += points
        result["normalized_answer"] = float(normalized)
        result["weighted_points"] = float(points)

    for criterion, result in zip(definition["criteria"], prepared):
        if criterion["answer_type"] == "flag" or result["answer"]["status"] == "not_applicable":
            continue
        if applicable_weight:
            result["effective_weight"] = float(Decimal(100) * decimal(criterion["weight"]) / applicable_weight)
            if not incomplete and result["weighted_points"] is not None:
                # Recompute from the original Decimal operands, never a serialized float.
                option = next(option for option in criterion["options"]
                              if same_value(option["value"], result["answer"]["value"]))
                result["contribution"] = float(Decimal(100) * decimal(criterion["weight"])
                                               * decimal(option["normalized"]) / applicable_weight)

    section_results = []
    for name, values in sections.items():
        weight, points = values["weight"], values["points"]
        invalid = values["invalid"]
        section_results.append({
            "section": name, "applicable_weight": float(weight),
            "weighted_points": None if invalid else float(points),
            "completion_percent": float(Decimal(100) * points / weight) if weight and not invalid else None,
            "contribution": float(Decimal(100) * points / applicable_weight)
            if applicable_weight and not incomplete else None,
        })
    flag_values = [flag["value"] for flag in flags]
    gross_error = True if any(value is True for value in flag_values) else (
        None if any(value is None for value in flag_values) else False)
    reason, total = None, None
    if not applicable_weight:
        reason = "Нет применимых критериев с положительным весом."
    elif incomplete:
        reason = "Итог недоступен: есть применимые критерии без допустимого ответа."
    else:
        rounding = {"half_up": ROUND_HALF_UP, "half_even": ROUND_HALF_EVEN}[policy["rounding"]]
        quantum = Decimal(1).scaleb(-policy["decimals"])
        total = float((Decimal(100) * weighted_sum / applicable_weight).quantize(quantum, rounding=rounding))
    total_before_override = total
    if total is not None and gross_error is True and policy["gross_error_zeroes_total"]:
        total = 0.0
        reason = "Итог обнулён по сохранённой политике грубого нарушения."
    reasons = list(dict.fromkeys(reasons))
    needs_review = bool(reasons) or incomplete or any(result.get("manual_review") for result in prepared)
    return {
        "status": "manual_review" if needs_review else "completed", "criteria": prepared,
        "total": total, "total_before_override": total_before_override, "total_reason": reason,
        "applicable_weight": float(applicable_weight), "sections": section_results,
        "flags": flags, "gross_error": gross_error, "manual_review_reasons": reasons,
    }
