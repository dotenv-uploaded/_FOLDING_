"""Safe, source-preserving XLSX normalization for text extraction.

Some producers write the visible value into every cell covered by a merged
range. Excel only displays the top-left cell, but generic OOXML readers can
return every hidden child value. This module removes those child ``<c>`` nodes
from a request-local copy before MarkItDown reads it. The source workbook is
never opened for writing.

XLSX is an attacker-controlled ZIP/XML container, so the copy step also forms a
strict resource and parser boundary. Worksheet parts are discovered through
the package relationships rather than guessed from conventional filenames.
"""

from __future__ import annotations

import posixpath
import re
import tempfile
from bisect import bisect_right
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote, urlsplit
from xml.dom import Node
from xml.dom.minidom import Document, Element
from zipfile import ZIP_DEFLATED, ZIP_STORED, ZipFile, ZipInfo

from defusedxml import minidom as safe_minidom
from defusedxml.common import DefusedXmlException

_MIB = 1024 * 1024

# These limits are intentionally above ordinary business workbooks while
# bounding both metadata claims and bytes actually inflated by ``zipfile``.
MAX_ARCHIVE_BYTES = 512 * _MIB
MAX_ARCHIVE_ENTRIES = 20_000
MAX_ENTRY_BYTES = 256 * _MIB
MAX_TOTAL_UNCOMPRESSED_BYTES = 1024 * _MIB
MAX_WORKSHEET_XML_BYTES = 16 * _MIB
MAX_PACKAGE_XML_BYTES = 4 * _MIB
MAX_COMPRESSION_RATIO = 250
MAX_MERGED_RANGES = 100_000
MAX_WORKSHEET_CELLS = 500_000
MAX_RANGE_LOOKUPS = 10_000_000
_RATIO_CHECK_MIN_BYTES = 1 * _MIB
_COPY_CHUNK_BYTES = 1024 * 1024

_SUPPORTED_COMPRESSION = {ZIP_STORED, ZIP_DEFLATED}
_OFFICE_DOCUMENT_RELATIONSHIPS = {
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
    "http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument",
}
_WORKSHEET_RELATIONSHIPS = {
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet",
    "http://purl.oclc.org/ooxml/officeDocument/relationships/worksheet",
}
_WORKSHEET_CONTENT_TYPES = {
    "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml",
    "application/vnd.ms-excel.worksheet",
}

_CELL_REFERENCE = re.compile(r"^\$?([A-Za-z]{1,3})\$?([1-9][0-9]*)$")
_MERGED_REFERENCE = re.compile(
    r"^\$?([A-Za-z]{1,3})\$?([1-9][0-9]*):"
    r"\$?([A-Za-z]{1,3})\$?([1-9][0-9]*)$"
)


class XlsxNormalizationError(Exception):
    """The workbook could not be copied within the safe OOXML boundary."""


@dataclass(frozen=True)
class _MergedRange:
    first_column: int
    first_row: int
    last_column: int
    last_row: int

    @property
    def anchor(self) -> tuple[int, int]:
        return self.first_column, self.first_row

    def contains(self, column: int, row: int) -> bool:
        return (
            self.first_column <= column <= self.last_column
            and self.first_row <= row <= self.last_row
        )


@dataclass
class _CopyBudget:
    total: int = 0

    def add(self, amount: int, *, entry_total: int, entry_limit: int) -> int:
        entry_total += amount
        self.total += amount
        if entry_total > entry_limit:
            raise XlsxNormalizationError("workbook entry exceeds the extraction limit")
        if self.total > MAX_TOTAL_UNCOMPRESSED_BYTES:
            raise XlsxNormalizationError("workbook exceeds the total extraction limit")
        return entry_total


@dataclass
class _MergedRangeIndex:
    ranges: list[_MergedRange]
    starts: list[int]
    prefix_last_rows: list[int]
    lookups: int = 0

    @classmethod
    def build(cls, ranges: list[_MergedRange]) -> _MergedRangeIndex:
        ordered = sorted(ranges, key=lambda item: item.first_row)
        prefix_last_rows: list[int] = []
        furthest_row = 0
        for merged_range in ordered:
            furthest_row = max(furthest_row, merged_range.last_row)
            prefix_last_rows.append(furthest_row)
        return cls(
            ranges=ordered,
            starts=[item.first_row for item in ordered],
            prefix_last_rows=prefix_last_rows,
        )

    def containing(self, column: int, row: int) -> _MergedRange | None:
        index = bisect_right(self.starts, row) - 1
        while index >= 0 and self.prefix_last_rows[index] >= row:
            self.lookups += 1
            if self.lookups > MAX_RANGE_LOOKUPS:
                raise XlsxNormalizationError(
                    "worksheet merged ranges exceed the processing limit"
                )
            candidate = self.ranges[index]
            if candidate.contains(column, row):
                return candidate
            index -= 1
        return None


@contextmanager
def extraction_copy(path: Path) -> Iterator[Path]:
    """Yield a normalized temporary workbook with the source basename.

    Preprocessing exceptions are translated here. Exceptions raised by the
    consumer after ``yield`` remain the consumer's responsibility, while the
    temporary directory is still removed deterministically.
    """

    with tempfile.TemporaryDirectory(prefix="doc2md-xlsx-") as temporary:
        target = Path(temporary) / path.name
        try:
            _copy_normalized(path, target)
        except XlsxNormalizationError:
            raise
        except Exception as error:
            raise XlsxNormalizationError(
                "invalid or unsupported workbook package"
            ) from error
        yield target


def _copy_normalized(source_path: Path, target_path: Path) -> None:
    if source_path.stat().st_size > MAX_ARCHIVE_BYTES:
        raise XlsxNormalizationError("workbook archive exceeds the upload limit")

    with ZipFile(source_path, "r") as source:
        entries, entry_parts = _validate_archive(source)
        worksheet_parts = _discover_worksheet_parts(source, entry_parts)
        budget = _CopyBudget()

        with ZipFile(target_path, "w", allowZip64=True) as target:
            target.comment = source.comment
            for entry in entries:
                part_name = _canonical_archive_name(entry.filename)
                if entry.is_dir():
                    target.writestr(entry, b"")
                elif part_name in worksheet_parts:
                    raw = _read_entry(
                        source,
                        entry,
                        budget,
                        limit=MAX_WORKSHEET_XML_BYTES,
                    )
                    normalized = _normalize_worksheet(raw)
                    if len(normalized) > MAX_WORKSHEET_XML_BYTES:
                        raise XlsxNormalizationError(
                            "normalized worksheet exceeds the extraction limit"
                        )
                    target.writestr(entry, normalized)
                else:
                    _copy_entry(source, target, entry, budget)


def _validate_archive(
    archive: ZipFile,
) -> tuple[list[ZipInfo], dict[str, ZipInfo]]:
    entries = archive.infolist()
    if len(entries) > MAX_ARCHIVE_ENTRIES:
        raise XlsxNormalizationError("workbook contains too many package entries")

    total = 0
    total_compressed = 0
    entry_parts: dict[str, ZipInfo] = {}
    casefolded_parts: set[str] = set()
    for entry in entries:
        part_name = _canonical_archive_name(entry.filename)
        folded = part_name.casefold()
        if folded in casefolded_parts:
            raise XlsxNormalizationError("workbook contains duplicate package entries")
        casefolded_parts.add(folded)
        entry_parts[part_name] = entry

        if entry.flag_bits & 0x1:
            raise XlsxNormalizationError("encrypted workbook entries are unsupported")
        if entry.compress_type not in _SUPPORTED_COMPRESSION:
            raise XlsxNormalizationError(
                "workbook uses an unsupported compression method"
            )
        if entry.file_size < 0 or entry.compress_size < 0:
            raise XlsxNormalizationError("workbook contains invalid entry sizes")
        if entry.file_size > MAX_ENTRY_BYTES:
            raise XlsxNormalizationError("workbook entry exceeds the extraction limit")

        total += entry.file_size
        total_compressed += entry.compress_size
        if total > MAX_TOTAL_UNCOMPRESSED_BYTES:
            raise XlsxNormalizationError("workbook exceeds the total extraction limit")
        if entry.file_size >= _RATIO_CHECK_MIN_BYTES:
            if entry.compress_size == 0:
                raise XlsxNormalizationError(
                    "workbook entry exceeds the compression ratio limit"
                )
            if entry.file_size / entry.compress_size > MAX_COMPRESSION_RATIO:
                raise XlsxNormalizationError(
                    "workbook entry exceeds the compression ratio limit"
                )

    if total >= _RATIO_CHECK_MIN_BYTES:
        if total_compressed == 0 or total / total_compressed > MAX_COMPRESSION_RATIO:
            raise XlsxNormalizationError(
                "workbook exceeds the aggregate compression ratio limit"
            )

    return entries, entry_parts


def _canonical_archive_name(name: str) -> str:
    if not name or name.startswith("/") or "\\" in name:
        raise XlsxNormalizationError("workbook contains an unsafe package path")
    decoded = unquote(name)
    if (
        "\\" in decoded
        or "?" in decoded
        or "#" in decoded
        or any(ord(character) < 32 for character in decoded)
    ):
        raise XlsxNormalizationError("workbook contains an unsafe package path")

    is_directory = decoded.endswith("/")
    body = decoded[:-1] if is_directory else decoded
    segments = body.split("/")
    if not body or any(segment in {"", ".", ".."} for segment in segments):
        raise XlsxNormalizationError("workbook contains an unsafe package path")
    canonical = "/".join(segments)
    return f"{canonical}/" if is_directory else canonical


def _discover_worksheet_parts(
    archive: ZipFile, entries: dict[str, ZipInfo]
) -> set[str]:
    content_types = _content_types(
        _read_required_xml_part(
            archive, entries, "[Content_Types].xml", MAX_PACKAGE_XML_BYTES
        )
    )
    root_relationships = _relationships(
        _read_required_xml_part(archive, entries, "_rels/.rels", MAX_PACKAGE_XML_BYTES)
    )
    office_documents = [
        relationship
        for relationship in root_relationships
        if relationship[0] in _OFFICE_DOCUMENT_RELATIONSHIPS
    ]
    if len(office_documents) != 1:
        raise XlsxNormalizationError(
            "workbook must contain one internal office document relationship"
        )

    _, target, target_mode = office_documents[0]
    if target_mode == "external":
        raise XlsxNormalizationError("external workbook relationships are unsupported")
    workbook_part = _resolve_relationship_target("", target)
    if workbook_part not in entries:
        raise XlsxNormalizationError("workbook relationship target is missing")

    workbook_relationship_part = _relationship_part(workbook_part)
    workbook_relationships = _relationships(
        _read_required_xml_part(
            archive,
            entries,
            workbook_relationship_part,
            MAX_PACKAGE_XML_BYTES,
        )
    )

    worksheets: set[str] = set()
    for relationship_type, relationship_target, target_mode in workbook_relationships:
        if relationship_type not in _WORKSHEET_RELATIONSHIPS:
            continue
        if target_mode == "external":
            raise XlsxNormalizationError(
                "external worksheet relationships are unsupported"
            )
        worksheet_part = _resolve_relationship_target(
            workbook_part, relationship_target
        )
        if worksheet_part not in entries:
            raise XlsxNormalizationError("worksheet relationship target is missing")
        content_type = _content_type_for_part(content_types, worksheet_part)
        if not _is_worksheet_content_type(content_type):
            raise XlsxNormalizationError(
                "worksheet relationship has an invalid content type"
            )
        worksheets.add(worksheet_part)
    return worksheets


def _content_types(document: Document) -> dict[str, str]:
    defaults: dict[str, str] = {}
    overrides: dict[str, str] = {}
    for element in _elements(document):
        if _local_name(element) == "Default":
            extension = element.getAttribute("Extension").lower()
            content_type = element.getAttribute("ContentType").lower()
            if extension and content_type:
                defaults[extension] = content_type
        elif _local_name(element) == "Override":
            part = element.getAttribute("PartName")
            content_type = element.getAttribute("ContentType").lower()
            if not part or not content_type:
                continue
            overrides[_canonical_content_type_part(part)] = content_type

    result = dict(overrides)
    # Defaults are applied lazily by callers through the marker keys. This
    # keeps explicit overrides authoritative without needing every ZIP entry.
    result.update({f"*.{extension}": value for extension, value in defaults.items()})
    return result


def _canonical_content_type_part(part: str) -> str:
    if not part.startswith("/") or part.startswith("//"):
        raise XlsxNormalizationError("content type contains an unsafe part path")
    return _canonical_archive_name(part[1:])


def _is_worksheet_content_type(content_type: str | None) -> bool:
    if content_type is None:
        return False
    return content_type in _WORKSHEET_CONTENT_TYPES or content_type.endswith(
        ".worksheet+xml"
    )


def _content_type_for_part(content_types: dict[str, str], part_name: str) -> str | None:
    override = content_types.get(part_name)
    if override is not None:
        return override
    basename = posixpath.basename(part_name)
    if "." not in basename:
        return None
    return content_types.get(f"*.{basename.rsplit('.', 1)[-1].lower()}")


def _relationships(document: Document) -> list[tuple[str, str, str]]:
    relationships: list[tuple[str, str, str]] = []
    for element in _elements(document):
        if _local_name(element) != "Relationship":
            continue
        relationship_type = element.getAttribute("Type")
        target = element.getAttribute("Target")
        target_mode = element.getAttribute("TargetMode").strip().lower()
        if not relationship_type or not target:
            raise XlsxNormalizationError("workbook contains an invalid relationship")
        if target_mode not in {"", "internal", "external"}:
            raise XlsxNormalizationError("workbook contains an invalid relationship")
        relationships.append((relationship_type, target, target_mode))
    return relationships


def _resolve_relationship_target(source_part: str, target: str) -> str:
    parsed = urlsplit(target)
    if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment:
        raise XlsxNormalizationError("relationship contains an unsafe target")

    decoded = unquote(parsed.path)
    decoded_uri = urlsplit(decoded)
    if (
        decoded_uri.scheme
        or decoded_uri.netloc
        or decoded_uri.query
        or decoded_uri.fragment
    ):
        raise XlsxNormalizationError("relationship contains an unsafe target")
    if "\\" in decoded or any(ord(character) < 32 for character in decoded):
        raise XlsxNormalizationError("relationship contains an unsafe target")
    if decoded.startswith("//"):
        raise XlsxNormalizationError("relationship contains an unsafe target")

    if decoded.startswith("/"):
        combined = decoded[1:]
    else:
        combined = posixpath.join(posixpath.dirname(source_part), decoded)
    normalized = posixpath.normpath(combined)
    if normalized in {"", ".", ".."} or normalized.startswith("../"):
        raise XlsxNormalizationError("relationship escapes the workbook package")
    return _canonical_archive_name(normalized)


def _relationship_part(source_part: str) -> str:
    directory = posixpath.dirname(source_part)
    basename = posixpath.basename(source_part)
    relationship = f"_rels/{basename}.rels"
    return f"{directory}/{relationship}" if directory else relationship


def _read_required_xml_part(
    archive: ZipFile,
    entries: dict[str, ZipInfo],
    part_name: str,
    limit: int,
) -> Document:
    entry = entries.get(part_name)
    if entry is None or entry.is_dir():
        raise XlsxNormalizationError(f"required package part is missing: {part_name}")
    raw = _read_entry_without_budget(archive, entry, limit=limit)
    return _parse_xml(raw)


def _read_entry_without_budget(
    archive: ZipFile, entry: ZipInfo, *, limit: int
) -> bytes:
    chunks: list[bytes] = []
    size = 0
    with archive.open(entry, "r") as stream:
        while chunk := stream.read(min(_COPY_CHUNK_BYTES, limit + 1 - size)):
            size += len(chunk)
            if size > limit:
                raise XlsxNormalizationError("package XML exceeds the parsing limit")
            chunks.append(chunk)
    return b"".join(chunks)


def _read_entry(
    archive: ZipFile,
    entry: ZipInfo,
    budget: _CopyBudget,
    *,
    limit: int,
) -> bytes:
    chunks: list[bytes] = []
    entry_total = 0
    with archive.open(entry, "r") as stream:
        while chunk := stream.read(_COPY_CHUNK_BYTES):
            entry_total = budget.add(
                len(chunk), entry_total=entry_total, entry_limit=limit
            )
            chunks.append(chunk)
    return b"".join(chunks)


def _copy_entry(
    source: ZipFile,
    target: ZipFile,
    entry: ZipInfo,
    budget: _CopyBudget,
) -> None:
    entry_total = 0
    with (
        source.open(entry, "r") as reader,
        target.open(entry, "w", force_zip64=True) as writer,
    ):
        while chunk := reader.read(_COPY_CHUNK_BYTES):
            entry_total = budget.add(
                len(chunk), entry_total=entry_total, entry_limit=MAX_ENTRY_BYTES
            )
            writer.write(chunk)


def _parse_xml(raw: bytes) -> Document:
    try:
        return safe_minidom.parseString(
            raw,
            forbid_dtd=True,
            forbid_entities=True,
            forbid_external=True,
        )
    except (DefusedXmlException, ValueError) as error:
        raise XlsxNormalizationError(
            "workbook contains unsafe or invalid XML"
        ) from error
    except Exception as error:
        # ExpatError is implementation-specific and not part of defusedxml's
        # public exception hierarchy. Keep all XML parser failures in the same
        # stable conversion boundary.
        raise XlsxNormalizationError(
            "workbook contains unsafe or invalid XML"
        ) from error


def _normalize_worksheet(raw: bytes) -> bytes:
    document = _parse_xml(raw)
    merged_ranges: list[_MergedRange] = []
    for element in _elements(document):
        if _local_name(element) != "mergeCell":
            continue
        reference = element.getAttribute("ref")
        merged_ranges.append(_parse_merged_range(reference))
        if len(merged_ranges) > MAX_MERGED_RANGES:
            raise XlsxNormalizationError("worksheet contains too many merged ranges")

    if not merged_ranges:
        document.unlink()
        return raw

    range_index = _MergedRangeIndex.build(merged_ranges)
    cell_count = 0
    for cell in list(_elements(document)):
        if _local_name(cell) != "c":
            continue
        cell_count += 1
        if cell_count > MAX_WORKSHEET_CELLS:
            raise XlsxNormalizationError("worksheet contains too many cells")
        coordinate = _parse_cell_reference(cell.getAttribute("r"))
        if coordinate is None:
            continue
        merged_range = range_index.containing(*coordinate)
        if merged_range is None or coordinate == merged_range.anchor:
            continue
        parent = cell.parentNode
        if parent is not None:
            parent.removeChild(cell)
            cell.unlink()

    serialized = document.toxml(encoding="UTF-8")
    document.unlink()
    return serialized


def _parse_merged_range(reference: str) -> _MergedRange:
    match = _MERGED_REFERENCE.fullmatch(reference)
    if match is None:
        raise XlsxNormalizationError("worksheet contains an invalid merged range")
    first_column = _column_number(match.group(1))
    first_row = int(match.group(2))
    last_column = _column_number(match.group(3))
    last_row = int(match.group(4))
    if (
        first_column > last_column
        or first_row > last_row
        or last_column > 16_384
        or last_row > 1_048_576
    ):
        raise XlsxNormalizationError("worksheet contains an invalid merged range")
    return _MergedRange(first_column, first_row, last_column, last_row)


def _parse_cell_reference(reference: str) -> tuple[int, int] | None:
    match = _CELL_REFERENCE.fullmatch(reference)
    if match is None:
        return None
    column = _column_number(match.group(1))
    row = int(match.group(2))
    if column > 16_384 or row > 1_048_576:
        return None
    return column, row


def _column_number(label: str) -> int:
    result = 0
    for character in label.upper():
        result = result * 26 + ord(character) - ord("A") + 1
    return result


def _elements(document: Document) -> Iterator[Element]:
    for node in document.getElementsByTagName("*"):
        if node.nodeType == Node.ELEMENT_NODE:
            yield node


def _local_name(element: Element) -> str:
    return element.localName or element.tagName.rsplit(":", 1)[-1]
