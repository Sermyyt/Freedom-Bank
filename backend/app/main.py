"""Composition root: python -m uvicorn app.main:app --host 127.0.0.1 --port 8000."""
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from . import catalog, schemas as s
from .config import ROOT, Settings
from .http import RequestMiddleware, register_handlers
from .jobs import JobRunner, interrupt_unfinished
from .openapi_compatibility import install_openapi_compatibility
from .providers import make_provider
from .routes import router
from .storage import Store


def application_lifespan(store, settings, provider):
    @asynccontextmanager
    async def lifespan(app):
        store.initialize()
        with store.transaction() as tx:
            catalog.bootstrap(tx)
            interrupt_unfinished(tx)
        app.state.runner = JobRunner(store, settings, provider)
        try:
            yield
        finally:
            app.state.runner.close()
    return lifespan


def create_app(settings=None, provider=None):
    settings = settings or Settings.from_env()
    store = Store(settings.database_path)
    selected = provider if provider is not None else make_provider(settings)
    responses = {code: {"model": s.Failure} for code in (400, 404, 405, 409, 413, 422, 429, 500, 502, 503, 504)}
    responses[413]["description"] = "Request Entity Too Large"
    responses[422]["description"] = "Unprocessable Entity"
    app = FastAPI(title="CQA API", version="1", lifespan=application_lifespan(store, settings, selected),
                  responses=responses)
    app.state.settings, app.state.store, app.state.provider = settings, store, selected
    app.add_middleware(RequestMiddleware, max_bytes=settings.max_upload_bytes)
    if settings.cors_origins:
        app.add_middleware(CORSMiddleware, allow_origins=list(settings.cors_origins),
                           allow_methods=["GET", "POST", "OPTIONS"], allow_headers=["Content-Type"],
                           expose_headers=["X-Request-ID", "Retry-After"])
    register_handlers(app)
    app.include_router(router)
    install_openapi_compatibility(app)
    if (ROOT / "frontend").is_dir():
        app.mount("/", StaticFiles(directory=ROOT / "frontend", html=True), name="frontend")
    return app


app = create_app()
