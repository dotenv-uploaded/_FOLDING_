import base64
import hashlib
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from codegate_cloud_api.models import GoogleIdentity
from fastapi.testclient import TestClient

from codegate_api.config import Settings
from codegate_api.main import create_app


class FakeGoogleProvider:
    def __init__(self) -> None:
        self.exchanges: list[dict[str, str]] = []

    async def exchange_code(self, **values: str) -> GoogleIdentity:
        self.exchanges.append(values)
        return GoogleIdentity(
            subject_id="google-user-123",
            email="operator@example.com",
            name="운영자",
        )

    async def close(self) -> None:
        return None


def _challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode()).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


def _settings(tmp_path: Path) -> Settings:
    return Settings(
        environment="test",
        auth_mode="google",
        google_client_id="desktop-client.apps.googleusercontent.com",
        session_pepper="test-session-pepper-for-google-oauth",
        seed_knowledge_root=Path("demo/llm-wiki"),
        seed_source_root=Path("demo/source"),
        runtime_root=tmp_path,
        source_root=tmp_path / "source",
        knowledge_releases_root=tmp_path / "knowledge/releases",
        knowledge_pointer_path=tmp_path / "knowledge/CURRENT",
        database_path=tmp_path / "state.sqlite3",
        auth_database_path=tmp_path / "auth.sqlite3",
        backup_root=tmp_path / "backups",
        agent_state_root=tmp_path / "claude",
    )


def test_integrated_google_oauth_issues_backend_session(tmp_path: Path) -> None:
    provider = FakeGoogleProvider()
    app = create_app(_settings(tmp_path), google_provider=provider)
    verifier = "v" * 64
    redirect_uri = "http://127.0.0.1:49152/oauth/callback/random-path"

    with TestClient(app) as client:
        started = client.post(
            "/api/v1/auth/google/start",
            json={"redirect_uri": redirect_uri, "code_challenge": _challenge(verifier)},
        )
        assert started.status_code == 200
        started_payload = started.json()
        authorization = urlsplit(started_payload["authorization_url"])
        query = parse_qs(authorization.query)
        assert authorization.netloc == "accounts.google.com"
        assert query["state"] == [started_payload["state"]]

        exchanged = client.post(
            "/api/v1/auth/google/exchange",
            json={
                "state": started_payload["state"],
                "code": "google-code",
                "code_verifier": verifier,
            },
        )
        assert exchanged.status_code == 200
        session = exchanged.json()

        me = client.get(
            "/api/v1/auth/me",
            headers={"Authorization": f"Bearer {session['access_token']}"},
        )
        assert me.status_code == 200
        assert me.json() == {
            "authenticated": True,
            "subject_id": "google-user-123",
            "tenant_id": "google-user-123",
            "email": "operator@example.com",
            "read_access": ["internal", "public", "restricted"],
            "write_scope": "workspace",
            "writable_document_ids": [],
            "provisioned": True,
            "authz_source": "google-oauth",
        }
        assert provider.exchanges[0]["redirect_uri"] == redirect_uri

        openapi = client.get("/openapi.json").json()
        assert "/api/v1/auth/google/start" in openapi["paths"]
        assert "/api/v1/auth/google/exchange" in openapi["paths"]
        assert "/api/v1/auth/refresh" in openapi["paths"]
        assert "/api/v1/auth/logout" in openapi["paths"]
