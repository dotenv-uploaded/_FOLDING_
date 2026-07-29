from __future__ import annotations

import json

import httpx

from wiki_builder.config import WikiConfig
from wiki_builder.openai_compatible import OpenAICompatibleClient


def test_local_client_uses_openai_compatible_structured_output(config: WikiConfig) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path.endswith("/models"):
            return httpx.Response(200, json={"data": [{"id": "gemma4:e2b"}]})
        payload = json.loads(request.content)
        assert payload["response_format"]["type"] == "json_schema"
        return httpx.Response(
            200,
            json={
                "model": "gemma4:e2b",
                "choices": [{"message": {"content": '{"value":"ok"}'}}],
                "usage": {"prompt_tokens": 12, "completion_tokens": 4},
            },
        )

    with OpenAICompatibleClient(
        config,
        transport=httpx.MockTransport(handler),
    ) as client:
        completion = client.complete(
            "system",
            "user",
            {
                "type": "object",
                "properties": {"value": {"type": "string"}},
                "required": ["value"],
                "additionalProperties": False,
            },
        )

    assert json.loads(completion.text) == {"value": "ok"}
    assert completion.usage["total_tokens"] == 16
    assert completion.usage["estimated_cost"] == 0.0
    assert [request.url.path for request in requests] == [
        "/v1/models",
        "/v1/chat/completions",
    ]


def test_local_client_accepts_lm_studio_gemma_model_id(config: WikiConfig) -> None:
    raw = {**config.raw, "provider": {**config.provider, "backend": "lmstudio"}}
    lm_studio = WikiConfig(path=config.path, raw=raw)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/models"):
            return httpx.Response(
                200,
                json={"data": [{"id": "google/gemma-4-e2b-it"}]},
            )
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": "{}"}}]},
        )

    with OpenAICompatibleClient(
        lm_studio,
        transport=httpx.MockTransport(handler),
    ) as client:
        assert client.check_model_access()["name"] == "google/gemma-4-e2b-it"
