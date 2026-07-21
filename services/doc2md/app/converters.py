from __future__ import annotations

import hashlib
import re
from pathlib import Path

import pyhwp2md
from markitdown import MarkItDown
from markitdown import MarkItDownException

from app import ocr, progress, render
from app.errors import Diagnostic, diagnostic
from app.schemas import RawConversion

HWP_EXTS = {".hwp", ".hwpx"}

# MarkItDown() is stateless per-call aside from its plugin registry, so one
# process-wide instance is safe to reuse across requests.
_markitdown = MarkItDown(enable_builtins=True)

_SLIDE_MARKER = re.compile(r"(<!-- Slide number: (\d+) -->)")


class ConversionFailedError(Exception):
    pass


def convert(path: Path, job=None) -> RawConversion:
    """Convert a file. ``job`` is an optional progress.Job to report into."""
    ext = path.suffix.lower()

    if ext in HWP_EXTS:
        progress.update(job, phase="convert", total=1, current=0, message="hwp 변환 중")
        result = _convert_hwp(path, ext)
    elif ext == ".pptx":
        result = _convert_pptx(path, ext, job)
    else:
        progress.update(
            job, phase="convert", total=1, current=0, message=f"{ext} 변환 중"
        )
        result = _convert_markitdown(path, ext, job)

    progress.update(job, phase="convert", total=1, current=1, message="변환 완료")
    return result


def _convert_hwp(path: Path, ext: str) -> RawConversion:
    try:
        body = pyhwp2md.convert(path)
    except pyhwp2md.Pyhwp2mdError as e:
        raise ConversionFailedError(f"hwp/hwpx conversion failed: {e}") from e
    return _finish(body, ext, "pyhwp2md", [])


# A PDF whose text layer yields less than this is treated as scanned: there is
# nothing to read without OCR.
_SCANNED_PDF_CHARS = 64


def _convert_markitdown(path: Path, ext: str, job=None) -> RawConversion:
    try:
        result = _markitdown.convert(str(path))
    except MarkItDownException as e:
        raise ConversionFailedError(f"markitdown conversion failed: {e}") from e

    body = result.markdown
    warnings: list[Diagnostic] = []

    # Scanned PDFs have no text layer at all — markitdown returns empty and the
    # document would silently convert to nothing. Render each page and OCR it.
    if ext == ".pdf" and len(body.strip()) < _SCANNED_PDF_CHARS and ocr.available():
        progress.update(
            job, phase="convert", total=1, current=0, message="스캔 PDF — 페이지 렌더링 중"
        )
        pages = render.render_pdf_pages(path)
        if pages:
            by_page, _ = _ocr_rendered(pages, "페이지", job, ocr.DEFAULT_LANG)
            if by_page:
                body = "\n\n".join(
                    f"<!-- page {n} -->\n\n{md}" for n, md in sorted(by_page.items())
                )
                return _finish(body, ext, "markitdown+ocr", warnings)
        warnings.append(diagnostic("scanned_pdf_ocr_failed"))

    return _finish(body, ext, "markitdown", warnings)


def _convert_pptx(path: Path, ext: str, job=None) -> RawConversion:
    """markitdown for text/tables + PP-StructureV3 for text baked into images.

    markitdown only references pictures as ``![alt](img)`` and never reads text
    inside them, so image-only / scanned slides come out empty. We OCR every
    embedded picture and splice the recognized text into its own slide.
    """
    progress.update(job, phase="convert", total=1, current=0, message="pptx 텍스트 추출 중")
    try:
        result = _markitdown.convert(str(path))
    except MarkItDownException as e:
        raise ConversionFailedError(f"markitdown conversion failed: {e}") from e

    body = result.markdown
    warnings: list[Diagnostic] = []
    # The deck's own text tells us which recognition model to use, so picking a
    # language costs nothing extra.
    lang = ocr.detect_lang(body)
    ocr_by_slide, library = _ocr_pptx_images(path, warnings, job, lang)
    if ocr_by_slide:
        body = _merge_ocr_into_slides(body, ocr_by_slide)

    return _finish(body, ext, library, warnings)


def _ocr_pptx_images(
    path: Path, warnings: list[Diagnostic], job=None, lang: str = "ko"
) -> tuple[dict[int, str], str]:
    if not ocr.available():
        warnings.append(diagnostic("ocr_engine_unavailable"))
        return {}, "markitdown"

    # One image per slide is the right unit of work: a deck's embedded pictures
    # number in the hundreds (icons, logos) and reading them individually both
    # costs far more and destroys the spatial layout a table depends on.
    progress.update(job, phase="convert", total=1, current=0, message="슬라이드 렌더링 중")
    slides = render.render_pptx_slides(path)

    if slides:
        return _ocr_rendered(slides, "슬라이드", job, lang)

    warnings.append(diagnostic("slide_render_unavailable"))
    return _ocr_embedded_pictures(path, warnings, job, lang)


def _ocr_rendered(
    images: list[bytes], unit: str, job=None, lang: str = "ko"
) -> tuple[dict[int, str], str]:
    """OCR one rendered page/slide image per index."""
    out: dict[int, str] = {}
    total = len(images)
    progress.update(
        job, phase="convert", total=total, current=0, message=f"{unit} OCR 0/{total}"
    )
    for i, blob in enumerate(images, start=1):
        md = ocr.extract_markdown(blob, lang=lang)
        if md:
            out[i] = md
        progress.update(job, current=i, message=f"{unit} OCR {i}/{total}")
    return out, ("markitdown+ocr" if out else "markitdown")


def _ocr_embedded_pictures(
    path: Path, warnings: list[Diagnostic], job=None, lang: str = "ko"
) -> tuple[dict[int, str], str]:
    """Fallback when slides cannot be rendered: read each embedded picture."""
    try:
        from pptx import Presentation

        prs = Presentation(str(path))
    except Exception as e:
        warnings.append(diagnostic("pptx_ocr_skipped", detail=str(e)))
        return {}, "markitdown"

    todo: list[tuple[int, bytes]] = []
    for slide_num, slide in enumerate(prs.slides, start=1):
        for pic in _iter_pictures(slide.shapes):
            try:
                todo.append((slide_num, pic.image.blob))
            except Exception:
                continue

    ocr_by_slide: dict[int, list[str]] = {}
    seen: dict[str, str] = {}  # blob-hash -> markdown, so a repeated logo is read once
    total = len(todo)
    progress.update(
        job, phase="convert", total=total, current=0, message=f"이미지 OCR 0/{total}"
    )
    for done, (slide_num, blob) in enumerate(todo, start=1):
        key = hashlib.sha256(blob).hexdigest()
        if key not in seen:
            seen[key] = ocr.extract_markdown(blob, lang=lang)
        if seen[key]:
            ocr_by_slide.setdefault(slide_num, []).append(seen[key])
        progress.update(job, current=done, message=f"이미지 OCR {done}/{total}")

    merged = {num: "\n\n".join(b) for num, b in ocr_by_slide.items()}
    return merged, ("markitdown+ocr" if merged else "markitdown")


def _iter_pictures(shapes):
    """Yield picture shapes with a resolvable embedded image, recursing into groups.

    python-pptx's ``shape.image`` raises ValueError (not AttributeError) for a
    Picture whose embed relationship is missing/broken, so a plain hasattr()
    check does not catch it and the whole conversion would crash on one bad
    shape. Skip anything that fails to resolve instead.
    """
    for shape in shapes:
        if shape.shape_type == 6:  # MSO_SHAPE_TYPE.GROUP
            yield from _iter_pictures(shape.shapes)
            continue
        if getattr(shape, "shape_type", None) != 13:  # MSO_SHAPE_TYPE.PICTURE
            continue
        try:
            shape.image
        except Exception:
            continue
        yield shape


def _merge_ocr_into_slides(md: str, ocr_by_slide: dict[int, str]) -> str:
    parts = _SLIDE_MARKER.split(md)
    if len(parts) == 1:
        # No slide markers (unexpected) — append everything at the end.
        joined = "\n\n".join(b for b in ocr_by_slide.values() if b)
        return md.rstrip() + "\n" + _ocr_block(joined) if joined else md

    out = [parts[0]]
    i = 1
    while i < len(parts):
        marker, num_str, body = parts[i], parts[i + 1], parts[i + 2]
        out.append(marker)
        block = ocr_by_slide.get(int(num_str))
        if block:
            body = body.rstrip() + "\n" + _ocr_block(block)
        out.append(body)
        i += 3
    return "".join(out)


def _ocr_block(markdown: str) -> str:
    return f"\n#### 이미지 텍스트 (OCR)\n\n{markdown.strip()}\n"


def _finish(
    body: str, ext: str, library_used: str, warnings: list[Diagnostic]
) -> RawConversion:
    if not body.strip():
        warnings.append(
            diagnostic("empty_output", detail="스캔/이미지 전용 파일일 수 있습니다")
        )
    return RawConversion(
        body=body,
        format=ext.lstrip("."),
        library_used=library_used,
        diagnostics=warnings,
    )
