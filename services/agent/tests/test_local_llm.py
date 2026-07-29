from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest

from codegate_api.agent.local_llm import LocalLlmClient, LocalLlmError
from codegate_api.config import Settings


def test_local_llm_uses_gemma4_and_falls_back_to_json_object() -> None:
    requests: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/models":
            return httpx.Response(
                200,
                json={"data": [{"id": "embedding-model"}, {"id": "gemma4:e2b"}]},
            )
        if request.url.path == "/v1/chat/completions":
            payload = json.loads(request.content)
            requests.append(payload)
            if payload["response_format"]["type"] == "json_schema":
                return httpx.Response(400, json={"error": {"message": "unsupported"}})
            return httpx.Response(
                200,
                json={
                    "model": "gemma4:e2b",
                    "choices": [
                        {
                            "message": {
                                "content": '```json\n{"outcome":"ready"}\n```',
                            }
                        }
                    ],
                    "usage": {"prompt_tokens": 42, "completion_tokens": 7},
                },
            )
        return httpx.Response(404)

    settings = Settings(
        local_llm_backend="ollama",
        local_llm_model="gemma4:e2b",
    )
    client = LocalLlmClient(settings, transport=httpx.MockTransport(handler))

    result = asyncio.run(
        client.complete_json(
            system_prompt="Return JSON.",
            user_prompt="Test",
            response_schema={"type": "object"},
        )
    )

    assert result.text == '{"outcome":"ready"}'
    assert result.model == "gemma4:e2b"
    assert result.input_tokens == 42
    assert result.output_tokens == 7
    assert [payload["response_format"]["type"] for payload in requests] == [
        "json_schema",
        "json_object",
    ]


def test_local_llm_accepts_loaded_gemma4_family_variant() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/models"
        return httpx.Response(200, json={"data": [{"id": "gemma-4-e2b-it-q4"}]})

    client = LocalLlmClient(
        Settings(local_llm_backend="lmstudio"),
        transport=httpx.MockTransport(handler),
    )

    endpoint = asyncio.run(client.check_access())

    assert endpoint == {
        "base_url": "http://127.0.0.1:1234/v1",
        "model": "gemma-4-e2b-it-q4",
    }


def test_local_llm_reports_all_unavailable_loopback_backends() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"error": "not ready"})

    client = LocalLlmClient(
        Settings(local_llm_backend="auto"),
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(LocalLlmError) as raised:
        asyncio.run(client.check_access())

    assert raised.value.code == "LOCAL_LLM_UNAVAILABLE"
    assert raised.value.retryable is True
    assert "127.0.0.1:11434" in str(raised.value)
    assert "127.0.0.1:1234" in str(raised.value)
