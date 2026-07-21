import logging
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import FastAPI, HTTPException

from app import cache, chunker, frontmatter, metadata_extract, postprocess, progress
from app.converters import ConversionFailedError, convert
from app.schemas import (
    BatchConvertRequest,
    ConvertRequest,
    ConvertResult,
    DocumentChunk,
    Frontmatter,
)

# Windows defaults stdout/stderr to the system codepage (cp949 on ko-KR), which
# raises UnicodeEncodeError or silently mangles Korean filenames/content the
# moment anything gets printed or logged. Force UTF-8 unconditionally so the
# service behaves the same on every platform regardless of console/locale.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8")

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s"
)

app = FastAPI(title="doc2md", version="0.1.0")

# Conversions are CPU-bound and serialized on purpose: OCR already saturates the
# machine, so running jobs concurrently would only make every ETA worse.
_workers = ThreadPoolExecutor(max_workers=1, thread_name_prefix="doc2md")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


def _run_pipeline(req: ConvertRequest, job=None) -> ConvertResult:
    """The whole conversion, reporting progress into ``job`` when given."""
    path = Path(req.path)

    raw = cache.get(path)
    was_cached = raw is not None
    if raw is None:
        raw = convert(path, job=job)
        cache.set(path, raw)
    else:
        progress.update(
            job, phase="convert", total=1, current=1, message="캐시된 변환 사용"
        )

    progress.update(job, phase="postprocess", total=1, current=0, message="본문 정제 중")
    cleaned = postprocess.clean(raw.body)
    progress.update(job, current=1)

    progress.update(job, phase="metadata", total=1, current=0, message="메타데이터 추출 중")
    auto_meta = metadata_extract.extract(cleaned.body, path.name)
    progress.update(job, current=1)

    progress.update(job, phase="frontmatter", total=1, current=0, message="프론트매터 조립 중")
    fm = frontmatter.build(
        path,
        cleaned.body,
        req.metadata,
        auto=auto_meta,
        title_hint=cleaned.title,
    )
    full_markdown = frontmatter.render(fm, cleaned.body)
    progress.update(job, current=1)

    chunks = None
    if req.chunking.enabled:
        progress.update(job, phase="chunking", total=1, current=0, message="청킹 중")
        chunks = _build_chunks(path, fm, cleaned.body, req)
        progress.update(job, current=1, message=f"{len(chunks)}개 청크 생성")

    return ConvertResult(
        chunks=chunks,
        markdown=full_markdown,
        frontmatter=fm,
        body=cleaned.body,
        format=raw.format,
        library_used=raw.library_used,
        warnings=raw.warnings,
        cached=was_cached,
    )


@app.post("/convert", response_model=ConvertResult)
def convert_document(req: ConvertRequest) -> ConvertResult:
    """Blocking conversion. Pass ``job_id`` to make progress pollable meanwhile."""
    path = Path(req.path)
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"file not found: {path}")

    job = progress.create(str(path), job_id=req.job_id) if req.job_id else None
    try:
        result = _run_pipeline(req, job)
    except ConversionFailedError as e:
        progress.fail(job, str(e))
        raise HTTPException(status_code=422, detail=str(e)) from e
    except Exception as e:
        progress.fail(job, str(e))
        raise
    progress.finish(job, result, cached=result.cached)
    return result


@app.post("/convert/async", status_code=202)
def convert_document_async(req: ConvertRequest) -> dict:
    """Start a conversion in the background and return immediately.

    Long conversions (a deck with OCR runs into the minutes) do not fit a
    blocking request: poll ``GET /jobs/{job_id}`` for progress/ETA, then fetch
    ``GET /jobs/{job_id}/result`` once status is ``done``.
    """
    path = Path(req.path)
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"file not found: {path}")

    job = progress.create(str(path), job_id=req.job_id)

    def _work() -> None:
        try:
            result = _run_pipeline(req, job)
        except Exception as e:
            progress.fail(job, str(e))
            return
        progress.finish(job, result, cached=result.cached)

    _workers.submit(_work)
    return {"job_id": job.job_id, "status": job.status, "poll": f"/jobs/{job.job_id}"}


@app.post("/convert/batch", status_code=202)
def convert_batch(req: BatchConvertRequest) -> dict:
    """Queue several files; each gets its own progress and ETA.

    Files convert one at a time (OCR already saturates the CPU), so the batch
    ETA is the running file's remaining time plus the predicted duration of the
    ones still queued.
    """
    missing = [p for p in req.paths if not Path(p).is_file()]
    if missing:
        raise HTTPException(status_code=404, detail=f"file(s) not found: {missing}")

    jobs = []
    for p in req.paths:
        job = progress.create(str(Path(p)))
        item = ConvertRequest(
            path=p,
            metadata=req.metadata,
            chunking=req.chunking,
            job_id=job.job_id,
        )

        def _work(item=item, job=job) -> None:
            try:
                result = _run_pipeline(item, job)
            except Exception as e:
                progress.fail(job, str(e))
                return
            progress.finish(job, result, cached=result.cached)

        _workers.submit(_work)
        jobs.append({"path": p, "job_id": job.job_id})

    batch_id = progress.create_batch([j["job_id"] for j in jobs], req.batch_id)
    return {
        "batch_id": batch_id,
        "jobs": jobs,
        "poll": f"/batches/{batch_id}",
    }


@app.get("/batches/{batch_id}")
def get_batch(batch_id: str) -> dict:
    snap = progress.batch_snapshot(batch_id)
    if snap is None:
        raise HTTPException(status_code=404, detail=f"unknown batch: {batch_id}")
    return snap


@app.get("/jobs")
def list_jobs() -> dict:
    return {"jobs": progress.list_jobs()}


@app.get("/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    job = progress.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"unknown job: {job_id}")
    return job.snapshot()


@app.get("/jobs/{job_id}/result", response_model=ConvertResult)
def get_job_result(job_id: str) -> ConvertResult:
    job = progress.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"unknown job: {job_id}")
    if job.status == "failed":
        raise HTTPException(status_code=422, detail=job.error or "conversion failed")
    if job.status != "done" or job.result is None:
        raise HTTPException(
            status_code=409, detail=f"job not finished (status={job.status})"
        )
    return job.result


def _build_chunks(
    path: Path, doc_fm: Frontmatter, body: str, req: ConvertRequest
) -> list[DocumentChunk]:
    """Split the body and give every chunk its own usable frontmatter.

    A chunk shares the document's ``id`` (it is the same document) but gets its
    own ``chunk_no``, so a retrieved chunk can always be traced back to its
    source document and position.
    """
    opts = req.chunking
    max_chars, min_chars = opts.resolve(len(body))
    pieces = chunker.chunk_markdown(
        body,
        max_chars=max_chars,
        min_chars=min_chars,
        split_level=opts.split_level,
    )

    slug = frontmatter.slugify(path.name)
    out: list[DocumentChunk] = []
    for piece in pieces:
        chunk_no = f"{slug}_{piece.index:03d}"
        chunk_fm = doc_fm.model_copy(update={"chunk_no": chunk_no})
        rendered = chunker.render_chunk(piece)
        out.append(
            DocumentChunk(
                chunk_no=chunk_no,
                index=piece.index,
                markdown=frontmatter.render(chunk_fm, rendered),
                body=rendered,
                frontmatter=chunk_fm,
                heading_path=piece.heading_path,
                chars=piece.chars,
            )
        )
    return out
