from __future__ import annotations

import hashlib
import re
from pathlib import Path

import pyhwp2md
from markitdown import MarkItDown
from markitdown import MarkItDownException

from app import ocr
from app.schemas import RawConversion

HWP_EXTS = {".hwp", ".hwpx"}

# MarkItDown() is stateless per-call aside from its plugin registry, so one
# process-wide instance is safe to reuse across requests.
_markitdown = MarkItDown(enable_builtins=True)

_SLIDE_MARKER = re.compile(r"(<!-- Slide number: (\d+) -->)")


class ConversionFailedError(Exception):
    pass


def convert(path: Path) -> RawConversion:
    ext = path.suffix.lower()

    if ext in HWP_EXTS:
        return _convert_hwp(path, ext)
    if ext == ".pptx":
        return _convert_pptx(path, ext)
    return _convert_markitdown(path, ext)


def _convert_hwp(path: Path, ext: str) -> RawConversion:
    try:
        body = pyhwp2md.convert(path)
    except pyhwp2md.Pyhwp2mdError as e:
        raise ConversionFailedError(f"hwp/hwpx conversion failed: {e}") from e
    return _finish(body, ext, "pyhwp2md", [])


def _convert_markitdown(path: Path, ext: str) -> RawConversion:
    try:
        result = _markitdown.convert(str(path))
    except MarkItDownException as e:
        raise ConversionFailedError(f"markitdown conversion failed: {e}") from e
    return _finish(result.markdown, ext, "markitdown", [])


def _convert_pptx(path: Path, ext: str) -> RawConversion:
    """markitdown for text/tables + RapidOCR for text baked into slide images.

    markitdown only references pictures as ``![alt](img)`` and never reads text
    inside them, so image-only / scanned slides come out empty. We OCR every
    embedded picture and splice the recognized text into its own slide.
    """
    try:
        result = _markitdown.convert(str(path))
    except MarkItDownException as e:
        raise ConversionFailedError(f"markitdown conversion failed: {e}") from e

    body = result.markdown
    warnings: list[str] = []
    ocr_by_slide, library = _ocr_pptx_images(path, warnings)
    if ocr_by_slide:
        body = _merge_ocr_into_slides(body, ocr_by_slide)

    return _finish(body, ext, library, warnings)


def _ocr_pptx_images(
    path: Path, warnings: list[str]
) -> tuple[dict[int, list[str]], str]:
    try:
        from pptx import Presentation
    except ImportError:
        warnings.append("pptx_ocr_skipped: python-pptx not installed")
        return {}, "markitdown"

    try:
        prs = Presentation(str(path))
    except Exception as e:
        warnings.append(f"pptx_ocr_skipped: could not open presentation ({e})")
        return {}, "markitdown"

    if not ocr.available():
        warnings.append("pptx_ocr_skipped: OCR engine unavailable")
        return {}, "markitdown"

    ocr_by_slide: dict[int, list[str]] = {}
    seen: dict[str, list[str]] = {}  # blob-hash -> lines, so a repeated logo is OCR'd once
    any_text = False

    for slide_num, slide in enumerate(prs.slides, start=1):
        lines: list[str] = []
        for pic in _iter_pictures(slide.shapes):
            try:
                blob = pic.image.blob
            except Exception:
                continue
            key = hashlib.sha256(blob).hexdigest()
            if key not in seen:
                seen[key] = ocr.ocr_image_bytes(blob)
            lines.extend(seen[key])
        if lines:
            ocr_by_slide[slide_num] = lines
            any_text = True

    library = "markitdown+ocr" if any_text else "markitdown"
    return ocr_by_slide, library


def _iter_pictures(shapes):
    """Yield picture shapes, recursing into group shapes."""
    for shape in shapes:
        if shape.shape_type == 6:  # MSO_SHAPE_TYPE.GROUP
            yield from _iter_pictures(shape.shapes)
        elif getattr(shape, "shape_type", None) == 13 or hasattr(shape, "image"):
            # 13 == PICTURE; hasattr(image) also catches picture placeholders
            if hasattr(shape, "image"):
                yield shape


def _merge_ocr_into_slides(md: str, ocr_by_slide: dict[int, list[str]]) -> str:
    parts = _SLIDE_MARKER.split(md)
    if len(parts) == 1:
        # No slide markers (unexpected) — append everything at the end.
        all_lines = [ln for lines in ocr_by_slide.values() for ln in lines]
        return md.rstrip() + "\n" + _ocr_block(all_lines) if all_lines else md

    out = [parts[0]]
    i = 1
    while i < len(parts):
        marker, num_str, body = parts[i], parts[i + 1], parts[i + 2]
        out.append(marker)
        lines = ocr_by_slide.get(int(num_str))
        if lines:
            body = body.rstrip() + "\n" + _ocr_block(lines)
        out.append(body)
        i += 3
    return "".join(out)


def _ocr_block(lines: list[str]) -> str:
    body = "\n".join(f"- {ln}" for ln in lines)
    return f"\n#### 이미지 텍스트 (OCR)\n\n{body}\n"


def _finish(
    body: str, ext: str, library_used: str, warnings: list[str]
) -> RawConversion:
    if not body.strip():
        warnings.append(
            "empty_output: likely a scanned/image-only file — OCR fallback not wired up yet"
        )
    return RawConversion(
        body=body,
        format=ext.lstrip("."),
        library_used=library_used,
        warnings=warnings,
    )
