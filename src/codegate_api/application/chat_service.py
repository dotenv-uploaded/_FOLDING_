from __future__ import annotations

import asyncio
from uuid import uuid4

from codegate_api.agent.gateway import AgentGateway, AgentGatewayError
from codegate_api.changes.hashing import request_hash
from codegate_api.changes.service import ChangePlanService, ChangeServiceError
from codegate_api.knowledge.access import AccessContext
from codegate_api.knowledge.repository import KnowledgeRepository
from codegate_api.models import (
    ApiError,
    ChatMessageRequest,
    ChatMessageResponse,
    DocumentResult,
    ResponseType,
)
from codegate_api.state.store import StateStore


class ChatService:
    def __init__(
        self,
        *,
        agent: AgentGateway,
        plans: ChangePlanService,
        state: StateStore,
    ) -> None:
        self._agent = agent
        self._plans = plans
        self._state = state
        self._conversation_locks: dict[str, asyncio.Lock] = {}
        self._lock_guard = asyncio.Lock()

    async def create_message(
        self,
        *,
        request: ChatMessageRequest,
        repository: KnowledgeRepository,
        access_context: AccessContext,
        idempotency_key: str | None = None,
    ) -> ChatMessageResponse:
        owner_key = (
            f"{access_context.tenant_id or 'public'}:"
            f"{access_context.subject_id or 'anonymous'}:{request.conversation_id}"
        )
        async with self._lock_guard:
            conversation_lock = self._conversation_locks.setdefault(owner_key, asyncio.Lock())
        async with conversation_lock:
            tenant_id = access_context.tenant_id or "public"
            subject_id = access_context.subject_id or "anonymous"
            digest = request_hash(request.model_dump(mode="json"))
            if idempotency_key:
                replay = self._state.get_chat_idempotency(
                    tenant_id=tenant_id,
                    subject_id=subject_id,
                    key=idempotency_key,
                    request_hash=digest,
                )
                if replay is not None:
                    return ChatMessageResponse.model_validate_json(replay)
            response = await self._create_serialized(
                request=request,
                repository=repository,
                access_context=access_context,
            )
            if idempotency_key:
                self._state.put_chat_idempotency(
                    tenant_id=tenant_id,
                    subject_id=subject_id,
                    key=idempotency_key,
                    request_hash=digest,
                    response_json=response.model_dump_json(),
                )
            return response

    async def _create_serialized(
        self,
        *,
        request: ChatMessageRequest,
        repository: KnowledgeRepository,
        access_context: AccessContext,
    ) -> ChatMessageResponse:
        tenant_id = access_context.tenant_id or "public"
        subject_id = access_context.subject_id or "anonymous"
        user_message_id = f"msg_{uuid4().hex}"
        assistant_message_id = f"msg_{uuid4().hex}"
        run_id = f"run_{uuid4().hex}"
        authenticated = access_context.subject_id is not None
        if authenticated:
            self._state.record_message(
                conversation_id=request.conversation_id,
                tenant_id=tenant_id,
                subject_id=subject_id,
                message_id=user_message_id,
                role="user",
                content=request.message,
            )
            self._state.record_agent_run(
                run_id=run_id,
                conversation_id=request.conversation_id,
                tenant_id=tenant_id,
                subject_id=subject_id,
                status="running",
                provider=type(self._agent).__name__,
            )
        resume_session_id = (
            self._state.latest_agent_session(
                conversation_id=request.conversation_id,
                tenant_id=tenant_id,
                subject_id=subject_id,
            )
            if authenticated
            else None
        )
        try:
            result = await self._agent.decide(
                message=request.message,
                selected_document_id=request.selected_document_id,
                conversation_id=request.conversation_id,
                repository=repository,
                access_context=access_context,
                resume_session_id=resume_session_id,
            )
        except AgentGatewayError as error:
            if authenticated:
                self._state.record_agent_run(
                    run_id=run_id,
                    conversation_id=request.conversation_id,
                    tenant_id=tenant_id,
                    subject_id=subject_id,
                    status="failed",
                    provider=type(self._agent).__name__,
                    error_code=error.code,
                )
            response = _error_response(
                request.conversation_id,
                assistant_message_id,
                code=error.code,
                message=str(error),
            )
            self._record_assistant(response, tenant_id, subject_id)
            return response

        if authenticated:
            self._state.record_agent_run(
                run_id=run_id,
                conversation_id=request.conversation_id,
                tenant_id=tenant_id,
                subject_id=subject_id,
                status="succeeded",
                provider=result.provider,
                session_id=result.session_id,
            )
        decision = result.decision
        documents = repository.search(
            decision.search_query,
            access_context=access_context,
        )
        if decision.intent == "locate":
            response = self._location_response(
                request=request,
                message_id=assistant_message_id,
                repository=repository,
                access_context=access_context,
                documents=documents,
                assistant_text=decision.assistant_text,
                target_document_id=decision.target_document_id,
            )
            self._record_assistant(response, tenant_id, subject_id)
            return response

        if decision.operation is None:
            response = _error_response(
                request.conversation_id,
                assistant_message_id,
                code="CHANGE_DETAILS_REQUIRED",
                message="변경 전 텍스트와 변경 후 텍스트를 명확히 적어주세요.",
            )
            self._record_assistant(response, tenant_id, subject_id)
            return response
        if access_context.subject_id is None:
            response = _error_response(
                request.conversation_id,
                assistant_message_id,
                code="AUTHENTICATION_REQUIRED",
                message="문서 변경 미리보기는 로그인이 필요합니다.",
            )
            self._record_assistant(response, tenant_id, subject_id)
            return response

        target_id = request.selected_document_id or decision.target_document_id
        writable_candidates = [document for document in documents if document.can_write]
        if target_id is None:
            if len(writable_candidates) != 1:
                response = ChatMessageResponse(
                    conversation_id=request.conversation_id,
                    message_id=assistant_message_id,
                    response_type=ResponseType.TARGET_SELECTION,
                    assistant_text="수정할 문서를 선택해주세요.",
                    documents=writable_candidates,
                )
                self._record_assistant(response, tenant_id, subject_id)
                return response
            target_id = writable_candidates[0].document_id
        elif request.selected_document_id is None and target_id not in {
            document.document_id for document in writable_candidates
        }:
            response = _error_response(
                request.conversation_id,
                assistant_message_id,
                code="DOCUMENT_NOT_FOUND",
                message="검색 근거 안에서 수정 가능한 대상을 찾지 못했습니다.",
            )
            self._record_assistant(response, tenant_id, subject_id)
            return response

        try:
            plan = self._plans.create_plan(
                repository=repository,
                access_context=access_context,
                document_id=target_id,
                operation=decision.operation,
                request_text=request.message,
            )
        except ChangeServiceError as error:
            response = _error_response(
                request.conversation_id,
                assistant_message_id,
                code=error.code,
                message=str(error),
            )
            self._record_assistant(response, tenant_id, subject_id)
            return response
        document = repository.get(target_id, access_context=access_context)
        response = ChatMessageResponse(
            conversation_id=request.conversation_id,
            message_id=assistant_message_id,
            response_type=ResponseType.CHANGE_PREVIEW,
            assistant_text="아래 diff를 확인한 뒤 정확한 plan_hash로 승인해주세요.",
            documents=[document] if document is not None else [],
            change_plan=plan,
        )
        self._record_assistant(response, tenant_id, subject_id)
        return response

    def _location_response(
        self,
        *,
        request: ChatMessageRequest,
        message_id: str,
        repository: KnowledgeRepository,
        access_context: AccessContext,
        documents: list[DocumentResult],
        assistant_text: str,
        target_document_id: str | None,
    ) -> ChatMessageResponse:
        if target_document_id:
            target = repository.get(target_document_id, access_context=access_context)
            if target is not None:
                documents = [
                    target,
                    *[item for item in documents if item.document_id != target_document_id],
                ]
        if not documents:
            return _error_response(
                request.conversation_id,
                message_id,
                code="DOCUMENT_NOT_FOUND",
                message="검색어와 일치하는 근거 청크가 없습니다.",
            )
        del assistant_text
        evidence_lines = [
            f"- {evidence.quote} {document.citations[index]}"
            for document in documents
            for index, evidence in enumerate(document.evidence)
        ]
        return ChatMessageResponse(
            conversation_id=request.conversation_id,
            message_id=message_id,
            response_type=ResponseType.LOCATION_RESULT,
            assistant_text="검증된 원문 근거입니다.\n\n" + "\n".join(evidence_lines),
            documents=documents,
        )

    def _record_assistant(
        self,
        response: ChatMessageResponse,
        tenant_id: str,
        subject_id: str,
    ) -> None:
        if tenant_id == "public" and subject_id == "anonymous":
            return
        self._state.record_message(
            conversation_id=response.conversation_id,
            tenant_id=tenant_id,
            subject_id=subject_id,
            message_id=response.message_id,
            role="assistant",
            content=response.assistant_text,
            response_type=response.response_type.value,
            metadata={
                "document_ids": [document.document_id for document in response.documents],
                "change_plan_id": (
                    response.change_plan.change_plan_id
                    if response.change_plan is not None
                    else None
                ),
                "error_code": response.error.code if response.error is not None else None,
            },
        )


def _error_response(
    conversation_id: str,
    message_id: str,
    *,
    code: str,
    message: str,
) -> ChatMessageResponse:
    return ChatMessageResponse(
        conversation_id=conversation_id,
        message_id=message_id,
        response_type=ResponseType.ERROR,
        assistant_text=message,
        documents=[],
        error=ApiError(code=code, message=message),
    )
