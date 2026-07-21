from pydantic import BaseModel, Field


class SourceInfo(BaseModel):
    filename: str
    uri: str
    sha256: str


class Frontmatter(BaseModel):
    schema_version: str = "1.0.0"
    id: str
    title: str
    doc_type: str
    language: str
    revision: str
    status: str = "active"

    official_number: str | None = None
    authority_level: str | None = None
    issuing_org: str | None = None

    issued_on: str | None = None
    effective_from: str | None = None
    effective_to: str | None = None

    source: SourceInfo

    access: str = "internal"
    tags: list[str] = []
    aliases: list[str] = []


class MetadataOverrides(BaseModel):
    """Fields a caller can supply explicitly; anything left None is auto-derived."""

    id: str | None = None
    title: str | None = None
    doc_type: str | None = None
    language: str | None = None
    revision: str | int | None = None
    status: str | None = None

    official_number: str | None = None
    authority_level: str | None = None
    issuing_org: str | None = None

    issued_on: str | None = None
    effective_from: str | None = None
    effective_to: str | None = None

    uri: str | None = None
    access: str | None = None
    tags: list[str] | None = None
    aliases: list[str] | None = None


class ConvertRequest(BaseModel):
    path: str = Field(..., description="Absolute path to the source file on disk")
    metadata: MetadataOverrides = MetadataOverrides()


class RawConversion(BaseModel):
    """The expensive part: just the extracted body text, cacheable by file content."""

    body: str
    format: str
    library_used: str
    warnings: list[str] = []


class ConvertResult(BaseModel):
    markdown: str = Field(..., description="Full document: YAML frontmatter + body")
    frontmatter: Frontmatter
    body: str = Field(..., description="Markdown body only, without frontmatter")
    format: str
    library_used: str
    warnings: list[str] = []
    cached: bool = False
