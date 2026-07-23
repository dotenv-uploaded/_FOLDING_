from __future__ import annotations

import hashlib
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from xml.dom import minidom
from zipfile import ZIP_DEFLATED, ZipFile

import pytest

from app import converters, xlsx
from app.converters import ConversionFailedError

_CONTENT_TYPES_XML = """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/custom/actual-sheet.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>
"""

_ROOT_RELS_XML = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>
"""

_WORKBOOK_XML = """<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Risk" sheetId="1" r:id="rId1"/></sheets>
</workbook>
"""

_WORKBOOK_RELS_XML = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="custom/actual-sheet.xml"/>
</Relationships>
"""

_SHEET_XML = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="2">
      {merged_cells}
    </row>
    <row r="4">
      {ordinary_cells}
    </row>
  </sheetData>
  <mergeCells count="1"><mergeCell ref="A2:H2"/></mergeCells>
</worksheet>
"""


def test_xlsx_conversion_follows_relationship_and_preserves_source(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workbook = tmp_path / "risk.xlsx"
    _write_workbook(workbook)
    before = _sha256(workbook)
    converted_paths: list[Path] = []

    def fake_convert(filename: str) -> SimpleNamespace:
        converted_path = Path(filename)
        converted_paths.append(converted_path)
        with ZipFile(converted_path) as archive:
            document = minidom.parseString(archive.read("xl/custom/actual-sheet.xml"))
        values = [
            text.firstChild.nodeValue
            for text in document.getElementsByTagName("t")
            if text.firstChild is not None
        ]
        return SimpleNamespace(markdown="\n".join(values))

    monkeypatch.setattr(converters._markitdown, "convert", fake_convert)

    result = converters.convert(workbook)

    assert result.body.count("병합된 위험 설명") == 1
    assert result.body.count("정상 반복 값") == 8
    assert result.format == "xlsx"
    assert result.library_used == "markitdown"
    assert len(converted_paths) == 1
    assert converted_paths[0] != workbook
    assert converted_paths[0].name == workbook.name
    assert not converted_paths[0].exists()
    assert _sha256(workbook) == before


def test_xlsx_conversion_with_real_markitdown_reads_custom_worksheet_part(
    tmp_path: Path,
) -> None:
    workbook = tmp_path / "risk.xlsx"
    _write_workbook(workbook)
    before = _sha256(workbook)

    result = converters.convert(workbook)

    assert result.body.count("병합된 위험 설명") == 1
    assert result.body.count("정상 반복 값") == 8
    assert _sha256(workbook) == before


def test_xlsx_rejects_high_compression_ratio_before_conversion(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workbook = tmp_path / "bomb.xlsx"
    _write_workbook(workbook)
    with ZipFile(workbook, "a", compression=ZIP_DEFLATED) as archive:
        archive.writestr("xl/media/repeated.bin", b"0" * (2 * 1024 * 1024))
    before = _sha256(workbook)
    called = False

    def fake_convert(_filename: str) -> SimpleNamespace:
        nonlocal called
        called = True
        return SimpleNamespace(markdown="unexpected")

    monkeypatch.setattr(converters._markitdown, "convert", fake_convert)

    with pytest.raises(ConversionFailedError, match="compression ratio limit"):
        converters.convert(workbook)

    assert not called
    assert _sha256(workbook) == before


def test_xlsx_rejects_split_zip_bomb_under_parallel_requests(tmp_path: Path) -> None:
    workbook = tmp_path / "split-bomb.xlsx"
    _write_workbook(workbook)
    with ZipFile(workbook, "a", compression=ZIP_DEFLATED) as archive:
        for index in range(4):
            archive.writestr(f"xl/media/repeated-{index}.bin", b"0" * (768 * 1024))
    before = _sha256(workbook)

    def attempt_conversion(_index: int) -> str:
        try:
            converters.convert(workbook)
        except ConversionFailedError as error:
            return str(error)
        raise AssertionError("split ZIP bomb reached the document converter")

    with ThreadPoolExecutor(max_workers=4) as executor:
        errors = list(executor.map(attempt_conversion, range(4)))

    assert all("aggregate compression ratio limit" in error for error in errors)
    assert _sha256(workbook) == before


def test_xlsx_rejects_utf16_dtd_and_entity_before_conversion(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workbook = tmp_path / "entity.xlsx"
    worksheet = """<?xml version="1.0" encoding="UTF-16"?>
<!DOCTYPE worksheet [<!ENTITY secret "EXPANDED_SECRET">]>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData><row r="2"><c r="A2" t="inlineStr"><is><t>&secret;</t></is></c></row></sheetData>
  <mergeCells count="1"><mergeCell ref="A2:B2"/></mergeCells>
</worksheet>
""".encode("utf-16")
    _write_workbook(workbook, worksheet=worksheet)
    before = _sha256(workbook)
    called = False

    def fake_convert(_filename: str) -> SimpleNamespace:
        nonlocal called
        called = True
        return SimpleNamespace(markdown="unexpected")

    monkeypatch.setattr(converters._markitdown, "convert", fake_convert)

    with pytest.raises(ConversionFailedError, match="unsafe or invalid XML"):
        converters.convert(workbook)

    assert not called
    assert _sha256(workbook) == before


def test_xlsx_normalizes_unexpected_zip_failures(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workbook = tmp_path / "unsupported.xlsx"
    _write_workbook(workbook)

    def fail_to_open(*_args, **_kwargs):
        raise NotImplementedError("unsupported compression")

    monkeypatch.setattr(xlsx, "ZipFile", fail_to_open)

    with pytest.raises(
        ConversionFailedError, match="invalid or unsupported workbook package"
    ):
        converters.convert(workbook)


def test_xlsx_removes_temp_copy_when_markitdown_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workbook = tmp_path / "failure.xlsx"
    _write_workbook(workbook)
    before = _sha256(workbook)
    converted_paths: list[Path] = []

    def fail_conversion(filename: str) -> SimpleNamespace:
        converted_paths.append(Path(filename))
        raise RuntimeError("reader failed")

    monkeypatch.setattr(converters._markitdown, "convert", fail_conversion)

    with pytest.raises(ConversionFailedError, match="markitdown conversion failed"):
        converters.convert(workbook)

    assert len(converted_paths) == 1
    assert not converted_paths[0].exists()
    assert _sha256(workbook) == before


def test_xlsx_parallel_extractions_use_isolated_temp_copies(tmp_path: Path) -> None:
    workbook = tmp_path / "parallel.xlsx"
    _write_workbook(workbook)
    barrier = threading.Barrier(4)

    def inspect_copy() -> Path:
        with xlsx.extraction_copy(workbook) as copy_path:
            assert copy_path.exists()
            barrier.wait(timeout=10)
            with ZipFile(copy_path) as archive:
                assert "병합된 위험 설명" in archive.read(
                    "xl/custom/actual-sheet.xml"
                ).decode("utf-8")
            return copy_path

    with ThreadPoolExecutor(max_workers=4) as executor:
        copies = list(executor.map(lambda _index: inspect_copy(), range(4)))

    assert len(set(copies)) == 4
    assert all(not copy_path.exists() for copy_path in copies)


def _write_workbook(path: Path, *, worksheet: str | bytes | None = None) -> None:
    if worksheet is None:
        merged_cells = "\n".join(
            _inline_cell(f"{column}2", "병합된 위험 설명") for column in "ABCDEFGH"
        )
        ordinary_cells = "\n".join(
            _inline_cell(f"{column}4", "정상 반복 값") for column in "ABCDEFGH"
        )
        worksheet = _SHEET_XML.format(
            merged_cells=merged_cells,
            ordinary_cells=ordinary_cells,
        )

    with ZipFile(path, "w", compression=ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", _CONTENT_TYPES_XML)
        archive.writestr("_rels/.rels", _ROOT_RELS_XML)
        archive.writestr("xl/workbook.xml", _WORKBOOK_XML)
        archive.writestr("xl/_rels/workbook.xml.rels", _WORKBOOK_RELS_XML)
        archive.writestr("xl/custom/actual-sheet.xml", worksheet)


def _inline_cell(reference: str, value: str) -> str:
    return f'<c r="{reference}" t="inlineStr"><is><t>{value}</t></is></c>'


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()
