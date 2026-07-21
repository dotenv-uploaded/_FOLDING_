from typing import Annotated

from fastapi import APIRouter, Depends

from codegate_api.dependencies import get_knowledge_repository
from codegate_api.knowledge.repository import KnowledgeRepository
from codegate_api.models import HealthResponse

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse)
def health(
    repository: Annotated[KnowledgeRepository, Depends(get_knowledge_repository)],
) -> HealthResponse:
    return HealthResponse(
        status="ok",
        knowledge_version=repository.version,
        converter_available=False,
        graph_available=True,
        agent_available=False,
    )
