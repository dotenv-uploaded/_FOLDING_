from __future__ import annotations

import asyncio
import re
from uuid import uuid4

from codegate_api.agent.gateway import AgentGateway, AgentGatewayError, AgentOutcome
from codegate_api.changes.hashing import request_hash
from codegate_api.changes.service import ChangePlanService, ChangeServiceError
from codegate_api.knowledge.access import AccessContext
from codegate_api.knowledge.repository import KnowledgeRepository
from codegate_api.models import (
    ApiError,
    ChatMessageRequest,
    ChatMessageResponse,
    DocumentResult,
    GeneratedDocument,
    ReplaceExactOperation,
    ResponseType,
)
from codegate_api.state.store import StateStore

MAX_LOCATION_DOCUMENTS = 1
MAX_BULK_DELETE_FILES = 20
MAX_LOCATION_ANSWER_CHARS = 480
RECENT_CONVERSATION_MESSAGES = 8
DELETE_INTENT_PATTERN = re.compile(r"(?:지워|삭제|제거|없애|비워)")
BULK_CONTRACT_DELETE_PATTERN = re.compile(
    r"계약서(?:를|을)?\s*(?:전부|모두)(?:\s*다)?\s*(?:지워|삭제|제거|없애)",
    re.IGNORECASE,
)


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
        bulk_delete_type = _bulk_file_deletion_type(request.message)
        if bulk_delete_type is not None:
            if authenticated:
                self._state.record_message(
                    conversation_id=request.conversation_id,
                    tenant_id=tenant_id,
                    subject_id=subject_id,
                    message_id=user_message_id,
                    role="user",
                    content=request.message,
                )
            response = self._bulk_file_deletion_response(
                request=request,
                message_id=assistant_message_id,
                document_type=bulk_delete_type,
                repository=repository,
                access_context=access_context,
            )
            self._record_assistant(response, tenant_id, subject_id)
            return response
        conversation_history = (
            self._state.recent_messages(
                conversation_id=request.conversation_id,
                tenant_id=tenant_id,
                subject_id=subject_id,
                limit=RECENT_CONVERSATION_MESSAGES,
            )
            if authenticated
            else []
        )
        runtime_fingerprint = self._agent.session_fingerprint(
            repository=repository,
            access_context=access_context,
        )
        resume_session_id = (
            self._state.latest_agent_session(
                conversation_id=request.conversation_id,
                tenant_id=tenant_id,
                subject_id=subject_id,
                runtime_fingerprint=runtime_fingerprint,
                max_age_seconds=self._agent.session_ttl_seconds,
            )
            if (
                authenticated
                and runtime_fingerprint is not None
                and self._agent.session_ttl_seconds is not None
            )
            else None
        )
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
                runtime_fingerprint=runtime_fingerprint,
            )
        try:
            result = await self._agent.decide(
                message=request.message,
                selected_document_id=request.selected_document_id,
                conversation_id=request.conversation_id,
                repository=repository,
                access_context=access_context,
                resume_session_id=resume_session_id,
                conversation_history=conversation_history,
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
                    runtime_fingerprint=runtime_fingerprint,
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
                runtime_fingerprint=runtime_fingerprint,
                session_id=result.session_id,
            )
        decision = result.decision
        if decision.outcome is not AgentOutcome.READY:
            if decision.outcome is AgentOutcome.NEEDS_CLARIFICATION and decision.intent == "locate":
                direct_documents = repository.search_with_direct_evidence(
                    request.message,
                    access_context=access_context,
                )
                if direct_documents:
                    response = self._location_response(
                        request=request,
                        message_id=assistant_message_id,
                        documents=direct_documents,
                        assistant_text="요청한 항목과 일치하는 현재 문서 근거를 찾았습니다.",
                        target_document_id=None,
                    )
                    self._record_assistant(response, tenant_id, subject_id)
                    return response
            response = _agent_outcome_response(
                request.conversation_id,
                assistant_message_id,
                outcome=decision.outcome,
                intent=decision.intent,
                user_message=request.message,
            )
            self._record_assistant(response, tenant_id, subject_id)
            return response
        documents = repository.search(
            decision.search_query,
            access_context=access_context,
        )
        if decision.intent == "delete_file":
            target_id = decision.target_document_id
            if target_id is None:
                response = _error_response(
                    request.conversation_id,
                    assistant_message_id,
                    code="DOCUMENT_SELECTION_REQUIRED",
                    message="삭제할 원본 파일 하나를 선택해주세요.",
                )
            elif (
                request.selected_document_id is not None
                and request.selected_document_id != target_id
            ):
                response = _error_response(
                    request.conversation_id,
                    assistant_message_id,
                    code="SELECTED_DOCUMENT_MISMATCH",
                    message=(
                        "선택한 문서와 삭제 요청에서 확인된 대상이 다릅니다. "
                        "삭제할 문서를 다시 선택해 주세요."
                    ),
                )
            else:
                response = self._file_deletion_response(
                    request=request,
                    message_id=assistant_message_id,
                    document_id=target_id,
                    repository=repository,
                    access_context=access_context,
                )
            self._record_assistant(response, tenant_id, subject_id)
            return response
        if decision.intent == "create_file":
            target_id = decision.target_document_id
            target_document = (
                repository.get(target_id, access_context=access_context)
                if target_id is not None
                else None
            )
            if (
                target_document is None
                or decision.target_filename is None
                or decision.document_markdown is None
            ):
                response = _error_response(
                    request.conversation_id,
                    assistant_message_id,
                    code="DOCUMENT_CREATION_DETAILS_REQUIRED",
                    message="새 문서의 근거, 파일명과 내용을 모두 확인하지 못했습니다.",
                )
            elif access_context.subject_id is None:
                response = _error_response(
                    request.conversation_id,
                    assistant_message_id,
                    code="AUTHENTICATION_REQUIRED",
                    message="새 문서 생성 미리보기는 로그인이 필요합니다.",
                )
            else:
                response = ChatMessageResponse(
                    conversation_id=request.conversation_id,
                    message_id=assistant_message_id,
                    response_type=ResponseType.DOCUMENT_CREATION_PREVIEW,
                    assistant_text=decision.assistant_text,
                    documents=[target_document],
                    generated_document=GeneratedDocument(
                        filename=decision.target_filename,
                        markdown=decision.document_markdown,
                        source_document_ids=[target_document.document_id],
                    ),
                )
            self._record_assistant(response, tenant_id, subject_id)
            return response
        if decision.intent == "locate":
            response = self._location_response(
                request=request,
                message_id=assistant_message_id,
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
        operation = decision.operation
        if operation.replacement_text == "":
            if DELETE_INTENT_PATTERN.search(request.message) is None:
                response = _error_response(
                    request.conversation_id,
                    assistant_message_id,
                    code="CHANGE_DELETION_UNVERIFIED",
                    message="내용을 비우려면 현재 요청에 삭제 의사를 명확히 적어주세요.",
                )
                self._record_assistant(response, tenant_id, subject_id)
                return response
        else:
            explicit_operation = _operation_with_explicit_replacement(operation, request.message)
            if explicit_operation is None:
                response = _error_response(
                    request.conversation_id,
                    assistant_message_id,
                    code="CHANGE_REPLACEMENT_UNVERIFIED",
                    message="변경 후 텍스트는 요청에 정확히 포함해 주세요.",
                )
                self._record_assistant(response, tenant_id, subject_id)
                return response
            operation = explicit_operation
        if access_context.subject_id is None:
            response = _error_response(
                request.conversation_id,
                assistant_message_id,
                code="AUTHENTICATION_REQUIRED",
                message="문서 변경 미리보기는 로그인이 필요합니다.",
            )
            self._record_assistant(response, tenant_id, subject_id)
            return response

        if (
            request.selected_document_id is not None
            and decision.target_document_id != request.selected_document_id
        ):
            response = _error_response(
                request.conversation_id,
                assistant_message_id,
                code="SELECTED_DOCUMENT_MISMATCH",
                message=(
                    "선택한 문서와 요청에서 확인된 대상이 다릅니다. "
                    "수정할 문서를 다시 선택해 주세요."
                ),
            )
            self._record_assistant(response, tenant_id, subject_id)
            return response

        target_id = decision.target_document_id
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
                operation=operation,
                request_text=request.message,
                expected_base_sha256=decision.source_sha256,
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

    def _file_deletion_response(
        self,
        *,
        request: ChatMessageRequest,
        message_id: str,
        document_id: str,
        repository: KnowledgeRepository,
        access_context: AccessContext,
    ) -> ChatMessageResponse:
        if access_context.subject_id is None:
            return _error_response(
                request.conversation_id,
                message_id,
                code="AUTHENTICATION_REQUIRED",
                message="파일 삭제 미리보기를 만들려면 로그인이 필요합니다.",
            )
        document = repository.get(document_id, access_context=access_context)
        if document is None:
            return _error_response(
                request.conversation_id,
                message_id,
                code="DOCUMENT_NOT_FOUND",
                message="현재 삭제 가능한 원본 문서를 찾지 못했습니다.",
            )
        try:
            plan = self._plans.create_delete_plan(
                repository=repository,
                access_context=access_context,
                document_id=document_id,
                request_text=request.message,
            )
        except ChangeServiceError as error:
            return _error_response(
                request.conversation_id,
                message_id,
                code=error.code,
                message=str(error),
            )
        return ChatMessageResponse(
            conversation_id=request.conversation_id,
            message_id=message_id,
            response_type=ResponseType.CHANGE_PREVIEW,
            assistant_text=(
                "아래 파일 삭제 diff를 확인해주세요. 승인하기 전에는 파일이 삭제되지 않으며, "
                "승인에는 화면의 정확한 plan_hash가 필요합니다."
            ),
            documents=[document],
            change_plan=plan,
        )

    def _bulk_file_deletion_response(
        self,
        *,
        request: ChatMessageRequest,
        message_id: str,
        document_type: str,
        repository: KnowledgeRepository,
        access_context: AccessContext,
    ) -> ChatMessageResponse:
        if access_context.subject_id is None:
            return _error_response(
                request.conversation_id,
                message_id,
                code="AUTHENTICATION_REQUIRED",
                message="파일 삭제 미리보기를 만들려면 로그인이 필요합니다.",
            )
        documents = repository.find_deletable_by_document_type(
            document_type,
            access_context=access_context,
        )
        if not documents:
            return _error_response(
                request.conversation_id,
                message_id,
                code="DOCUMENT_NOT_FOUND",
                message="삭제 가능한 계약서 파일을 찾지 못했습니다.",
            )
        if len(documents) > MAX_BULK_DELETE_FILES:
            return _error_response(
                request.conversation_id,
                message_id,
                code="TOO_MANY_DELETE_TARGETS",
                message=(
                    f"계약서가 {len(documents)}개라 한 번에 미리보기할 수 없습니다. "
                    "폴더나 파일명을 더 구체적으로 지정해주세요."
                ),
            )
        try:
            plans = self._plans.create_delete_plans(
                repository=repository,
                access_context=access_context,
                document_ids=[document.document_id for document in documents],
                request_text=request.message,
            )
        except ChangeServiceError as error:
            return _error_response(
                request.conversation_id,
                message_id,
                code=error.code,
                message=str(error),
            )
        return ChatMessageResponse(
            conversation_id=request.conversation_id,
            message_id=message_id,
            response_type=ResponseType.CHANGE_PREVIEW,
            assistant_text=(
                f"계약서 {len(plans)}개의 삭제 미리보기를 만들었습니다. "
                "각 파일은 별도 승인을 받아야 하며 승인 전에는 삭제되지 않습니다."
            ),
            documents=documents,
            change_plans=plans,
        )

    def _location_response(
        self,
        *,
        request: ChatMessageRequest,
        message_id: str,
        documents: list[DocumentResult],
        assistant_text: str,
        target_document_id: str | None,
    ) -> ChatMessageResponse:
        if target_document_id:
            searched_target = next(
                (item for item in documents if item.document_id == target_document_id),
                None,
            )
            if searched_target is None:
                return _error_response(
                    request.conversation_id,
                    message_id,
                    code="DOCUMENT_NOT_FOUND",
                    message="검증한 대상 문서에서 현재 검색어와 일치하는 근거를 찾지 못했습니다.",
                )
            documents = [
                searched_target,
                *[item for item in documents if item.document_id != target_document_id],
            ]
        if not documents:
            return _error_response(
                request.conversation_id,
                message_id,
                code="DOCUMENT_NOT_FOUND",
                message="검색어와 일치하는 근거 청크가 없습니다.",
            )
        displayed_documents = [
            document.model_copy(
                update={
                    "evidence": document.evidence[:1],
                    "citations": document.citations[:1],
                }
            )
            for document in documents[:MAX_LOCATION_DOCUMENTS]
            if document.evidence and document.citations
        ]
        return ChatMessageResponse(
            conversation_id=request.conversation_id,
            message_id=message_id,
            response_type=ResponseType.LOCATION_RESULT,
            assistant_text=_compact_answer(assistant_text),
            documents=displayed_documents,
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
    retryable: bool = False,
) -> ChatMessageResponse:
    return ChatMessageResponse(
        conversation_id=conversation_id,
        message_id=message_id,
        response_type=ResponseType.ERROR,
        assistant_text=message,
        documents=[],
        error=ApiError(code=code, message=message, retryable=retryable),
    )


def _agent_outcome_response(
    conversation_id: str,
    message_id: str,
    *,
    outcome: AgentOutcome,
    intent: str,
    user_message: str,
) -> ChatMessageResponse:
    if outcome is AgentOutcome.NEEDS_CLARIFICATION:
        if intent == "create_file":
            return _error_response(
                conversation_id,
                message_id,
                code="DOCUMENT_CREATION_DETAILS_REQUIRED",
                message="참고할 문서와 만들 HWPX 파일명을 더 구체적으로 적어주세요.",
            )
        if intent == "delete_file":
            return _error_response(
                conversation_id,
                message_id,
                code="DOCUMENT_SELECTION_REQUIRED",
                message="삭제할 원본 파일 하나를 파일명이나 문서 제목으로 지정해주세요.",
            )
        if intent == "change":
            message = (
                "지울 항목이나 내용을 지정해주세요. 직전 요청을 이어 말한 경우 같은 대화에서 "
                "대상 문서와 항목을 한 번 더 적어주세요."
                if DELETE_INTENT_PATTERN.search(user_message)
                else (
                    "수정할 문서, 바꿀 항목, 새 값을 알려주세요. "
                    "기존 값은 앱이 문서에서 확인합니다."
                )
            )
            return _error_response(
                conversation_id,
                message_id,
                code="CHANGE_DETAILS_REQUIRED",
                message=message,
            )
        return _error_response(
            conversation_id,
            message_id,
            code="CLARIFICATION_REQUIRED",
            message="파일명, 문서 제목 또는 찾을 항목을 하나 이상 알려주세요.",
        )
    if outcome is AgentOutcome.NOT_FOUND:
        return _error_response(
            conversation_id,
            message_id,
            code="DOCUMENT_NOT_FOUND",
            message="검색어와 일치하는 검증된 문서 근거가 없습니다.",
        )
    if outcome is AgentOutcome.TOOL_ERROR:
        return _error_response(
            conversation_id,
            message_id,
            code="AGENT_TOOL_ERROR",
            message="현재 문서 근거를 안전하게 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.",
            retryable=True,
        )
    return _error_response(
        conversation_id,
        message_id,
        code="UNSUPPORTED_AGENT_REQUEST",
        message=(
            "지원되는 문서 조회·수정 요청으로 해석하지 못했습니다. "
            "파일명과 작업할 항목을 적어주세요."
        ),
    )


def _bulk_file_deletion_type(user_message: str) -> str | None:
    return "contract" if BULK_CONTRACT_DELETE_PATTERN.search(user_message) else None


def _compact_answer(value: str) -> str:
    answer = " ".join(value.split())
    if len(answer) <= MAX_LOCATION_ANSWER_CHARS:
        return answer
    candidate = answer[:MAX_LOCATION_ANSWER_CHARS]
    sentence_end = max(candidate.rfind("다."), candidate.rfind("요."), candidate.rfind("."))
    if sentence_end >= MAX_LOCATION_ANSWER_CHARS // 3:
        return candidate[: sentence_end + 1].rstrip()
    return candidate.rstrip() + "…"


def _operation_with_explicit_replacement(
    operation: ReplaceExactOperation,
    user_message: str,
) -> ReplaceExactOperation | None:
    """Strip model-added shared context while retaining only user-supplied replacement text."""

    replacement = operation.replacement_text
    if replacement in user_message:
        return operation
    expected = operation.expected_text
    prefix = 0
    max_prefix = min(len(expected), len(replacement))
    while prefix < max_prefix and expected[prefix] == replacement[prefix]:
        prefix += 1
    suffix = 0
    max_suffix = min(len(expected), len(replacement)) - prefix
    while suffix < max_suffix and expected[-suffix - 1] == replacement[-suffix - 1]:
        suffix += 1

    expected_end = len(expected) - suffix
    replacement_end = len(replacement) - suffix
    candidate_expected = expected[prefix:expected_end]
    candidate_replacement = replacement[prefix:replacement_end]
    if not candidate_expected or not candidate_replacement:
        return None

    while suffix > 0:
        expanded_expected = expected[prefix : expected_end + 1]
        expanded_replacement = replacement[prefix : replacement_end + 1]
        if expanded_replacement not in user_message:
            break
        candidate_expected = expanded_expected
        candidate_replacement = expanded_replacement
        expected_end += 1
        replacement_end += 1
        suffix -= 1

    while prefix > 0:
        expanded_expected = expected[prefix - 1 : expected_end]
        expanded_replacement = replacement[prefix - 1 : replacement_end]
        if expanded_replacement not in user_message:
            break
        candidate_expected = expanded_expected
        candidate_replacement = expanded_replacement
        prefix -= 1

    if candidate_replacement not in user_message:
        return None
    return ReplaceExactOperation(
        expected_text=candidate_expected,
        replacement_text=candidate_replacement,
        expected_occurrences=operation.expected_occurrences,
    )
