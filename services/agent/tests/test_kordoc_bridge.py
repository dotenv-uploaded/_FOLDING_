"""한글(HWP/HWPX) 수정 경로.

여기서 지키는 약속은 셋이다.

1. 안전 검사를 우회하지 않는다 — 검사 대상이 "파일의 텍스트"에서 "파일에서 뽑아낸
   마크다운"으로 바뀔 뿐, 앵커 유일성·해시 대조·승인 게이트는 그대로 돈다.
2. 부분 반영을 남기지 않는다 — kordoc 이 `skipped[]` 로 못 고친 곳을 알려 주면 실패로
   올린다. 승인했는데 원본이 그대로인 상태가 가장 나쁘다.
3. 서식을 보존한다 — 텍스트만 갈아끼우고 표·스타일은 건드리지 않는다.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from codegate_api.changes.kordoc import KordocBridge, KordocError, is_hwp


class TestIsHwp:
    @pytest.mark.parametrize(
        "uri",
        [
            "source://계약서.hwp",
            "source://folder/보고서.HWPX",
            "source://a/b/c.hwp",
        ],
    )
    def test_한글_확장자를_알아본다(self, uri: str) -> None:
        assert is_hwp(uri) is True

    @pytest.mark.parametrize(
        "uri",
        [
            "source://notes.md",
            "source://a.txt",
            "source://report.pdf",
            "source://hwp",  # 확장자가 아니라 파일명일 뿐
        ],
    )
    def test_나머지는_기존_텍스트_경로로_보낸다(self, uri: str) -> None:
        assert is_hwp(uri) is False


class TestSkippedIsNeverSilent:
    """`skipped[]` 가 있으면 반드시 실패한다 — 조용히 일부만 반영하지 않는다."""

    def test_skipped_가_있으면_실패로_올린다(self) -> None:
        bridge = KordocBridge()
        bridge._run = lambda payload: {  # type: ignore[method-assign]
            "ok": True,
            "skipped": ["표 구조 변경은 지원하지 않음"],
            "patched_b64": "AAAA",
        }

        with pytest.raises(KordocError) as caught:
            bridge.patch(b"original", "edited", "source://a.hwp")

        assert caught.value.code == "HWP_PARTIAL_PATCH"
        # 사용자가 다음에 뭘 해야 하는지 문장으로 말해야 한다.
        assert "직접 고쳐" in str(caught.value)

    def test_성공했다고만_하고_바이트가_없으면_실패다(self) -> None:
        bridge = KordocBridge()
        bridge._run = lambda payload: {"ok": True, "skipped": [], "patched_b64": None}  # type: ignore[method-assign]

        with pytest.raises(KordocError) as caught:
            bridge.patch(b"original", "edited", "source://a.hwp")
        assert caught.value.code == "HWP_PATCH_FAILED"

    def test_본문을_못_읽으면_빈_마크다운으로_넘기지_않는다(self) -> None:
        bridge = KordocBridge()
        bridge._run = lambda payload: {"ok": True, "markdown": "   "}  # type: ignore[method-assign]

        with pytest.raises(KordocError) as caught:
            bridge.to_markdown(b"original")
        assert caught.value.code == "HWP_PARSE_FAILED"


class TestNodeMissing:
    def test_node_가_없으면_이유를_말한다(self) -> None:
        bridge = KordocBridge(node_path="/nonexistent/node")
        with pytest.raises(KordocError) as caught:
            bridge.to_markdown(b"x")
        assert caught.value.code == "KORDOC_UNAVAILABLE"
        assert "Node" in str(caught.value)


def _node_available() -> bool:
    return shutil.which("node") is not None


FIXTURE = Path(__file__).parent / "fixtures" / "sample.hwp"


@pytest.mark.skipif(not _node_available(), reason="Node 가 필요하다")
@pytest.mark.skipif(not FIXTURE.exists(), reason="한글 fixture 가 필요하다")
class TestRealRoundTrip:
    """실물 한글 파일로 도는 검증. kordoc 을 내려받으므로 네트워크가 필요하다."""

    def test_텍스트를_바꾸고_다시_읽으면_반영돼_있다(self) -> None:
        bridge = KordocBridge()
        original = FIXTURE.read_bytes()

        markdown = bridge.to_markdown(original)
        anchor = next(
            (word for word in ("하드사이언스", "계약자", "계약") if word in markdown), None
        )
        assert anchor is not None, "fixture 에서 바꿀 앵커를 찾지 못했다"

        edited = markdown.replace(anchor, "테스트치환어")
        outcome = bridge.patch(original, edited, "source://sample.hwp")

        assert outcome.skipped == []
        # 다시 읽어 반영을 확인한다 — 바이트만 바뀌고 파싱이 깨지면 안 된다.
        assert "테스트치환어" in bridge.to_markdown(outcome.content)
