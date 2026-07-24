"""도구 승인 대기소.

여기가 틀리면 두 방향으로 위험하다: 답을 못 받았는데 통과시키거나(되돌릴 수 없는 작업이
무감독 실행), 답을 받았는데 안 풀리거나(에이전트가 영원히 멈춤). 둘 다 막는다.
"""

import anyio

from codegate_api.agent.approvals import ApprovalRegistry
from codegate_api.agent.tool_risk import ToolRisk


def test_승인하면_허용으로_풀린다():
    async def scenario():
        reg = ApprovalRegistry()
        p = reg.create(tool_name="Bash", risk=ToolRisk.CAUTION, reason=None, summary="ls")

        async def approve():
            await anyio.sleep(0.01)
            reg.resolve(p.approval_id, True)

        async with anyio.create_task_group() as tg:
            tg.start_soon(approve)
            return await reg.wait(p.approval_id)

    assert anyio.run(scenario) is True


def test_거부하면_거부로_풀린다():
    async def scenario():
        reg = ApprovalRegistry()
        p = reg.create(tool_name="Bash", risk=ToolRisk.DANGER, reason="rm", summary="rm -rf x")
        async with anyio.create_task_group() as tg:
            tg.start_soon(_later, lambda: reg.resolve(p.approval_id, False))
            return await reg.wait(p.approval_id)

    assert anyio.run(scenario) is False


def test_답을_못_받으면_거부로_친다():
    # 되돌릴 수 없는 작업 앞에서 답 없이 통과시키지 않는다.
    async def scenario():
        reg = ApprovalRegistry(timeout_seconds=0.05)
        p = reg.create(tool_name="Bash", risk=ToolRisk.DANGER, reason="rm", summary="rm -rf /")
        return await reg.wait(p.approval_id)

    assert anyio.run(scenario) is False


def test_실행이_끝나면_남은_대기를_거부로_푼다():
    async def scenario():
        reg = ApprovalRegistry(timeout_seconds=10)
        p = reg.create(tool_name="Bash", risk=ToolRisk.CAUTION, reason=None, summary="x")
        result = {}

        async def waiter():
            result["v"] = await reg.wait(p.approval_id)

        async with anyio.create_task_group() as tg:
            tg.start_soon(waiter)
            await anyio.sleep(0.01)
            reg.cancel_all()
        return result["v"]

    assert anyio.run(scenario) is False


def test_없는_요청을_결정하면_무시된다():
    reg = ApprovalRegistry()
    assert reg.resolve("appr_없음", True) is False


def test_두_번_결정해도_터지지_않는다():
    async def scenario():
        reg = ApprovalRegistry()
        p = reg.create(tool_name="Read", risk=ToolRisk.SAFE, reason=None, summary="f")
        async with anyio.create_task_group() as tg:
            tg.start_soon(_later, lambda: reg.resolve(p.approval_id, True))
            first = await reg.wait(p.approval_id)
        # 이미 끝난 뒤 다시 눌러도 조용히 무시.
        return first, reg.resolve(p.approval_id, False)

    first, second = anyio.run(scenario)
    assert first is True
    assert second is False


async def _later(fn):
    await anyio.sleep(0.01)
    fn()
