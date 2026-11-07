"""Static assets revalidate without changing API caching or file validators."""
import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture
def client(tmp_path, monkeypatch, settings):
    # Keep the HTTP tests independent of a checkout or a mutation worker's directory layout.
    frontend = tmp_path / 'frontend'
    (frontend / 'js').mkdir(parents=True)
    (frontend / 'index.html').write_text('<html>synthetic frontend</html>', encoding='utf-8')
    (frontend / 'js/main.js').write_text('export const synthetic = true;', encoding='utf-8')
    monkeypatch.setattr('app.main.ROOT', tmp_path)
    with TestClient(create_app(settings)) as test_client:
        yield test_client


@pytest.mark.parametrize('path', ['/', '/js/main.js'])
@pytest.mark.parametrize('method', ['GET', 'HEAD'])
def test_frontend_files_require_revalidation_and_keep_validators(client, path, method):
    response = client.request(method, path)
    assert response.status_code == 200
    assert response.headers['cache-control'] == 'no-cache'
    assert response.headers['etag']
    assert response.headers['last-modified']
    if method == 'HEAD':
        assert response.content == b''


@pytest.mark.parametrize('path', ['/', '/js/main.js'])
@pytest.mark.parametrize('validator,header', [('etag', 'If-None-Match'), ('last-modified', 'If-Modified-Since')])
def test_conditional_static_requests_remain_cheap(client, path, validator, header):
    original = client.get(path)
    response = client.get(path, headers={header: original.headers[validator]})
    assert response.status_code == 304
    assert response.content == b''
    assert response.headers['cache-control'] == 'no-cache'
    assert response.headers['etag'] == original.headers['etag']


def test_missing_static_file_also_revalidates(client):
    response = client.get('/missing-static.js')
    assert response.status_code == 404
    assert response.headers['cache-control'] == 'no-cache'


def test_static_directory_redirect_also_revalidates(tmp_path, monkeypatch, settings):
    # This synthetic frontend is outside the repository; real frontend files stay read-only.
    folder = tmp_path / 'frontend' / 'section'
    folder.mkdir(parents=True)
    (folder / 'index.html').write_text('<html>temporary static fixture</html>', encoding='utf-8')
    monkeypatch.setattr('app.main.ROOT', tmp_path)
    with TestClient(create_app(settings)) as client:
        response = client.get('/section', follow_redirects=False)
        assert response.status_code == 307
        assert response.headers['cache-control'] == 'no-cache'


def test_static_method_error_also_revalidates(client):
    response = client.post('/js/main.js')
    assert response.status_code == 405
    assert response.headers['cache-control'] == 'no-cache'


@pytest.mark.parametrize('path,status', [('/api/health', 200), ('/api/not-found', 404),
                                        ('/api', 404), ('/docs', 200), ('/openapi.json', 200)])
def test_nonstatic_routes_do_not_gain_cache_headers(client, path, status):
    response = client.get(path)
    assert response.status_code == status
    assert 'cache-control' not in response.headers
    assert 'etag' not in response.headers
    assert 'last-modified' not in response.headers


def test_api_errors_keep_their_original_headers(client):
    response = client.post('/api/health')
    assert response.status_code == 405
    assert 'cache-control' not in response.headers
    assert response.json()['error']['code'] == 'METHOD_NOT_ALLOWED'
