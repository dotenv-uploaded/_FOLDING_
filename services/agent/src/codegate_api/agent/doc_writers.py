"""형식별 문서 편집 — 고치고 **다시 열어 확인한 뒤에만** 성공으로 친다.

왜 이렇게 만드나
----------------
열린 에이전트는 도구를 자유롭게 쓴다. 그래서 품질을 지키는 책임이 "에이전트를 가두는
프로토콜"이 아니라 **도구 자신**에게 있다. 각 편집 함수는 계약 하나를 지킨다:

    원본은 건드리지 않는다 → 새 파일로 낸다 → 그 파일을 다시 파싱해 편집이 실제로
    반영됐는지 확인한다 → 하나라도 어긋나면 결과를 지우고 실패한다.

"고친 줄 알았는데 그대로인 문서"가 나가는 것이 가장 나쁘다. 부분만 반영된 사본을 완성본인
척 남기지 않는다(rhwp 양식 채우기와 같은 규칙).

무엇을 지원하나
--------------
지금은 **텍스트 치환**이 공통 연산이다. 형식마다 텍스트가 사는 곳이 달라서 각각 다르게
훑는다: docx 는 문단·표 셀, xlsx 는 시트 셀, pptx 는 도형·표, pdf 는 페이지 텍스트(원본을
직접 못 고치므로 주석으로 표시한 **파생 사본**을 만든다).

PDF 만 예외인 이유
-----------------
PDF 는 본문 글자를 안전하게 바꿔 넣을 방법이 없다(글꼴·자간·레이아웃이 깨진다). 그래서
`edit_pdf_annotate` 는 본문을 고치는 척하지 않고, 찾은 자리에 주석을 다는 파생 사본을
만든다 — 할 수 있는 일과 없는 일을 분명히 한다.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


class DocWriterError(Exception):
    """문서 편집 실패. 사용자에게 그대로 보여줄 한국어 메시지를 담는다."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class EditResult:
    """편집 결과 — 몇 군데를 바꿨고, 검증을 통과했는지."""

    output: str
    replaced: int
    verified: bool


def _prepare(source: Path, target: Path) -> None:
    """원본을 덮어쓰지 않게 막고, 결과 경로가 비어 있는지 확인한다."""
    if not source.is_file():
        raise DocWriterError("source_missing", f"원본 문서를 찾지 못했습니다: {source.name}")
    if source.resolve() == target.resolve():
        raise DocWriterError("same_path", "원본을 덮어쓸 수 없습니다. 다른 이름으로 저장해 주세요.")
    if target.exists():
        raise DocWriterError("target_exists", f"같은 이름의 파일이 이미 있습니다: {target.name}")
    target.parent.mkdir(parents=True, exist_ok=True)


def _verify_or_fail(target: Path, *, replaced: int, still_has_old: bool, new_text: str) -> EditResult:
    """검증 결과를 판정한다. 실패면 결과 파일을 지워 반쪽짜리를 남기지 않는다."""
    if replaced == 0:
        target.unlink(missing_ok=True)
        raise DocWriterError("not_found", "바꿀 문구를 문서에서 찾지 못했습니다.")
    if still_has_old:
        target.unlink(missing_ok=True)
        raise DocWriterError(
            "verify_failed", "고친 내용이 저장되지 않았습니다. 문서를 확인해 주세요."
        )
    del new_text  # 검증은 호출부가 형식에 맞게 이미 했다
    return EditResult(output=str(target), replaced=replaced, verified=True)


# --- DOCX ------------------------------------------------------------------


def _docx_texts(document: object) -> list[str]:
    """문단과 표 셀의 글자를 모두 모은다(검증용)."""
    texts: list[str] = [p.text for p in document.paragraphs]  # type: ignore[attr-defined]
    for table in document.tables:  # type: ignore[attr-defined]
        for row in table.rows:
            for cell in row.cells:
                texts.append(cell.text)
    return texts


def edit_docx_text(source: Path, target: Path, old: str, new: str) -> EditResult:
    """DOCX 의 문단·표 셀에서 문구를 바꾼다.

    run 이 쪼개져 있으면 문단 단위로 합쳐 바꾼다 — 그러면 그 문단의 서식이 첫 run 으로
    통일되지만, 글자가 안 바뀌는 것보다 낫다(바뀐 사실은 검증으로 보장한다).
    """
    from docx import Document  # 지연 import — 이 도구를 안 쓰면 로드하지 않는다

    _prepare(source, target)
    document = Document(str(source))
    replaced = 0

    def replace_in_paragraph(paragraph: object) -> int:
        if old not in paragraph.text:  # type: ignore[attr-defined]
            return 0
        merged = paragraph.text.replace(old, new)  # type: ignore[attr-defined]
        for run in list(paragraph.runs)[1:]:  # type: ignore[attr-defined]
            run.text = ""
        if paragraph.runs:  # type: ignore[attr-defined]
            paragraph.runs[0].text = merged  # type: ignore[attr-defined]
        else:
            paragraph.add_run(merged)  # type: ignore[attr-defined]
        return 1

    for paragraph in document.paragraphs:
        replaced += replace_in_paragraph(paragraph)
    for table in document.tables:
        for row in table.rows:
            for cell in row.cells:
                for paragraph in cell.paragraphs:
                    replaced += replace_in_paragraph(paragraph)

    document.save(str(target))

    # 다시 열어 확인 — 새 문구가 있고 옛 문구가 없어야 한다.
    check = Document(str(target))
    texts = _docx_texts(check)
    return _verify_or_fail(
        target,
        replaced=replaced,
        still_has_old=any(old in t for t in texts) or not any(new in t for t in texts),
        new_text=new,
    )


# --- XLSX ------------------------------------------------------------------


def edit_xlsx_text(source: Path, target: Path, old: str, new: str) -> EditResult:
    """XLSX 의 문자열 셀에서 문구를 바꾼다. 수식은 건드리지 않는다."""
    from openpyxl import load_workbook

    _prepare(source, target)
    workbook = load_workbook(str(source))
    replaced = 0
    for sheet in workbook.worksheets:
        for row in sheet.iter_rows():
            for cell in row:
                value = cell.value
                if isinstance(value, str) and old in value:
                    cell.value = value.replace(old, new)
                    replaced += 1
    workbook.save(str(target))

    check = load_workbook(str(target))
    values = [
        cell.value
        for sheet in check.worksheets
        for row in sheet.iter_rows()
        for cell in row
        if isinstance(cell.value, str)
    ]
    return _verify_or_fail(
        target,
        replaced=replaced,
        still_has_old=any(old in v for v in values) or not any(new in v for v in values),
        new_text=new,
    )


# --- PPTX ------------------------------------------------------------------


def _pptx_frames(presentation: object):
    """슬라이드의 텍스트 프레임을 모두 훑는다(도형 + 표 셀)."""
    for slide in presentation.slides:  # type: ignore[attr-defined]
        for shape in slide.shapes:
            if shape.has_text_frame:
                yield shape.text_frame
            if getattr(shape, "has_table", False):
                for row in shape.table.rows:
                    for cell in row.cells:
                        yield cell.text_frame


def edit_pptx_text(source: Path, target: Path, old: str, new: str) -> EditResult:
    """PPTX 의 도형·표 텍스트에서 문구를 바꾼다."""
    from pptx import Presentation

    _prepare(source, target)
    presentation = Presentation(str(source))
    replaced = 0
    for frame in _pptx_frames(presentation):
        for paragraph in frame.paragraphs:
            joined = "".join(run.text for run in paragraph.runs)
            if old not in joined:
                continue
            merged = joined.replace(old, new)
            for run in list(paragraph.runs)[1:]:
                run.text = ""
            if paragraph.runs:
                paragraph.runs[0].text = merged
                replaced += 1
    presentation.save(str(target))

    check = Presentation(str(target))
    texts = [frame.text for frame in _pptx_frames(check)]
    return _verify_or_fail(
        target,
        replaced=replaced,
        still_has_old=any(old in t for t in texts) or not any(new in t for t in texts),
        new_text=new,
    )


# --- PDF -------------------------------------------------------------------


def annotate_pdf(source: Path, target: Path, find: str, note: str) -> EditResult:
    """PDF 에서 문구를 찾아 **주석을 단 파생 사본**을 만든다.

    PDF 본문 글자는 안전하게 바꿔 넣을 수 없다(글꼴·자간·레이아웃이 깨진다). 그래서 고치는
    척하지 않고, 찾은 자리에 메모를 남긴다. 원본은 그대로 둔다.
    """
    import pymupdf

    _prepare(source, target)
    document = pymupdf.open(str(source))
    marked = 0
    try:
        for page in document:
            for rect in page.search_for(find):
                page.add_text_annot(rect.tl, note)
                marked += 1
        if marked == 0:
            raise DocWriterError("not_found", "표시할 문구를 PDF 에서 찾지 못했습니다.")
        document.save(str(target))
    finally:
        document.close()

    # 다시 열어 주석이 실제로 남았는지 확인한다.
    check = pymupdf.open(str(target))
    try:
        annots = sum(1 for page in check for _ in page.annots())
    finally:
        check.close()
    if annots < marked:
        target.unlink(missing_ok=True)
        raise DocWriterError("verify_failed", "주석이 저장되지 않았습니다.")
    return EditResult(output=str(target), replaced=marked, verified=True)
