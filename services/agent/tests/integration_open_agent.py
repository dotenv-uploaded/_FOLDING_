"""열린 에이전트 스트림 — 승인 게이트가 실제 도구를 가로채는지.

진짜 Claude Agent SDK 를 부르고 진짜 파일을 만든다(비용 발생). 기본은 꺼 둔다:

    CODEGATE_OPEN_AGENT_INTEGRATION=1 ANTHROPIC_API_KEY=... \
      .venv/bin/python -m pytest tests/integration_open_agent.py -q

이 테스트가 지키는 것: 도구가 실행 **전에** 승인 이벤트로 잡히고, 승인하면 실행되고,
거부하면 막힌다. 게이트가 양방향으로 동작하는지가 열린 에이전트의 전부다.
"""

import os
import tempfile
from pathlib import Path

import anyio
import pytest

from codegate_api.agent.approvals import ApprovalRegistry
from codegate_api.agent.stream import run_open_agent
from codegate_api.files.resolver import SourceUriResolver
from codegate_api.knowledge.access import AccessContext
from codegate_api.knowledge.repository import KnowledgeRepository

enabled = os.environ.get("CODEGATE_OPEN_AGENT_INTEGRATION") == "1"


def _repository() -> KnowledgeRepository:
    return KnowledgeRepository(
        Path("demo/llm-wiki"),
        SourceUriResolver(Path("demo/source")),
    )


async def _run(approve: bool) -> bool:
    with tempfile.TemporaryDirectory() as cwd, tempfile.TemporaryDirectory() as cfg:
        registry = ApprovalRegistry(timeout_seconds=60)
        saw_approval = {"v": False}
        async for ev in run_open_agent(
            prompt="Use the Write tool to create note.txt containing 'gate' then say done.",
            registry=registry,
            repository=_repository(),
            access_context=AccessContext.anonymous(),
            working_directory=Path(cwd),
            state_directory=Path(cfg),
            model=None,
            resume_session_id=None,
            timeout_seconds=90,
        ):
            if ev["type"] == "approval":
                saw_approval["v"] = True
                assert ev["tool"] == "Write"
                assert ev["risk"] == "caution"
                registry.resolve(ev["approval_id"], approve)
        # 승인은 도구가 실행 전에 잡혀야 성립한다.
        assert saw_approval["v"], "승인 이벤트가 나오지 않았다 — 게이트가 도구를 못 잡았다"
        return (Path(cwd) / "note.txt").exists()


@pytest.mark.skipif(not enabled, reason="CODEGATE_OPEN_AGENT_INTEGRATION=1 로 켠다")
def test_승인하면_파일이_만들어진다():
    assert anyio.run(_run, True) is True


@pytest.mark.skipif(not enabled, reason="CODEGATE_OPEN_AGENT_INTEGRATION=1 로 켠다")
def test_거부하면_파일이_만들어지지_않는다():
    assert anyio.run(_run, False) is False
