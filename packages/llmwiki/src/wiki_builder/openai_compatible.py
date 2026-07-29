from __future__ import annotations

import re
import time
from dataclasses import dataclass
from typing import Any

import httpx

from wiki_builder.config import WikiConfig
from wiki_builder.errors import ProviderError

RETRYABLE_STATUS_CODES = {408, 429, 500, 502, 503, 504}
DEFAULT_LM_STUDIO_BASE_URL = "http://127.0.0.1:1234/v1"
_GEMMA4_PATTERN = re.compile(r"gemma[-_.:/ ]?4", re.IGNORECASE)


@dataclass(frozen=True)
class OpenAICompatibleCompletion:
    text: str
    usage: dict[str, Any]


class OpenAICompatibleClient:
    def __init__(
        self,
        config: WikiConfig,
        *,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.config = config
        self._transport = transport
        self._client: httpx.Client | None = None
        self._base_url: str | None = None
        self._model: str | None = None

    def __enter__(self) -> OpenAICompatibleClient:
        self._base_url, self._model = self._resolve_endpoint()
        headers = {"Content-Type": "application/json"}
        token = str(self.config.provider.get("api_token", "")).strip()
        if token:
            headers["Authorization"] = f"Bearer {token}"
        self._client = httpx.Client(
            base_url=f"{self._base_url.rstrip('/')}/",
            headers=headers,
            timeout=float(self.config.provider["request_timeout_seconds"]),
            transport=self._transport,
        )
        return self

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        if self._client is not None:
            self._client.close()
        self._client = None

    def check_model_access(self) -> dict[str, Any]:
        if self._base_url is None or self._model is None:
            self._base_url, self._model = self._resolve_endpoint()
        return {
            "name": self._model,
            "version": None,
            "display_name": self._model,
            "base_url": self._base_url,
        }

    def complete(
        self,
        system_prompt: str,
        user_prompt: str,
        response_schema: dict[str, Any],
    ) -> OpenAICompatibleCompletion:
        if self._client is None or self._model is None:
            raise ProviderError("로컬 LLM client가 열리지 않았습니다")
        payload: dict[str, Any] = {
            "model": self._model,
            "temperature": self.config.provider["temperature"],
            "max_tokens": self.config.provider["max_output_tokens"],
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "llmwiki_enrichment",
                    "strict": True,
                    "schema": response_schema,
                },
            },
        }
        response = self._post_with_retry(payload)
        if response.status_code in {400, 404, 422}:
            response = self._post_with_retry(
                {
                    **payload,
                    "response_format": {"type": "json_object"},
                }
            )
        if response.status_code != 200:
            if response.status_code == 404:
                raise ProviderError(
                    f"Gemma 4 모델을 찾을 수 없습니다: {self._model}. "
                    f"`ollama pull {self.config.provider['model']}` 후 다시 시도하세요"
                )
            raise ProviderError(
                f"로컬 LLM 요청 실패: HTTP {response.status_code}: {_error_message(response)}"
            )
        try:
            result = response.json()
            text = result["choices"][0]["message"]["content"]
        except (ValueError, KeyError, IndexError, TypeError) as error:
            raise ProviderError("로컬 LLM이 OpenAI 호환 JSON 응답을 반환하지 않았습니다") from error
        if not isinstance(text, str) or not text.strip():
            raise ProviderError("로컬 LLM이 빈 텍스트를 반환했습니다")
        usage = result.get("usage") if isinstance(result, dict) else None
        input_tokens = _usage_value(usage, "prompt_tokens")
        output_tokens = _usage_value(usage, "completion_tokens")
        return OpenAICompatibleCompletion(
            text=_strip_json_fence(text),
            usage={
                "input_tokens": input_tokens or 0,
                "output_tokens": output_tokens or 0,
                "total_tokens": (input_tokens or 0) + (output_tokens or 0),
                "estimated_cost": 0.0,
                "currency": "USD",
                "pricing_effective_on": "local",
            },
        )

    def _resolve_endpoint(self) -> tuple[str, str]:
        failures: list[str] = []
        for base_url in self._candidate_base_urls():
            try:
                models = self._list_models(base_url)
            except ProviderError as error:
                failures.append(f"{base_url}: {error}")
                continue
            selected = _select_model(models, str(self.config.provider["model"]))
            if selected is not None:
                return base_url, selected
            failures.append(f"{base_url}: Gemma 4 모델 없음")
        detail = "; ".join(failures)
        raise ProviderError(
            "Ollama 또는 LM Studio 로컬 서버에 Gemma 4를 준비하세요. "
            f"권장 명령: `ollama pull {self.config.provider['model']}`. {detail}"
        )

    def _candidate_base_urls(self) -> list[str]:
        configured = str(self.config.provider["base_url"]).rstrip("/")
        backend = str(self.config.provider.get("backend", "auto"))
        if backend == "ollama":
            return [configured]
        if backend == "lmstudio":
            return [DEFAULT_LM_STUDIO_BASE_URL]
        candidates = [configured, DEFAULT_LM_STUDIO_BASE_URL]
        return list(dict.fromkeys(candidates))

    def _list_models(self, base_url: str) -> list[str]:
        headers: dict[str, str] = {}
        token = str(self.config.provider.get("api_token", "")).strip()
        if token:
            headers["Authorization"] = f"Bearer {token}"
        try:
            with httpx.Client(
                base_url=f"{base_url.rstrip('/')}/",
                headers=headers,
                timeout=float(self.config.provider["request_timeout_seconds"]),
                transport=self._transport,
            ) as client:
                response = client.get("models")
        except (httpx.TimeoutException, httpx.NetworkError) as error:
            raise ProviderError(f"연결 실패 ({type(error).__name__})") from error
        if response.status_code != 200:
            raise ProviderError(
                f"모델 목록 응답 HTTP {response.status_code}: {_error_message(response)}"
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
            raise ProviderError("로컬 LLM 모델 목록이 OpenAI 호환 JSON이 아닙니다") from error

    def _post_with_retry(self, payload: dict[str, Any]) -> httpx.Response:
        assert self._client is not None
        max_attempts = int(self.config.provider["api_max_attempts"])
        last_response: httpx.Response | None = None
        for attempt in range(1, max_attempts + 1):
            try:
                response = self._client.post("chat/completions", json=payload)
            except (httpx.TimeoutException, httpx.NetworkError) as error:
                if attempt == max_attempts:
                    raise ProviderError(
                        f"로컬 LLM 요청 실패 ({type(error).__name__})"
                    ) from error
                self._sleep(attempt)
                continue
            last_response = response
            if response.status_code not in RETRYABLE_STATUS_CODES or attempt == max_attempts:
                return response
            self._sleep(attempt)
        assert last_response is not None
        return last_response

    def _sleep(self, attempt: int) -> None:
        base = float(self.config.provider["retry_base_seconds"])
        time.sleep(base * (2 ** (attempt - 1)))


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
    stripped = re.sub(r"^```(?:json)?\s*", "", text.strip(), flags=re.IGNORECASE)
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
        if isinstance(error, dict) and isinstance(error.get("message"), str):
            return error["message"][:500]
        if isinstance(error, str):
            return error[:500]
    except (ValueError, AttributeError):
        pass
    return response.text[:500] or "응답 본문 없음"
