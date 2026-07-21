from typing import Literal

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
    # "{청킹파일명}_{청킹번호}". doc2md emits one whole document, so it defaults to
    # chunk 1 of this file; a downstream chunker overrides it per chunk.
    chunk_no: str | None = None

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
    chunk_no: str | None = None

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


class ChunkOptions(BaseModel):
    """How to split the document for LLM consumption. Sizes are in characters."""

    enabled: bool = False
    strategy: Literal["fixed", "ratio"] = Field(
        "fixed",
        description="'fixed' caps every chunk at max_chars; 'ratio' sizes chunks "
        "as 1/parts of this document, so each document yields ~parts chunks",
    )
    parts: int = Field(5, ge=2, le=100, description="ratio strategy: target chunk count")
    max_chars: int = Field(4000, ge=200, le=1_000_000)
    min_chars: int = Field(2400, ge=0, le=1_000_000)
    # ratio strategy guards: splitting a short document into `parts` pieces
    # produces useless fragments, and a huge one could overflow a context window
    ratio_floor_chars: int = Field(2000, ge=200, le=1_000_000)
    ratio_cap_chars: int = Field(120_000, ge=1000, le=1_000_000)
    split_level: int = Field(
        2, ge=1, le=6, description="Headings at or above this level start a new chunk"
    )

    def resolve(self, body_len: int) -> tuple[int, int]:
        """Return the (max_chars, min_chars) to actually use for this document."""
        if self.strategy != "ratio":
            return self.max_chars, self.min_chars
        target = max(
            self.ratio_floor_chars, min(self.ratio_cap_chars, body_len // self.parts + 1)
        )
        return target, int(target * 0.6)


class ConvertRequest(BaseModel):
    path: str = Field(..., description="Absolute path to the source file on disk")
    metadata: MetadataOverrides = MetadataOverrides()
    chunking: ChunkOptions = ChunkOptions()
    job_id: str | None = Field(
        None,
        description="Track progress under this id; generate one client-side to "
        "poll /jobs/{job_id} while a blocking /convert runs. Optional.",
    )


class RawConversion(BaseModel):
    """The expensive part: just the extracted body text, cacheable by file content."""

    body: str
    format: str
    library_used: str
    warnings: list[str] = []


class BatchConvertRequest(BaseModel):
    """Convert several files, each tracked with its own progress/ETA."""

    paths: list[str] = Field(..., min_length=1)
    metadata: MetadataOverrides = MetadataOverrides()
    chunking: ChunkOptions = ChunkOptions()
    batch_id: str | None = None


class DocumentChunk(BaseModel):
    """One LLM-sized piece of the document, usable on its own."""

    chunk_no: str = Field(..., description="{청킹파일명}_{청킹번호}")
    index: int
    markdown: str = Field(..., description="This chunk's own frontmatter + its body")
    body: str = Field(..., description="Chunk body only, without frontmatter")
    frontmatter: Frontmatter
    heading_path: list[str] = Field(
        default_factory=list, description="Section breadcrumb this chunk sits under"
    )
    chars: int


class ConvertResult(BaseModel):
    markdown: str = Field(..., description="Full document: YAML frontmatter + body")
    frontmatter: Frontmatter
    body: str = Field(..., description="Markdown body only, without frontmatter")
    format: str
    library_used: str
    warnings: list[str] = []
    cached: bool = False
    chunks: list[DocumentChunk] | None = Field(
        None, description="Present only when chunking was requested"
    )
