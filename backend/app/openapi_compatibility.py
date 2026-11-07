"""Keep published schema names when Pydantic merges identical input/output schemas."""
from copy import deepcopy


_COMMON = "#/components/schemas/ChecklistDefinition"
_INPUT = _COMMON + "-Input"
_OUTPUT = _COMMON + "-Output"


def _replace_references(value, source, target):
    if isinstance(value, dict):
        if value.get("$ref") == source:
            value["$ref"] = target
        for child in value.values():
            _replace_references(child, source, target)
    elif isinstance(value, list):
        for child in value:
            _replace_references(child, source, target)


def _restore_checklist_names(document):
    schemas = document["components"]["schemas"]
    definition = schemas.pop("ChecklistDefinition", None)
    if definition is None:
        return
    for name in ("ChecklistDefinition-Input", "ChecklistDefinition-Output"):
        schemas.setdefault(name, deepcopy(definition))
    _replace_references(document, _COMMON, _OUTPUT)
    for path in document["paths"].values():
        for operation in path.values():
            if isinstance(operation, dict):
                _replace_references(operation.get("requestBody"), _OUTPUT, _INPUT)


def install_openapi_compatibility(app):
    generate = app.openapi

    def openapi():
        document = generate()
        _restore_checklist_names(document)
        return document

    app.openapi = openapi
