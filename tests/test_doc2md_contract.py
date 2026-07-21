from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from codegate_api.files.resolver import SourceUriResolver
from codegate_api.integrations.doc2md import (
    ConversionResult,
    Doc2MdClient,
    Doc2MdError,
)
from codegate_api.knowledge.access import AccessContext
from codegate_api.knowledge.schemas import ManifestEntry


class _FakeResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload

    def __enter__(self) -> _FakeResponse:
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def read(self) -> bytes:
        return json.dumps(self._payload, ensure_ascii=False).encode("utf-8")


def _manifest() -> ManifestEntry:
    row = json.loads(
        Path("demo/llm-wiki/manifest.jsonl").read_text(encoding="utf-8").splitlines()[0]
    )
    return ManifestEntry.model_validate(row)


def _response(manifest: ManifestEntry, sha256: str) -> dict[str, Any]:
    return {
        "markdown": "---\nid: REG-000001\n---\n# 문서\n",
        "frontmatter": {
            "schema_version": "1.0.0",
            "id": manifest.id,
            "title": manifest.title,
            "doc_type": manifest.doc_type,
            "language": manifest.language,
            "revision": manifest.revision,
            "status": manifest.status,
            "authority_level": manifest.authority_level,
            "source": {
                "filename": manifest.source.filename,
                "uri": manifest.source.uri,
                "sha256": sha256,
            },
            "access": manifest.access.value,
            "tags": manifest.tags,
            "aliases": manifest.aliases,
        },
        "body": "# 문서\n",
        "format": "md",
        "library_used": "markitdown",
        "warnings": [],
        "cached": False,
    }


def test_doc2md_adapter_forces_stable_metadata_and_validates_hash(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    manifest = _manifest()
    source_root = tmp_path / "source"
    source = source_root / "regulations/REG-000001.md"
    source.parent.mkdir(parents=True)
    source.write_text("source", encoding="utf-8")
    captured: dict[str, Any] = {}

    def fake_urlopen(request: Any, timeout: float) -> _FakeResponse:
        captured.update(json.loads(request.data))
        assert timeout == 120.0
        return _FakeResponse(_response(manifest, manifest.source.sha256))

    monkeypatch.setattr("codegate_api.integrations.doc2md.urlopen", fake_urlopen)
    client = Doc2MdClient(
        base_url="http://doc2md.internal",
        resolver=SourceUriResolver(source_root),
        timeout_seconds=120.0,
    )

    converted = client.convert(manifest, expected_source_sha256=manifest.source.sha256)

    assert captured["path"] == str(source.resolve())
    assert captured["metadata"]["id"] == "REG-000001"
    assert captured["metadata"]["uri"] == "source://regulations/REG-000001.md"
    assert captured["metadata"]["revision"] == manifest.revision
    assert captured["metadata"]["authority_level"] == manifest.authority_level
    assert captured["metadata"]["issued_on"] == "2026-06-01"
    assert captured["metadata"]["effective_from"] == "2026-07-01"
    assert converted.converter == "doc2md:markitdown"


def test_doc2md_adapter_rejects_stale_cache_response(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    manifest = _manifest()
    source_root = tmp_path / "source"
    source = source_root / "regulations/REG-000001.md"
    source.parent.mkdir(parents=True)
    source.write_text("source", encoding="utf-8")
    monkeypatch.setattr(
        "codegate_api.integrations.doc2md.urlopen",
        lambda *_args, **_kwargs: _FakeResponse(_response(manifest, "f" * 64)),
    )
    client = Doc2MdClient(
        base_url="http://doc2md.internal",
        resolver=SourceUriResolver(source_root),
        timeout_seconds=120.0,
    )

    with pytest.raises(Doc2MdError) as raised:
        client.convert(manifest, expected_source_sha256=manifest.source.sha256)

    assert raised.value.code == "DOC2MD_STALE_CACHE"


def test_sync_pipeline_invokes_configured_doc2md_adapter(
    client: TestClient,
    auth_headers: dict[str, str],
    test_app: FastAPI,
) -> None:
    source_root = test_app.state.container.settings.resolved_source_root()

    class FakeDoc2Md:
        def __init__(self) -> None:
            self.expected_hashes: list[str] = []

        def convert(
            self,
            manifest: ManifestEntry,
            *,
            expected_source_sha256: str,
        ) -> ConversionResult:
            self.expected_hashes.append(expected_source_sha256)
            assert manifest.revision == "2"
            source_text = (source_root / manifest.source.filename).read_text(encoding="utf-8")
            assert "3년" in source_text
            text = (
                Path("demo/llm-wiki/docs/regulations/REG-000001.md")
                .read_text(encoding="utf-8")
                .replace("1년", "3년")
            )
            return ConversionResult(
                canonical_markdown=text,
                body=text,
                format="md",
                converter="fake-doc2md",
                warnings=(),
                cached=False,
            )

    converter = FakeDoc2Md()
    test_app.state.container.pipeline._doc2md = converter  # type: ignore[assignment]  # noqa: SLF001
    preview = client.post(
        "/api/v1/chat/messages",
        headers=auth_headers,
        json={
            "conversation_id": "doc2md-pipeline",
            "message": 'REG-000001에서 "1년"을 "3년"으로 변경해줘',
            "selected_document_id": "REG-000001",
        },
    ).json()["change_plan"]
    approved = client.post(
        f"/api/v1/change-plans/{preview['change_plan_id']}/approve",
        headers={**auth_headers, "Idempotency-Key": "doc2md-pipeline-key"},
        json={"plan_hash": preview["plan_hash"]},
    )
    assert approved.status_code == 202

    execution_id = approved.json()["execution_id"]
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        execution = client.get(f"/api/v1/executions/{execution_id}", headers=auth_headers).json()
        if execution["sync_status"] == "published":
            break
        time.sleep(0.01)
    else:
        raise AssertionError("doc2md-backed sync did not publish")

    assert converter.expected_hashes == [approved.json()["after_sha256"]]
    manifest = test_app.state.container.catalog.snapshot().get_manifest(
        "REG-000001",
        access_context=AccessContext.anonymous(),
    )
    assert manifest is not None
    assert manifest.conversion.converter == "fake-doc2md"
