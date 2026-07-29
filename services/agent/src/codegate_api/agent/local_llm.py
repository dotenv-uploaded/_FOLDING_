from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

import httpx

from codegate_api.config import Settings

DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1"
DEFAULT_LM_STUDIO_BASE_URL = "http://127.0.0.1:1234/v1"
_GEMMA4_PATTERN = re.compile(r"gemma[-_.:/ ]?4", re.IGNORECASE)


class LocalLlmError(RuntimeError):
    def __init__(self, code: str, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable


@dataclass(frozen=True, slots=True)
class LocalLlmCompletion:
    text: str
    model: str
    base_url: str
    input_tokens: int | None
    output_tokens: int | None


@dataclass(frozen=True, slots=True)
class _Endpoint:
    base_url: str
    model: str


class LocalLlmClient:
    def __init__(
        self,
        settings: Settings,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._settings = settings
        self._transport = transport
        self._endpoint: _Endpoint | None = None

    async def complete_json(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        response_schema: dict[str, Any],
    ) -> LocalLlmCompletion:
        endpoint = self._endpoint or await self._resolve_endpoint()
        self._endpoint = endpoint
        headers = {"Content-Type": "application/json"}
        token = self._settings.local_llm_api_token
        if token is not None:
            headers["Authorization"] = f"Bearer {token.get_secret_value()}"
        payload: dict[str, Any] = {
            "model": endpoint.model,
            "temperature": 0,
            "max_tokens": self._settings.local_llm_max_output_tokens,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "codegate_response",
                    "strict": True,
                    "schema": response_schema,
                },
            },
        }
        response = await self._post(endpoint, headers, payload)
        if response.status_code in {400, 404, 422}:
            fallback = {
                **payload,
                "response_format": {"type": "json_object"},
            }
            response = await self._post(endpoint, headers, fallback)
        if response.status_code != 200:
            message = _error_message(response)
            if response.status_code == 404:
                raise LocalLlmError(
                    "LOCAL_MODEL_NOT_FOUND",
                    f"Gemma 4 모델을 찾지 못했습니다: {endpoint.model}. "
                    f"`ollama pull {self._settings.local_llm_model}` 후 다시 시도해 주세요.",
                )
            raise LocalLlmError(
                "LOCAL_LLM_REQUEST_FAILED",
                f"로컬 LLM 응답 오류 HTTP {response.status_code}: {message}",
                retryable=response.status_code == 429 or response.status_code >= 500,
            )
        try:
            result = response.json()
            text = result["choices"][0]["message"]["content"]
        except (ValueError, KeyError, IndexError, TypeError) as error:
            raise LocalLlmError(
                "LOCAL_LLM_RESULT_INVALID",
                "로컬 LLM이 OpenAI 호환 JSON 응답을 반환하지 않았습니다.",
            ) from error
        if not isinstance(text, str) or not text.strip():
            raise LocalLlmError(
                "LOCAL_LLM_RESULT_INVALID",
                "로컬 LLM이 빈 응답을 반환했습니다.",
            )
        usage = result.get("usage") if isinstance(result, dict) else None
        return LocalLlmCompletion(
            text=_strip_json_fence(text),
            model=str(result.get("model") or endpoint.model),
            base_url=endpoint.base_url,
            input_tokens=_usage_value(usage, "prompt_tokens"),
            output_tokens=_usage_value(usage, "completion_tokens"),
        )

    async def check_access(self) -> dict[str, str]:
        endpoint = self._endpoint or await self._resolve_endpoint()
        self._endpoint = endpoint
        return {"base_url": endpoint.base_url, "model": endpoint.model}

    async def _resolve_endpoint(self) -> _Endpoint:
        failures: list[str] = []
        for base_url in self._candidate_base_urls():
            try:
                models = await self._list_models(base_url)
            except LocalLlmError as error:
                failures.append(f"{base_url}: {error}")
                continue
            selected = _select_model(models, self._settings.local_llm_model)
            if selected is not None:
                return _Endpoint(base_url=base_url, model=selected)
            failures.append(
                f"{base_url}: Gemma 4 모델 없음 "
                f"(요청 모델 {self._settings.local_llm_model})"
            )
        detail = "; ".join(failures) if failures else "사용 가능한 loopback endpoint가 없습니다."
        raise LocalLlmError(
            "LOCAL_LLM_UNAVAILABLE",
            "Ollama 또는 LM Studio의 로컬 서버와 Gemma 4 모델을 준비해 주세요. "
            f"Ollama 권장 명령: `ollama pull {self._settings.local_llm_model}`. {detail}",
            retryable=True,
        )

    def _candidate_base_urls(self) -> list[str]:
        if self._settings.local_llm_base_url:
            return [self._settings.local_llm_base_url.rstrip("/")]
        if self._settings.local_llm_backend == "ollama":
            return [DEFAULT_OLLAMA_BASE_URL]
        if self._settings.local_llm_backend == "lmstudio":
            return [DEFAULT_LM_STUDIO_BASE_URL]
        return [DEFAULT_OLLAMA_BASE_URL, DEFAULT_LM_STUDIO_BASE_URL]

    async def _list_models(self, base_url: str) -> list[str]:
        headers: dict[str, str] = {}
        token = self._settings.local_llm_api_token
        if token is not None:
            headers["Authorization"] = f"Bearer {token.get_secret_value()}"
        try:
            async with httpx.AsyncClient(
                base_url=f"{base_url.rstrip('/')}/",
                headers=headers,
                timeout=self._settings.local_llm_timeout_seconds,
                transport=self._transport,
            ) as client:
                response = await client.get("models")
        except (httpx.TimeoutException, httpx.NetworkError) as error:
            raise LocalLlmError(
                "LOCAL_LLM_UNAVAILABLE",
                f"연결 실패 ({type(error).__name__})",
                retryable=True,
            ) from error
        if response.status_code != 200:
            raise LocalLlmError(
                "LOCAL_LLM_UNAVAILABLE",
                f"모델 목록 응답 HTTP {response.status_code}: {_error_message(response)}",
                retryable=response.status_code >= 500,
            )
        try:
            payload = response.json()
            values = payload.get("data", [])
            return [
                str(item["id"])
                for item in values
                if isinstance(item, dict) and isinstance(item.get("id"), str)
            ]
        except (ValueError, AttributeError, KeyError, TypeError) as error:
            raise LocalLlmError(
                "LOCAL_LLM_RESULT_INVALID",
                "로컬 LLM 모델 목록이 OpenAI 호환 JSON이 아닙니다.",
            ) from error

    async def _post(
        self,
        endpoint: _Endpoint,
        headers: dict[str, str],
        payload: dict[str, Any],
    ) -> httpx.Response:
        try:
            async with httpx.AsyncClient(
                base_url=f"{endpoint.base_url.rstrip('/')}/",
                headers=headers,
                timeout=self._settings.local_llm_timeout_seconds,
                transport=self._transport,
            ) as client:
                return await client.post("chat/completions", json=payload)
        except (httpx.TimeoutException, httpx.NetworkError) as error:
            self._endpoint = None
            raise LocalLlmError(
                "LOCAL_LLM_UNAVAILABLE",
                f"로컬 LLM 호출에 실패했습니다 ({type(error).__name__}).",
                retryable=True,
            ) from error


def _select_model(models: list[str], requested: str) -> str | None:
    requested_lower = requested.lower()
    for model in models:
        if model.lower() == requested_lower:
            return model
    requested_family = requested_lower.split(":", maxsplit=1)[0]
    for model in models:
        if model.lower().split(":", maxsplit=1)[0] == requested_family:
            return model
    return next((model for model in models if _GEMMA4_PATTERN.search(model)), None)


def _strip_json_fence(text: str) -> str:
    stripped = text.strip()
    stripped = re.sub(r"^```(?:json)?\s*", "", stripped, flags=re.IGNORECASE)
    return re.sub(r"\s*```$", "", stripped).strip()


def _usage_value(usage: object, key: str) -> int | None:
    if not isinstance(usage, dict):
        return None
    value = usage.get(key)
    return value if isinstance(value, int) and value >= 0 else None


def _error_message(response: httpx.Response) -> str:
    try:
        payload = response.json()
        error = payload.get("error")
        if isinstance(error, dict):
            message = error.get("message")
            if isinstance(message, str):
                return message[:500]
        if isinstance(error, str):
            return error[:500]
    except (ValueError, AttributeError):
        pass
    return response.text[:500] or "응답 본문 없음"
