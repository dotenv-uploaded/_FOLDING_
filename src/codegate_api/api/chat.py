from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, Depends, Header

from codegate_api.dependencies import get_access_context, get_knowledge_repository
from codegate_api.knowledge.access import AccessContext
from codegate_api.knowledge.repository import KnowledgeRepository
from codegate_api.models import (
    ApiError,
    ChatMessageRequest,
    ChatMessageResponse,
    ResponseType,
)

router = APIRouter(tags=["chat"])


@router.post("/chat/messages", response_model=ChatMessageResponse)
def create_message(
    request: ChatMessageRequest,
    repository: Annotated[KnowledgeRepository, Depends(get_knowledge_repository)],
    access_context: Annotated[AccessContext, Depends(get_access_context)],
    idempotency_key: Annotated[str | None, Header()] = None,
) -> ChatMessageResponse:
    del idempotency_key  # Persistence and deduplication start in the approval phase.
    documents = repository.search(request.message, access_context=access_context)
    if not documents:
        return ChatMessageResponse(
            conversation_id=request.conversation_id,
            message_id=f"msg_{uuid4().hex}",
            response_type=ResponseType.ERROR,
            assistant_text="관련 문서를 찾지 못했습니다.",
            documents=[],
            error=ApiError(
                code="DOCUMENT_NOT_FOUND",
                message="검색어와 일치하는 근거 청크가 없습니다.",
            ),
        )

    return ChatMessageResponse(
        conversation_id=request.conversation_id,
        message_id=f"msg_{uuid4().hex}",
        response_type=ResponseType.LOCATION_RESULT,
        assistant_text="관련 문서와 근거를 찾았습니다.",
        documents=documents,
    )
