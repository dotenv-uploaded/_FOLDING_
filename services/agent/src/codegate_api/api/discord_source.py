from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status

from codegate_api.container import AppContainer
from codegate_api.dependencies import get_access_context, get_container
from codegate_api.integrations.discord_source import DiscordSourceConnector, ProjectionResult
from codegate_api.knowledge.access import AccessContext
from codegate_api.models import (
    DiscordBackfillResponse,
    DiscordContextResponse,
    DiscordExportResponse,
    DiscordProjectionResponse,
    DiscordSourceStatusResponse,
)

router = APIRouter(prefix="/knowledge/sources/discord", tags=["discord-source"])


def _connector(container: AppContainer) -> DiscordSourceConnector:
    connector = container.discord_source
    if connector is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "NOT_FOUND", "message": "Discord source is not enabled."},
        )
    return connector


def _require_operator(access_context: AccessContext) -> None:
    if access_context.subject_id is None or not access_context.provisioned:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "DISCORD_SOURCE_OPERATOR_REQUIRED",
                "message": "A provisioned workspace operator is required.",
            },
        )


def _projection_response(
    projection: ProjectionResult,
    knowledge_version: str,
) -> DiscordProjectionResponse:
    return DiscordProjectionResponse(
        status="projected",
        changed=projection.changed,
        event_count=projection.event_count,
        document_ids=list(projection.document_ids),
        fragment_files=list(projection.fragment_files),
        raw_files=list(projection.raw_files),
        knowledge_version=knowledge_version,
    )


@router.get("/status", response_model=DiscordSourceStatusResponse)
async def source_status(
    access_context: Annotated[AccessContext, Depends(get_access_context)],
    container: Annotated[AppContainer, Depends(get_container)],
) -> DiscordSourceStatusResponse:
    del access_context
    connector = _connector(container)
    current = connector.status()
    gateway = container.discord_gateway
    return DiscordSourceStatusResponse(
        enabled=True,
        guild_id=current.guild_id,
        allowed_channels=list(current.allowed_channels),
        event_count=current.event_count,
        projected_documents=list(current.projected_documents),
        last_knowledge_version=current.last_knowledge_version,
        gateway_enabled=gateway is not None,
        gateway_running=gateway.running if gateway is not None else False,
        gateway_error=gateway.error if gateway is not None else None,
    )


@router.post("/backfill", response_model=DiscordBackfillResponse)
async def backfill(
    access_context: Annotated[AccessContext, Depends(get_access_context)],
    container: Annotated[AppContainer, Depends(get_container)],
) -> DiscordBackfillResponse:
    _require_operator(access_context)
    inserted, projection, version = await _connector(container).backfill()
    response = _projection_response(projection, version)
    return DiscordBackfillResponse(**response.model_dump(), inserted_events=inserted)


@router.post("/project", response_model=DiscordProjectionResponse)
async def project(
    access_context: Annotated[AccessContext, Depends(get_access_context)],
    container: Annotated[AppContainer, Depends(get_container)],
) -> DiscordProjectionResponse:
    _require_operator(access_context)
    projection, version = await _connector(container).flush(force_rebuild=True)
    return _projection_response(projection, version)


@router.get("/context", response_model=DiscordContextResponse)
async def context(
    access_context: Annotated[AccessContext, Depends(get_access_context)],
    container: Annotated[AppContainer, Depends(get_container)],
    query: Annotated[str, Query(min_length=1, max_length=1_000)],
    limit: Annotated[int, Query(ge=1, le=20)] = 5,
) -> DiscordContextResponse:
    documents = _connector(container).search(
        query,
        access_context=access_context,
        top_k=limit,
    )
    return DiscordContextResponse(query=query, documents=documents)


@router.get("/export", response_model=DiscordExportResponse)
async def export_markdown(
    access_context: Annotated[AccessContext, Depends(get_access_context)],
    container: Annotated[AppContainer, Depends(get_container)],
) -> DiscordExportResponse:
    del access_context
    return DiscordExportResponse(content=_connector(container).export_markdown())
