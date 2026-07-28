"""rhwp 다리 통합 테스트 — 사이드카(Python) → Node 워커 → @rhwp/core WASM.

실제 Node·@rhwp/core·(선택) 실제 .hwp 양식이 필요하므로 기본은 꺼 둔다:

    CODEGATE_RHWP_INTEGRATION=1 \
    CODEGATE_RHWP_ROOT=/path/to/dir-with-node_modules-@rhwp-core \
    [CODEGATE_RHWP_FIXTURE=/path/to/일일업무.hwp] \
      .venv/bin/python -m pytest tests/integration_rhwp.py -q

이 테스트가 지키는 것: 다리가 살아 있고(ping→버전), 실제 양식이 주어지면 빈 칸을 채운 뒤
**재파싱 검증**이 통과하며 값이 실제로 파일에 남는다.
"""

from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

import pytest

from codegate_api.agent.rhwp import RhwpWorkerClient

enabled = os.environ.get("CODEGATE_RHWP_INTEGRATION") == "1"
node_bin = shutil.which("node")
rhwp_root = os.environ.get("CODEGATE_RHWP_ROOT")
fixture = os.environ.get("CODEGATE_RHWP_FIXTURE")

_reason = "CODEGATE_RHWP_INTEGRATION=1 · node · CODEGATE_RHWP_ROOT 로 켠다"
_ready = enabled and node_bin is not None and rhwp_root is not None


def _client(staging: Path) -> RhwpWorkerClient:
    return RhwpWorkerClient(
        node_bin=Path(node_bin),
        worker_script=Path(__file__).resolve().parent.parent / "native" / "rhwp" / "rhwp_worker.mjs",
        staging_root=staging,
        rhwp_root=Path(rhwp_root),
    )


@pytest.mark.skipif(not _ready, reason=_reason)
def test_다리가_살아있다_ping():
    with tempfile.TemporaryDirectory() as stage:
        client = _client(Path(stage))
        try:
            version = client.ping()
            assert version and version != "?"
        finally:
            client.close()


@pytest.mark.skipif(not (_ready and fixture), reason=_reason + " + CODEGATE_RHWP_FIXTURE")
def test_빈칸을_채우고_재파싱으로_검증한다():
    with tempfile.TemporaryDirectory() as stage:
        stage_path = Path(stage)
        shutil.copy(fixture, stage_path / "src.hwp")
        client = _client(stage_path)
        try:
            structure = client.read_structure("src.hwp")
            empty = [c["cellIndex"] for c in structure["cells"] if not c["text"]]
            assert empty, "채울 빈 칸이 있어야 한다"

            targets = empty[:2]
            values = {i: f"검증값-{i}" for i in targets}
            result = client.fill("src.hwp", "out.hwp", values)
            assert result["verified"] is True
            assert set(result["filled"]) == set(targets)

            # 워커와 별개로 다시 읽어 실제 반영을 확인한다.
            again = client.read_structure("out.hwp")
            got = {c["cellIndex"]: c["text"] for c in again["cells"]}
            for i in targets:
                assert f"검증값-{i}" in got.get(i, "")
        finally:
            client.close()
