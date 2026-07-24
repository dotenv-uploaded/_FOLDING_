"""열린 에이전트의 스트리밍 + 승인 엔드포인트.

    POST /api/v1/agent/stream            SSE — 텍스트·도구·승인요청·완료를 흘린다
    POST /api/v1/agent/approvals/{id}    사용자의 승인/거부를 대기소에 전달한다

왜 두 경로인가
-------------
승인 요청은 스트림으로 **나가고**, 사용자의 답은 별도 요청으로 **돌아온다.** 한 요청으로
왕복할 수 없다 — 스트림은 답을 기다리는 동안 열려 있어야 하기 때문이다. 그래서 스트림이
승인 대기소를 허브에 등록해 두고, resolve 엔드포인트가 그 허브를 통해 같은 대기소에 닿는다.
"""

from __future__ import annotations

import json
from typing import Annotated, AsyncIterator
from uuid import uuid4

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from codegate_api.agent.stream import run_open_agent_threaded
from codegate_api.container import AppContainer
from codegate_api.dependencies import (
    get_access_context,
    get_container,
    get_knowledge_repository,
)
from codegate_api.knowledge.access import AccessContext
from codegate_api.knowledge.repository import KnowledgeRepository
from codegate_api.models import ChatMessageRequest, StrictModel

router = APIRouter(tags=["agent"])


class ApprovalDecisionRequest(StrictModel):
    approved: bool


def _sse(event: dict[str, object]) -> str:
    """한 이벤트를 SSE 한 줄로. `data:` 뒤 JSON, 빈 줄로 끝맺음."""
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


@router.post("/agent/stream")
async def stream_agent(
    request: ChatMessageRequest,
    repository: Annotated[KnowledgeRepository, Depends(get_knowledge_repository)],
    access_context: Annotated[AccessContext, Depends(get_access_context)],
    container: Annotated[AppContainer, Depends(get_container)],
) -> StreamingResponse:
    stream_id = f"stream_{uuid4().hex}"
    registry = container.approval_hub.open(
        stream_id,
        timeout_seconds=container.settings.claude_timeout_seconds,
    )

    async def body() -> AsyncIterator[str]:
        try:
            async for event in run_open_agent_threaded(
                prompt=request.message,
                registry=registry,
                repository=repository,
                access_context=access_context,
                working_directory=container.settings.resolved_source_root(),
                state_directory=container.settings.resolved_agent_state_root() / stream_id,
                model=container.settings.claude_model,
                resume_session_id=None,
                timeout_seconds=container.settings.claude_timeout_seconds,
            ):
                yield _sse(event)
        finally:
            # 스트림이 끝나거나 끊기면 대기소를 뗀다 — 남은 승인 대기를 거부로 풀어 준다.
            container.approval_hub.close(stream_id)

    return StreamingResponse(
        body(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/agent/approvals/{approval_id}")
async def resolve_approval(
    approval_id: str,
    request: ApprovalDecisionRequest,
    container: Annotated[AppContainer, Depends(get_container)],
    access_context: Annotated[AccessContext, Depends(get_access_context)],
) -> dict[str, bool]:
    del access_context  # 인증은 의존성에서 강제된다
    # 없는/이미 끝난 id 는 조용히 False — 늦게 눌렀거나 두 번 눌러도 터지지 않는다.
    delivered = container.approval_hub.resolve(approval_id, request.approved)
    return {"delivered": delivered}
