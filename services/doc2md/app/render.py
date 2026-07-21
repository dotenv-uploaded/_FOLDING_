"""Render a document one page/slide at a time, as a single image each.

OCR'ing a deck's *embedded pictures* is the wrong unit of work: a 9-slide deck
carried 109 of them (one slide alone had 39 icons and logos), so we paid 109
model passes and still lost the spatial relationship between shapes — a table
built from separate text boxes was unreadable as a table.

Rendering **one image per slide / per page** fixes both: 9 passes instead of 109,
and the layout the reader actually sees is what the model sees.

Everything is returned as in-memory PNG bytes. The PowerPoint path has to export
through a temp directory (COM gives no in-memory API), so it cleans up after
itself — no rendered image survives the call.
"""

from __future__ import annotations

import logging
import shutil
import tempfile
from pathlib import Path

logger = logging.getLogger("doc2md.render")

# Rendering resolution. Slide text at 150 DPI lands well above the ~20px glyph
# height OCR needs, without exploding pixel count.
PDF_DPI = 150
PPTX_WIDTH_PX = 1600


def render_pdf_pages(path: Path) -> list[bytes]:
    """One PNG per PDF page."""
    try:
        import fitz  # PyMuPDF
    except ImportError:
        logger.warning("PyMuPDF not installed — cannot render PDF pages")
        return []

    pages: list[bytes] = []
    try:
        with fitz.open(str(path)) as doc:
            zoom = PDF_DPI / 72
            matrix = fitz.Matrix(zoom, zoom)
            for page in doc:
                pix = page.get_pixmap(matrix=matrix, alpha=False)
                pages.append(pix.tobytes("png"))
    except Exception as e:
        logger.warning("PDF render failed: %s", e)
        return []
    return pages


# Deliberately NOT here: page-wise text extraction via PyMuPDF's get_text().
# It is ~47x faster than markitdown's pdfminer backend (1.4s vs 66.3s across the
# PDF corpus) and recovers exactly the same Hangul, but it returns plain text —
# on one 28K-char file it produced 0 table rows where pdfminer produced 210.
# Tables are the thing this pipeline works hardest to preserve, so the speed is
# not worth it. PDFs therefore report `source_page` only when a page was OCR'd;
# section spans (char_start/char_end) carry provenance for the rest.


def render_pptx_slides(path: Path) -> list[bytes]:
    """One PNG per slide, via PowerPoint automation.

    Requires PowerPoint on Windows. Returns [] when unavailable so the caller can
    fall back to reading embedded pictures instead of failing the conversion.
    """
    try:
        import pythoncom
        import win32com.client
    except ImportError:
        logger.info("pywin32 unavailable — no slide rendering")
        return []

    tmpdir = Path(tempfile.mkdtemp(prefix="doc2md_slides_"))
    app = None
    pythoncom.CoInitialize()
    try:
        app = win32com.client.Dispatch("PowerPoint.Application")
        deck = app.Presentations.Open(
            str(path.resolve()), WithWindow=False, ReadOnly=True
        )
        try:
            height = int(PPTX_WIDTH_PX * deck.PageSetup.SlideHeight / deck.PageSetup.SlideWidth)
            deck.Export(str(tmpdir), "PNG", PPTX_WIDTH_PX, height)
        finally:
            deck.Close()
        return [p.read_bytes() for p in sorted(tmpdir.glob("*.PNG")) or sorted(tmpdir.glob("*.png"))]
    except Exception as e:
        logger.warning("PowerPoint slide render failed: %s", e)
        return []
    finally:
        if app is not None:
            try:
                app.Quit()
            except Exception:
                pass
        pythoncom.CoUninitialize()
        shutil.rmtree(tmpdir, ignore_errors=True)  # never leave images on disk
