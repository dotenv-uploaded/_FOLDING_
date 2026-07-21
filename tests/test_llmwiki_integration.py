from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
import yaml

from codegate_api.files.atomic import SafeSourceFileStore
from codegate_api.files.resolver import SourceUriResolver
from codegate_api.knowledge.access import AccessContext
from codegate_api.knowledge.llmwiki import (
    LLMWikiCompatibilityAdapter,
    LLMWikiCompatibilityError,
    NativeLLMWikiCatalog,
    NativeLLMWikiPipeline,
)
from codegate_api.knowledge.repository import KnowledgeRepository
from codegate_api.state.store import PendingEvent, StateStore


@dataclass(frozen=True)
class NativeFixture:
    adapter: LLMWikiCompatibilityAdapter
    source_root: Path
    source_path: Path
    input_path: Path
    compatibility_root: Path
    before_sha256: str


def _sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _write_jsonl(path: Path, values: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(json.dumps(value, ensure_ascii=False, sort_keys=True) + "\n" for value in values),
        encoding="utf-8",
    )


def _frontmatter(source_sha256: str, body: str, *, revision: str = "1") -> str:
    metadata = {
        "schema_version": "1.0.0",
        "id": "REG-100001",
        "title": "개인정보 처리 규정",
        "doc_type": "regulation",
        "language": "ko",
        "revision": revision,
        "status": "active",
        "official_number": None,
        "authority_level": "regulation",
        "issuing_org": "정보보호위원회",
        "issued_on": None,
        "effective_from": None,
        "effective_to": None,
        "source": {
            "filename": "regulations/REG-100001.md",
            "uri": "source://regulations/REG-100001.md",
            "sha256": source_sha256,
        },
        "access": "public",
        "tags": ["개인정보"],
        "aliases": ["보관 규정"],
    }
    return "---\n" + yaml.safe_dump(metadata, allow_unicode=True, sort_keys=False) + "---\n" + body


def _create_native_fixture(tmp_path: Path) -> NativeFixture:
    source_root = tmp_path / "source"
    source_path = source_root / "regulations/REG-100001.md"
    source_path.parent.mkdir(parents=True)
    source_content = "# local source\n\n개인정보는 1년간 보관한다.\n".encode()
    source_path.write_bytes(source_content)
    source_sha256 = _sha256(source_content)

    input_root = tmp_path / "input"
    input_root.mkdir()
    input_path = input_root / "REG-100001.md"
    body = (
        '# 개인정보 처리 규정\n\n<a id="art-1"></a>\n## 보관 기간\n\n개인정보는 1년간 보관한다.\n'
    )
    input_text = _frontmatter(source_sha256, body)
    input_path.write_text(input_text, encoding="utf-8")

    build_id = "build-0123456789abcdefabcd"
    storage_root = tmp_path / "storage"
    wiki_root = storage_root / "tenants/local/wikis/workspace"
    build_dir = wiki_root / "builds" / build_id
    canonical_path = build_dir / "docs/regulations/REG-100001.md"
    canonical_text = _frontmatter(
        source_sha256,
        "# 개인정보 처리 규정\n\n"
        '<a id="art-1"></a>\n'
        '<a id="sec-0123456789"></a>\n'
        "## 보관 기간\n\n개인정보는 1년간 보관한다.\n",
    )
    canonical_path.parent.mkdir(parents=True, exist_ok=True)
    canonical_path.write_text(canonical_text, encoding="utf-8")
    (build_dir / "README.md").write_text("# Native LLMWIKI\n", encoding="utf-8")

    manifest = {
        "schema_version": "1.0.0",
        "wiki_version": "1.0.0",
        "doc_id": "REG-100001",
        "revision": "1",
        "title": "개인정보 처리 규정",
        "doc_type": "regulation",
        "language": "ko",
        "status": "active",
        "official_number": None,
        "authority_level": "regulation",
        "issuing_org": "정보보호위원회",
        "issued_on": None,
        "effective_from": None,
        "effective_to": None,
        "path": "docs/regulations/REG-100001.md",
        "access": "public",
        "tags": ["개인정보"],
        "aliases": ["보관 규정"],
        "source": {
            "filename": "regulations/REG-100001.md",
            "uri": "source://regulations/REG-100001.md",
            "sha256": source_sha256,
            "verification": "verified",
        },
        "ingest": {
            "path": "source-md/REG-100001.md",
            "sha256": _sha256(input_text.encode()),
        },
        "content_sha256": _sha256(canonical_text.encode()),
        "section_count": 1,
        "chunk_count": 1,
        "link_count": 0,
        "summary": None,
        "keywords": [],
        "enrichment": {
            "status": "pending",
            "model": None,
            "prompt_version": None,
            "record_ref": None,
        },
    }
    chunk_text = "개인정보는 1년간 보관한다."
    chunk = {
        "schema_version": "1.0.0",
        "wiki_version": "1.0.0",
        "chunk_id": "REG-100001@1#sec-0123456789:c001",
        "doc_id": "REG-100001",
        "revision": "1",
        "ordinal": 1,
        "section_id": "sec-0123456789",
        "heading_path": ["개인정보 처리 규정", "보관 기간"],
        "chunk_type": "section",
        "text": chunk_text,
        "embedding_text": f"개인정보 처리 규정\n보관 기간\n{chunk_text}",
        "char_count": len(chunk_text),
        "source_path": "docs/regulations/REG-100001.md",
        "content_sha256": _sha256(chunk_text.encode()),
        "status": "active",
        "effective_from": None,
        "effective_to": None,
        "tags": ["개인정보"],
        "access": "public",
    }
    _write_jsonl(build_dir / "manifest.jsonl", [manifest])
    _write_jsonl(build_dir / "retrieval/chunks.jsonl", [chunk])
    _write_jsonl(build_dir / "retrieval/links.jsonl", [])
    _write_json(
        build_dir / "retrieval/aliases.json",
        {
            "schema_version": "1.0.0",
            "normalization": "NFC+whitespace",
            "entries": [
                {
                    "term": "보관 규정",
                    "targets": [{"doc_id": "REG-100001", "kind": "declared"}],
                }
            ],
        },
    )
    _write_json(
        build_dir / "build-meta.json",
        {
            "schema_version": "1.0.0",
            "wiki_version": "1.0.0",
            "build_format_version": "server-v1",
            "tenant_id": "local",
            "wiki_id": "workspace",
            "build_id": build_id,
        },
    )
    permissive_schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
    }
    for name in ("current", "build-meta", "manifest", "chunk", "link", "aliases"):
        _write_json(build_dir / f"schemas/{name}.schema.json", permissive_schema)
    _write_json(
        wiki_root / "current.json",
        {
            "schema_version": "1.0.0",
            "tenant_id": "local",
            "wiki_id": "workspace",
            "build_id": build_id,
            "relative_path": f"builds/{build_id}",
            "complete": False,
        },
    )

    compatibility_root = tmp_path / "compatibility"
    adapter = LLMWikiCompatibilityAdapter(
        source_resolver=SourceUriResolver(source_root),
        input_root=input_root,
        storage_root=storage_root,
        compatibility_root=compatibility_root,
        tenant_id="local",
        wiki_id="workspace",
    )
    return NativeFixture(
        adapter=adapter,
        source_root=source_root,
        source_path=source_path,
        input_path=input_path,
        compatibility_root=compatibility_root,
        before_sha256=source_sha256,
    )


def _build_pipeline(fixture: NativeFixture, tmp_path: Path) -> NativeLLMWikiPipeline:
    catalog = NativeLLMWikiCatalog(
        adapter=fixture.adapter,
        runner=object(),  # type: ignore[arg-type]
        source_resolver=SourceUriResolver(fixture.source_root),
    )
    catalog.bootstrap()
    state = StateStore(tmp_path / "state.sqlite3")
    state.initialize()
    return NativeLLMWikiPipeline(
        catalog=catalog,
        file_store=SafeSourceFileStore(
            SourceUriResolver(fixture.source_root),
            backup_root=tmp_path / "backups",
            max_bytes=1_000_000,
        ),
        state_store=state,
    )


def _event(
    fixture: NativeFixture,
    *,
    event_id: str,
    before_sha256: str,
    after_sha256: str,
    expected_text: str,
    replacement_text: str,
) -> PendingEvent:
    execution_id = f"exec_{event_id}"
    return PendingEvent(
        event_id=event_id,
        execution_id=execution_id,
        attempts=0,
        payload={
            "schema_version": "1.0.0",
            "event_id": event_id,
            "execution_id": execution_id,
            "document_id": "REG-100001",
            "source_uri": "source://regulations/REG-100001.md",
            "before_sha256": before_sha256,
            "after_sha256": after_sha256,
            "file_version_id": f"fv_{after_sha256}",
            "operation": {
                "type": "replace_exact",
                "expected_text": expected_text,
                "replacement_text": replacement_text,
                "expected_occurrences": 1,
            },
        },
    )


def test_native_llmwiki_build_is_mapped_to_valid_read_cache(tmp_path: Path) -> None:
    fixture = _create_native_fixture(tmp_path)
    build = fixture.adapter.current_native_build()

    assert build is not None
    package_root = fixture.adapter.materialize(build)
    repository = KnowledgeRepository(
        package_root,
        SourceUriResolver(fixture.source_root),
    )
    repository.load()

    assert repository.version == build.build_id
    assert repository.index_artifacts_available is True
    result = repository.get("REG-100001", access_context=AccessContext.anonymous())
    assert result is not None
    assert result.evidence[0].quote == "개인정보는 1년간 보관한다."
    source = repository.read_source_text(
        "REG-100001",
        access_context=AccessContext.anonymous(),
    )
    assert source is not None
    assert "1년간" in source[1]
    assert fixture.adapter.input_path(build, "REG-100001") == fixture.input_path
    canonical = (package_root / "docs/regulations/REG-100001.md").read_text(encoding="utf-8")
    assert '<span id="art-1"></span>' in canonical
    assert canonical.count('<a id="sec-0123456789"></a>') == 1


def test_native_llmwiki_adapter_rejects_symlinked_canonical_file(tmp_path: Path) -> None:
    fixture = _create_native_fixture(tmp_path)
    build = fixture.adapter.current_native_build()
    assert build is not None
    canonical = build.build_dir / "docs/regulations/REG-100001.md"
    target = tmp_path / "outside.md"
    target.write_text(canonical.read_text(encoding="utf-8"), encoding="utf-8")
    canonical.unlink()
    canonical.symlink_to(target)

    try:
        fixture.adapter.materialize(build)
    except LLMWikiCompatibilityError as error:
        assert "symlink" in str(error)
    else:
        raise AssertionError("symlinked native canonical file was accepted")


def test_native_pipeline_updates_normalized_body_source_hash_and_revision(
    tmp_path: Path,
) -> None:
    fixture = _create_native_fixture(tmp_path)
    pipeline = _build_pipeline(fixture, tmp_path)

    changed_source = fixture.source_path.read_text(encoding="utf-8").replace("1년", "3년")
    fixture.source_path.write_text(changed_source, encoding="utf-8")
    after_sha256 = _sha256(changed_source.encode())
    event = _event(
        fixture,
        event_id="evt_test",
        before_sha256=fixture.before_sha256,
        after_sha256=after_sha256,
        expected_text="1년",
        replacement_text="3년",
    )

    assert pipeline._apply_inputs([event]) == {"REG-100001"}  # noqa: SLF001
    assert pipeline._apply_inputs([event]) == {"REG-100001"}  # noqa: SLF001

    text = fixture.input_path.read_text(encoding="utf-8")
    lines = text.split("---", maxsplit=2)
    metadata = yaml.safe_load(lines[1])
    assert metadata["revision"] == "2"
    assert metadata["source"]["sha256"] == after_sha256
    assert "개인정보는 3년간 보관한다." in lines[2]


def test_native_pipeline_rejects_unapproved_normalized_input_content(tmp_path: Path) -> None:
    fixture = _create_native_fixture(tmp_path)
    pipeline = _build_pipeline(fixture, tmp_path)
    fixture.input_path.write_text(
        fixture.input_path.read_text(encoding="utf-8").replace(
            "## 보관 기간",
            "UNAPPROVED-CONTENT\n\n## 보관 기간",
        ),
        encoding="utf-8",
    )
    changed_source = fixture.source_path.read_text(encoding="utf-8").replace("1년", "3년")
    fixture.source_path.write_text(changed_source, encoding="utf-8")
    event = _event(
        fixture,
        event_id="evt_unapproved",
        before_sha256=fixture.before_sha256,
        after_sha256=_sha256(changed_source.encode()),
        expected_text="1년",
        replacement_text="3년",
    )

    with pytest.raises(LLMWikiCompatibilityError, match="unapproved change"):
        pipeline._apply_inputs([event])  # noqa: SLF001


def test_native_pipeline_rejects_live_source_hash_race(tmp_path: Path) -> None:
    fixture = _create_native_fixture(tmp_path)
    pipeline = _build_pipeline(fixture, tmp_path)
    approved_source = fixture.source_path.read_text(encoding="utf-8").replace("1년", "3년")
    event = _event(
        fixture,
        event_id="evt_source_race",
        before_sha256=fixture.before_sha256,
        after_sha256=_sha256(approved_source.encode()),
        expected_text="1년",
        replacement_text="3년",
    )
    fixture.source_path.write_text(
        approved_source.replace("3년", "9년"),
        encoding="utf-8",
    )

    with pytest.raises(LLMWikiCompatibilityError, match="live source changed"):
        pipeline._apply_inputs([event])  # noqa: SLF001

    fixture.source_path.write_text(approved_source, encoding="utf-8")
    assert pipeline._apply_inputs([event]) == {"REG-100001"}  # noqa: SLF001
    fixture.source_path.write_text(
        approved_source.replace("3년", "9년"),
        encoding="utf-8",
    )
    with pytest.raises(LLMWikiCompatibilityError, match="live source changed"):
        pipeline._verify_live_sources([event])  # noqa: SLF001


def test_native_pipeline_restores_active_input_after_failed_publish_undo(
    tmp_path: Path,
) -> None:
    fixture = _create_native_fixture(tmp_path)
    pipeline = _build_pipeline(fixture, tmp_path)
    original_source = fixture.source_path.read_text(encoding="utf-8")
    changed_source = original_source.replace("1년", "3년")
    changed_sha256 = _sha256(changed_source.encode())
    fixture.source_path.write_text(changed_source, encoding="utf-8")
    forward = _event(
        fixture,
        event_id="evt_forward",
        before_sha256=fixture.before_sha256,
        after_sha256=changed_sha256,
        expected_text="1년",
        replacement_text="3년",
    )
    assert pipeline._apply_inputs([forward]) == {"REG-100001"}  # noqa: SLF001

    fixture.source_path.write_text(original_source, encoding="utf-8")
    undo = _event(
        fixture,
        event_id="evt_undo",
        before_sha256=changed_sha256,
        after_sha256=fixture.before_sha256,
        expected_text="3년",
        replacement_text="1년",
    )

    assert pipeline._apply_inputs([undo]) == set()  # noqa: SLF001
    restored = fixture.input_path.read_text(encoding="utf-8")
    metadata = yaml.safe_load(restored.split("---", maxsplit=2)[1])
    assert metadata["revision"] == "1"
    assert metadata["source"]["sha256"] == fixture.before_sha256
    assert "개인정보는 1년간 보관한다." in restored
    assert "개인정보는 3년간 보관한다." not in restored
