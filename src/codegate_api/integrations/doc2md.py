from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from codegate_api.files.resolver import SourceUriResolver
from codegate_api.knowledge.schemas import ManifestEntry


class Doc2MdError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class Doc2MdSource(BaseModel):
    model_config = ConfigDict(extra="ignore")

    filename: str
    uri: str
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class Doc2MdFrontmatter(BaseModel):
    model_config = ConfigDict(extra="ignore")

    schema_version: str
    id: str
    title: str
    doc_type: str
    language: str
    revision: str
    status: str
    official_number: str | None = None
    authority_level: str | None = None
    issuing_org: str | None = None
    issued_on: str | None = None
    effective_from: str | None = None
    effective_to: str | None = None
    source: Doc2MdSource
    access: str
    tags: list[str]
    aliases: list[str]


class Doc2MdResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    markdown: str
    frontmatter: Doc2MdFrontmatter
    body: str
    format: str
    library_used: str
    warnings: list[str]
    cached: bool


@dataclass(frozen=True, slots=True)
class ConversionResult:
    canonical_markdown: str
    body: str
    format: str
    converter: str
    warnings: tuple[str, ...]
    cached: bool


class Doc2MdClient:
    """Internal-only consumer for the team's standalone doc2md v0.1.0 API."""

    def __init__(
        self,
        *,
        base_url: str,
        resolver: SourceUriResolver,
        timeout_seconds: float,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._resolver = resolver
        self._timeout = timeout_seconds

    def convert(
        self,
        manifest: ManifestEntry,
        *,
        expected_source_sha256: str,
    ) -> ConversionResult:
        path = self._resolver.resolve(manifest.source.uri)
        self._validate_resolved_source(path)
        payload = {
            "path": str(path),
            "metadata": {
                "id": manifest.id,
                "title": manifest.title,
                "doc_type": manifest.doc_type,
                "language": manifest.language,
                "revision": manifest.revision,
                "status": manifest.status,
                "official_number": manifest.official_number,
                "authority_level": manifest.authority_level,
                "issuing_org": manifest.issuing_org,
                "issued_on": manifest.issued_on.isoformat() if manifest.issued_on else None,
                "effective_from": (
                    manifest.effective_from.isoformat() if manifest.effective_from else None
                ),
                "effective_to": (
                    manifest.effective_to.isoformat() if manifest.effective_to else None
                ),
                "uri": manifest.source.uri,
                "access": manifest.access.value,
                "tags": manifest.tags,
                "aliases": manifest.aliases,
            },
        }
        request = Request(
            f"{self._base_url}/convert",
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json", "Accept": "application/json"},
            method="POST",
        )
        try:
            with urlopen(request, timeout=self._timeout) as response:  # noqa: S310
                body = response.read()
        except HTTPError as error:
            code = "DOC2MD_SOURCE_NOT_FOUND" if error.code == 404 else "DOC2MD_CONVERSION_FAILED"
            raise Doc2MdError(code, f"doc2md가 HTTP {error.code}를 반환했습니다.") from error
        except (OSError, TimeoutError, URLError) as error:
            raise Doc2MdError(
                "DOC2MD_UNAVAILABLE", "doc2md 서비스에 연결할 수 없습니다."
            ) from error
        try:
            converted = Doc2MdResponse.model_validate_json(body)
        except ValidationError as error:
            raise Doc2MdError(
                "DOC2MD_RESPONSE_INVALID", "doc2md 응답 schema가 유효하지 않습니다."
            ) from error
        self._validate_contract(
            converted,
            manifest=manifest,
            expected_source_sha256=expected_source_sha256,
        )
        return ConversionResult(
            canonical_markdown=converted.markdown,
            body=converted.body,
            format=converted.format,
            converter=f"doc2md:{converted.library_used}",
            warnings=tuple(converted.warnings),
            cached=converted.cached,
        )

    def health(self) -> bool:
        request = Request(f"{self._base_url}/health", headers={"Accept": "application/json"})
        try:
            with urlopen(request, timeout=min(self._timeout, 5.0)) as response:  # noqa: S310
                payload: Any = json.loads(response.read())
        except (HTTPError, OSError, TimeoutError, URLError, json.JSONDecodeError):
            return False
        return isinstance(payload, dict) and payload.get("status") == "ok"

    def _validate_resolved_source(self, path: Path) -> None:
        if not path.is_file() or not path.is_relative_to(self._resolver.source_root):
            raise Doc2MdError(
                "DOC2MD_SOURCE_UNSAFE", "doc2md에 전달할 원본 경로가 안전하지 않습니다."
            )

    @staticmethod
    def _validate_contract(
        converted: Doc2MdResponse,
        *,
        manifest: ManifestEntry,
        expected_source_sha256: str,
    ) -> None:
        frontmatter = converted.frontmatter
        if frontmatter.id != manifest.id:
            raise Doc2MdError(
                "DOC2MD_ID_MISMATCH", "doc2md가 stable document_id를 보존하지 않았습니다."
            )
        if frontmatter.source.uri != manifest.source.uri:
            raise Doc2MdError(
                "DOC2MD_URI_MISMATCH", "doc2md가 source URI override를 보존하지 않았습니다."
            )
        if frontmatter.source.sha256 != expected_source_sha256:
            raise Doc2MdError(
                "DOC2MD_STALE_CACHE",
                "doc2md 응답 source hash가 현재 원본과 달라 캐시 결과를 거부했습니다.",
            )
        if frontmatter.doc_type != manifest.doc_type or frontmatter.access != manifest.access.value:
            raise Doc2MdError(
                "DOC2MD_METADATA_MISMATCH",
                "doc2md가 필수 metadata override를 보존하지 않았습니다.",
            )
        if (
            frontmatter.revision != manifest.revision
            or frontmatter.status != manifest.status
            or frontmatter.authority_level != manifest.authority_level
        ):
            raise Doc2MdError(
                "DOC2MD_METADATA_MISMATCH",
                "doc2md가 revision 또는 권위 metadata override를 보존하지 않았습니다.",
            )
        if not converted.body.strip():
            raise Doc2MdError("DOC2MD_EMPTY_OUTPUT", "doc2md 변환 본문이 비어 있습니다.")
        if converted.body not in converted.markdown:
            raise Doc2MdError(
                "DOC2MD_RESPONSE_INVALID",
                "doc2md 본문과 canonical Markdown이 일치하지 않습니다.",
            )
