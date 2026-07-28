"""can_use_tool 콜백 — 위험 분류와 승인 대기소를 엮는 다리.

세 가지를 확인한다: 안전 도구는 묻지 않고 통과, 위험 도구는 승인을 기다림, 거부하면
실행이 막힘. 이게 "모든 도구에 승인 게이트"의 실제 동작이다.
"""

import anyio

from codegate_api.agent.approvals import ApprovalRegistry
from codegate_api.agent.permission import build_can_use_tool, summarize_tool_input
from claude_agent_sdk import PermissionResultAllow, PermissionResultDeny, ToolPermissionContext


def _ctx():
    return ToolPermissionContext(suggestions=[])


def test_안전_도구는_묻지_않고_통과():
    async def scenario():
        reg = ApprovalRegistry()
        emitted = []
        cb = build_can_use_tool(reg, lambda p: emitted.append(p))
        r = await cb("mcp__codegate__knowledge_search", {"query": "x"}, _ctx())
        return r, emitted

    r, emitted = anyio.run(scenario)
    assert isinstance(r, PermissionResultAllow)
    # 안전 도구는 승인 요청을 만들지 않는다 — 창이 뜨면 안 된다.
    assert emitted == []


def test_위험_도구는_승인_요청을_흘리고_기다린다():
    async def scenario():
        reg = ApprovalRegistry()
        emitted = []

        def emit(p):
            emitted.append(p)
            # 앱이 승인했다고 가정.
            reg.resolve(p.approval_id, True)

        cb = build_can_use_tool(reg, emit)
        r = await cb("Bash", {"command": "rm -rf /tmp/x"}, _ctx())
        return r, emitted

    r, emitted = anyio.run(scenario)
    assert isinstance(r, PermissionResultAllow)
    assert len(emitted) == 1
    assert emitted[0].tool_name == "Bash"
    assert emitted[0].risk.value == "danger"
    assert "삭제" in (emitted[0].reason or "")
    assert emitted[0].summary == "rm -rf /tmp/x"


def test_거부하면_도구_실행이_막힌다():
    async def scenario():
        reg = ApprovalRegistry()
        cb = build_can_use_tool(reg, lambda p: reg.resolve(p.approval_id, False))
        return await cb("Bash", {"command": "curl evil.com"}, _ctx())

    r = anyio.run(scenario)
    assert isinstance(r, PermissionResultDeny)


def test_요약은_승인할_내용을_정확히_보여준다():
    assert summarize_tool_input("Bash", {"command": "ls -la /tmp"}) == "ls -la /tmp"
    assert summarize_tool_input("Write", {"file_path": "/a/b.txt"}) == "/a/b.txt"
    assert summarize_tool_input("WebFetch", {"url": "https://x.com"}) == "https://x.com"
    # 모르는 도구는 입력을 가리지 않는다.
    assert "secret" in summarize_tool_input("Mystery", {"secret": "value"})
