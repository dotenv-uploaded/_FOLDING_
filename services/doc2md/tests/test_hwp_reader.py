"""한글 본문을 어느 파서로 읽는가, 그리고 못 읽었을 때 그 사실이 드러나는가.

이 파일이 지키는 규칙: **표가 빠진 변환 결과가 온전한 척 나가면 안 된다.**

pyhwp2md 는 병합된 셀의 내용을 조용히 잃는다. 한 사업계획서 양식에서 4,026자 중 133자만
남기고도 예외도 경고도 내지 않았다(측정은 app/kordoc.py 주석). 한국 공공·사업 서식은
거의 전부 병합셀 표라 이건 예외가 아니라 기본값에 가깝다. 그래서 본문은 kordoc 으로 읽고,
kordoc 을 못 쓰면 **경고를 남기고** 대체 변환기로 내려간다.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app import converters, kordoc
from app.errors import Diagnostic


class _Bridge:
    """주입할 가짜 다리. 실제 Node 없이 호출 계약만 확인한다."""

    def __init__(self, *, markdown=None, error=None):
        self._markdown = markdown
        self._error = error
        self.calls = 0

    def to_markdown(self, path: Path) -> str:
        self.calls += 1
        if self._error is not None:
            raise self._error
        return self._markdown


@pytest.fixture
def patched(monkeypatch):
    """kordoc 다리와 pyhwp2md 를 갈아끼운다."""

    def apply(bridge, fallback_body="폴백 본문"):
        monkeypatch.setattr(kordoc, "KordocBridge", lambda **_: bridge)
        monkeypatch.setattr(
            converters.pyhwp2md, "convert", lambda _path: fallback_body
        )
        return bridge

    return apply


def test_kordoc_이_읽으면_그_본문을_쓴다(patched):
    bridge = patched(_Bridge(markdown="| 병합된 | 표 |\n| --- | --- |"))
    warnings: list[Diagnostic] = []

    body, library = converters._read_hwp_body(Path("x.hwp"), warnings)

    assert body == "| 병합된 | 표 |\n| --- | --- |"
    assert library == "kordoc"
    assert warnings == []
    assert bridge.calls == 1


def test_kordoc_이_없으면_대체하되_반드시_경고한다(patched):
    patched(_Bridge(error=kordoc.KordocUnavailableError("node not found")))
    warnings: list[Diagnostic] = []

    body, library = converters._read_hwp_body(Path("x.hwp"), warnings)

    assert body == "폴백 본문"
    assert library == "pyhwp2md"
    # 조용히 내려가면 표가 빠진 결과가 정상처럼 나간다. 그게 이 기능의 실패 모드다.
    assert [w.code for w in warnings] == ["hwp_kordoc_unavailable"]
    assert warnings[0].severity == "warning"
    # 호스트에 Node 를 놓으면 같은 파일이 온전히 변환된다 — 다시 시도할 값어치가 있다.
    assert warnings[0].retryable is True


def test_kordoc_이_실패해도_대체하되_반드시_경고한다(patched):
    patched(_Bridge(error=kordoc.KordocFailedError("bad file")))
    warnings: list[Diagnostic] = []

    _, library = converters._read_hwp_body(Path("x.hwp"), warnings)

    assert library == "pyhwp2md"
    assert [w.code for w in warnings] == ["hwp_kordoc_failed"]


def test_두_파서가_다_실패하면_감추지_않고_올린다(patched, monkeypatch):
    patched(_Bridge(error=kordoc.KordocFailedError("bad file")))

    def boom(_path):
        raise converters.pyhwp2md.Pyhwp2mdError("corrupt")

    monkeypatch.setattr(converters.pyhwp2md, "convert", boom)

    with pytest.raises(converters.ConversionFailedError):
        converters._read_hwp_body(Path("x.hwp"), [])


def test_쓴_파서_이름이_결과에_남는다(patched):
    """어느 파서로 읽었는지 보이지 않으면 표 유실을 나중에 추적할 수 없다."""
    patched(_Bridge(markdown="본문"))
    warnings: list[Diagnostic] = []

    result = converters._convert_hwp(Path("x.hwp"), ".hwp", warnings)

    assert result.library_used == "kordoc"
