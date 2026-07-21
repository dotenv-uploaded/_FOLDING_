from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status

from codegate_api.dependencies import get_access_context, get_knowledge_repository
from codegate_api.knowledge.access import AccessContext
from codegate_api.knowledge.repository import KnowledgeRepository
from codegate_api.models import DocumentResult

router = APIRouter(tags=["documents"])


@router.get("/documents/{document_id}", response_model=DocumentResult)
def get_document(
    document_id: str,
    repository: Annotated[KnowledgeRepository, Depends(get_knowledge_repository)],
    access_context: Annotated[AccessContext, Depends(get_access_context)],
) -> DocumentResult:
    document = repository.get(document_id, access_context=access_context)
    if document is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "DOCUMENT_NOT_FOUND", "message": "문서를 찾을 수 없습니다."},
        )
    return document
