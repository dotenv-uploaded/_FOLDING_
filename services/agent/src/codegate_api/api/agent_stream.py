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

import re

from fastapi import APIRouter, Depends, HTTPException
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


#: 승인 대기를 스트림 전체 타임아웃보다 이만큼 일찍 끝낸다(초).
#:
#: 두 값이 같으면 "무응답 = 거부" 가 성립하지 않는다 — 승인이 거부로 풀리기 전에 스트림이
#: 먼저 죽어서, 사용자는 거부되었다는 사실 대신 타임아웃 오류만 본다. 먼저 거부로 풀려야
#: 에이전트가 "승인되지 않아 실행하지 않았다"고 제대로 말하고 끝낼 수 있다.
_APPROVAL_TIMEOUT_MARGIN_SECONDS = 60

#: 사람이 창을 보고 누르기에 최소한 필요한 시간(초).
_APPROVAL_TIMEOUT_FLOOR_SECONDS = 30


def _approval_timeout(stream_timeout_seconds: float) -> float:
    return max(
        _APPROVAL_TIMEOUT_FLOOR_SECONDS,
        stream_timeout_seconds - _APPROVAL_TIMEOUT_MARGIN_SECONDS,
    )


def _canonical_state_id(conversation_id: str) -> str:
    """대화 id 를 디렉터리 이름으로 쓸 수 있게 다듬는다.

    id 는 클라이언트가 정하므로 `../` 같은 것이 들어올 수 있다. 경로를 벗어나는 문자를
    남겨 두면 설정 디렉터리가 엉뚱한 곳에 생긴다 — 안전한 문자만 남기고, 비면 거부한다
    (호출부가 `is_relative_to` 로 한 번 더 확인한다).
    """
    cleaned = re.sub(r"[^A-Za-z0-9_-]", "_", conversation_id).strip("_")
    return cleaned or "default"


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
        timeout_seconds=_approval_timeout(container.settings.claude_timeout_seconds),
    )
    # 상태 디렉터리는 **대화 단위**로 잡는다 — 요청마다가 아니다.
    #
    # 이 경로는 `CLAUDE_CONFIG_DIR` 이 된다. 요청마다 새 uuid 로 만들면 매번 빈 설정
    # 디렉터리가 생기고, CLI 가 그때마다 첫 실행 초기화를 하느라 connect 가 몇 분씩
    # 걸린다(실제로 그래서 스트림이 빈 채로 끝나 보였다). 대화 id 로 고정하면 재사용되어
    # 빠르고, 같은 대화의 맥락도 이어진다.
    state_root = container.settings.resolved_agent_state_root()
    state_directory = (state_root / _canonical_state_id(request.conversation_id)).resolve()
    if not state_directory.is_relative_to(state_root):
        raise HTTPException(
            status_code=400,
            detail={"code": "AGENT_SESSION_INVALID", "message": "대화 경로가 유효하지 않습니다."},
        )

    # 앞 턴의 세션을 이어받는다. 이걸 넘기지 않으면 매 요청이 새 대화가 되어, 방금
    # 자기가 만든 파일조차 기억하지 못한다.
    resume_session_id = container.agent_sessions.get(request.conversation_id)

    async def body() -> AsyncIterator[str]:
        try:
            async for event in run_open_agent_threaded(
                prompt=request.message,
                registry=registry,
                repository=repository,
                access_context=access_context,
                working_directory=container.settings.resolved_source_root(),
                state_directory=state_directory,
                model=container.settings.claude_model,
                resume_session_id=resume_session_id,
                timeout_seconds=container.settings.claude_timeout_seconds,
            ):
                if event.get("type") == "done":
                    container.agent_sessions.remember(
                        request.conversation_id, event.get("session_id")
                    )
                elif event.get("type") == "error" and resume_session_id is not None:
                    # 이어 붙이기가 실패했을 수 있다(세션이 만료·삭제됨). 기억을 지워
                    # 다음 턴은 새 대화로 깨끗하게 시작하게 한다 — 안 지우면 같은 실패를
                    # 영원히 반복한다.
                    container.agent_sessions.forget(request.conversation_id)
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
