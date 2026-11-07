"""Organizer transport failures and input limits are safe and offline."""
import io
from urllib.error import URLError
from urllib.parse import parse_qs, urlsplit

import pytest

from app.config import Settings
from app.errors import APIError
from app import imports


@pytest.mark.parametrize("failure,status,code", [
    (TimeoutError("private transport diagnostics"), 504, "DATASET_TIMEOUT"),
    (URLError(TimeoutError("private transport diagnostics")), 504, "DATASET_TIMEOUT"),
    (URLError("private transport diagnostics"), 502, "DATASET_UPSTREAM_ERROR"),
    (OSError("private transport diagnostics"), 502, "DATASET_UPSTREAM_ERROR"),
])
def test_transport_errors_have_safe_status_without_internal_details(monkeypatch, failure, status, code):
    def fail(*args, **kwargs):
        raise failure

    monkeypatch.setattr(imports, "urlopen", fail)
    with pytest.raises(APIError) as exc:
        imports.fetch_dataset(Settings(dataset_url="https://example.invalid/invoke"), "SYNTHETIC")
    assert exc.value.status == status
    assert exc.value.code == code
    assert "private" not in str(exc.value)
    assert "example.invalid" not in str(exc.value)


@pytest.mark.parametrize("raw,limit,status,code", [
    (b"not JSON", 100, 502, "DATASET_UPSTREAM_ERROR"),
    (b"123456789", 8, 413, "PAYLOAD_TOO_LARGE"),
])
def test_upstream_body_limits_and_decode_failures_are_distinct(monkeypatch, raw, limit, status, code):
    monkeypatch.setattr(imports, "urlopen", lambda *args, **kwargs: io.BytesIO(raw))
    with pytest.raises(APIError) as exc:
        imports.fetch_dataset(Settings(dataset_url="https://example.invalid/invoke", max_upload_bytes=limit), "SYNTHETIC")
    assert (exc.value.status, exc.value.code) == (status, code)


def test_group_parameter_cannot_inject_another_query_parameter(monkeypatch):
    urls = []

    def response(request, **kwargs):
        urls.append(request.full_url)
        return io.BytesIO(b'{"isSuccess": true}')

    monkeypatch.setattr(imports, "urlopen", response)
    settings = Settings(dataset_url="https://example.invalid/invoke?api-version=1&group_id=OLD")
    assert imports.fetch_dataset(settings, "NEW&admin=true") == {"isSuccess": True}
    assert parse_qs(urlsplit(urls[0]).query) == {"api-version": ["1"], "group_id": ["NEW&admin=true"]}
