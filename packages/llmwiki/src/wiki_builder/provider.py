from __future__ import annotations

from wiki_builder.config import WikiConfig
from wiki_builder.errors import ProviderError
from wiki_builder.gemini import GeminiClient, get_api_key
from wiki_builder.openai_compatible import OpenAICompatibleClient

type ProviderClient = GeminiClient | OpenAICompatibleClient


def build_provider_client(config: WikiConfig) -> ProviderClient:
    name = str(config.provider["name"])
    if name == "google-gemini":
        return GeminiClient(config)
    if name == "local-openai":
        return OpenAICompatibleClient(config)
    raise ProviderError(f"지원하지 않는 enrichment provider입니다: {name}")


def ensure_provider_ready(config: WikiConfig) -> None:
    if config.provider["name"] == "google-gemini":
        get_api_key(config, required=True)


def doctor(config: WikiConfig) -> dict[str, object]:
    name = str(config.provider["name"])
    local = name == "local-openai"
    credential_ready = local or get_api_key(config, required=False) is not None
    access: dict[str, object] = {"ok": False, "model": None, "error": None}
    try:
        with build_provider_client(config) as client:
            access = {"ok": True, "model": client.check_model_access(), "error": None}
    except ProviderError as error:
        access["error"] = str(error)
    checks: dict[str, object] = {
        "credentials": {
            "ok": credential_ready,
            "required": not local,
            "value_exposed": False,
        },
        "provider_config": {
            "ok": name in {"local-openai", "google-gemini"},
            "provider": name,
            "model": config.provider["model"],
            "data_policy": config.provider["data_policy"],
        },
        "model_access": access,
    }
    return {
        "ok": credential_ready and bool(access["ok"]),
        "checks": checks,
    }
