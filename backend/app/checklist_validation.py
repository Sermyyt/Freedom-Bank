"""Checklist business rules; structural request validation belongs to schemas.py."""
from copy import deepcopy
import math

from app.scoring import finite_weight_total, same_value, scale_normalized


def _finite_number(value):
    return type(value) in (int, float) and math.isfinite(value)


def _error(errors, path, message):
    errors.append({"path": ["body", *path], "code": "INVALID_CHECKLIST", "message": message})


def _required_text(value, fields, path, errors):
    for key in fields:
        if not isinstance(value.get(key), str) or not value[key].strip():
            _error(errors, [*path, key], "Поле должно содержать непустой текст.")


def _validate_identity(criterion, path, seen, errors):
    _required_text(criterion, ("id", "name", "description"), path, errors)
    if criterion.get("id") in seen:
        _error(errors, [*path, "id"], "ID критерия повторяется.")
    seen.add(criterion.get("id"))


def _validate_weight(criterion, path, errors):
    kind, weight = criterion.get("answer_type"), criterion.get("weight")
    if kind not in ("binary", "scale", "flag"):
        _error(errors, [*path, "answer_type"], "Неизвестный тип ответа.")
    if kind == "flag":
        if weight is not None:
            _error(errors, [*path, "weight"], "Флаг не имеет веса.")
    elif not _finite_number(weight) or weight <= 0:
        _error(errors, [*path, "weight"], "Вес должен быть положительным конечным числом.")


def _validate_na(criterion, path, errors):
    if criterion.get("na_allowed") and not (criterion.get("na_condition") or "").strip():
        _error(errors, [*path, "na_condition"], "Для N/A необходимо условие неприменимости.")


def _validate_values(kind, values, path, errors):
    if not values:
        _error(errors, path, "Шкала не может быть пустой.")
    if any(same_value(value, previous) for index, value in enumerate(values) for previous in values[:index]):
        _error(errors, path, "Варианты ответа не должны повторяться.")
    if kind in ("binary", "flag"):
        _validate_booleans(values, path, errors)
    numeric = bool(values) and all(_finite_number(value) for value in values)
    if kind == "scale" and not numeric:
        _error(errors, path, "Ступени шкалы должны быть конечными числами, не boolean.")
    return numeric


def _validate_booleans(values, path, errors):
    if len(values) != 2 or any(type(value) is not bool for value in values) or set(values) != {False, True}:
        _error(errors, path, "Нужны ровно два логических ответа: true и false.")


def _fill_scale_default(option, maximum, path, errors):
    try:
        option["normalized"] = scale_normalized(option["value"], maximum)
        return True
    except ValueError:
        _error(errors, path, "Для автоматического нормирования максимум шкалы должен быть положительным.")
        return False


def _validate_normalized(option, kind, path, errors):
    value = option.get("normalized")
    if not _finite_number(value) or not 0 <= value <= 1:
        _error(errors, path, "Нормированное значение должно быть числом от 0 до 1.")
    elif kind == "binary" and type(option["value"]) is bool and value != int(option["value"]):
        _error(errors, path, "Для true нормирование равно 1, для false — 0.")


def _normalize_option(option, kind, maximum, path, errors):
    if kind == "flag":
        if option.get("normalized") is not None:
            _error(errors, path, "Нормирование флага должно быть null.")
        option["normalized"] = None
        return
    needs_default = kind == "scale" and option.get("normalized") is None and maximum is not None
    if needs_default and not _fill_scale_default(option, maximum, path, errors):
        return
    _validate_normalized(option, kind, path, errors)


def _validate_criterion(criterion, path, seen, errors):
    _validate_identity(criterion, path, seen, errors)
    _validate_weight(criterion, path, errors)
    _validate_na(criterion, path, errors)
    options = criterion.get("options", [])
    values = [option.get("value") for option in options]
    kind = criterion.get("answer_type")
    numeric = _validate_values(kind, values, [*path, "options"], errors)
    maximum = max(values) if numeric else None
    for index, option in enumerate(options):
        _normalize_option(option, kind, maximum, [*path, "options", index, "normalized"], errors)


def normalize_definition(definition):
    normalized = deepcopy(definition)
    errors, warnings, seen = [], [], set()
    _required_text(normalized, ("name", "description"), [], errors)
    criteria = normalized.get("criteria", [])
    if not criteria:
        _error(errors, ["criteria"], "Добавьте хотя бы один критерий.")
    for index, criterion in enumerate(criteria):
        _validate_criterion(criterion, ["criteria", index], seen, errors)
    weights = [criterion["weight"] for criterion in criteria
               if criterion.get("answer_type") != "flag" and _finite_number(criterion.get("weight"))
               and criterion["weight"] > 0]
    if not finite_weight_total(weights):
        _error(errors, ["criteria"], "Сумма весов превышает допустимый диапазон чисел.")
    return normalized, errors, warnings
