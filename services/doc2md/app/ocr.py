"""Korean-first OCR via RapidOCR (ONNX).

Model choice — fastest + lightest + accurate for Korean:
  det: PP-OCRv5 default (language-agnostic text-box detection)
  rec: korean_PP-OCRv5_rec_mobile  (~13MB ONNX, Korean-specialized, newest v5)

The default RapidOCR recognition model is Chinese and mangles Hangul
(입찰안내서 → 吾卫出京), so the Korean rec model is mandatory here.

The engine is lazy-initialized on first use and reused process-wide: model load
+ first-call graph warmup costs a few seconds, so non-OCR requests never pay it.
"""

from __future__ import annotations

import logging
import threading

logger = logging.getLogger("doc2md.ocr")

# Recognized lines below this confidence are dropped as noise (logos, textures).
MIN_SCORE = 0.6

_engine = None
_engine_lock = threading.Lock()
_engine_failed = False


def _get_engine():
    global _engine, _engine_failed
    if _engine is not None or _engine_failed:
        return _engine
    with _engine_lock:
        if _engine is not None or _engine_failed:
            return _engine
        try:
            from rapidocr import LangRec, ModelType, OCRVersion, RapidOCR

            _engine = RapidOCR(
                params={
                    "Rec.lang_type": LangRec.KOREAN,
                    "Rec.ocr_version": OCRVersion.PPOCRV5,
                    "Rec.model_type": ModelType.MOBILE,
                }
            )
            logger.info("RapidOCR (korean_PP-OCRv5_rec_mobile) initialized")
        except Exception as e:  # onnxruntime/rapidocr missing, model download fail, etc.
            _engine_failed = True
            logger.warning("OCR unavailable, image text will be skipped: %s", e)
    return _engine


def available() -> bool:
    return _get_engine() is not None


def ocr_image_bytes(blob: bytes) -> list[str]:
    """Return recognized text lines from a raw image blob, in reading order.

    Returns [] if OCR is unavailable, the image has no text, or nothing clears
    the confidence threshold. Never raises — a bad image must not fail the
    whole document conversion.
    """
    engine = _get_engine()
    if engine is None:
        return []
    try:
        result = engine(blob)
    except Exception as e:
        logger.warning("OCR failed on one image: %s", e)
        return []

    if result is None or not getattr(result, "txts", None):
        return []

    scores = result.scores or []
    lines: list[str] = []
    for i, txt in enumerate(result.txts):
        score = scores[i] if i < len(scores) else 1.0
        text = (txt or "").strip()
        if text and score >= MIN_SCORE:
            lines.append(text)
    return lines
