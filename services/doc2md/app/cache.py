import hashlib
from pathlib import Path
from threading import Lock

from pydantic import ValidationError

from app.schemas import RawConversion

_CACHE_DIR = Path(__file__).resolve().parent.parent / ".cache" / "raw"
_lock = Lock()


def _cache_key(path: Path) -> str:
    stat = path.stat()
    raw = f"{path.resolve()}|{stat.st_mtime_ns}|{stat.st_size}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def get(path: Path) -> RawConversion | None:
    key = _cache_key(path)
    cache_file = _CACHE_DIR / f"{key}.json"
    if not cache_file.exists():
        return None
    try:
        return RawConversion.model_validate_json(cache_file.read_text(encoding="utf-8"))
    except (ValidationError, OSError, ValueError):
        # An entry written by an older RawConversion shape, or a half-written
        # file. A stale cache must never be able to fail a conversion — treat it
        # as a miss and let the caller redo the work.
        return None


def set(path: Path, result: RawConversion) -> None:
    key = _cache_key(path)
    with _lock:
        _CACHE_DIR.mkdir(parents=True, exist_ok=True)
        cache_file = _CACHE_DIR / f"{key}.json"
        cache_file.write_text(result.model_dump_json(), encoding="utf-8")
