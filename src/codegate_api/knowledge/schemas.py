from datetime import date, datetime
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AgentGuide(StrictModel):
    schema_version: Literal["1.0.0"]
    required_citations: list[Literal["document_id", "graph_version", "chunk_id"]]
    document_content_trust: Literal["untrusted"]
    read_acl_stage: Literal["before_retrieval"]
    write_authority: Literal["application_approval_only"]
    relation_statuses: list[Literal["VERIFIED"]]
    max_evidence_chunks: int = Field(ge=1, le=10)

    @field_validator("required_citations")
    @classmethod
    def require_all_citation_fields(
        cls,
        value: list[Literal["document_id", "graph_version", "chunk_id"]],
    ) -> list[Literal["document_id", "graph_version", "chunk_id"]]:
        required = {"document_id", "graph_version", "chunk_id"}
        if set(value) != required or len(value) != len(required):
            raise ValueError("required_citations must contain each required field exactly once")
        return value


class Editability(StrEnum):
    EDITABLE = "editable"
    READ_ONLY = "read_only"


class AccessLevel(StrEnum):
    PUBLIC = "public"
    INTERNAL = "internal"
    RESTRICTED = "restricted"


class WriteAccess(StrEnum):
    NONE = "none"
    RESTRICTED = "restricted"
    ALLOWED = "allowed"


class SourceMetadata(StrictModel):
    filename: str
    uri: str
    media_type: str
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class ConversionMetadata(StrictModel):
    converter: str
    conversion_version: str
    converted_at: datetime
    status: str


class ManifestEntry(StrictModel):
    schema_version: str
    id: str
    file_version_id: str
    title: str
    doc_type: str
    language: str
    revision: str
    status: str
    issued_on: date | None = None
    effective_from: date | None = None
    effective_to: date | None = None
    source: SourceMetadata
    canonical_path: str
    access: AccessLevel
    write_access: WriteAccess
    editability: Editability
    tags: list[str]
    aliases: list[str]
    conversion: ConversionMetadata


class Chunk(StrictModel):
    schema_version: str
    chunk_id: str
    document_id: str
    file_version_id: str
    section: str
    text: str
    text_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    ordinal: int = Field(ge=0)


class RelationStatus(StrEnum):
    VERIFIED = "VERIFIED"
    PROPOSED = "PROPOSED"


class Link(StrictModel):
    schema_version: str
    source_id: str
    target_id: str
    relation: str
    status: RelationStatus
    evidence_chunk_ids: list[str]
