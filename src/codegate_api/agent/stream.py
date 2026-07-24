"""열린 에이전트를 **스트리밍**으로 돌린다.

기존 `AgentGateway.decide` 는 단발이다 — 끝까지 돌아 결정 하나를 뱉는다. 열린 에이전트는
다르다: 도구를 여러 번 쓰고, 그때마다 승인을 받아야 하며, 답은 자유형 텍스트다. 멈춰서
물어보려면 **실행 중간에 이벤트를 흘려보내야** 한다.

실제 SDK 동작으로 검증했다: 텍스트는 `TextBlock`, 도구는 `ToolUseBlock` 으로 오고,
`can_use_tool` 콜백이 도구 실행 **직전에** 발동한다(거부하면 도구가 막힌다).

이 모듈은 SDK 를 자유형으로 돌리며 이벤트를 yield 하는 async generator 다:

    text        답변 텍스트 조각
    tool        도구를 쓰기 시작함(무엇을)
    approval    승인이 필요함 — 앱이 창을 띄우고 resolve 를 부른다
    done        끝. 이번 실행 비용 포함.
    error       실패. 원인 포함.

대기소는 **밖에서 주입**받는다(세션 소유). 그래야 앱의 resolve 요청이 같은 대기소에 닿는다
— 대기소가 이 제너레이터 안에 갇히면 resolve 가 도달할 곳이 없다.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeSDKClient,
    ResultMessage,
    TextBlock,
    ToolUseBlock,
)

from codegate_api.agent.approvals import ApprovalRegistry, PendingApproval
from codegate_api.agent.permission import build_can_use_tool, summarize_tool_input
from codegate_api.agent.runtime import SubprocessStderrTail, build_open_agent_options
from codegate_api.knowledge.access import AccessContext
from codegate_api.knowledge.repository import KnowledgeRepository


async def run_open_agent(
    *,
    prompt: str,
    registry: ApprovalRegistry,
    repository: KnowledgeRepository,
    access_context: AccessContext,
    working_directory: Path,
    state_directory: Path,
    model: str | None,
    resume_session_id: str | None,
    timeout_seconds: float,
) -> AsyncIterator[dict[str, Any]]:
    """열린 에이전트를 돌리며 이벤트를 흘린다.

    `registry` 는 밖에서 소유한다(세션 단위) — 앱의 resolve 가 같은 대기소에 닿아야 한다.
    `can_use_tool` 이 대기소에 요청을 넣으면, 이 루프가 그것을 `approval` 이벤트로 흘린다.
    """
    approval_queue: asyncio.Queue[PendingApproval] = asyncio.Queue()

    def emit_approval(pending: PendingApproval) -> None:
        # 콜백은 큐에 넣기만 한다 — 실제 전송(yield)은 아래 루프가 한다.
        approval_queue.put_nowait(pending)

    can_use_tool = build_can_use_tool(registry, emit_approval)
    stderr_tail = SubprocessStderrTail()
    options = build_open_agent_options(
        repository,
        working_directory=working_directory,
        state_directory=state_directory,
        access_context=access_context,
        can_use_tool=can_use_tool,
        model=model,
        resume=resume_session_id,
        stderr=stderr_tail,
    )

    total_cost: float | None = None
    try:
        async with asyncio.timeout(timeout_seconds):
            async with ClaudeSDKClient(options=options) as client:
                await client.query(prompt)
                response_iter = client.receive_response().__aiter__()
                async for event in _merge(response_iter, approval_queue):
                    if event["kind"] == "approval":
                        pending: PendingApproval = event["value"]
                        yield {
                            "type": "approval",
                            "approval_id": pending.approval_id,
                            "tool": pending.tool_name,
                            "risk": pending.risk.value,
                            "reason": pending.reason,
                            "summary": pending.summary,
                        }
                        continue

                    response = event["value"]
                    if isinstance(response, AssistantMessage):
                        for block in response.content:
                            if isinstance(block, TextBlock) and block.text:
                                yield {"type": "text", "text": block.text}
                            elif isinstance(block, ToolUseBlock):
                                yield {
                                    "type": "tool",
                                    "tool": block.name,
                                    "summary": summarize_tool_input(block.name, block.input),
                                }
                    elif isinstance(response, ResultMessage):
                        total_cost = response.total_cost_usd
        yield {"type": "done", "cost_usd": total_cost}
    except (TimeoutError, asyncio.TimeoutError):
        yield {
            "type": "error",
            "code": "AGENT_TIMEOUT",
            "message": "Claude 응답 시간이 초과되었습니다.",
        }
    except Exception as error:  # noqa: BLE001 - 스트림은 오류도 이벤트로 전한다
        tail = stderr_tail.text()
        yield {
            "type": "error",
            "code": "AGENT_FAILED",
            "message": f"{type(error).__name__}: {error}" + (f"\n{tail}" if tail else ""),
        }
    finally:
        # 남은 승인 대기를 거부로 풀어 준다 — 안 풀면 그 도구 호출이 타임아웃까지 멈춘다.
        registry.cancel_all()


async def _merge(
    response_iter: AsyncIterator[Any],
    approval_queue: asyncio.Queue[PendingApproval],
) -> AsyncIterator[dict[str, Any]]:
    """SDK 응답 스트림과 승인 큐를 하나로 합친다 — 먼저 준비되는 것을 흘린다.

    승인 요청은 `can_use_tool` 이 SDK 처리 도중 큐에 넣으므로, SDK 다음 응답을 기다리는
    동안에도 큐를 함께 지켜봐야 앱이 승인 창을 제때 띄운다.
    """
    response_task: asyncio.Task[Any] | None = None
    queue_task: asyncio.Task[PendingApproval] | None = None
    exhausted = False

    try:
        while True:
            if response_task is None and not exhausted:
                response_task = asyncio.ensure_future(response_iter.__anext__())
            if queue_task is None:
                queue_task = asyncio.ensure_future(approval_queue.get())

            waiters = {t for t in (response_task, queue_task) if t is not None}
            if not waiters:
                return
            done, _ = await asyncio.wait(waiters, return_when=asyncio.FIRST_COMPLETED)

            if queue_task is not None and queue_task in done:
                pending = queue_task.result()
                queue_task = None
                yield {"kind": "approval", "value": pending}

            if response_task is not None and response_task in done:
                try:
                    value = response_task.result()
                    response_task = None
                    yield {"kind": "response", "value": value}
                except StopAsyncIteration:
                    response_task = None
                    exhausted = True
                # SDK 스트림이 끝났고 큐도 비었으면 종료.
                if exhausted and approval_queue.empty():
                    return
    finally:
        for task in (response_task, queue_task):
            if task is not None and not task.done():
                task.cancel()
