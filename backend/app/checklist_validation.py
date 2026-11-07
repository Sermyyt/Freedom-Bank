"""Checklist business rules; structural request validation belongs to schemas.py."""
from copy import deepcopy
import math

from app.scoring import same_value, scale_normalized


def _finite_number(value):
    return type(value) in (int, float) and math.isfinite(value)


def normalize_definition(definition):
    normalized = deepcopy(definition)
    errors, warnings = [], []

    def error(path, message):
        errors.append({"path": ["body", *path], "code": "INVALID_CHECKLIST", "message": message})

    for key in ("name", "description"):
        if not isinstance(normalized.get(key), str) or not normalized[key].strip():
            error([key], "Поле должно содержать непустой текст.")
    criteria = normalized.get("criteria", [])
    if not criteria:
        error(["criteria"], "Добавьте хотя бы один критерий.")
    seen = set()
    for index, criterion in enumerate(criteria):
        path = ["criteria", index]
        for key in ("id", "name", "description"):
            if not isinstance(criterion.get(key), str) or not criterion[key].strip():
                error([*path, key], "Поле должно содержать непустой текст.")
        if criterion.get("id") in seen:
            error([*path, "id"], "ID критерия повторяется.")
        seen.add(criterion.get("id"))
        kind, weight = criterion.get("answer_type"), criterion.get("weight")
        if kind not in ("binary", "scale", "flag"):
            error([*path, "answer_type"], "Неизвестный тип ответа.")
        if kind == "flag":
            if weight is not None:
                error([*path, "weight"], "Флаг не имеет веса.")
        elif not _finite_number(weight) or weight <= 0:
            error([*path, "weight"], "Вес должен быть положительным конечным числом.")
        if criterion.get("na_allowed") and not (criterion.get("na_condition") or "").strip():
            error([*path, "na_condition"], "Для N/A необходимо условие неприменимости.")
        options = criterion.get("options", [])
        if not options:
            error([*path, "options"], "Шкала не может быть пустой.")
        values = [option.get("value") for option in options]
        if any(same_value(value, previous) for i, value in enumerate(values) for previous in values[:i]):
            error([*path, "options"], "Варианты ответа не должны повторяться.")
        if kind in ("binary", "flag") and (len(values) != 2 or
                any(type(value) is not bool for value in values) or set(values) != {False, True}):
            error([*path, "options"], "Нужны ровно два логических ответа: true и false.")
        numeric_scale = bool(values) and all(_finite_number(value) for value in values)
        if kind == "scale" and not numeric_scale:
            error([*path, "options"], "Ступени шкалы должны быть конечными числами, не boolean.")
        for option_index, option in enumerate(options):
            target = [*path, "options", option_index, "normalized"]
            value = option.get("normalized")
            if kind == "flag":
                if value is not None:
                    error(target, "Нормирование флага должно быть null.")
                option["normalized"] = None
                continue
            if kind == "scale" and value is None and numeric_scale:
                try:
                    value = scale_normalized(option["value"], max(values))
                    option["normalized"] = value
                except ValueError:
                    error(target, "Для автоматического нормирования максимум шкалы должен быть положительным.")
                    continue
            if not _finite_number(value) or not 0 <= value <= 1:
                error(target, "Нормированное значение должно быть числом от 0 до 1.")
            elif kind == "binary" and type(option["value"]) is bool and value != int(option["value"]):
                error(target, "Для true нормирование равно 1, для false — 0.")
    return normalized, errors, warnings
