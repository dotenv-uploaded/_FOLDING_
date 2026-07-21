import hashlib
import json
import re
import tomllib
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from codegate_api.files.resolver import SourceUriResolver
from codegate_api.knowledge.access import AccessContext
from codegate_api.knowledge.schemas import AgentGuide, Chunk, Link, ManifestEntry
from codegate_api.models import DocumentResult, Evidence, Relation


class KnowledgePackageError(RuntimeError):
    """Raised when the llm-wiki package violates its integrity contract."""


REQUIRED_CHECKSUM_PATHS = frozenset(
    {
        "AGENT_GUIDE.md",
        "README.md",
        "VERSION",
        "manifest.jsonl",
        "retrieval/aliases.json",
        "retrieval/chunks.jsonl",
        "retrieval/links.jsonl",
        "schemas/agent-guide.schema.json",
        "schemas/chunk.schema.json",
        "schemas/link.schema.json",
        "schemas/manifest.schema.json",
    }
)


class KnowledgeRepository:
    def __init__(self, package_root: Path, source_resolver: SourceUriResolver) -> None:
        self._root = package_root.resolve()
        self._source_resolver = source_resolver
        self._version = "unknown"
        self._agent_guide: AgentGuide | None = None
        self._documents: dict[str, ManifestEntry] = {}
        self._chunks: list[Chunk] = []
        self._links: list[Link] = []
        self._loaded = False

    @property
    def version(self) -> str:
        self._ensure_loaded()
        return self._version

    @property
    def agent_guide(self) -> AgentGuide:
        self._ensure_loaded()
        assert self._agent_guide is not None
        return self._agent_guide

    def load(self) -> None:
        checksummed_paths = self._validate_checksums()
        missing_checksums = REQUIRED_CHECKSUM_PATHS - checksummed_paths
        if missing_checksums:
            missing = ", ".join(sorted(missing_checksums))
            raise KnowledgePackageError(f"required checksum entries are missing: {missing}")
        self._version = self._read_required_text("VERSION").strip()
        if not self._version:
            raise KnowledgePackageError("VERSION must not be empty")
        self._agent_guide = self._read_agent_guide()

        documents = [
            ManifestEntry.model_validate(item) for item in self._read_jsonl("manifest.jsonl")
        ]
        self._documents = {document.id: document for document in documents}
        if len(self._documents) != len(documents):
            raise KnowledgePackageError("manifest contains duplicate document IDs")

        self._chunks = [
            Chunk.model_validate(item) for item in self._read_jsonl("retrieval/chunks.jsonl")
        ]
        self._links = [
            Link.model_validate(item) for item in self._read_jsonl("retrieval/links.jsonl")
        ]
        self._validate_references(checksummed_paths)
        self._loaded = True

    def search(
        self,
        query: str,
        *,
        access_context: AccessContext,
        top_k: int = 5,
    ) -> list[DocumentResult]:
        self._ensure_loaded()
        tokens = self._tokens(query)
        if not tokens:
            return []

        best_chunks: dict[str, tuple[float, Chunk]] = {}
        for chunk in self._chunks:
            document = self._documents[chunk.document_id]
            if not access_context.can_read(document):
                continue
            metadata = " ".join([document.title, *document.tags, *document.aliases]).lower()
            content = " ".join([chunk.text, chunk.section]).lower()
            weighted_matches = sum(
                2 if token in metadata else 1 if token in content else 0 for token in tokens
            )
            if weighted_matches == 0:
                continue
            score = weighted_matches / (len(tokens) * 2)
            previous = best_chunks.get(chunk.document_id)
            if previous is None or score > previous[0]:
                best_chunks[chunk.document_id] = (score, chunk)

        doc_type_priority = {"regulation": 0, "manual": 1, "report": 2}
        ranked = sorted(
            best_chunks.items(),
            key=lambda item: (
                -item[1][0],
                doc_type_priority.get(self._documents[item[0]].doc_type, 99),
                item[0],
            ),
        )[:top_k]
        return [
            self._to_result(document_id, score, chunk, access_context)
            for document_id, (score, chunk) in ranked
        ]

    def get(
        self,
        document_id: str,
        *,
        access_context: AccessContext,
    ) -> DocumentResult | None:
        self._ensure_loaded()
        document = self._documents.get(document_id)
        if document is None or not access_context.can_read(document):
            return None
        chunk = next(chunk for chunk in self._chunks if chunk.document_id == document_id)
        return self._to_result(document_id, 1.0, chunk, access_context)

    def _to_result(
        self,
        document_id: str,
        score: float,
        chunk: Chunk,
        access_context: AccessContext,
    ) -> DocumentResult:
        document = self._documents[document_id]
        relations = [
            Relation(relation=link.relation, target_document_id=link.target_id)
            for link in self._links
            if (
                link.source_id == document_id
                and link.status == "VERIFIED"
                and access_context.can_read(self._documents[link.target_id])
            )
        ]
        return DocumentResult(
            document_id=document.id,
            file_version_id=document.file_version_id,
            title=document.title,
            display_path=document.source.filename,
            source_uri=document.source.uri,
            score=round(score, 4),
            graph_version=self._version,
            evidence=[Evidence(chunk_id=chunk.chunk_id, section=chunk.section, quote=chunk.text)],
            relations=relations,
            can_read=True,
            can_write=access_context.can_write(document),
            editability=document.editability.value,
        )

    def _validate_checksums(self) -> set[str]:
        checksum_lines = self._read_required_text("checksums.sha256").splitlines()
        if not checksum_lines:
            raise KnowledgePackageError("checksums.sha256 must not be empty")

        checksummed_paths: set[str] = set()
        for line in checksum_lines:
            try:
                expected, relative_name = line.split(maxsplit=1)
            except ValueError as error:
                raise KnowledgePackageError("invalid checksum line") from error
            relative_name = relative_name.removeprefix("*").strip()
            if relative_name in checksummed_paths:
                raise KnowledgePackageError(f"duplicate checksum entry: {relative_name}")
            path = self._safe_package_path(relative_name)
            if not path.is_file():
                raise KnowledgePackageError(f"checksum target is missing: {relative_name}")
            actual = hashlib.sha256(path.read_bytes()).hexdigest()
            if actual != expected:
                raise KnowledgePackageError(f"checksum mismatch: {relative_name}")
            checksummed_paths.add(relative_name)
        return checksummed_paths

    def _validate_references(self, checksummed_paths: set[str]) -> None:
        chunk_ids = {chunk.chunk_id for chunk in self._chunks}
        for document in self._documents.values():
            if document.canonical_path not in checksummed_paths:
                raise KnowledgePackageError(
                    f"canonical document is not checksummed: {document.canonical_path}"
                )
            canonical = self._safe_package_path(document.canonical_path)
            if not canonical.is_file():
                raise KnowledgePackageError(
                    f"canonical document is missing: {document.canonical_path}"
                )
            source = self._source_resolver.resolve(document.source.uri)
            if not source.is_file():
                raise KnowledgePackageError(f"source document is missing: {document.source.uri}")
            source_sha256 = hashlib.sha256(source.read_bytes()).hexdigest()
            if source_sha256 != document.source.sha256:
                raise KnowledgePackageError(f"source checksum mismatch: {document.source.uri}")

        for chunk in self._chunks:
            if chunk.document_id not in self._documents:
                raise KnowledgePackageError(
                    f"chunk references unknown document: {chunk.document_id}"
                )
            text_sha256 = hashlib.sha256(chunk.text.encode("utf-8")).hexdigest()
            if text_sha256 != chunk.text_sha256:
                raise KnowledgePackageError(f"chunk checksum mismatch: {chunk.chunk_id}")
        for link in self._links:
            if link.source_id not in self._documents or link.target_id not in self._documents:
                raise KnowledgePackageError("link references unknown document")
            if not set(link.evidence_chunk_ids).issubset(chunk_ids):
                raise KnowledgePackageError("link references unknown evidence chunk")

    def _read_agent_guide(self) -> AgentGuide:
        raw_guide = self._read_required_text("AGENT_GUIDE.md")
        if len(raw_guide.encode("utf-8")) > 32_768:
            raise KnowledgePackageError("AGENT_GUIDE.md exceeds 32 KiB")
        sections = raw_guide.split("+++", maxsplit=2)
        if len(sections) != 3 or sections[0].strip() or not sections[2].strip():
            raise KnowledgePackageError("AGENT_GUIDE.md requires TOML frontmatter and a body")
        try:
            metadata = tomllib.loads(sections[1])
            return AgentGuide.model_validate(metadata)
        except (tomllib.TOMLDecodeError, ValidationError) as error:
            raise KnowledgePackageError("invalid AGENT_GUIDE.md frontmatter") from error

    def _read_jsonl(self, relative_name: str) -> Iterable[dict[str, Any]]:
        path = self._safe_package_path(relative_name)
        for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise KnowledgePackageError(
                    f"invalid JSONL at {relative_name}:{line_number}"
                ) from error
            if not isinstance(value, dict):
                raise KnowledgePackageError(
                    f"JSONL object required at {relative_name}:{line_number}"
                )
            yield value

    def _read_required_text(self, relative_name: str) -> str:
        path = self._safe_package_path(relative_name)
        if not path.is_file():
            raise KnowledgePackageError(f"required package file is missing: {relative_name}")
        return path.read_text(encoding="utf-8")

    def _safe_package_path(self, relative_name: str) -> Path:
        candidate = (self._root / relative_name).resolve()
        if not candidate.is_relative_to(self._root):
            raise KnowledgePackageError(f"package path escapes root: {relative_name}")
        return candidate

    def _ensure_loaded(self) -> None:
        if not self._loaded:
            self.load()

    @staticmethod
    def _tokens(query: str) -> list[str]:
        return [
            token.lower() for token in re.findall(r"[0-9A-Za-z가-힣]+", query) if len(token) > 1
        ]
