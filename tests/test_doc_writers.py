"""형식별 문서 편집 — 고치고 다시 열어 확인하는 계약.

이 계약이 헐거우면 "고친 줄 알았는데 그대로인 문서"가 나간다. 그래서 세 가지를 못 박는다:
바뀐 내용이 실제로 저장될 것, 못 바꿨으면 **결과 파일을 남기지 말 것**, 원본은 그대로일 것.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from codegate_api.agent.doc_writers import (
    DocWriterError,
    annotate_pdf,
    edit_docx_text,
    edit_pptx_text,
    edit_xlsx_text,
)


def _docx(path: Path) -> None:
    from docx import Document

    document = Document()
    document.add_paragraph("예산은 12억 원입니다.")
    table = document.add_table(rows=1, cols=2)
    table.rows[0].cells[0].text = "합계"
    table.rows[0].cells[1].text = "12억 원"
    document.save(str(path))


def _xlsx(path: Path) -> None:
    from openpyxl import Workbook

    workbook = Workbook()
    workbook.active["A1"] = "예산 12억 원"
    workbook.save(str(path))


def _pptx(path: Path) -> None:
    from pptx import Presentation
    from pptx.util import Inches

    presentation = Presentation()
    slide = presentation.slides.add_slide(presentation.slide_layouts[5])
    box = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(4), Inches(1))
    box.text_frame.text = "목표 12억 원"
    presentation.save(str(path))


def _pdf(path: Path) -> None:
    import pymupdf

    document = pymupdf.open()
    document.new_page().insert_text((72, 72), "Budget 12 billion")
    document.save(str(path))
    document.close()


def test_docx_는_문단과_표셀을_모두_바꾸고_검증한다(tmp_path: Path) -> None:
    from docx import Document

    source, target = tmp_path / "a.docx", tmp_path / "a2.docx"
    _docx(source)
    result = edit_docx_text(source, target, "12억 원", "15억 원")
    assert result.verified and result.replaced == 2  # 문단 1 + 표 셀 1

    texts = [p.text for p in Document(str(target)).paragraphs]
    texts += [c.text for t in Document(str(target)).tables for r in t.rows for c in r.cells]
    assert any("15억 원" in t for t in texts)
    assert not any("12억 원" in t for t in texts)


def test_xlsx_와_pptx_도_같은_계약을_지킨다(tmp_path: Path) -> None:
    xlsx_source, xlsx_target = tmp_path / "b.xlsx", tmp_path / "b2.xlsx"
    _xlsx(xlsx_source)
    assert edit_xlsx_text(xlsx_source, xlsx_target, "12억 원", "15억 원").verified

    pptx_source, pptx_target = tmp_path / "c.pptx", tmp_path / "c2.pptx"
    _pptx(pptx_source)
    assert edit_pptx_text(pptx_source, pptx_target, "12억 원", "15억 원").verified


def test_pdf_는_본문을_고치지_않고_주석만_단다(tmp_path: Path) -> None:
    source, target = tmp_path / "e.pdf", tmp_path / "e2.pdf"
    _pdf(source)
    result = annotate_pdf(source, target, "12 billion", "확인 필요")
    assert result.verified and result.replaced >= 1
    assert source.exists()  # 원본 보존


def test_못_바꾸면_결과_파일을_남기지_않는다(tmp_path: Path) -> None:
    # 반쪽짜리 사본을 완성본인 척 남기는 것이 가장 나쁘다.
    source, target = tmp_path / "a.docx", tmp_path / "none.docx"
    _docx(source)
    with pytest.raises(DocWriterError) as error:
        edit_docx_text(source, target, "없는문구", "x")
    assert error.value.code == "not_found"
    assert not target.exists()


def test_원본을_덮어쓰거나_기존_파일을_지우지_않는다(tmp_path: Path) -> None:
    source = tmp_path / "a.docx"
    _docx(source)
    with pytest.raises(DocWriterError) as same:
        edit_docx_text(source, source, "12억 원", "15억 원")
    assert same.value.code == "same_path"

    existing = tmp_path / "already.docx"
    _docx(existing)
    with pytest.raises(DocWriterError) as exists:
        edit_docx_text(source, existing, "12억 원", "15억 원")
    assert exists.value.code == "target_exists"


def test_지원하지_않는_형식은_분명히_거부한다(tmp_path: Path) -> None:
    missing = tmp_path / "없는파일.docx"
    with pytest.raises(DocWriterError) as error:
        edit_docx_text(missing, tmp_path / "out.docx", "a", "b")
    assert error.value.code == "source_missing"
