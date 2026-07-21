import sys
from pathlib import Path

from fastapi import FastAPI, HTTPException

from app import cache, frontmatter, metadata_extract, postprocess
from app.converters import ConversionFailedError, convert
from app.schemas import ConvertRequest, ConvertResult

# Windows defaults stdout/stderr to the system codepage (cp949 on ko-KR), which
# raises UnicodeEncodeError or silently mangles Korean filenames/content the
# moment anything gets printed or logged. Force UTF-8 unconditionally so the
# service behaves the same on every platform regardless of console/locale.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8")

app = FastAPI(title="doc2md", version="0.1.0")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/convert", response_model=ConvertResult)
def convert_document(req: ConvertRequest) -> ConvertResult:
    path = Path(req.path)

    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"file not found: {path}")

    raw = cache.get(path)
    was_cached = raw is not None
    if raw is None:
        try:
            raw = convert(path)
        except ConversionFailedError as e:
            raise HTTPException(status_code=422, detail=str(e)) from e
        cache.set(path, raw)

    cleaned = postprocess.clean(raw.body)
    auto_meta = metadata_extract.extract(cleaned.body, path.name)

    fm = frontmatter.build(
        path,
        cleaned.body,
        req.metadata,
        auto=auto_meta,
        title_hint=cleaned.title,
    )
    full_markdown = frontmatter.render(fm, cleaned.body)

    return ConvertResult(
        markdown=full_markdown,
        frontmatter=fm,
        body=cleaned.body,
        format=raw.format,
        library_used=raw.library_used,
        warnings=raw.warnings,
        cached=was_cached,
    )
