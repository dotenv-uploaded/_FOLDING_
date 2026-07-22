"""요약 만들기는 **부팅을 막지 않아야 한다.**

부팅 경로에 넣었더니 헬스 체크가 먼저 만료돼 sidecar 가 통째로 죽었다(14개 중 4개에서
강제 종료). 배경 작업이 느리든 터지든 서비스는 떠 있어야 한다.
"""

from __future__ import annotations

import threading
import time

from codegate_api.knowledge.llmwiki import NativeLLMWikiCatalog


class _Runner:
    def __init__(self, *, seconds: float = 0.0, boom: bool = False) -> None:
        self.seconds = seconds
        self.boom = boom
        self.done = threading.Event()

    def enrich(self) -> None:
        try:
            if self.seconds:
                time.sleep(self.seconds)
            if self.boom:
                raise RuntimeError("provider unavailable")
        finally:
            self.done.set()


def _catalog(runner: _Runner) -> NativeLLMWikiCatalog:
    catalog = NativeLLMWikiCatalog.__new__(NativeLLMWikiCatalog)
    catalog._runner = runner  # type: ignore[attr-defined]
    return catalog


def test_느린_enrichment_가_호출자를_붙잡지_않는다() -> None:
    runner = _Runner(seconds=1.0)
    started = time.monotonic()
    _catalog(runner).enrich_in_background()
    # 즉시 돌아와야 한다 — 여기서 기다리면 헬스 체크가 만료된다.
    assert time.monotonic() - started < 0.3
    assert runner.done.wait(timeout=5.0)


def test_enrichment_이_터져도_전파되지_않는다() -> None:
    runner = _Runner(boom=True)
    _catalog(runner).enrich_in_background()  # 예외가 올라오면 이 줄에서 실패한다
    assert runner.done.wait(timeout=5.0)


def test_배경_스레드는_데몬이라_종료를_막지_않는다() -> None:
    runner = _Runner(seconds=0.2)
    before = {t.name for t in threading.enumerate()}
    _catalog(runner).enrich_in_background()
    spawned = [t for t in threading.enumerate() if t.name == "llmwiki-enrichment"]
    assert spawned, "배경 스레드가 뜨지 않았다"
    assert spawned[0].daemon is True
    assert runner.done.wait(timeout=5.0)
    del before
