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



def score(definition, results, policy, manual_review_reasons=None):
    """Return a new snapshot; never mutate the persisted answers or definition."""
    with localcontext() as context:
        context.prec = 50
        return _score(definition, results, policy, manual_review_reasons or [])


def _answer_option(criterion, result):
    if result["answer"]["status"] != "answered":
        return None
    return next((option for option in criterion["options"]
                 if same_value(option["value"], result["answer"]["value"])), None)


def _prepared_result(criterion, source):
    result = deepcopy(source)
    result.update(original_weight=None, normalized_answer=None, effective_weight=None,
                  weighted_points=None, contribution=None)
    if criterion["answer_type"] != "flag":
        result["original_weight"] = float(decimal(criterion["weight"]))
    return result


class _WeightedTotals:
    def __init__(self):
        self.weight = Decimal(0)
        self.points = Decimal(0)
        self.incomplete = False
        self.sections = {}

    def add(self, criterion, result):
        section = self.sections.setdefault(criterion["section"],
                                           {"weight": Decimal(0), "points": Decimal(0), "invalid": False})
        if result["answer"]["status"] == "not_applicable":
            return
        weight = decimal(criterion["weight"])
        self.weight += weight
        section["weight"] += weight
        option = _answer_option(criterion, result)
        if option is None:
            self.incomplete = True
            section["invalid"] = True
            return
        normalized = decimal(option["normalized"])
        points = weight * normalized
        self.points += points
        section["points"] += points
        result["normalized_answer"] = float(normalized)
        result["weighted_points"] = float(points)

    def contribution(self, criterion, result):
        if criterion["answer_type"] == "flag" or result["answer"]["status"] == "not_applicable":
            return
        if self.weight:
            result["effective_weight"] = float(Decimal(100) * decimal(criterion["weight"]) / self.weight)
            if not self.incomplete and result["weighted_points"] is not None:
                option = _answer_option(criterion, result)
                result["contribution"] = float(Decimal(100) * decimal(criterion["weight"])
                                               * decimal(option["normalized"]) / self.weight)

    def section_result(self, name, values):
        weight, points, invalid = values["weight"], values["points"], values["invalid"]
        return {
            "section": name, "applicable_weight": float(weight),
            "weighted_points": None if invalid else float(points),
            "completion_percent": float(Decimal(100) * points / weight) if weight and not invalid else None,
            "contribution": float(Decimal(100) * points / self.weight) if self.weight and not self.incomplete else None,
        }

    def rounded_total(self, policy):
        if not self.weight:
            return None, "Нет применимых критериев с положительным весом."
        if self.incomplete:
            return None, "Итог недоступен: есть применимые критерии без допустимого ответа."
        rounding = {"half_up": ROUND_HALF_UP, "half_even": ROUND_HALF_EVEN}[policy["rounding"]]
        quantum = Decimal(1).scaleb(-policy["decimals"])
        value = (Decimal(100) * self.points / self.weight).quantize(quantum, rounding=rounding)
        return float(value), None


def _collect_results(definition, results, manual_review_reasons):
    by_id = {result["criterion_id"]: result for result in results}
    totals, prepared, flags, reasons = _WeightedTotals(), [], [], list(manual_review_reasons)
    for criterion in definition["criteria"]:
        result = _prepared_result(criterion, by_id[criterion["id"]])
        prepared.append(result)
        reasons.extend(result.get("manual_review_reasons", []))
        answer = result["answer"]
        if answer["status"] == "invalid":
            reasons.append("Есть критерий без допустимого ответа.")
        if criterion["answer_type"] == "flag":
            flags.append({"criterion_id": criterion["id"],
                          "value": answer["value"] if answer["status"] == "answered" else None})
        else:
            totals.add(criterion, result)
    return totals, prepared, flags, list(dict.fromkeys(reasons))


def _gross_error(flags):
    values = [flag["value"] for flag in flags]
    if any(value is True for value in values):
        return True
    return None if any(value is None for value in values) else False


def _score(definition, results, policy, manual_review_reasons):
    totals, prepared, flags, reasons = _collect_results(definition, results, manual_review_reasons)
    for criterion, result in zip(definition["criteria"], prepared):
        totals.contribution(criterion, result)
    gross_error = _gross_error(flags)
    total, reason = totals.rounded_total(policy)
    total_before_override = total
    if total is not None and gross_error is True and policy["gross_error_zeroes_total"]:
        total = 0.0
        reason = "Итог обнулён по сохранённой политике грубого нарушения."
    needs_review = bool(reasons) or totals.incomplete or any(result.get("manual_review") for result in prepared)
    return {
        "status": "manual_review" if needs_review else "completed", "criteria": prepared,
        "total": total, "total_before_override": total_before_override, "total_reason": reason,
        "applicable_weight": float(totals.weight),
        "sections": [totals.section_result(name, values) for name, values in totals.sections.items()],
        "flags": flags, "gross_error": gross_error, "manual_review_reasons": reasons,
    }
