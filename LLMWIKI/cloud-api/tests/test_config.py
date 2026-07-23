import pytest
from pydantic import ValidationError

from codegate_cloud_api.config import Settings


def test_production_requires_google_client_and_session_pepper() -> None:
    with pytest.raises(ValidationError, match="CODEGATE_GOOGLE_CLIENT_ID"):
        Settings(environment="production")


def test_production_rejects_wildcard_cors() -> None:
    with pytest.raises(ValidationError, match="CORS origin allowlist"):
        Settings(
            environment="production",
            google_client_id="client.apps.googleusercontent.com",
            session_pepper="x" * 32,
            cors_origins=["*"],
        )


def test_production_rejects_insecure_google_endpoint() -> None:
    with pytest.raises(ValidationError, match="must use HTTPS"):
        Settings(
            environment="production",
            google_client_id="client.apps.googleusercontent.com",
            session_pepper="x" * 32,
            google_token_endpoint="http://oauth.example/token",
        )
