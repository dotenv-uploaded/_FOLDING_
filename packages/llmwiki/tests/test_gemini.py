from __future__ import annotations

import json
from copy import deepcopy

import httpx
import pytest

import wiki_builder.gemini as gemini_module
from wiki_builder.config import WikiConfig
from wiki_builder.errors import ProviderError
from wiki_builder.gemini import GeminiClient, sanitize_json_schema
from wiki_builder.provenance import model_fingerprint


class FakeHttpClient:
    def __init__(self, responses: list[httpx.Response]):
        self.responses = responses
        self.requests: list[tuple[str, dict]] = []
        self.closed = False

    def post(self, path: str, json: dict) -> httpx.Response:
        self.requests.append((path, json))
        return self.responses.pop(0)

    def get(self, path: str) -> httpx.Response:
        self.requests.append((path, {}))
        return self.responses.pop(0)

    def close(self) -> None:
        self.closed = True


def _gemini_config(config: WikiConfig) -> WikiConfig:
    raw = deepcopy(config.raw)
    raw["provider"].update(
        {
            "name": "google-gemini",
            "backend": "auto",
            "api": "generateContent",
            "api_version": "v1beta",
            "base_url": "https://generativelanguage.googleapis.com",
            "requested_model": "gemini-2.5-flash-lite",
            "model": "gemini-3.1-flash-lite",
            "migration_reason": "test",
            "api_key_env": "GEMINI_API_KEY",
            "data_policy": "development-free",
            "pricing": {
                "currency": "USD",
                "effective_on": "2026-07-09",
                "input_per_million_tokens": 0.25,
                "output_per_million_tokens": 1.5,
            },
        }
    )
    return WikiConfig(path=config.path, raw=raw)


def _install_fake_client(
    monkeypatch: pytest.MonkeyPatch,
    responses: list[httpx.Response],
) -> FakeHttpClient:
    fake = FakeHttpClient(responses)
    monkeypatch.setattr(gemini_module, "get_api_key", lambda config, required=True: "secret")
    monkeypatch.setattr(gemini_module.httpx, "Client", lambda **kwargs: fake)
    return fake


def test_schema_is_reduced_to_gemini_supported_subset() -> None:
    source = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
            "doc_id": {"type": "string", "const": "REG-000001", "pattern": "^REG"},
            "keywords": {
                "type": "array",
                "uniqueItems": True,
                "minItems": 5,
                "items": {"type": "string", "minLength": 1},
            },
            "evidence": {"$ref": "#/$defs/evidence"},
        },
        "required": ["doc_id", "keywords", "evidence"],
        "$defs": {
            "evidence": {
                "type": "object",
                "properties": {"quote": {"type": "string"}},
                "required": ["quote"],
            }
        },
    }
    result = sanitize_json_schema(source)
    assert "$schema" not in result
    assert result["propertyOrdering"] == ["doc_id", "keywords", "evidence"]
    assert result["properties"]["doc_id"]["enum"] == ["REG-000001"]
    assert "pattern" not in result["properties"]["doc_id"]
    assert "uniqueItems" not in result["properties"]["keywords"]
    assert "minLength" not in result["properties"]["keywords"]["items"]
    assert result["properties"]["keywords"]["minItems"] == 5
    assert result["$defs"]["evidence"]["required"] == ["quote"]


def test_complete_sends_gemini_structured_output_request(
    config: WikiConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = _gemini_config(config)
    response = httpx.Response(
        200,
        json={
            "candidates": [
                {
                    "finishReason": "STOP",
                    "content": {"parts": [{"text": '{"value":"ok"}'}]},
                }
            ],
            "usageMetadata": {
                "promptTokenCount": 100,
                "candidatesTokenCount": 20,
                "thoughtsTokenCount": 5,
                "totalTokenCount": 125
            },
        },
    )
    fake = _install_fake_client(monkeypatch, [response])
    schema = {
        "type": "object",
        "additionalProperties": False,
        "required": ["value"],
        "properties": {"value": {"type": "string"}},
    }
    with GeminiClient(config) as client:
        completion = client.complete("system", "user", schema)
    assert json.loads(completion.text) == {"value": "ok"}
    assert completion.usage["input_tokens"] == 100
    assert completion.usage["output_tokens"] == 25
    assert completion.usage["estimated_cost"] > 0
    path, payload = fake.requests[0]
    assert path.endswith("/models/gemini-3.1-flash-lite:generateContent")
    assert payload["systemInstruction"]["parts"][0]["text"] == "system"
    generation = payload["generationConfig"]
    assert generation["responseMimeType"] == "application/json"
    assert generation["thinkingConfig"]["thinkingLevel"] == "minimal"
    assert generation["responseJsonSchema"]["required"] == ["value"]
    assert fake.closed is True


def test_retryable_api_error_is_retried(
    config: WikiConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = _gemini_config(config)
    responses = [
        httpx.Response(429, json={"error": {"message": "quota"}}),
        httpx.Response(
            200,
            json={
                "candidates": [
                    {
                        "finishReason": "STOP",
                        "content": {"parts": [{"text": "{}"}]},
                    }
                ]
            },
        ),
    ]
    fake = _install_fake_client(monkeypatch, responses)
    monkeypatch.setattr(gemini_module.time, "sleep", lambda seconds: None)
    with GeminiClient(config) as client:
        assert client.complete("system", "user", {"type": "object"}).text == "{}"
    assert len(fake.requests) == 2


def test_auth_error_does_not_expose_key(
    config: WikiConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = _gemini_config(config)
    fake = _install_fake_client(
        monkeypatch,
        [httpx.Response(401, json={"error": {"message": "invalid credential"}})],
    )
    with GeminiClient(config) as client, pytest.raises(ProviderError) as captured:
        client.complete("system", "user", {"type": "object"})
    assert "secret" not in str(captured.value)
    assert len(fake.requests) == 1


def test_provider_fingerprint_changes_with_model_config(config: WikiConfig) -> None:
    changed_raw = deepcopy(config.raw)
    changed_raw["provider"]["model"] = "different-model"
    changed = WikiConfig(path=config.path, raw=changed_raw)
    assert model_fingerprint(config) != model_fingerprint(changed)


def test_env_example_exists_and_secrets_are_ignored(config: WikiConfig) -> None:
    env_file = config.resolve_path("env_file")
    env_example = env_file.with_name(".env.example")
    assert env_example.is_file()
    lines = env_example.read_text(encoding="utf-8").splitlines()
    assert "CODEGATE_LOCAL_LLM_BACKEND=auto" in lines
    assert "CODEGATE_LOCAL_LLM_MODEL=gemma4:e2b" in lines
    assert not any(line.startswith("GEMINI_API_KEY=") for line in lines)
    ignore_rules = (config.project_dir / ".gitignore").read_text(encoding="utf-8").splitlines()
    assert ".env" in ignore_rules
    assert "!.env.example" in ignore_rules
