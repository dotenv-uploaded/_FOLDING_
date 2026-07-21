from __future__ import annotations

import hashlib
from copy import deepcopy

import pytest

from wiki_builder.config import WikiConfig
from wiki_builder.errors import ValidationError
from wiki_builder.markdown import (
    load_documents,
    normalize_text,
    split_front_matter,
    strip_generated_anchors,
)


def test_loads_expected_documents_without_modifying_inputs(config: WikiConfig) -> None:
    input_dir = config.resolve_path("input_dir")
    before = {
        path.name: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(input_dir.glob("*.md"))
    }
    documents = load_documents(config)
    after = {
        path.name: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(input_dir.glob("*.md"))
    }
    assert len(documents) == 50
    assert sum(len(document.sections) for document in documents) == 148
    assert before == after


def test_generated_anchors_do_not_change_body(config: WikiConfig) -> None:
    for document in load_documents(config):
        source = normalize_text(document.input_path.read_text(encoding="utf-8"))
        _, source_body = split_front_matter(source, document.input_path)
        assert strip_generated_anchors(document.normalized_body) == normalize_text(source_body)
        assert document.normalized_body.count('<a id="sec-') == len(document.sections)


def test_front_matter_marks_unavailable_source_verification(config: WikiConfig) -> None:
    document = next(doc for doc in load_documents(config) if doc.doc_id == "REG-000001")
    assert document.metadata["source"]["verification"] == "unavailable"
    assert document.metadata["source"]["sha256"].endswith("0001")
    assert '<a id="art-1"></a>' in document.normalized_body


def test_document_preamble_is_retained_in_first_section(config: WikiConfig) -> None:
    document = next(doc for doc in load_documents(config) if doc.doc_id == "REG-000018")
    assert "효력이 종료되었으며" in document.sections[0].text
    assert "REG-000019.md" in document.sections[0].text


def test_document_count_limit_is_enforced(config: WikiConfig) -> None:
    raw = deepcopy(config.raw)
    raw["input_limits"]["max_documents"] = 49
    limited = WikiConfig(path=config.path, raw=raw)
    with pytest.raises(ValidationError, match="문서 수가 제한"):
        load_documents(limited)


def test_symlink_input_is_rejected(config: WikiConfig, tmp_path) -> None:
    input_dir = tmp_path / "source-md"
    input_dir.mkdir()
    source = config.resolve_path("input_dir") / "REG-000001.md"
    (input_dir / source.name).symlink_to(source)
    raw = deepcopy(config.raw)
    raw["paths"]["input_dir"] = str(input_dir)
    linked = WikiConfig(path=config.path, raw=raw)
    with pytest.raises(ValidationError, match="심볼릭 링크 입력"):
        load_documents(linked)
