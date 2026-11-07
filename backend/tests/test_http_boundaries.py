"""HTTP boundary checks for upload limits, CORS and safe parsing errors."""
from fastapi.testclient import TestClient
from app.config import Settings
from app.main import create_app


def test_upload_limit_applies_to_streaming_bodies_without_content_length(tmp_path):
    app = create_app(Settings(database_path=tmp_path / "limits.db", max_upload_bytes=64))
    with TestClient(app) as client:
        response = client.post("/api/evaluations", content=iter([b"a" * 40, b"b" * 40]))
        assert response.status_code == 413
        assert response.json()["error"]["code"] == "PAYLOAD_TOO_LARGE"
        assert response.json()["meta"]["request_id"]


def test_invalid_json_and_validation_do_not_echo_values(tmp_path):
    with TestClient(create_app(Settings(database_path=tmp_path / "parse.db"))) as client:
        response = client.post("/api/evaluations", content='{"secret-marker":', headers={"Content-Type": "application/json"})
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "INVALID_JSON"
        assert "secret-marker" not in response.text
        response = client.post("/api/evaluations", json={"revision_ids": "private-input"})
        assert response.status_code == 422
        assert "private-input" not in response.text


def test_cors_allows_only_configured_origin_and_keeps_error_envelope(tmp_path):
    app = create_app(Settings(database_path=tmp_path / "cors.db", cors_origins=("http://localhost:3000",)))
    with TestClient(app) as client:
        response = client.options("/api/evaluations", headers={"Origin": "http://localhost:3000",
                                  "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type"})
        assert response.status_code == 200
        assert response.headers["access-control-allow-origin"] == "http://localhost:3000"
        response = client.get("/api/missing", headers={"Origin": "http://localhost:3000"})
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "NOT_FOUND"
        assert response.headers["access-control-allow-origin"] == "http://localhost:3000"
        assert "access-control-allow-origin" not in client.get("/api/health", headers={"Origin": "http://unlisted.invalid"}).headers


def test_unknown_and_duplicate_query_parameters_are_rejected(tmp_path):
    with TestClient(create_app(Settings(database_path=tmp_path / "query.db"))) as client:
        assert client.get("/api/conversations?unknown=value").status_code == 422
        assert client.get("/api/conversations?limit=1&limit=2").status_code == 422
        assert client.get("/api/conversations?limit=1&offset=0").status_code == 200
