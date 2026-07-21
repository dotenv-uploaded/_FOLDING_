from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class Section:
    section_id: str
    heading: str
    heading_path: tuple[str, ...]
    ordinal: int
    text: str

    @property
    def evidence_text(self) -> str:
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


@dataclass
class BuildData:
    documents: list[Document] = field(default_factory=list)
    chunks: list[dict[str, Any]] = field(default_factory=list)
    aliases: dict[str, Any] = field(default_factory=dict)
    links: list[dict[str, Any]] = field(default_factory=list)
    manifest: list[dict[str, Any]] = field(default_factory=list)
    enrichments: list[dict[str, Any]] = field(default_factory=list)
