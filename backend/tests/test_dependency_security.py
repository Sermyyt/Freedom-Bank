"""Security boundaries required of the pinned static-file and upload stack."""
import pytest
from starlette.staticfiles import StaticFiles


def test_file_upload_keeps_binary_openapi_format(client):
    schema = client.get("/openapi.json").json()
    upload = schema["components"]["schemas"]["Body_import_file_api_imports_file_post"]
    assert upload["properties"]["file"]["type"] == "string"
    assert upload["properties"]["file"]["format"] == "binary"


@pytest.mark.parametrize("path", ["\\\\untrusted.invalid\\share\\file", "/outside/file", "\\outside\\file"])
def test_absolute_static_paths_are_rejected_before_filesystem_resolution(tmp_path, monkeypatch, path):
    static = StaticFiles(directory=tmp_path)

    def unexpected_resolution(_):
        pytest.fail("Rejected static paths must not reach filesystem/UNC resolution")

    # No external host is contacted even if this security regression fails.
    monkeypatch.setattr("starlette.staticfiles.os.path.realpath", unexpected_resolution)
    assert static.lookup_path(path) == ("", None)
