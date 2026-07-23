"""수동 재빌드.

왜 있는가
---------
자동 경로(`process_pending`)는 *승인된 문서 편집* 만 활성 빌드에 반영한다. 그래서 문서
편집이 아닌 변화 — 새로 만든 요약, watchdog 가 놓친 파일 수정 — 는 반영될 길이 없었다.
실제로 배경에서 만든 요약 14개가 캐시에만 쌓이고 활성 빌드는 4개인 채 남았다. 빌드가
완료됐는데 반영 안 된 캐시가 있는 상태는 그 자체로 모순이다.

이 엔드포인트는 그 탈출구다. staleness 를 추측하지 않는다 — 재빌드를 요청받으면
현재 입력과 요약으로 새 빌드를 만들어 활성화한다.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status

from codegate_api.container import AppContainer
from codegate_api.dependencies import get_access_context, get_container
from codegate_api.knowledge.access import AccessContext
from codegate_api.knowledge.llmwiki import NativeLLMWikiPipeline
from codegate_api.models import KnowledgeRebuildResponse

router = APIRouter(tags=["knowledge"])


@router.post("/knowledge/rebuild", response_model=KnowledgeRebuildResponse)
async def rebuild_knowledge(
    access_context: Annotated[AccessContext, Depends(get_access_context)],
    container: Annotated[AppContainer, Depends(get_container)],
) -> KnowledgeRebuildResponse:
    del access_context  # 인증은 의존성에서 이미 강제된다
    pipeline = container.pipeline
    if not isinstance(pipeline, NativeLLMWikiPipeline):
        # LLMWIKI 모드에만 있는 기능이다. "됐다"고 답하고 아무 일도 안 하지 않는다.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "code": "NOT_FOUND",
                "message": "이 지식 모드에서는 수동 재빌드를 지원하지 않습니다.",
            },
        )
    version = await pipeline.rebuild()
    return KnowledgeRebuildResponse(status="rebuilt", knowledge_version=version)
