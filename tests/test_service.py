from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from wiki_builder.builder import build_wiki
from wiki_builder.config import WikiConfig, WikiScope
from wiki_builder.errors import UnsafeOutputError, ValidationError

GENERAL_DOCUMENT = """---
schema_version: "1.0.0"
id: DOC-000001
title: 서비스 운영 메모
doc_type: general
language: ko
revision: "1"
status: active
official_number: null
authority_level: reference
issuing_org: 운영팀
issued_on: 2026-07-21
effective_from: null
effective_to: null
source:
  filename: service-note.txt
  uri: source://uploads/service-note.txt
  sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  verification: verified
access: internal
tags: []
aliases: []
---

# 서비스 운영 메모

## 목적

서비스 운영 상태를 기록한다.
"""


def _scope(config: WikiConfig, tmp_path: Path) -> WikiScope:
    input_dir = tmp_path / "source-md"
    shutil.copytree(config.resolve_path("input_dir"), input_dir)
    return WikiScope(
        tenant_id="tenant-a",
        wiki_id="operations",
        input_dir=input_dir,
        storage_root=tmp_path / "storage",
        synthetic_corpus=True,
        actor_id="tester",
    )


def test_add_update_delete_creates_distinct_immutable_builds(
    config: WikiConfig,
    tmp_path: Path,
) -> None:
    scope = _scope(config, tmp_path)
    first = build_wiki(config, scope, activate_incomplete=True)
    assert len(first.documents) == 50

    added_path = scope.input_dir / "DOC-000001.md"
    added_path.write_text(GENERAL_DOCUMENT, encoding="utf-8")
    second = build_wiki(config, scope, activate_incomplete=True)
    assert len(second.documents) == 51
    assert second.build_id != first.build_id
    assert first.build_dir.is_dir()
    assert (second.build_dir / "docs" / "general" / "DOC-000001.md").is_file()

    added_path.write_text(
        GENERAL_DOCUMENT.replace("운영 상태를 기록한다.", "운영 상태와 변경 이력을 기록한다."),
        encoding="utf-8",
    )
    third = build_wiki(config, scope, activate_incomplete=True)
    assert third.build_id not in {first.build_id, second.build_id}

    added_path.unlink()
    fourth = build_wiki(config, scope, activate_incomplete=True)
    assert len(fourth.documents) == 50
    assert fourth.build_id != third.build_id
    assert first.build_dir.is_dir() and second.build_dir.is_dir() and third.build_dir.is_dir()
    current = json.loads(scope.current_pointer.read_text(encoding="utf-8"))
    assert current["build_id"] == fourth.build_id


def test_same_inputs_reuse_same_immutable_build(config: WikiConfig, tmp_path: Path) -> None:
    scope = _scope(config, tmp_path)
    first = build_wiki(config, scope, activate_incomplete=True)
    second = build_wiki(config, scope, activate_incomplete=True)
    assert second.build_id == first.build_id
    assert second.created is False


def test_incomplete_build_is_not_activated_by_default(
    config: WikiConfig,
    tmp_path: Path,
) -> None:
    scope = _scope(config, tmp_path)
    result = build_wiki(config, scope)
    assert result.activated is False
    assert not scope.current_pointer.exists()


def test_scope_rejects_path_traversal(config: WikiConfig, tmp_path: Path) -> None:
    with pytest.raises(ValidationError, match="tenant_id"):
        WikiScope(
            tenant_id="../other",
            wiki_id="wiki",
            input_dir=config.resolve_path("input_dir"),
            storage_root=tmp_path,
        )


def test_stale_activation_is_rejected(config: WikiConfig, tmp_path: Path) -> None:
    scope = _scope(config, tmp_path)
    first = build_wiki(config, scope, activate_incomplete=True)

    added_path = scope.input_dir / "DOC-000001.md"
    added_path.write_text(GENERAL_DOCUMENT, encoding="utf-8")
    second = build_wiki(
        config,
        scope,
        activate_incomplete=True,
        expected_current_build_id=first.build_id,
    )

    added_path.write_text(
        GENERAL_DOCUMENT.replace("운영 상태를 기록한다.", "오래된 요청의 변경이다."),
        encoding="utf-8",
    )
    with pytest.raises(UnsafeOutputError, match="요청 시작 시점과 달라"):
        build_wiki(
            config,
            scope,
            activate_incomplete=True,
            expected_current_build_id=first.build_id,
        )
    current = json.loads(scope.current_pointer.read_text(encoding="utf-8"))
    assert current["build_id"] == second.build_id
