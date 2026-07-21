from __future__ import annotations

import hashlib
import re
import unicodedata
from collections.abc import Iterable
from copy import deepcopy
from pathlib import Path
from typing import Any

import yaml

from wiki_builder.config import WikiConfig
from wiki_builder.errors import ValidationError
from wiki_builder.models import Document, Section
from wiki_builder.schemas import validate_record

FRONT_MATTER_ORDER = (
    "schema_version",
    "id",
    "title",
    "doc_type",
    "language",
    "revision",
    "status",
    "official_number",
    "authority_level",
    "issuing_org",
    "issued_on",
    "effective_from",
    "effective_to",
    "source",
    "access",
    "tags",
    "aliases",
)
DOC_TYPE_DIRECTORY = {
    "regulation": "regulations",
    "policy": "policies",
    "procedure": "procedures",
    "manual": "manuals",
    "guide": "guides",
    "specification": "specifications",
    "contract": "contracts",
    "report": "reports",
    "meeting_note": "meeting-notes",
    "general": "general",
}
DATE_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
DOC_ID_RE = re.compile(r"^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$")
HEADING_RE = re.compile(r"^(#{1,6})[ \t]+(.+?)[ \t]*$")
FENCE_RE = re.compile(r"^[ \t]{0,3}(`{3,}|~{3,})")
GENERATED_ANCHOR_RE = re.compile(r'^<a id="(sec-[0-9a-f]{10})"></a>[ \t]*$')
ANY_ANCHOR_RE = re.compile(r'^<a id="[^"<>]+"></a>[ \t]*$')


class StringSafeLoader(yaml.SafeLoader):
    """Safe YAML loader that leaves ISO dates as strings."""


for first_char, resolvers in list(StringSafeLoader.yaml_implicit_resolvers.items()):
    StringSafeLoader.yaml_implicit_resolvers[first_char] = [
        item for item in resolvers if item[0] != "tag:yaml.org,2002:timestamp"
    ]


def normalize_text(text: str) -> str:
    text = unicodedata.normalize("NFC", text.replace("\r\n", "\n").replace("\r", "\n"))
    lines = [line.rstrip(" \t") for line in text.split("\n")]
    return "\n".join(lines).rstrip("\n") + "\n"


def split_front_matter(text: str, path: Path) -> tuple[dict[str, Any], str]:
    lines = text.splitlines(keepends=True)
    if not lines or lines[0].strip() != "---":
        raise ValidationError(f"YAML front matter 시작 구분자가 없습니다: {path}")
    end = next(
        (index for index, line in enumerate(lines[1:], start=1) if line.strip() == "---"),
        None,
    )
    if end is None:
        raise ValidationError(f"YAML front matter 종료 구분자가 없습니다: {path}")
    front = yaml.load("".join(lines[1:end]), Loader=StringSafeLoader)
    if not isinstance(front, dict):
        raise ValidationError(f"front matter가 객체가 아닙니다: {path}")
    return front, "".join(lines[end + 1 :])


def validate_front_matter(metadata: dict[str, Any], path: Path, config: WikiConfig) -> None:
    missing = [key for key in FRONT_MATTER_ORDER if key not in metadata]
    unknown = sorted(set(metadata) - set(FRONT_MATTER_ORDER))
    if missing:
        raise ValidationError(f"{path.name}: front matter 필수 필드 누락: {', '.join(missing)}")
    if unknown:
        raise ValidationError(f"{path.name}: 알 수 없는 front matter 필드: {', '.join(unknown)}")
    validate_record(config, "source-document", metadata, path.name)
    doc_type = str(metadata["doc_type"])
    if doc_type not in DOC_TYPE_DIRECTORY:
        raise ValidationError(f"{path.name}: 지원하지 않는 doc_type: {doc_type}")
    doc_id = str(metadata["id"])
    if not DOC_ID_RE.fullmatch(doc_id) or path.stem != doc_id:
        raise ValidationError(f"{path.name}: id와 파일명이 일치하지 않습니다")
    if metadata["status"] not in {"active", "draft", "archived", "superseded"}:
        raise ValidationError(f"{path.name}: 잘못된 status")
    if metadata["access"] not in {"public", "internal", "restricted"}:
        raise ValidationError(f"{path.name}: 잘못된 access")
    for field in ("issued_on", "effective_from", "effective_to"):
        value = metadata[field]
        if value is not None and not DATE_RE.fullmatch(str(value)):
            raise ValidationError(f"{path.name}: {field}는 YYYY-MM-DD 또는 null이어야 합니다")
    source = metadata["source"]
    if not isinstance(source, dict) or not {"filename", "uri", "sha256"}.issubset(source):
        raise ValidationError(f"{path.name}: source 필드 구성이 잘못되었습니다")
    if not re.fullmatch(r"[0-9a-fA-F]{64}", str(source["sha256"])):
        raise ValidationError(f"{path.name}: source.sha256 형식이 잘못되었습니다")
    for field in ("tags", "aliases"):
        values = metadata[field]
        if not isinstance(values, list) or not all(
            isinstance(item, str) and item for item in values
        ):
            raise ValidationError(f"{path.name}: {field}는 비어 있지 않은 문자열 배열이어야 합니다")
        if len(values) != len(set(values)):
            raise ValidationError(f"{path.name}: {field}에 중복 값이 있습니다")


def canonical_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    ordered: dict[str, Any] = {}
    for key in FRONT_MATTER_ORDER:
        value = deepcopy(metadata[key])
        if key == "source":
            value = {
                "filename": str(value["filename"]),
                "uri": str(value["uri"]),
                "sha256": str(value["sha256"]).lower(),
                "verification": str(value.get("verification", "unavailable")),
            }
        ordered[key] = value
    return ordered


def dump_front_matter(metadata: dict[str, Any]) -> str:
    return yaml.safe_dump(
        metadata,
        allow_unicode=True,
        sort_keys=False,
        default_flow_style=False,
        width=1000,
    )


def _scan_headings(lines: list[str]) -> list[tuple[int, int, str]]:
    headings: list[tuple[int, int, str]] = []
    fence_char: str | None = None
    fence_length = 0
    for index, line in enumerate(lines):
        fence = FENCE_RE.match(line)
        if fence:
            marker = fence.group(1)
            if fence_char is None:
                fence_char, fence_length = marker[0], len(marker)
            elif marker[0] == fence_char and len(marker) >= fence_length:
                fence_char, fence_length = None, 0
            continue
        if fence_char is not None:
            continue
        match = HEADING_RE.match(line)
        if match:
            headings.append((index, len(match.group(1)), match.group(2).strip()))
    return headings


def make_section_id(doc_id: str, heading_path: Iterable[str], prefix: str = "sec-") -> str:
    material = doc_id + " / ".join(heading_path)
    return prefix + hashlib.sha256(material.encode("utf-8")).hexdigest()[:10]


def add_section_anchors(body: str, doc_id: str, prefix: str = "sec-") -> tuple[str, str]:
    lines = body.splitlines()
    headings = _scan_headings(lines)
    h1 = [heading for _, level, heading in headings if level == 1]
    if len(h1) != 1:
        raise ValidationError(f"{doc_id}: H1은 정확히 하나여야 합니다 (현재 {len(h1)}개)")
    h2_indexes = {index: heading for index, level, heading in headings if level == 2}
    if not h2_indexes:
        raise ValidationError(f"{doc_id}: H2 섹션이 없습니다")
    result: list[str] = []
    for index, line in enumerate(lines):
        heading = h2_indexes.get(index)
        if heading is not None:
            section_id = make_section_id(doc_id, (h1[0], heading), prefix)
            expected = f'<a id="{section_id}"></a>'
            if not result or result[-1] != expected:
                result.append(expected)
        result.append(line)
    return "\n".join(result).rstrip("\n") + "\n", h1[0]


def strip_generated_anchors(body: str) -> str:
    lines = [line for line in body.splitlines() if not GENERATED_ANCHOR_RE.fullmatch(line)]
    return normalize_text("\n".join(lines))


def extract_sections(body: str, doc_id: str, h1_title: str) -> tuple[Section, ...]:
    lines = body.splitlines()
    headings = _scan_headings(lines)
    h1_indexes = [index for index, level, _ in headings if level == 1]
    h2 = [(index, heading) for index, level, heading in headings if level == 2]
    preamble: list[str] = []
    if h1_indexes and h2:
        preamble = [
            line
            for line in lines[h1_indexes[0] + 1 : h2[0][0]]
            if not ANY_ANCHOR_RE.fullmatch(line)
        ]
    sections: list[Section] = []
    for ordinal, (heading_index, heading) in enumerate(h2, start=1):
        end = h2[ordinal][0] if ordinal < len(h2) else len(lines)
        content_lines = lines[heading_index + 1 : end]
        cleaned = [line for line in content_lines if not ANY_ANCHOR_RE.fullmatch(line)]
        if ordinal == 1 and any(line.strip() for line in preamble):
            cleaned = [*preamble, "", *cleaned]
        text = "\n".join(cleaned).strip()
        if not text:
            raise ValidationError(f"{doc_id}: 빈 H2 섹션: {heading}")
        heading_path = (h1_title, heading)
        sections.append(
            Section(
                section_id=make_section_id(doc_id, heading_path),
                heading=heading,
                heading_path=heading_path,
                ordinal=ordinal,
                text=text,
            )
        )
    return tuple(sections)


def output_relative_path(metadata: dict[str, Any]) -> str:
    directory = DOC_TYPE_DIRECTORY[str(metadata["doc_type"])]
    return f"docs/{directory}/{metadata['id']}.md"


def parse_document(path: Path, input_dir: Path, config: WikiConfig) -> Document:
    raw_bytes = path.read_bytes()
    try:
        raw = raw_bytes.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValidationError(f"UTF-8 문서가 아닙니다: {path}") from exc
    normalized = normalize_text(raw)
    metadata, body = split_front_matter(normalized, path)
    validate_front_matter(metadata, path, config)
    body = normalize_text(body)
    anchored_body, h1_title = add_section_anchors(
        body, str(metadata["id"]), str(config.raw["normalization"]["section_anchor_prefix"])
    )
    if strip_generated_anchors(anchored_body) != body:
        raise ValidationError(f"{path.name}: 앵커 처리 중 원문 본문이 변경되었습니다")
    sections = extract_sections(anchored_body, str(metadata["id"]), h1_title)
    max_sections = int(config.input_limits["max_sections_per_document"])
    if len(sections) > max_sections:
        raise ValidationError(
            f"{path.name}: H2 섹션이 제한을 초과했습니다: {len(sections)} > {max_sections}"
        )
    if h1_title != str(metadata["title"]):
        raise ValidationError(f"{path.name}: H1 제목과 front matter title이 다릅니다")
    output_metadata = canonical_metadata(metadata)
    output_markdown = f"---\n{dump_front_matter(output_metadata)}---\n{anchored_body}"
    return Document(
        input_path=path,
        input_relative_path=path.relative_to(input_dir).as_posix(),
        output_relative_path=output_relative_path(metadata),
        metadata=output_metadata,
        original_sha256=hashlib.sha256(raw_bytes).hexdigest(),
        normalized_markdown=output_markdown,
        normalized_body=anchored_body,
        sections=sections,
        h1_title=h1_title,
    )


def load_documents(config: WikiConfig) -> list[Document]:
    input_dir = config.resolve_path("input_dir")
    if not input_dir.is_dir():
        raise ValidationError(f"입력 폴더가 없습니다: {input_dir}")
    paths = sorted(input_dir.glob("*.md"), key=lambda item: item.name)
    max_documents = int(config.input_limits["max_documents"])
    if len(paths) > max_documents:
        raise ValidationError(f"문서 수가 제한을 초과했습니다: {len(paths)} > {max_documents}")
    max_file_bytes = int(config.input_limits["max_markdown_file_bytes"])
    max_total_bytes = int(config.input_limits["max_total_markdown_bytes"])
    total_bytes = 0
    for path in paths:
        if path.is_symlink():
            raise ValidationError(f"심볼릭 링크 입력 파일은 사용할 수 없습니다: {path}")
        size = path.stat().st_size
        if size > max_file_bytes:
            raise ValidationError(
                f"Markdown 파일 크기가 제한을 초과했습니다: {path.name}: "
                f"{size} > {max_file_bytes}"
            )
        total_bytes += size
        if total_bytes > max_total_bytes:
            raise ValidationError(
                f"Markdown 전체 크기가 제한을 초과했습니다: {total_bytes} > {max_total_bytes}"
            )
    documents = [parse_document(path, input_dir, config) for path in paths]
    ids = [document.doc_id for document in documents]
    duplicates = sorted({doc_id for doc_id in ids if ids.count(doc_id) > 1})
    if duplicates:
        raise ValidationError(f"중복 문서 ID: {', '.join(duplicates)}")
    return documents
