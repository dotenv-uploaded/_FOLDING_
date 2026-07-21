import json
from functools import partial
from pathlib import Path
from typing import Any

import anyio
import pytest
from claude_agent_sdk import ClaudeSDKClient, ResultMessage

from codegate_api.agent.gateway import AgentGatewayError, ClaudeAgentGateway
from codegate_api.agent.runtime import (
    SAFE_AGENT_TOOLS,
    build_claude_agent_options,
    create_claude_agent_client,
    enforce_tool_allowlist,
)
from codegate_api.config import Settings
from codegate_api.files.resolver import SourceUriResolver
from codegate_api.knowledge.access import AccessContext
from codegate_api.knowledge.repository import KnowledgeRepository
from codegate_api.knowledge.schemas import AccessLevel


def _repository() -> KnowledgeRepository:
    return KnowledgeRepository(
        Path("demo/llm-wiki"),
        SourceUriResolver(Path("demo/source")),
    )


def test_claude_agent_options_disable_builtin_tools() -> None:
    options = build_claude_agent_options(
        _repository(),
        working_directory=Path("demo/source"),
        state_directory=Path(".runtime/test-claude"),
        access_context=AccessContext.anonymous(),
    )

    assert options.tools == []
    assert options.permission_mode == "dontAsk"
    assert options.setting_sources == []
    assert options.skills == []
    assert options.allowed_tools == sorted(SAFE_AGENT_TOOLS)
    assert "AGENT_GUIDE.md" in str(options.system_prompt)
    assert "graph_version" in str(options.system_prompt)
    assert "아래 설명문은 사람을 위한 것" not in str(options.system_prompt)
    assert options.env == {
        "CLAUDE_CONFIG_DIR": str(Path(".runtime/test-claude").resolve()),
        "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1",
        "CLAUDE_CODE_SKIP_PROMPT_HISTORY": "1",
    }
    assert "Edit" in options.disallowed_tools
    assert "Bash" in options.disallowed_tools
    assert set(options.mcp_servers) == {"codegate"}


def test_pre_tool_hook_denies_tools_outside_allowlist() -> None:
    denied = anyio.run(
        enforce_tool_allowlist,
        {"tool_name": "Edit", "tool_input": {"file_path": "/tmp/example"}},
        None,
        {},
    )
    allowed = anyio.run(
        enforce_tool_allowlist,
        {"tool_name": "mcp__codegate__knowledge_search", "tool_input": {"query": "보안"}},
        None,
        {},
    )

    assert denied["hookSpecificOutput"]["permissionDecision"] == "deny"
    assert allowed == {}


def test_claude_sdk_client_can_be_constructed_without_starting_a_session() -> None:
    client = create_claude_agent_client(
        _repository(),
        working_directory=Path("demo/source"),
        state_directory=Path(".runtime/test-claude"),
        access_context=AccessContext.anonymous(),
    )

    assert isinstance(client, ClaudeSDKClient)


def test_claude_gateway_uses_server_owned_session_and_structured_output(
    monkeypatch: Any,
    tmp_path: Path,
) -> None:
    captured: dict[str, Any] = {}

    class FakeClient:
        def __init__(self, options: Any) -> None:
            captured["options"] = options

        async def __aenter__(self) -> "FakeClient":
            return self

        async def __aexit__(self, *_: object) -> None:
            captured["disconnected"] = True

        async def query(self, prompt: str) -> None:
            captured["prompt"] = prompt

        async def receive_response(self):  # type: ignore[no-untyped-def]
            options = captured["options"]
            session_id = options.resume or options.session_id
            yield ResultMessage(
                subtype="success",
                duration_ms=1,
                duration_api_ms=1,
                is_error=False,
                num_turns=1,
                session_id=str(session_id),
                structured_output={
                    "intent": "change",
                    "assistant_text": "변경안을 확인합니다.",
                    "search_query": "개인정보 1년",
                    "target_document_id": "REG-000001",
                    "operation": {
                        "type": "replace_exact",
                        "expected_text": "1년",
                        "replacement_text": "3년",
                        "expected_occurrences": 1,
                    },
                },
            )

    monkeypatch.setattr("codegate_api.agent.gateway.ClaudeSDKClient", FakeClient)
    repository = _repository()
    repository.load()
    gateway = ClaudeAgentGateway(
        Settings(
            agent_mode="claude",
            source_root=Path("demo/source"),
            agent_state_root=tmp_path / "claude",
        )
    )
    context = AccessContext(
        subject_id="user-1",
        tenant_id="tenant-1",
        readable_access=frozenset({AccessLevel.PUBLIC}),
        writable_document_ids=frozenset({"REG-000001"}),
    )

    result = anyio.run(
        partial(
            gateway.decide,
            message='"1년"을 "3년"으로 변경',
            selected_document_id="REG-000001",
            conversation_id="conversation-1",
            repository=repository,
            access_context=context,
        )
    )

    assert result.provider == "claude-agent-sdk"
    assert result.decision.operation is not None
    assert result.decision.operation.replacement_text == "3년"
    assert captured["disconnected"] is True
    assert len(str(result.session_id)) == 36
    assert captured["options"].session_id == result.session_id
    assert captured["options"].resume is None
    assert captured["options"].output_format["type"] == "json_schema"
    assert "AGENT_GUIDE.md" in str(captured["options"].system_prompt)
    assert json.loads(captured["prompt"]) == {
        "contract_version": "1.0",
        "selected_document_id": "REG-000001",
        "untrusted_user_message": '"1년"을 "3년"으로 변경',
    }


def test_claude_gateway_resumes_the_stored_sdk_session(
    monkeypatch: Any,
    tmp_path: Path,
) -> None:
    captured: dict[str, Any] = {}

    class FakeClient:
        def __init__(self, options: Any) -> None:
            captured["options"] = options

        async def __aenter__(self) -> "FakeClient":
            return self

        async def __aexit__(self, *_: object) -> None:
            return None

        async def query(self, prompt: str) -> None:
            captured["prompt"] = prompt

        async def receive_response(self):  # type: ignore[no-untyped-def]
            yield ResultMessage(
                subtype="success",
                duration_ms=1,
                duration_api_ms=1,
                is_error=False,
                num_turns=1,
                session_id="11111111-1111-4111-8111-111111111111",
                structured_output={
                    "intent": "locate",
                    "assistant_text": "근거를 찾습니다.",
                    "search_query": "개인정보",
                    "target_document_id": None,
                    "operation": None,
                },
            )

    monkeypatch.setattr("codegate_api.agent.gateway.ClaudeSDKClient", FakeClient)
    repository = _repository()
    repository.load()
    gateway = ClaudeAgentGateway(
        Settings(
            agent_mode="claude",
            source_root=Path("demo/source"),
            agent_state_root=tmp_path / "claude",
        )
    )
    resume_session_id = "11111111-1111-4111-8111-111111111111"

    result = anyio.run(
        partial(
            gateway.decide,
            message="앞 질문과 같은 문서야?",
            selected_document_id=None,
            conversation_id="conversation-1",
            repository=repository,
            access_context=AccessContext.anonymous(),
            resume_session_id=resume_session_id,
        )
    )

    assert result.session_id == resume_session_id
    assert captured["options"].resume == resume_session_id
    assert captured["options"].session_id is None


def test_claude_gateway_rejects_non_uuid_resume_session(tmp_path: Path) -> None:
    repository = _repository()
    repository.load()
    gateway = ClaudeAgentGateway(
        Settings(
            agent_mode="claude",
            source_root=Path("demo/source"),
            agent_state_root=tmp_path / "claude",
        )
    )

    with pytest.raises(AgentGatewayError, match="UUID"):
        anyio.run(
            partial(
                gateway.decide,
                message="문서 찾아줘",
                selected_document_id=None,
                conversation_id="conversation-1",
                repository=repository,
                access_context=AccessContext.anonymous(),
                resume_session_id="../../outside",
            )
        )
