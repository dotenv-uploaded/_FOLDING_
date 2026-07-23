from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import unicodedata
from enum import StrEnum
from importlib.metadata import version
from typing import Annotated, Any, Literal, Protocol, cast
from uuid import UUID, uuid4

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeSDKClient,
    ResultMessage,
    SessionStore,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from codegate_api.agent.instructions import (
    PROMPT_CONTRACT_VERSION,
    build_system_prompt,
    build_turn_prompt,
)
from codegate_api.agent.runtime import (
    ALLOWED_AGENT_TOOLS,
    SAFE_AGENT_TOOLS,
    SDK_CONTROL_TOOLS,
    build_claude_agent_options,
)
from codegate_api.agent.session_store import LocalJsonlSessionStore
from codegate_api.agent.tools import TOOL_CONTRACT_VERSION
from codegate_api.config import Settings
from codegate_api.knowledge.access import AccessContext
from codegate_api.knowledge.repository import KnowledgeRepository
from codegate_api.knowledge.schemas import DOCUMENT_ID_PATTERN
from codegate_api.models import ReplaceExactOperation

EXPECTED_TOOL_SOURCE_KINDS = {
    "mcp__codegate__knowledge_search": "knowledge_search",
    "mcp__codegate__document_get": "document_get",
    "mcp__codegate__knowledge_document_read": "canonical_document",
    "mcp__codegate__source_file_read": "current_source",
}

logger = logging.getLogger(__name__)

_DOCUMENT_ID_REFERENCE_PATTERN = re.compile(
    r"(?<![A-Za-z0-9_-])[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+(?![A-Za-z0-9_-])"
)
_VALIDATION_LOCATION_PARTS = frozenset(
    {
        "AgentStructuredOutput",
        "NeedsClarificationOutput",
        "NotFoundOutput",
        "ReadyChangeOutput",
        "ReadyCreateFileOutput",
        "ReadyDeleteFileOutput",
        "ReadyLocateOutput",
        "ReplaceExactOperation",
        "ToolErrorOutput",
        "UnsupportedOutput",
        "assistant_text",
        "decision",
        "decision_type",
        "expected_occurrences",
        "expected_text",
        "intent",
        "operation",
        "prompt_contract_version",
        "replacement_text",
        "search_query",
        "source_sha256",
        "target_filename",
        "target_document_id",
        "document_markdown",
        "type",
    }
)


class AgentGatewayError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _classify_sdk_result_error(response: ResultMessage) -> AgentGatewayError:
    result_text = (response.result or "").casefold()
    if response.is_error and "credit balance is too low" in result_text:
        return AgentGatewayError(
            "AGENT_CREDIT_EXHAUSTED",
            "Claude API 크레딧 잔액이 부족합니다. Anthropic Console에서 크레딧을 확인해 주세요.",
        )
    if response.api_error_status in {401, 403}:
        return AgentGatewayError(
            "AGENT_AUTH_INVALID",
            "Claude API 키가 유효하지 않거나 사용할 권한이 없습니다.",
        )
    if response.api_error_status == 429:
        return AgentGatewayError(
            "AGENT_RATE_LIMITED",
            "Claude API 요청 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.",
        )
    if response.api_error_status is not None and response.api_error_status >= 500:
        return AgentGatewayError(
            "AGENT_UPSTREAM_UNAVAILABLE",
            "Claude API가 일시적으로 응답하지 않습니다. 잠시 후 다시 시도해 주세요.",
        )
    if response.subtype == "error_max_budget_usd":
        return AgentGatewayError(
            "AGENT_BUDGET_EXCEEDED",
            "Claude 요청이 앱의 실행 예산 한도를 초과했습니다.",
        )
    if response.subtype == "error_max_structured_output_retries":
        return AgentGatewayError(
            "AGENT_RESULT_INVALID",
            "Claude Agent SDK가 검증된 구조화 결과를 반환하지 못했습니다.",
        )
    if response.is_error:
        return AgentGatewayError(
            "AGENT_UPSTREAM_REJECTED",
            "Claude API 요청이 거부됐습니다. API 키, 모델과 계정 상태를 확인해 주세요.",
        )
    return AgentGatewayError(
        "AGENT_RESULT_INVALID",
        "Claude Agent SDK가 검증된 구조화 결과를 반환하지 못했습니다.",
    )


class AgentOutcome(StrEnum):
    READY = "ready"
    NEEDS_CLARIFICATION = "needs_clarification"
    NOT_FOUND = "not_found"
    TOOL_ERROR = "tool_error"
    UNSUPPORTED = "unsupported"


class AgentDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    prompt_contract_version: Literal["2.1"] = Field(
        description="Prompt contract version used for this decision; must equal 2.1."
    )
    outcome: AgentOutcome = Field(
        description=(
            "ready only when all current-turn requirements passed; otherwise the precise "
            "fail-closed reason."
        )
    )
    intent: Literal["locate", "change", "delete_file", "create_file"] = Field(
        description="The user's requested document task, preserved even when outcome is not ready."
    )
    assistant_text: str = Field(
        min_length=1,
        max_length=480,
        description=(
            "For a ready locate, a concise Korean answer grounded only in current-turn tool "
            "evidence; otherwise a brief routing status. Never hidden reasoning or a write claim."
        ),
    )
    search_query: str = Field(
        min_length=1,
        max_length=4_000,
        description=(
            "Minimal business-document retrieval query with prompt-control and permission text "
            "removed."
        ),
    )
    target_document_id: str | None = Field(
        ...,
        pattern=DOCUMENT_ID_PATTERN,
        max_length=96,
        description="Stable ID verified by a CODEGATE tool in the current turn, otherwise null.",
    )
    source_document_ids: list[str] = Field(
        default_factory=list,
        max_length=20,
        description=(
            "Ordered current-turn verified source IDs for a ready HWPX creation, otherwise empty."
        ),
    )
    source_sha256: str | None = Field(
        ...,
        pattern=r"^[0-9a-f]{64}$",
        description=(
            "Hash copied from the current-turn source_file_read result for a ready change, "
            "otherwise null."
        ),
    )
    operation: ReplaceExactOperation | None = Field(
        ...,
        description=(
            "One current-source-grounded replace_exact proposal for a ready change, otherwise null."
        ),
    )
    target_filename: str | None = Field(
        default=None,
        min_length=6,
        max_length=255,
        pattern=r'^[^./\\\x00-\x1f<>:"|?*][^/\\\x00-\x1f<>:"|?*]*\.[Hh][Ww][Pp][Xx]$',
        description="Requested safe HWPX basename for a ready file creation, otherwise null.",
    )
    document_markdown: str | None = Field(
        default=None,
        min_length=1,
        max_length=65_536,
        description="Grounded Markdown body for a ready HWPX creation, otherwise null.",
    )

    @model_validator(mode="after")
    def enforce_decision_contract(self) -> AgentDecision:
        if self.prompt_contract_version != PROMPT_CONTRACT_VERSION:
            raise ValueError("prompt contract version does not match the runtime")
        if self.intent == "locate" and (
            self.operation is not None or self.source_sha256 is not None
        ):
            raise ValueError("locate decisions cannot contain a change operation or source hash")
        if self.intent == "delete_file" and (
            self.operation is not None or self.source_sha256 is not None
        ):
            raise ValueError(
                "file deletion decisions cannot contain content changes or source hash"
            )
        if self.intent == "create_file" and (
            self.operation is not None or self.source_sha256 is not None
        ):
            raise ValueError("file creation decisions cannot contain source edits or source hash")
        if self.intent != "create_file" and (
            self.source_document_ids
            or self.target_filename is not None
            or self.document_markdown is not None
        ):
            raise ValueError("only file creation decisions can contain generated document fields")
        if self.outcome is not AgentOutcome.READY and (
            self.operation is not None
            or self.source_sha256 is not None
            or self.source_document_ids
            or self.target_filename is not None
            or self.document_markdown is not None
        ):
            raise ValueError("non-ready decisions cannot contain write proposal fields")
        if (
            self.outcome
            in {
                AgentOutcome.NOT_FOUND,
                AgentOutcome.TOOL_ERROR,
                AgentOutcome.UNSUPPORTED,
            }
            and self.target_document_id is not None
        ):
            raise ValueError("failed or unsupported decisions cannot identify a target document")
        if (
            self.outcome is AgentOutcome.READY
            and self.intent == "change"
            and (
                self.target_document_id is None
                or self.source_sha256 is None
                or self.operation is None
            )
        ):
            raise ValueError(
                "a ready change requires a target, source hash, and replace_exact operation"
            )
        if (
            self.outcome is AgentOutcome.READY
            and self.intent == "delete_file"
            and self.target_document_id is None
        ):
            raise ValueError("a ready file deletion requires a verified target")
        if (
            self.outcome is AgentOutcome.READY
            and self.intent == "create_file"
            and (
                self.target_document_id is None
                or not self.source_document_ids
                or self.target_document_id != self.source_document_ids[0]
                or len(set(self.source_document_ids)) != len(self.source_document_ids)
                or any(
                    re.fullmatch(DOCUMENT_ID_PATTERN, source_id) is None
                    or len(source_id) > 96
                    for source_id in self.source_document_ids
                )
                or self.target_filename is None
                or self.document_markdown is None
            )
        ):
            raise ValueError(
                "a ready file creation requires ordered verified sources, an HWPX filename, "
                "and Markdown"
            )
        if self.operation is not None and self.intent != "change":
            raise ValueError("only a change decision can contain an operation")
        return self


VerifiedDocumentId = Annotated[
    str,
    Field(pattern=DOCUMENT_ID_PATTERN, max_length=96),
]
SourceSha256 = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]


class _StructuredDecisionBase(BaseModel):
    model_config = ConfigDict(extra="forbid")

    prompt_contract_version: Literal["2.1"] = Field(
        description="Prompt contract version used for this decision; must equal 2.1."
    )
    assistant_text: str = Field(
        min_length=1,
        max_length=480,
        description=(
            "For ready_locate, a concise Korean answer grounded only in current-turn tool "
            "evidence; otherwise a brief routing status. Never hidden reasoning or a write claim."
        ),
    )
    search_query: str = Field(
        min_length=1,
        max_length=4_000,
        description=(
            "Minimal business-document retrieval query with prompt-control and permission text "
            "removed."
        ),
    )


class ReadyLocateOutput(_StructuredDecisionBase):
    decision_type: Literal["ready_locate"] = Field(
        description="Use only when current-turn read evidence fully supports a locate answer."
    )
    target_document_id: VerifiedDocumentId | None = Field(
        ...,
        description="Current-turn verified stable ID, or null for a search-only locate result.",
    )


class ReadyChangeOutput(_StructuredDecisionBase):
    decision_type: Literal["ready_change"] = Field(
        description="Use only when one exact source-grounded change proposal is complete."
    )
    target_document_id: VerifiedDocumentId = Field(
        description="Stable ID verified by a CODEGATE tool in the current turn."
    )
    source_sha256: SourceSha256 = Field(
        description="Hash copied from the current-turn source_file_read result."
    )
    operation: ReplaceExactOperation = Field(
        description="One current-source-grounded replace_exact proposal."
    )


class ReadyDeleteFileOutput(_StructuredDecisionBase):
    decision_type: Literal["ready_delete_file"] = Field(
        description=(
            "Use only when the user requested deletion of one whole source file and the target "
            "was verified with current-turn document evidence."
        )
    )
    target_document_id: VerifiedDocumentId = Field(
        description="Stable ID verified by a CODEGATE tool in the current turn."
    )


class ReadyCreateFileOutput(_StructuredDecisionBase):
    decision_type: Literal["ready_create_file"] = Field(
        description=(
            "Use only when one or more verified source documents support a new HWPX proposal."
        )
    )
    target_document_id: VerifiedDocumentId = Field(
        description="Primary source ID; must equal the first source_document_ids entry."
    )
    source_document_ids: list[VerifiedDocumentId] = Field(
        min_length=1,
        max_length=20,
        description="Ordered unique source IDs verified and read in the current turn.",
    )
    target_filename: str = Field(
        min_length=6,
        max_length=255,
        pattern=r'^[^./\\\x00-\x1f<>:"|?*][^/\\\x00-\x1f<>:"|?*]*\.[Hh][Ww][Pp][Xx]$',
        description="User-requested HWPX basename without any directory component.",
    )
    document_markdown: str = Field(
        min_length=1,
        max_length=65_536,
        description="Markdown body grounded in the current canonical source document.",
    )


class _NonReadyOutput(_StructuredDecisionBase):
    intent: Literal["locate", "change", "delete_file", "create_file"] = Field(
        description="The user's requested document task, preserved on a non-ready result."
    )


class NeedsClarificationOutput(_NonReadyOutput):
    decision_type: Literal["needs_clarification"] = Field(
        description="The task is supported but its target or requested wording is ambiguous."
    )


class NotFoundOutput(_NonReadyOutput):
    decision_type: Literal["not_found"] = Field(
        description="The exact current-turn search returned a valid empty document list."
    )


class ToolErrorOutput(_NonReadyOutput):
    decision_type: Literal["tool_error"] = Field(
        description="A required current-turn CODEGATE tool failed or returned invalid evidence."
    )


class UnsupportedOutput(_NonReadyOutput):
    decision_type: Literal["unsupported"] = Field(
        description="No supported business-document task remains in the newest request."
    )


StructuredDecision = (
    ReadyLocateOutput
    | ReadyChangeOutput
    | ReadyCreateFileOutput
    | ReadyDeleteFileOutput
    | NeedsClarificationOutput
    | NotFoundOutput
    | ToolErrorOutput
    | UnsupportedOutput
)


class AgentStructuredOutput(BaseModel):
    """SDK-facing discriminated schema that makes cross-field states unrepresentable."""

    model_config = ConfigDict(extra="forbid")

    decision: StructuredDecision = Field(
        description="Exactly one typed routing or document-change decision."
    )

    def to_decision(self) -> AgentDecision:
        value = self.decision
        common = {
            "prompt_contract_version": value.prompt_contract_version,
            "assistant_text": value.assistant_text,
            "search_query": value.search_query,
        }
        if isinstance(value, ReadyLocateOutput):
            return AgentDecision.model_validate(
                {
                    **common,
                    "outcome": AgentOutcome.READY,
                    "intent": "locate",
                    "target_document_id": value.target_document_id,
                    "source_document_ids": [],
                    "source_sha256": None,
                    "operation": None,
                    "target_filename": None,
                    "document_markdown": None,
                }
            )
        if isinstance(value, ReadyChangeOutput):
            return AgentDecision.model_validate(
                {
                    **common,
                    "outcome": AgentOutcome.READY,
                    "intent": "change",
                    "target_document_id": value.target_document_id,
                    "source_document_ids": [],
                    "source_sha256": value.source_sha256,
                    "operation": value.operation,
                    "target_filename": None,
                    "document_markdown": None,
                }
            )
        if isinstance(value, ReadyCreateFileOutput):
            return AgentDecision.model_validate(
                {
                    **common,
                    "outcome": AgentOutcome.READY,
                    "intent": "create_file",
                    "target_document_id": value.target_document_id,
                    "source_document_ids": value.source_document_ids,
                    "source_sha256": None,
                    "operation": None,
                    "target_filename": value.target_filename,
                    "document_markdown": value.document_markdown,
                }
            )
        if isinstance(value, ReadyDeleteFileOutput):
            return AgentDecision.model_validate(
                {
                    **common,
                    "outcome": AgentOutcome.READY,
                    "intent": "delete_file",
                    "target_document_id": value.target_document_id,
                    "source_document_ids": [],
                    "source_sha256": None,
                    "operation": None,
                    "target_filename": None,
                    "document_markdown": None,
                }
            )
        outcome = AgentOutcome(value.decision_type)
        return AgentDecision.model_validate(
            {
                **common,
                "outcome": outcome,
                "intent": value.intent,
                "target_document_id": None,
                "source_document_ids": [],
                "source_sha256": None,
                "operation": None,
                "target_filename": None,
                "document_markdown": None,
            }
        )


class AgentRunResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    decision: AgentDecision
    provider: str
    session_id: str | None = None
    tool_calls: list[str] = Field(default_factory=list)


class AgentGateway(Protocol):
    @property
    def session_ttl_seconds(self) -> int | None: ...

    def session_fingerprint(
        self,
        *,
        repository: KnowledgeRepository,
        access_context: AccessContext,
    ) -> str | None: ...

    async def decide(
        self,
        *,
        message: str,
        selected_document_id: str | None,
        conversation_id: str,
        repository: KnowledgeRepository,
        access_context: AccessContext,
        resume_session_id: str | None = None,
        conversation_history: list[dict[str, str | None]] | None = None,
    ) -> AgentRunResult: ...


class DeterministicAgentGateway:
    @property
    def session_ttl_seconds(self) -> None:
        return None

    def session_fingerprint(
        self,
        *,
        repository: KnowledgeRepository,
        access_context: AccessContext,
    ) -> None:
        del repository, access_context
        return None

    async def decide(
        self,
        *,
        message: str,
        selected_document_id: str | None,
        conversation_id: str,
        repository: KnowledgeRepository,
        access_context: AccessContext,
        resume_session_id: str | None = None,
        conversation_history: list[dict[str, str | None]] | None = None,
    ) -> AgentRunResult:
        del conversation_id, resume_session_id, conversation_history
        requested_filename = _requested_hwpx_filename(message)
        if requested_filename is not None and _is_file_creation_request(message):
            search_query = _creation_search_query(message, requested_filename)
            requested_document_id = selected_document_id or _extract_document_id(message)
            source_document_ids = (
                [requested_document_id]
                if requested_document_id is not None
                else [
                    candidate.document_id
                    for candidate in repository.search(
                        search_query,
                        access_context=access_context,
                        top_k=20,
                    )
                ]
            )
            sources = [
                (
                    document_id,
                    repository.read_canonical_text(
                        document_id,
                        access_context=access_context,
                    ),
                )
                for document_id in source_document_ids
            ]
            if not sources or any(source is None for _, source in sources):
                return AgentRunResult(
                    provider="deterministic",
                    decision=AgentDecision(
                        prompt_contract_version=PROMPT_CONTRACT_VERSION,
                        outcome=AgentOutcome.NEEDS_CLARIFICATION,
                        intent="create_file",
                        assistant_text=(
                            "새 문서에 사용할 근거 문서를 더 명확히 지정해야 합니다."
                        ),
                        search_query=search_query,
                        target_document_id=None,
                        source_sha256=None,
                        operation=None,
                    ),
                )
            title = requested_filename.rsplit(".", 1)[0]
            grounded_sections = "\n\n".join(
                f"## 근거 문서 {index}\n\n{source[1].strip()}"
                for index, (_, source) in enumerate(sources, start=1)
                if source is not None
            )
            return AgentRunResult(
                provider="deterministic",
                decision=AgentDecision(
                    prompt_contract_version=PROMPT_CONTRACT_VERSION,
                    outcome=AgentOutcome.READY,
                    intent="create_file",
                    assistant_text="현재 문서 근거로 새 HWPX 생성 미리보기를 준비했습니다.",
                    search_query=search_query,
                    target_document_id=source_document_ids[0],
                    source_document_ids=source_document_ids,
                    source_sha256=None,
                    operation=None,
                    target_filename=requested_filename,
                    document_markdown=f"# {title}\n\n{grounded_sections}",
                ),
            )
        if _is_whole_file_deletion_request(message):
            document_id = selected_document_id or _extract_document_id(message)
            if document_id is None:
                candidates = repository.search(message, access_context=access_context)
                if len(candidates) == 1:
                    document_id = candidates[0].document_id
            document = (
                repository.get(document_id, access_context=access_context)
                if document_id is not None
                else None
            )
            if document is None:
                return AgentRunResult(
                    provider="deterministic",
                    decision=AgentDecision(
                        prompt_contract_version=PROMPT_CONTRACT_VERSION,
                        outcome=AgentOutcome.NEEDS_CLARIFICATION,
                        intent="delete_file",
                        assistant_text="삭제할 원본 파일 하나를 더 명확히 지정해야 합니다.",
                        search_query=message,
                        target_document_id=None,
                        source_sha256=None,
                        operation=None,
                    ),
                )
            return AgentRunResult(
                provider="deterministic",
                decision=AgentDecision(
                    prompt_contract_version=PROMPT_CONTRACT_VERSION,
                    outcome=AgentOutcome.READY,
                    intent="delete_file",
                    assistant_text="파일 삭제 승인 미리보기를 준비합니다.",
                    search_query=message,
                    target_document_id=document.document_id,
                    source_sha256=None,
                    operation=None,
                ),
            )
        operation = _parse_replace_operation(message)
        document_id = selected_document_id or _extract_document_id(message)
        if operation is not None:
            source_sha256: str | None = None
            if document_id is not None and operation.replacement_text in message:
                source = repository.read_source_text(
                    document_id,
                    access_context=access_context,
                )
                if source is not None and source[1].count(operation.expected_text) == 1:
                    source_sha256 = source[0].source.sha256
            if source_sha256 is None:
                return AgentRunResult(
                    provider="deterministic",
                    decision=AgentDecision(
                        prompt_contract_version=PROMPT_CONTRACT_VERSION,
                        outcome=AgentOutcome.NEEDS_CLARIFICATION,
                        intent="change",
                        assistant_text="대상과 변경 문구를 더 명확히 확인해야 합니다.",
                        search_query=message,
                        target_document_id=document_id,
                        source_sha256=None,
                        operation=None,
                    ),
                )
            return AgentRunResult(
                provider="deterministic",
                decision=AgentDecision(
                    prompt_contract_version=PROMPT_CONTRACT_VERSION,
                    outcome=AgentOutcome.READY,
                    intent="change",
                    assistant_text="실제 원본을 기준으로 변경 미리보기를 만들겠습니다.",
                    search_query=message,
                    target_document_id=document_id,
                    source_sha256=source_sha256,
                    operation=operation,
                ),
            )
        return AgentRunResult(
            provider="deterministic",
            decision=AgentDecision(
                prompt_contract_version=PROMPT_CONTRACT_VERSION,
                outcome=AgentOutcome.READY,
                intent="locate",
                assistant_text="관련 문서와 근거를 찾았습니다.",
                search_query=message,
                target_document_id=document_id,
                source_sha256=None,
                operation=None,
            ),
        )


class ClaudeAgentGateway:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._sessions = LocalJsonlSessionStore(
            settings.resolved_agent_state_root() / "transcripts"
        )

    @property
    def session_ttl_seconds(self) -> int:
        return self._settings.claude_session_ttl_seconds

    def session_fingerprint(
        self,
        *,
        repository: KnowledgeRepository,
        access_context: AccessContext,
    ) -> str:
        system_prompt = build_system_prompt(repository.agent_guide)
        fingerprint_payload = {
            "prompt_contract_version": PROMPT_CONTRACT_VERSION,
            "system_prompt_sha256": hashlib.sha256(system_prompt.encode("utf-8")).hexdigest(),
            "tool_contract_version": TOOL_CONTRACT_VERSION,
            "allowed_tools": sorted(ALLOWED_AGENT_TOOLS),
            "output_schema": AgentStructuredOutput.model_json_schema(),
            "agent_guide": repository.agent_guide.model_dump(mode="json"),
            "graph_version": repository.version,
            "model": self._settings.claude_model or "sdk-default",
            "sdk_version": version("claude-agent-sdk"),
            "access": {
                "tenant_id": access_context.tenant_id,
                "subject_id": access_context.subject_id,
                "readable_access": sorted(level.value for level in access_context.readable_access),
                "writable_document_ids": sorted(access_context.writable_document_ids),
                "provisioned": access_context.provisioned,
                "allow_all_writes": access_context.allow_all_writes,
                "authz_source": access_context.authz_source,
            },
        }
        encoded = json.dumps(
            fingerprint_payload,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()

    async def decide(
        self,
        *,
        message: str,
        selected_document_id: str | None,
        conversation_id: str,
        repository: KnowledgeRepository,
        access_context: AccessContext,
        resume_session_id: str | None = None,
        conversation_history: list[dict[str, str | None]] | None = None,
    ) -> AgentRunResult:
        del conversation_id
        working_directory = self._settings.resolved_source_root()
        effective_resume = (
            _canonical_session_id(resume_session_id) if resume_session_id is not None else None
        )
        if effective_resume is not None and not await self._sessions.contains(
            working_directory=working_directory,
            session_id=effective_resume,
        ):
            effective_resume = None
        session_id = str(uuid4())
        effective_session_id = effective_resume or session_id
        state_root = self._settings.resolved_agent_state_root()
        state_directory = (state_root / effective_session_id).resolve()
        if not state_directory.is_relative_to(state_root):
            raise AgentGatewayError(
                "AGENT_SESSION_INVALID", "Claude session 경로가 유효하지 않습니다."
            )
        options = build_claude_agent_options(
            repository,
            working_directory=working_directory,
            state_directory=state_directory,
            access_context=access_context,
            output_schema=AgentStructuredOutput.model_json_schema(),
            model=self._settings.claude_model,
            session_id=None if effective_resume else session_id,
            resume=effective_resume,
            session_store=cast(SessionStore, self._sessions),
        )
        prompt = build_turn_prompt(
            user_message=message,
            selected_document_id=selected_document_id,
            graph_version=repository.version,
            conversation_history=conversation_history,
            creation_request=_creation_routing_context(message),
        )
        try:
            tool_calls: list[str] = []
            tool_uses: list[ToolUseBlock] = []
            tool_results: dict[str, ToolResultBlock] = {}
            async with asyncio.timeout(self._settings.claude_timeout_seconds):
                async with ClaudeSDKClient(options=options) as client:
                    await client.query(prompt)
                    async for response in client.receive_response():
                        if isinstance(response, AssistantMessage):
                            current_tool_uses = [
                                block
                                for block in response.content
                                if isinstance(block, ToolUseBlock)
                            ]
                            tool_uses.extend(current_tool_uses)
                            tool_calls.extend(
                                block.name
                                for block in current_tool_uses
                                if block.name in SAFE_AGENT_TOOLS
                            )
                            continue
                        if isinstance(response, UserMessage):
                            if isinstance(response.content, list):
                                tool_results.update(
                                    {
                                        block.tool_use_id: block
                                        for block in response.content
                                        if isinstance(block, ToolResultBlock)
                                    }
                                )
                            continue
                        if not isinstance(response, ResultMessage):
                            continue
                        if response.subtype != "success" or response.structured_output is None:
                            result_error = _classify_sdk_result_error(response)
                            logger.warning(
                                "Claude Agent SDK returned no validated result: "
                                "subtype=%s is_error=%s turns=%s api_status=%s "
                                "permission_denials=%s errors=%s structured_output=%s code=%s",
                                response.subtype,
                                response.is_error,
                                response.num_turns,
                                response.api_error_status,
                                len(response.permission_denials or []),
                                len(response.errors or []),
                                response.structured_output is not None,
                                result_error.code,
                            )
                            raise result_error
                        returned_session_id = _canonical_session_id(response.session_id)
                        if returned_session_id != effective_session_id:
                            raise AgentGatewayError(
                                "AGENT_SESSION_MISMATCH",
                                "Claude Agent SDK session ID가 요청한 session과 다릅니다.",
                            )
                        decision = AgentStructuredOutput.model_validate(
                            _normalize_structured_enum_casing(response.structured_output)
                        ).to_decision()
                        decision = _bind_search_query_to_tool_evidence(
                            decision,
                            tool_uses,
                            tool_results,
                            expected_graph_version=repository.version,
                        )
                        _validate_tool_trace(
                            decision,
                            tool_uses,
                            tool_results,
                            expected_graph_version=repository.version,
                            selected_document_id=selected_document_id,
                            routing_document_ids=_routing_document_ids(
                                message,
                                conversation_history,
                            ),
                        )
                        return AgentRunResult(
                            provider="claude-agent-sdk",
                            session_id=returned_session_id,
                            tool_calls=tool_calls,
                            decision=decision,
                        )
        except TimeoutError as error:
            raise AgentGatewayError(
                "AGENT_TIMEOUT", "Claude 응답 시간이 초과되었습니다."
            ) from error
        except AgentGatewayError:
            raise
        except ValidationError as error:
            logger.warning(
                "Claude structured decision failed application validation: errors=%s",
                _validation_error_signature(error),
            )
            raise AgentGatewayError(
                "AGENT_RESULT_INVALID",
                "Claude Agent SDK가 prompt contract를 충족하지 못했습니다.",
            ) from error
        except Exception as error:
            raise AgentGatewayError(
                "AGENT_UNAVAILABLE", "Claude Agent SDK 호출에 실패했습니다."
            ) from error
        raise AgentGatewayError("AGENT_RESULT_MISSING", "Claude 최종 응답을 받지 못했습니다.")


def build_agent_gateway(settings: Settings) -> AgentGateway:
    if settings.agent_mode == "claude":
        return ClaudeAgentGateway(settings)
    return DeterministicAgentGateway()


def _normalize_structured_enum_casing(value: Any) -> Any:
    """Honor the provider's documented case-insensitive enum edge case without widening values."""

    if not isinstance(value, dict) or not isinstance(value.get("decision"), dict):
        return value
    normalized = dict(value)
    decision = dict(value["decision"])
    normalized["decision"] = decision
    enum_values = {
        "decision_type": {
            "ready_locate",
            "ready_change",
            "ready_create_file",
            "ready_delete_file",
            "needs_clarification",
            "not_found",
            "tool_error",
            "unsupported",
        },
        "intent": {"locate", "change", "delete_file", "create_file"},
    }
    for field, allowed in enum_values.items():
        raw = decision.get(field)
        candidate = raw.casefold() if isinstance(raw, str) else None
        if candidate in allowed:
            decision[field] = candidate
    operation = decision.get("operation")
    if isinstance(operation, dict):
        normalized_operation = dict(operation)
        operation_type = normalized_operation.get("type")
        if isinstance(operation_type, str) and operation_type.casefold() == "replace_exact":
            normalized_operation["type"] = "replace_exact"
        decision["operation"] = normalized_operation
    return normalized


def _validation_error_signature(error: ValidationError) -> list[str]:
    signatures: list[str] = []
    for item in error.errors(include_url=False, include_context=False, include_input=False):
        location = ".".join(
            (
                str(part)
                if isinstance(part, str) and part in _VALIDATION_LOCATION_PARTS
                else "<index>"
                if isinstance(part, int)
                else "<unknown>"
            )
            for part in item["loc"]
        )
        signatures.append(f"{location or '<root>'}:{item['type']}")
    return signatures


def _bind_search_query_to_tool_evidence(
    decision: AgentDecision,
    tool_uses: list[ToolUseBlock],
    tool_results: dict[str, ToolResultBlock],
    *,
    expected_graph_version: str,
) -> AgentDecision:
    """Use the successful resolving query when structured output paraphrases it."""

    search_uses = [
        tool_use for tool_use in tool_uses if tool_use.name == "mcp__codegate__knowledge_search"
    ]
    if not search_uses or any(
        tool_use.input.get("query") == decision.search_query for tool_use in search_uses
    ):
        return decision
    if decision.outcome is AgentOutcome.NOT_FOUND:
        empty_queries: list[tuple[float, str]] = []
        for tool_use in search_uses:
            query = tool_use.input.get("query")
            if not isinstance(query, str) or not query or len(query) > 4_000:
                continue
            try:
                payload = _validated_tool_result_payload(
                    tool_use,
                    tool_results.get(tool_use.id),
                    expected_graph_version=expected_graph_version,
                )
            except AgentGatewayError:
                continue
            alignment = _query_alignment_score(decision.search_query, query)
            if payload.get("documents") == [] and alignment > 0:
                empty_queries.append((alignment, query))
        if empty_queries:
            _, query = max(empty_queries, key=lambda candidate: candidate[0])
            return decision.model_copy(update={"search_query": query})
        return decision
    if decision.outcome is not AgentOutcome.READY:
        return decision
    candidates: list[tuple[float, str]] = []
    for tool_use in search_uses:
        query = tool_use.input.get("query")
        if not isinstance(query, str) or not query or len(query) > 4_000:
            continue
        try:
            payload = _validated_tool_result_payload(
                tool_use,
                tool_results.get(tool_use.id),
                expected_graph_version=expected_graph_version,
            )
        except AgentGatewayError:
            continue
        document_ids = _search_result_document_ids(payload)
        target = decision.target_document_id
        if target is not None and target not in document_ids:
            continue
        if target is None and not document_ids:
            continue
        alignment = _query_alignment_score(decision.search_query, query)
        if alignment > 0:
            candidates.append((alignment, query))
    if candidates:
        _, query = max(candidates, key=lambda candidate: candidate[0])
        return decision.model_copy(update={"search_query": query})
    return decision


_GENERIC_QUERY_TERMS = frozenset(
    {
        "근거",
        "내용",
        "담당자",
        "문서",
        "변경",
        "이름",
        "파일",
        "확인",
    }
)


def _query_alignment_score(structured_query: str, tool_query: str) -> float:
    structured = unicodedata.normalize("NFKC", structured_query).casefold()
    actual = unicodedata.normalize("NFKC", tool_query).casefold()
    if structured == actual:
        return 100.0
    structured_terms = set(re.findall(r"[0-9a-z가-힣]+", structured))
    actual_terms = set(re.findall(r"[0-9a-z가-힣]+", actual))
    shared = structured_terms & actual_terms
    distinctive = {term for term in shared if len(term) >= 2 and term not in _GENERIC_QUERY_TERMS}
    filenames = set(
        re.findall(r"[^/\\\s]+\.(?:hwp|hwpx|pdf|docx?|xlsx?|md|txt)", structured)
    ) & set(re.findall(r"[^/\\\s]+\.(?:hwp|hwpx|pdf|docx?|xlsx?|md|txt)", actual))
    if not distinctive and not filenames:
        return 0.0
    union = structured_terms | actual_terms
    return len(distinctive) * 2.0 + len(filenames) * 10.0 + len(shared) / max(1, len(union))


def _validate_tool_trace(
    decision: AgentDecision,
    tool_uses: list[ToolUseBlock],
    tool_results: dict[str, ToolResultBlock],
    *,
    expected_graph_version: str,
    selected_document_id: str | None,
    routing_document_ids: frozenset[str] | None = None,
) -> None:
    if any(tool_use.name not in SAFE_AGENT_TOOLS | SDK_CONTROL_TOOLS for tool_use in tool_uses):
        raise AgentGatewayError(
            "AGENT_TOOL_TRACE_INVALID",
            "Claude가 허용되지 않은 도구를 사용했습니다.",
        )
    codegate_tool_uses = [tool_use for tool_use in tool_uses if tool_use.name in SAFE_AGENT_TOOLS]
    names = [tool_use.name for tool_use in codegate_tool_uses]
    source_tool = "mcp__codegate__source_file_read"
    resolver_tools = {
        "mcp__codegate__document_get",
        "mcp__codegate__knowledge_search",
    }
    target = decision.target_document_id
    target_get_indices = [
        index
        for index, tool_use in enumerate(codegate_tool_uses)
        if tool_use.name == "mcp__codegate__document_get"
        and tool_use.input.get("document_id") == target
    ]
    if target is not None and not target_get_indices:
        raise AgentGatewayError(
            "AGENT_TOOL_TRACE_INVALID",
            "Claude가 현재 turn에서 대상 문서 ID를 검증하지 않았습니다.",
        )
    if target is not None:
        target_payloads = [
            _validated_tool_result_payload(
                codegate_tool_uses[index],
                tool_results.get(codegate_tool_uses[index].id),
                expected_graph_version=expected_graph_version,
            )
            for index in target_get_indices
        ]
        if not any(_document_id_from_result(payload) == target for payload in target_payloads):
            raise AgentGatewayError(
                "AGENT_TOOL_RESULT_INVALID",
                "Claude가 현재 turn에서 대상 문서 결과를 검증하지 못했습니다.",
            )
    if decision.outcome is AgentOutcome.TOOL_ERROR:
        if not codegate_tool_uses or not any(
            _tool_result_failed(
                tool_use,
                tool_results.get(tool_use.id),
                expected_graph_version=expected_graph_version,
            )
            for tool_use in codegate_tool_uses
        ):
            raise AgentGatewayError(
                "AGENT_TOOL_TRACE_INVALID",
                "Claude의 tool_error 결정에 현재 turn의 실패한 도구 결과가 없습니다.",
            )
        return
    if decision.outcome is AgentOutcome.NOT_FOUND:
        if len(codegate_tool_uses) == 1:
            tool_use = codegate_tool_uses[0]
            if (
                tool_use.name == "mcp__codegate__knowledge_search"
                and tool_use.input.get("query") == decision.search_query
            ):
                try:
                    payload = _validated_tool_result_payload(
                        tool_use,
                        tool_results.get(tool_use.id),
                        expected_graph_version=expected_graph_version,
                    )
                except AgentGatewayError:
                    pass
                else:
                    if payload.get("documents") == []:
                        return
        raise AgentGatewayError(
            "AGENT_TOOL_TRACE_INVALID",
            "Claude의 not_found 결정에 현재 turn의 빈 검색 결과가 없습니다.",
        )
    if decision.outcome is not AgentOutcome.READY:
        return
    result_payloads = {
        tool_use.id: _validated_tool_result_payload(
            tool_use,
            tool_results.get(tool_use.id),
            expected_graph_version=expected_graph_version,
        )
        for tool_use in codegate_tool_uses
    }
    search_indices = [
        index
        for index, tool_use in enumerate(codegate_tool_uses)
        if tool_use.name == "mcp__codegate__knowledge_search"
    ]
    matching_search_indices = [
        index
        for index in search_indices
        if codegate_tool_uses[index].input.get("query") == decision.search_query
    ]
    matching_target_search_indices = [
        index
        for index in matching_search_indices
        if target is not None
        and target in _search_result_document_ids(result_payloads[codegate_tool_uses[index].id])
    ]
    if search_indices and not matching_search_indices:
        raise AgentGatewayError(
            "AGENT_TOOL_TRACE_INVALID",
            "Claude의 검색 도구 입력과 구조화 search_query가 일치하지 않습니다.",
        )
    if target is not None:
        target_get_index = target_get_indices[0]
        direct_history_target = (
            selected_document_id is None
            and routing_document_ids is not None
            and target in routing_document_ids
        )
        if selected_document_id == target or direct_history_target:
            target_resolved_in_order = target_get_index == 0
        else:
            target_resolved_in_order = any(
                search_index < target_get_index for search_index in matching_target_search_indices
            )
        if not target_resolved_in_order:
            raise AgentGatewayError(
                "AGENT_TOOL_TRACE_INVALID",
                "Claude의 검색과 대상 문서 확인 순서가 현재 routing hint와 일치하지 않습니다.",
            )
    if decision.intent == "create_file":
        canonical_tool = "mcp__codegate__knowledge_document_read"
        canonical_indices = [index for index, name in enumerate(names) if name == canonical_tool]
        source_ids = decision.source_document_ids
        if (
            len(canonical_indices) != len(source_ids)
            or source_tool in names
            or target is None
            or not source_ids
            or target != source_ids[0]
        ):
            raise AgentGatewayError(
                "AGENT_TOOL_TRACE_INVALID",
                "Claude가 현재 turn의 새 문서 근거 확인 계약을 지키지 않았습니다.",
            )
        source_get_indices: dict[str, int] = {}
        for source_id in source_ids:
            get_indices = [
                index
                for index, tool_use in enumerate(codegate_tool_uses)
                if tool_use.name == "mcp__codegate__document_get"
                and tool_use.input.get("document_id") == source_id
            ]
            if len(get_indices) != 1:
                raise AgentGatewayError(
                    "AGENT_TOOL_TRACE_INVALID",
                    "Claude가 생성 근거 문서를 현재 turn에서 각각 한 번 확인하지 않았습니다.",
                )
            get_index = get_indices[0]
            get_payload = result_payloads[codegate_tool_uses[get_index].id]
            if _document_id_from_result(get_payload) != source_id:
                raise AgentGatewayError(
                    "AGENT_TOOL_RESULT_INVALID",
                    "Claude가 생성 근거 문서 결과를 검증하지 못했습니다.",
                )
            source_get_indices[source_id] = get_index
        direct_source_ids = {
            source_id
            for source_id in source_ids
            if source_id == selected_document_id
            or (
                selected_document_id is None
                and routing_document_ids is not None
                and source_id in routing_document_ids
            )
        }
        if any(
            source_id not in direct_source_ids
            and not any(
                search_index < source_get_indices[source_id]
                and source_id
                in _search_result_document_ids(
                    result_payloads[codegate_tool_uses[search_index].id]
                )
                for search_index in matching_search_indices
            )
            for source_id in source_ids
        ):
            raise AgentGatewayError(
                "AGENT_TOOL_TRACE_INVALID",
                "Claude의 생성 근거 문서가 현재 검색 결과와 일치하지 않습니다.",
            )
        if list(source_get_indices.values()) != sorted(source_get_indices.values()):
            raise AgentGatewayError(
                "AGENT_TOOL_TRACE_INVALID",
                "Claude가 생성 근거 문서를 결정된 순서대로 확인하지 않았습니다.",
            )
        canonical_ids: list[str] = []
        for canonical_index in canonical_indices:
            canonical_use = codegate_tool_uses[canonical_index]
            canonical_payload = result_payloads[canonical_use.id]
            canonical_id = canonical_use.input.get("document_id")
            if (
                not isinstance(canonical_id, str)
                or canonical_payload.get("document_id") != canonical_id
                or canonical_id not in source_get_indices
                or source_get_indices[canonical_id] >= canonical_index
            ):
                raise AgentGatewayError(
                    "AGENT_TOOL_TRACE_INVALID",
                    "Claude의 새 문서 근거 확인 순서나 대상이 일치하지 않습니다.",
                )
            canonical_ids.append(canonical_id)
        expected_tail = list(
            range(len(codegate_tool_uses) - len(source_ids), len(codegate_tool_uses))
        )
        if canonical_ids != source_ids or canonical_indices != expected_tail:
            raise AgentGatewayError(
                "AGENT_TOOL_TRACE_INVALID",
                "Claude가 검증된 모든 생성 근거를 순서대로 읽지 않았습니다.",
            )
        return
    if decision.intent == "locate":
        post_target_searches_are_scoped = True
        if target is not None:
            for index in range(target_get_indices[0] + 1, len(codegate_tool_uses)):
                tool_use = codegate_tool_uses[index]
                if (
                    tool_use.name != "mcp__codegate__knowledge_search"
                    or tool_use.input.get("query") != decision.search_query
                    or target not in _search_result_document_ids(result_payloads[tool_use.id])
                ):
                    post_target_searches_are_scoped = False
                    break
        if (
            source_tool in names
            or "mcp__codegate__knowledge_document_read" in names
            or not any(name in resolver_tools for name in names)
            or not post_target_searches_are_scoped
            or (target is not None and not matching_target_search_indices)
            or (target is None and not search_indices)
            or (
                target is None
                and not any(
                    _search_result_document_ids(result_payloads[codegate_tool_uses[index].id])
                    for index in matching_search_indices
                )
            )
        ):
            raise AgentGatewayError(
                "AGENT_TOOL_TRACE_INVALID",
                "Claude가 현재 turn의 위치 검색 도구 계약을 지키지 않았습니다.",
            )
        return

    if decision.intent == "delete_file":
        if (
            target is None
            or source_tool in names
            or "mcp__codegate__knowledge_document_read" in names
        ):
            raise AgentGatewayError(
                "AGENT_TOOL_TRACE_INVALID",
                "Claude가 현재 turn의 파일 삭제 대상 확인 계약을 지키지 않았습니다.",
            )
        return

    source_indices = [index for index, name in enumerate(names) if name == source_tool]
    if len(source_indices) != 1:
        raise AgentGatewayError(
            "AGENT_TOOL_TRACE_INVALID",
            "Claude가 현재 turn의 원본 확인 도구 계약을 지키지 않았습니다.",
        )
    source_index = source_indices[0]
    source_input = codegate_tool_uses[source_index].input
    source_payload = result_payloads[codegate_tool_uses[source_index].id]
    resolved_before_source = any(
        tool_use.name == "mcp__codegate__document_get"
        and tool_use.input.get("document_id") == target
        for tool_use in codegate_tool_uses[:source_index]
    )
    if (
        source_input.get("document_id") != target
        or not resolved_before_source
        or source_index != len(codegate_tool_uses) - 1
    ):
        raise AgentGatewayError(
            "AGENT_TOOL_TRACE_INVALID",
            "Claude의 대상 확인과 원본 확인 순서가 일치하지 않습니다.",
        )
    canonical_indices = [
        index
        for index, name in enumerate(names)
        if name == "mcp__codegate__knowledge_document_read"
    ]
    if any(
        not (
            target_get_indices[0] < index < source_index
            and codegate_tool_uses[index].input.get("document_id") == target
        )
        for index in canonical_indices
    ):
        raise AgentGatewayError(
            "AGENT_TOOL_TRACE_INVALID",
            "Claude의 canonical 문서 확인 순서나 대상이 일치하지 않습니다.",
        )
    if (
        source_payload.get("document_id") != target
        or source_payload.get("source_sha256") != decision.source_sha256
        or source_payload.get("provenance", {}).get("source_kind") != "current_source"
    ):
        raise AgentGatewayError(
            "AGENT_TOOL_RESULT_INVALID",
            "Claude의 변경 결정이 현재 원본 도구 결과와 일치하지 않습니다.",
        )


def _validated_tool_result_payload(
    tool_use: ToolUseBlock,
    result: ToolResultBlock | None,
    *,
    expected_graph_version: str,
) -> dict[str, Any]:
    if result is None or result.is_error:
        raise AgentGatewayError(
            "AGENT_TOOL_RESULT_INVALID",
            "Claude가 실패하거나 누락된 도구 결과를 ready 결정에 사용했습니다.",
        )
    payload = _decode_tool_result_payload(result.content)
    provenance = payload.get("provenance") if payload is not None else None
    if (
        payload is None
        or payload.get("tool_contract_version") != TOOL_CONTRACT_VERSION
        or not isinstance(provenance, dict)
        or provenance.get("trust") != "untrusted_content"
        or provenance.get("graph_version") != expected_graph_version
        or provenance.get("source_kind") != EXPECTED_TOOL_SOURCE_KINDS.get(tool_use.name)
    ):
        raise AgentGatewayError(
            "AGENT_TOOL_RESULT_INVALID",
            f"Claude 도구 결과 계약이 유효하지 않습니다: {tool_use.name}",
        )
    _validate_tool_result_shape(tool_use, payload)
    return payload


def _tool_result_failed(
    tool_use: ToolUseBlock,
    result: ToolResultBlock | None,
    *,
    expected_graph_version: str,
) -> bool:
    if result is None or result.is_error:
        return True
    try:
        _validated_tool_result_payload(
            tool_use,
            result,
            expected_graph_version=expected_graph_version,
        )
    except AgentGatewayError:
        return True
    return False


def _decode_tool_result_payload(
    content: str | list[dict[str, Any]] | None,
) -> dict[str, Any] | None:
    candidates: list[str] = []
    if isinstance(content, str):
        candidates.append(content)
    elif isinstance(content, list):
        candidates.extend(
            str(block["text"])
            for block in content
            if isinstance(block, dict) and block.get("type") == "text" and "text" in block
        )
    for candidate in candidates:
        try:
            payload = json.loads(candidate)
        except (json.JSONDecodeError, TypeError):
            continue
        if isinstance(payload, dict):
            return payload
    return None


def _document_id_from_result(payload: dict[str, Any]) -> str | None:
    document = payload.get("document")
    if not isinstance(document, dict):
        return None
    document_id = document.get("document_id")
    return str(document_id) if isinstance(document_id, str) else None


def _search_result_document_ids(payload: dict[str, Any]) -> set[str]:
    documents = payload.get("documents")
    if not isinstance(documents, list):
        return set()
    return {
        str(document["document_id"])
        for document in documents
        if isinstance(document, dict) and isinstance(document.get("document_id"), str)
    }


def _validate_tool_result_shape(tool_use: ToolUseBlock, payload: dict[str, Any]) -> None:
    tool_name = tool_use.name
    requested_document_id = tool_use.input.get("document_id")
    valid = False
    if tool_name == "mcp__codegate__knowledge_search":
        valid = isinstance(payload.get("documents"), list)
    elif tool_name == "mcp__codegate__document_get":
        valid = _document_id_from_result(payload) == requested_document_id
    elif tool_name == "mcp__codegate__knowledge_document_read":
        valid = payload.get("document_id") == requested_document_id and isinstance(
            payload.get("content"), str
        )
    elif tool_name == "mcp__codegate__source_file_read":
        valid = (
            payload.get("document_id") == requested_document_id
            and isinstance(payload.get("source_sha256"), str)
            and isinstance(payload.get("content"), str)
        )
    if not valid:
        raise AgentGatewayError(
            "AGENT_TOOL_RESULT_INVALID",
            f"Claude 도구 결과 payload가 유효하지 않습니다: {tool_name}",
        )


def _canonical_session_id(value: str) -> str:
    try:
        parsed = UUID(value)
    except (ValueError, AttributeError) as error:
        raise AgentGatewayError(
            "AGENT_SESSION_INVALID",
            "Claude Agent SDK session ID가 UUID 형식이 아닙니다.",
        ) from error
    canonical = str(parsed)
    if value.lower() != canonical:
        raise AgentGatewayError(
            "AGENT_SESSION_INVALID",
            "Claude Agent SDK session ID가 canonical UUID 형식이 아닙니다.",
        )
    return canonical


def _extract_document_id(message: str) -> str | None:
    match = _DOCUMENT_ID_REFERENCE_PATTERN.search(message)
    if match is None:
        return None
    document_id = match.group(0)
    return document_id if len(document_id) <= 96 else None


def _routing_document_ids(
    message: str,
    conversation_history: list[dict[str, str | None]] | None,
) -> frozenset[str]:
    current_ids = _document_ids_in_text(message)
    if current_ids:
        return current_ids if len(current_ids) == 1 else frozenset()
    for item in reversed(conversation_history or []):
        if item.get("role") != "user":
            continue
        history_ids = _document_ids_in_text(str(item.get("content", "")))
        if history_ids:
            return history_ids if len(history_ids) == 1 else frozenset()
    return frozenset()


def _document_ids_in_text(value: str) -> frozenset[str]:
    return frozenset(
        document_id
        for document_id in _DOCUMENT_ID_REFERENCE_PATTERN.findall(value)
        if len(document_id) <= 96
    )


def _parse_replace_operation(message: str) -> ReplaceExactOperation | None:
    if re.search(r"지워|삭제|제거|없애|비워", message, re.IGNORECASE):
        quoted_delete = re.search(
            r"[\"'“‘](?P<old>.+?)[\"'”’]\s*(?:을|를)?\s*"
            r"(?:지워|삭제|제거|없애|비워)",
            message,
            re.IGNORECASE,
        )
        if quoted_delete:
            return ReplaceExactOperation(
                expected_text=quoted_delete.group("old"),
                replacement_text="",
            )
    if not re.search(r"바꿔|변경|수정|교체|replace", message, re.IGNORECASE):
        return None
    quoted = re.search(
        r"[\"'“‘](?P<old>.+?)[\"'”’]\s*(?:을|를)?\s*"
        r"[\"'“‘](?P<new>.+?)[\"'”’]\s*(?:으로|로)",
        message,
    )
    if quoted:
        return ReplaceExactOperation(
            expected_text=quoted.group("old"),
            replacement_text=quoted.group("new"),
        )
    unquoted = re.search(
        r"(?P<old>[^\s]+?)(?:을|를)\s+(?P<new>[^\s]+?)(?:으로|로)\s*"
        r"(?:바꿔|변경|수정|교체)",
        message,
    )
    if unquoted:
        return ReplaceExactOperation(
            expected_text=unquoted.group("old"),
            replacement_text=unquoted.group("new"),
        )
    return None


def _is_whole_file_deletion_request(message: str) -> bool:
    return (
        re.search(
            r"(?:파일|원본)\s*(?:을|를)?\s*(?:전부\s*)?(?:다\s*)?"
            r"(?:지워|삭제|제거|없애)(?:\s*해)?(?:\s*줘|\s*주세요)?",
            message,
            re.IGNORECASE,
        )
        is not None
    )


def _requested_hwpx_filename(message: str) -> str | None:
    match = re.search(r"(?<![/\\\w])([^/\\\s]+\.hwpx)(?![A-Za-z0-9])", message, re.IGNORECASE)
    return match.group(1) if match is not None else None


def _is_file_creation_request(message: str) -> bool:
    return re.search(r"(?:만들|생성|작성)(?:어|해)?(?:\s*줘|\s*주세요)?", message) is not None


def _creation_search_query(message: str, filename: str) -> str:
    query = message.replace(filename, " ")
    query = re.sub(r"(?:만들|생성|작성)(?:어|해)?(?:\s*줘|\s*주세요)?", " ", query)
    source_clause = re.split(
        r"(?:참고해서|참고하여|참고해|[을를]\s+보고)(?:\s|$)",
        query,
        maxsplit=1,
    )[0]
    if source_clause.strip():
        query = source_clause
    query = re.sub(r"\s+", " ", query).strip(" .,!?")
    if re.search(r"업무\s*보고", query):
        return "업무 진행사항 기록 주간 성과 데이터 리포트"
    return query or "참고 문서"


def _creation_routing_context(message: str) -> dict[str, str] | None:
    filename = _requested_hwpx_filename(message)
    if filename is None or not _is_file_creation_request(message):
        return None
    return {
        "intent": "create_file",
        "target_filename": filename,
        "source_search_query": _creation_search_query(message, filename),
        "source_selection": "all_directly_relevant_results",
    }
