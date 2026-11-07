"""Consistent HTTP boundaries: request IDs, size limits and sanitized errors."""
import sqlite3
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException
from .errors import APIError
from .evaluation import DomainError
from .ingestion import IngestionError
from .storage import new_id


def success(request, data):
    return dict(data=data, meta=dict(request_id=request.state.request_id))


class StrictQueryRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()
        allowed = {parameter.alias for parameter in self.dependant.query_params}

        async def checked(request):
            if set(request.query_params) - allowed or any(len(request.query_params.getlist(key)) > 1 for key in allowed):
                raise APIError(422, "VALIDATION_ERROR", "Неизвестные или повторные параметры запроса.")
            return await handler(request)
        return checked


def failure(request_id, status, code, message, details=None, retryable=False):
    return JSONResponse(status_code=status, content=dict(
        error=dict(code=code, message=message, details=details or [], retryable=retryable),
        meta=dict(request_id=request_id)), headers={"Retry-After": "1"} if status == 429 else None)


class RequestMiddleware:
    def __init__(self, app, max_bytes):
        self.app, self.max_bytes = app, max_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        identifier = new_id()
        scope.setdefault("state", {})["request_id"] = identifier
        if scope["method"] in {"POST", "PUT", "PATCH"}:
            try:
                receive = await buffer_body(receive, self.max_bytes)
            except ClientDisconnected:
                return
            except PayloadTooLarge:
                return await failure(identifier, 413, "PAYLOAD_TOO_LARGE", "Превышен лимит тела запроса.")(scope, receive, send)
        await self.dispatch(scope, receive, send, identifier)

    async def dispatch(self, scope, receive, send, identifier):
        started = False

        async def safe_send(message):
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
                message.setdefault("headers", []).append((b"x-request-id", identifier.encode("ascii")))
            await send(message)
        try:
            await self.app(scope, receive, safe_send)
        except Exception:
            if not started:
                await failure(identifier, 500, "INTERNAL_ERROR", "Внутренняя ошибка сервера.")(scope, receive, safe_send)


class ClientDisconnected(Exception):
    pass


class PayloadTooLarge(Exception):
    pass


async def buffer_body(receive, max_bytes):
    chunks, size = [], 0
    while True:
        message = await receive()
        if message["type"] == "http.disconnect":
            raise ClientDisconnected()
        chunk = message.get("body", b"")
        size += len(chunk)
        if size > max_bytes:
            raise PayloadTooLarge()
        chunks.append(chunk)
        if not message.get("more_body", False):
            return replay_body(b"".join(chunks), receive)


def replay_body(body, original_receive):
    delivered = False

    async def receive():
        nonlocal delivered
        if not delivered:
            delivered = True
            return {"type": "http.request", "body": body, "more_body": False}
        return await original_receive()
    return receive


async def api_error(request, exc):
    return failure(request.state.request_id, exc.status, exc.code, exc.message, exc.details, exc.retryable)


async def domain_error(request, exc):
    return failure(request.state.request_id, 422, exc.code, "Проверьте ответ и доказательства.", exc.details)


async def ingestion_error(request, exc):
    return failure(request.state.request_id, exc.status, exc.code, exc.message)


async def storage_error(request, exc):
    return failure(request.state.request_id, 503, "SERVICE_UNAVAILABLE", "Хранилище временно недоступно.", retryable=True)


async def validation_error(request, exc):
    if any(e["type"] == "json_invalid" for e in exc.errors()):
        return failure(request.state.request_id, 400, "INVALID_JSON", "Не удалось прочитать JSON запроса.")
    details = [dict(path=list(e["loc"]), code=e["type"], message="Неверное или отсутствующее значение.") for e in exc.errors()]
    return failure(request.state.request_id, 422, "VALIDATION_ERROR", "Проверьте поля запроса.", details)


async def http_error(request, exc):
    code, message = {404: ("NOT_FOUND", "Объект не найден."), 405: ("METHOD_NOT_ALLOWED", "Метод не поддерживается."),
                     400: ("INVALID_JSON", "Не удалось прочитать запрос.")}.get(exc.status_code, ("VALIDATION_ERROR", "Некорректный запрос."))
    return failure(request.state.request_id, exc.status_code, code, message)


def register_handlers(app):
    app.add_exception_handler(APIError, api_error)
    app.add_exception_handler(DomainError, domain_error)
    app.add_exception_handler(IngestionError, ingestion_error)
    app.add_exception_handler(sqlite3.Error, storage_error)
    app.add_exception_handler(RequestValidationError, validation_error)
    app.add_exception_handler(HTTPException, http_error)
