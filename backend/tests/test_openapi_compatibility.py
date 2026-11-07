"""Published OpenAPI names remain stable across Python and Pydantic upgrades."""
import pytest


def test_openapi_keeps_both_published_checklist_definition_schemas(client):
    document = client.get("/openapi.json").json()
    assert client.get("/openapi.json").json() == document
    schemas = document["components"]["schemas"]
    input_schema = schemas["ChecklistDefinition-Input"]
    output_schema = schemas["ChecklistDefinition-Output"]
    assert input_schema == output_schema
    assert input_schema["required"] == ["name", "description", "criteria"]
    assert set(input_schema["properties"]) == {"name", "description", "criteria"}
    assert input_schema["additionalProperties"] is False


@pytest.mark.parametrize("path,expected", [
    (("paths", "/api/checklists/validate", "post", "requestBody", "content", "application/json", "schema"),
     "#/components/schemas/ChecklistDefinition-Input"),
    (("components", "schemas", "ChecklistVersion", "properties", "definition"),
     "#/components/schemas/ChecklistDefinition-Output"),
    (("components", "schemas", "Evaluation", "properties", "checklist_snapshot"),
     "#/components/schemas/ChecklistDefinition-Output"),
])
def test_openapi_keeps_published_checklist_references(client, path, expected):
    value = client.get("/openapi.json").json()
    for part in path:
        value = value[part]
    assert value["$ref"] == expected


def test_openapi_error_descriptions_do_not_follow_python_phrase_changes(client):
    document = client.get("/openapi.json").json()
    for path in document["paths"].values():
        for operation in path.values():
            responses = operation["responses"]
            assert responses["413"]["description"] == "Request Entity Too Large"
            assert responses["422"]["description"] == "Unprocessable Entity"
