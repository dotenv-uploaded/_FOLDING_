from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class SourceFragment:
    input_path: Path
    input_relative_path: str
    chunk_no: str | None
    original_sha256: str
    normalized_body: str


@dataclass(frozen=True)
class Section:
    section_id: str
    heading: str
    heading_path: tuple[str, ...]
    ordinal: int
    text: str
    source_chunk_no: str | None = None
    source_input_relative_path: str | None = None
    source_input_sha256: str | None = None
    pre_chunked: bool = False
    include_heading_in_evidence: bool = True

    @property
    def evidence_text(self) -> str:
        if not self.include_heading_in_evidence:
            return self.text.rstrip()
        return f"## {self.heading}\n\n{self.text}".rstrip()


@dataclass(frozen=True)
class Document:
    input_path: Path
    input_relative_path: str
    output_relative_path: str
    metadata: dict[str, Any]
    original_sha256: str
    normalized_markdown: str
    normalized_body: str
    sections: tuple[Section, ...]
    h1_title: str
    source_fragments: tuple[SourceFragment, ...] = ()
    chunking_mode: str = "sections"

    @property
    def doc_id(self) -> str:
        return str(self.metadata["id"])

    @property
    def revision(self) -> str:
        return str(self.metadata["revision"])

    @property
    def title(self) -> str:
        return str(self.metadata["title"])


@dataclass(frozen=True)
class Link:
    from_doc_id: str
    from_section_id: str
    to_doc_id: str
    evidence_quote: str
    relation_type: str = "references"
    origin: str = "explicit"
    #: 이 간선을 만든 **모든** 근거(엔티티 겹침으로 유도된 간선에만 채워진다).
    #:
    #: `evidence_quote` 는 대표 하나뿐이라 "왜 이어졌나"를 물으면 절반만 답하게 된다.
    #: 화면에서 근거를 보여주려면 겹친 엔티티가 무엇무엇인지, 그리고 **양쪽 문서가 각각
    #: 어느 문장에서 그것을 말했는지**가 있어야 한다. 겹친 개수는 곧 연결의 강도이기도 하다.
    shared_entities: tuple[dict[str, str], ...] = ()


@dataclass
class BuildData:
    documents: list[Document] = field(default_factory=list)
    chunks: list[dict[str, Any]] = field(default_factory=list)
    aliases: dict[str, Any] = field(default_factory=dict)
    links: list[dict[str, Any]] = field(default_factory=list)
    manifest: list[dict[str, Any]] = field(default_factory=list)
    enrichments: list[dict[str, Any]] = field(default_factory=list)
