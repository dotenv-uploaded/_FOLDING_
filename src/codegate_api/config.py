from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime settings loaded from environment variables or a local .env file."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="CODEGATE_",
        extra="ignore",
    )

    app_name: str = "CODEGATE 2026 API"
    environment: str = "development"
    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:3000"])
    knowledge_root: Path = Path("demo/llm-wiki")
    source_root: Path = Path("demo/source")
    agent_state_root: Path = Path(".runtime/claude")

    def resolved_knowledge_root(self) -> Path:
        return self.knowledge_root.expanduser().resolve()

    def resolved_source_root(self) -> Path:
        return self.source_root.expanduser().resolve()

    def resolved_agent_state_root(self) -> Path:
        return self.agent_state_root.expanduser().resolve()


@lru_cache
def get_settings() -> Settings:
    return Settings()
