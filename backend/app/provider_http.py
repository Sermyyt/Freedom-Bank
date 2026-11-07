"""Minimal documented HTTP adapters; retries belong to the evaluator, not HTTPX."""
import hashlib
import json
import math
from urllib.parse import urlsplit

import httpx

from app.providers import ProviderError


def _parse_json(text):
    try:
        return json.loads(text, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (ValueError, TypeError):
        return None


def _counter(value):
    return value if type(value) is int and value >= 0 else None


def _objects(value):
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _block_text(blocks, kind):
    return "".join(block["text"] for block in blocks
                   if block.get("type") == kind and isinstance(block.get("text"), str))


def _retry_after(value):
    try:
        seconds = float(value)
        return max(0.0, seconds) if math.isfinite(seconds) else None
    except (ValueError, TypeError):
        return None


class HTTPProvider:
    is_demo = False
    ready = True
    criteria_per_call = 1

    def __init__(self, settings, *, transport=None):
        self.model = settings.llm_model
        self._api_key = settings.llm_api_key
        root = (settings.llm_base_url or self.default_base_url).rstrip("/")
        parsed = urlsplit(root)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.query or parsed.fragment or parsed.username:
            raise ValueError("Invalid LLM_BASE_URL")
        if not parsed.path.endswith("/v1"):
            root += "/v1"
        self._endpoint = root + self.endpoint_path
        self._timeout = settings.llm_timeout
        self._max_output_tokens = getattr(settings, "llm_max_output_tokens", 8192)
        self._transport = transport
        self.cache_settings = {"endpoint_hash": hashlib.sha256(self._endpoint.encode("utf-8")).hexdigest(),
                               "max_output_tokens": self._max_output_tokens, "protocol": self.protocol,
                               "criteria_per_call": self.criteria_per_call}

    def _redact(self, value):
        if isinstance(value, str):
            return value.replace(self._api_key, "[redacted]")
        if isinstance(value, dict):
            return {key: self._redact(item) for key, item in value.items()}
        if isinstance(value, list):
            return [self._redact(item) for item in value]
        return value

    def headers(self):
        return {"Authorization": f"Bearer {self._api_key}", "Content-Type": "application/json"}

    def usage(self, payload):
        reported = payload.get("usage") if isinstance(payload, dict) else None
        reported = reported if isinstance(reported, dict) else {}
        return {"input_tokens": _counter(reported.get("input_tokens")),
                "output_tokens": _counter(reported.get("output_tokens")), "cost": None, "currency": None}

    def _request(self, body):
        try:
            with httpx.Client(timeout=self._timeout, transport=self._transport, follow_redirects=False) as client:
                response = client.post(self._endpoint, headers=self.headers(), json=body)
        except httpx.TimeoutException:
            raise ProviderError("PROVIDER_TIMEOUT", "Провайдер не ответил вовремя.", retryable=True) from None
        except httpx.RequestError:
            raise ProviderError("PROVIDER_NETWORK_ERROR", "Не удалось связаться с провайдером.", retryable=True) from None
        payload = self._redact(_parse_json(response.text))
        if response.status_code != 200:
            status = response.status_code
            raise ProviderError("PROVIDER_HTTP_ERROR", "Провайдер отклонил запрос.",
                                retryable=status == 429 or status >= 500,
                                usage=self.usage(payload), raw_response={"http_status": status},
                                retry_after=_retry_after(response.headers.get("Retry-After")))
        return payload, self._redact(response.text)

    def generate(self, criteria, transcript, prompt, response_schema, errors=None):
        payload, text = self._request(self.request_body(prompt, response_schema))
        parsed = _parse_json(self.output_text(payload))
        return {"criteria": parsed.get("criteria") if isinstance(parsed, dict) else None,
                "usage": self.usage(payload), "provider_response": payload if payload is not None else {"unparsed": text}}

    @staticmethod
    def input_text(prompt):
        value = prompt["data"]
        if prompt.get("validation_errors"):
            value += "\nОшибки предыдущей попытки:\n" + json.dumps(prompt["validation_errors"], ensure_ascii=False)
        return value


class OpenAIProvider(HTTPProvider):
    name = "openai"
    default_base_url = "https://api.openai.com/v1"
    endpoint_path = "/responses"
    protocol = "responses-json-schema-v1"

    def request_body(self, prompt, schema):
        return {"model": self.model, "store": False, "max_output_tokens": self._max_output_tokens,
                "input": [{"role": "system", "content": prompt["instructions"]},
                          {"role": "user", "content": self.input_text(prompt)}],
                "text": {"format": {"type": "json_schema", "name": "conversation_assessment",
                                    "strict": True, "schema": schema}}}

    def output_text(self, payload):
        if not isinstance(payload, dict) or payload.get("status") != "completed":
            return None
        blocks = [block for item in _objects(payload.get("output")) if item.get("type") == "message"
                  for block in _objects(item.get("content"))]
        if any(block.get("type") == "refusal" for block in blocks):
            return None
        return _block_text(blocks, "output_text")


class AnthropicProvider(HTTPProvider):
    name = "anthropic"
    default_base_url = "https://api.anthropic.com/v1"
    endpoint_path = "/messages"
    protocol = "messages-2026-10-21-json-schema"

    def headers(self):
        return {**super().headers(), "anthropic-version": "2026-10-21"}

    def request_body(self, prompt, schema):
        return {"model": self.model, "max_tokens": self._max_output_tokens, "system": prompt["instructions"],
                "messages": [{"role": "user", "content": self.input_text(prompt)}],
                "output_config": {"format": {"type": "json_schema", "schema": schema}}}

    def usage(self, payload):
        result = super().usage(payload)
        reported = payload.get("usage") if isinstance(payload, dict) else None
        if result["input_tokens"] is not None and isinstance(reported, dict):
            counters = [_counter(reported.get(key, 0)) for key in ("cache_creation_input_tokens", "cache_read_input_tokens")]
            result["input_tokens"] = (result["input_tokens"] + sum(counters)) if all(item is not None for item in counters) else None
        return result

    def output_text(self, payload):
        if not isinstance(payload, dict) or payload.get("stop_reason") != "end_turn":
            return None
        return _block_text(_objects(payload.get("content")), "text")
