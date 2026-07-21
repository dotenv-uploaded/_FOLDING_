from __future__ import annotations

import asyncio
import re
from typing import Literal, Protocol
from uuid import UUID, uuid4

from claude_agent_sdk import ClaudeSDKClient, ResultMessage
from pydantic import BaseModel, ConfigDict, Field

from codegate_api.agent.instructions import build_turn_prompt
from codegate_api.agent.runtime import build_claude_agent_options
from codegate_api.config import Settings
from codegate_api.knowledge.access import AccessContext
from codegate_api.knowledge.repository import KnowledgeRepository
from codegate_api.knowledge.schemas import DOCUMENT_ID_PATTERN
from codegate_api.models import ReplaceExactOperation


class AgentGatewayError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class AgentDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    intent: Literal["locate", "change"]
    assistant_text: str = Field(min_length=1, max_length=2_000)
    search_query: str = Field(min_length=1, max_length=4_000)
    target_document_id: str | None = Field(
        default=None,
        pattern=DOCUMENT_ID_PATTERN,
        max_length=96,
    )
    operation: ReplaceExactOperation | None = None


class AgentRunResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    decision: AgentDecision
    provider: str
    session_id: str | None = None


class AgentGateway(Protocol):
    async def decide(
        self,
        *,
        message: str,
        selected_document_id: str | None,
        conversation_id: str,
        repository: KnowledgeRepository,
        access_context: AccessContext,
        resume_session_id: str | None = None,
    ) -> AgentRunResult: ...


class DeterministicAgentGateway:
    async def decide(
        self,
        *,
        message: str,
        selected_document_id: str | None,
        conversation_id: str,
        repository: KnowledgeRepository,
        access_context: AccessContext,
        resume_session_id: str | None = None,
    ) -> AgentRunResult:
        del conversation_id, repository, access_context, resume_session_id
        operation = _parse_replace_operation(message)
        document_id = selected_document_id or _extract_document_id(message)
        if operation is not None:
            return AgentRunResult(
                provider="deterministic",
                decision=AgentDecision(
                    intent="change",
                    assistant_text="실제 원본을 기준으로 변경 미리보기를 만들겠습니다.",
                    search_query=message,
                    target_document_id=document_id,
                    operation=operation,
                ),
            )
        return AgentRunResult(
            provider="deterministic",
            decision=AgentDecision(
                intent="locate",
                assistant_text="관련 문서와 근거를 찾았습니다.",
                search_query=message,
                target_document_id=document_id,
            ),
        )


class ClaudeAgentGateway:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    async def decide(
        self,
        *,
        message: str,
        selected_document_id: str | None,
        conversation_id: str,
        repository: KnowledgeRepository,
        access_context: AccessContext,
        resume_session_id: str | None = None,
    ) -> AgentRunResult:
        del conversation_id
        session_id = str(uuid4())
        effective_session_id = _canonical_session_id(resume_session_id or session_id)
        state_root = self._settings.resolved_agent_state_root()
        state_directory = (state_root / effective_session_id).resolve()
        if not state_directory.is_relative_to(state_root):
            raise AgentGatewayError(
                "AGENT_SESSION_INVALID", "Claude session 경로가 유효하지 않습니다."
            )
        options = build_claude_agent_options(
            repository,
            working_directory=self._settings.resolved_source_root(),
            state_directory=state_directory,
            access_context=access_context,
            output_schema=AgentDecision.model_json_schema(),
            model=self._settings.claude_model,
            session_id=None if resume_session_id else session_id,
            resume=resume_session_id,
        )
        prompt = build_turn_prompt(
            user_message=message,
            selected_document_id=selected_document_id,
        )
        try:
            async with asyncio.timeout(self._settings.claude_timeout_seconds):
                async with ClaudeSDKClient(options=options) as client:
                    await client.query(prompt)
                    async for response in client.receive_response():
                        if not isinstance(response, ResultMessage):
                            continue
                        if response.subtype != "success" or response.structured_output is None:
                            raise AgentGatewayError(
                                "AGENT_RESULT_INVALID",
                                "Claude Agent SDK가 검증된 구조화 결과를 반환하지 못했습니다.",
                            )
                        returned_session_id = _canonical_session_id(response.session_id)
                        if returned_session_id != effective_session_id:
                            raise AgentGatewayError(
                                "AGENT_SESSION_MISMATCH",
                                "Claude Agent SDK session ID가 요청한 session과 다릅니다.",
                            )
                        return AgentRunResult(
                            provider="claude-agent-sdk",
                            session_id=returned_session_id,
                            decision=AgentDecision.model_validate(response.structured_output),
                        )
        except TimeoutError as error:
            raise AgentGatewayError(
                "AGENT_TIMEOUT", "Claude 응답 시간이 초과되었습니다."
            ) from error
        except AgentGatewayError:
            raise
        except Exception as error:
            raise AgentGatewayError(
                "AGENT_UNAVAILABLE", "Claude Agent SDK 호출에 실패했습니다."
            ) from error
        raise AgentGatewayError("AGENT_RESULT_MISSING", "Claude 최종 응답을 받지 못했습니다.")


def build_agent_gateway(settings: Settings) -> AgentGateway:
    if settings.agent_mode == "claude":
        return ClaudeAgentGateway(settings)
    return DeterministicAgentGateway()


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
    match = re.search(r"\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+\b", message)
    return match.group(0) if match else None


def _parse_replace_operation(message: str) -> ReplaceExactOperation | None:
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
