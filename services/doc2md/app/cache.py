import hashlib
from pathlib import Path
from threading import Lock

from pydantic import ValidationError

from app.schemas import RawConversion

_CACHE_DIR = Path(__file__).resolve().parent.parent / ".cache" / "raw"
_lock = Lock()

#: 변환 결과의 판 번호. **키의 일부다.**
#:
#: 키가 파일(경로·mtime·크기)만 담으면, 변환기를 고쳐도 이미 변환해 둔 파일은 옛 결과가
#: 영원히 나온다. 파일은 안 변했으니 캐시는 자기가 유효하다고 믿는다. 실제로 한글 본문을
#: kordoc 으로 읽도록 바꾼 뒤에도 모든 파일이 예전 pyhwp2md 결과를 돌려줬다 — 코드는
#: 고쳤는데 한 번도 실행되지 않았다.
#:
#: `convert()` 의 출력이 달라지면 이 번호를 올린다. 그러면 키가 달라져 다시 변환된다.
#:
#: v2 — 한글(HWP/HWPX) 본문을 kordoc 으로 읽는다(병합셀 표 유실 수정).
_PIPELINE_VERSION = "v2"


def _cache_key(path: Path) -> str:
    stat = path.stat()
    raw = f"{_PIPELINE_VERSION}|{path.resolve()}|{stat.st_mtime_ns}|{stat.st_size}"
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
