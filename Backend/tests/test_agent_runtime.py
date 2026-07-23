import json
from functools import partial
from pathlib import Path
from typing import Any

import anyio
import pytest
from claude_agent_sdk import (
    AssistantMessage,
    ClaudeSDKClient,
    ResultMessage,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
    project_key_for_directory,
)
from pydantic import ValidationError

from codegate_api.agent.gateway import (
    AgentDecision,
    AgentGatewayError,
    AgentStructuredOutput,
    ClaudeAgentGateway,
    _bind_search_query_to_tool_evidence,
    _classify_sdk_result_error,
    _extract_document_id,
    _normalize_structured_enum_casing,
    _routing_document_ids,
    _validate_tool_trace,
    _validation_error_signature,
)
from codegate_api.agent.runtime import (
    ALLOWED_AGENT_TOOLS,
    build_claude_agent_options,
    create_claude_agent_client,
    enforce_tool_allowlist,
)
from codegate_api.agent.session_store import LocalJsonlSessionStore
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


def test_deterministic_document_id_extraction_respects_schema_length() -> None:
    assert _extract_document_id("REG-000001 문서") == "REG-000001"
    assert _extract_document_id("REG-000001의 문서") == "REG-000001"
    assert _extract_document_id(f"{'A' * 96}-X 문서") is None


def test_routing_document_ids_support_korean_particles_in_recent_user_context() -> None:
    history = [
        {
            "role": "user",
            "content": "REG-000001의 개인정보 보관 기간을 확인해줘",
            "response_type": None,
        },
        {
            "role": "assistant",
            "content": "REG-999999의 값이라고 답했습니다.",
            "response_type": "location_result",
        },
    ]

    assert _routing_document_ids("그 값을 지워줘", history) == frozenset({"REG-000001"})


def test_routing_document_ids_use_only_the_most_recent_unambiguous_user_reference() -> None:
    history = [
        {"role": "user", "content": "REG-000001을 찾아줘", "response_type": None},
        {"role": "assistant", "content": "찾았습니다.", "response_type": "location_result"},
        {"role": "user", "content": "MAN-000001을 확인해줘", "response_type": None},
    ]

    assert _routing_document_ids("그 값을 지워줘", history) == frozenset({"MAN-000001"})
    assert _routing_document_ids("REG-000001과 MAN-000001을 비교해줘", history) == frozenset()


def test_validation_error_signature_redacts_model_supplied_field_names() -> None:
    with pytest.raises(ValidationError) as raised:
        AgentStructuredOutput.model_validate(
            {
                "decision": {
                    "prompt_contract_version": "2.1",
                    "decision_type": "ready_locate",
                    "assistant_text": "근거를 확인했습니다.",
                    "search_query": "개인정보",
                    "target_document_id": "REG-000001",
                    "private-document-value": "must-not-log",
                }
            }
        )

    signature = _validation_error_signature(raised.value)

    assert "private-document-value" not in repr(signature)
    assert "must-not-log" not in repr(signature)
    assert any("<unknown>:extra_forbidden" in item for item in signature)


def _tool_result_block(
    tool_use_id: str,
    source_kind: str,
    payload: dict[str, Any],
) -> ToolResultBlock:
    return ToolResultBlock(
        tool_use_id=tool_use_id,
        content=json.dumps(
            {
                "tool_contract_version": "2.0",
                "provenance": {
                    "trust": "untrusted_content",
                    "source_kind": source_kind,
                    "graph_version": "2026-07-21.2-demo",
                },
                **payload,
            },
            ensure_ascii=False,
        ),
        is_error=False,
    )


def _tool_result_message(
    tool_use_id: str,
    source_kind: str,
    payload: dict[str, Any],
) -> UserMessage:
    return UserMessage(content=[_tool_result_block(tool_use_id, source_kind, payload)])


def _structured_output(decision: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {"decision": decision}


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
    assert options.allowed_tools == sorted(ALLOWED_AGENT_TOOLS)
    assert "<runtime_contract>" in str(options.system_prompt)
    assert '"prompt_contract_version":"2.1"' in str(options.system_prompt)
    assert '"document_content_trust":"untrusted"' in str(options.system_prompt)
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
    structured_output = anyio.run(
        enforce_tool_allowlist,
        {"tool_name": "StructuredOutput", "tool_input": {}},
        None,
        {},
    )

    assert denied["hookSpecificOutput"]["permissionDecision"] == "deny"
    assert allowed == {}
    assert structured_output == {}


@pytest.mark.parametrize(
    ("subtype", "is_error", "api_status", "result", "expected_code"),
    [
        ("success", True, 400, "Credit balance is too low", "AGENT_CREDIT_EXHAUSTED"),
        ("success", True, 401, "Unauthorized", "AGENT_AUTH_INVALID"),
        ("success", True, 429, "Rate limited", "AGENT_RATE_LIMITED"),
        ("success", True, 529, "Overloaded", "AGENT_UPSTREAM_UNAVAILABLE"),
        ("error_max_budget_usd", True, None, None, "AGENT_BUDGET_EXCEEDED"),
        ("success", True, 400, "Invalid request", "AGENT_UPSTREAM_REJECTED"),
        ("error_max_structured_output_retries", True, None, None, "AGENT_RESULT_INVALID"),
    ],
)
def test_sdk_result_errors_are_classified_without_exposing_provider_details(
    subtype: str,
    is_error: bool,
    api_status: int | None,
    result: str | None,
    expected_code: str,
) -> None:
    response = ResultMessage(
        subtype=subtype,
        duration_ms=1,
        duration_api_ms=1,
        is_error=is_error,
        num_turns=1,
        session_id="11111111-1111-4111-8111-111111111111",
        api_error_status=api_status,
        result=result,
    )

    error = _classify_sdk_result_error(response)

    assert error.code == expected_code
    if result:
        assert result not in str(error)


def test_structured_decision_accepts_only_documented_enum_casing_variance() -> None:
    raw = _structured_output(
        {
            "prompt_contract_version": "2.1",
            "decision_type": "Ready_Change",
            "assistant_text": "변경 미리보기를 준비합니다.",
            "search_query": "REG-000001 개인정보 보관 기간",
            "target_document_id": "REG-000001",
            "source_sha256": "a" * 64,
            "operation": {
                "type": "Replace_Exact",
                "expected_text": "1년",
                "replacement_text": "3년",
                "expected_occurrences": 1,
            },
        }
    )

    decision = AgentStructuredOutput.model_validate(
        _normalize_structured_enum_casing(raw)
    ).to_decision()

    assert decision.intent == "change"
    assert decision.operation is not None
    assert decision.operation.type == "replace_exact"


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
            yield AssistantMessage(
                content=[
                    ToolUseBlock(
                        id="tool-1",
                        name="mcp__codegate__document_get",
                        input={"document_id": "REG-000001"},
                    ),
                    ToolUseBlock(
                        id="tool-2",
                        name="mcp__codegate__source_file_read",
                        input={"document_id": "REG-000001"},
                    ),
                    ToolUseBlock(
                        id="structured-output",
                        name="StructuredOutput",
                        input={},
                    ),
                ],
                model="test-model",
            )
            yield _tool_result_message(
                "tool-1",
                "document_get",
                {"document": {"document_id": "REG-000001"}},
            )
            yield _tool_result_message(
                "tool-2",
                "current_source",
                {
                    "document_id": "REG-000001",
                    "source_sha256": (
                        "7e2d690883e207dea2880bef301fc000ea6ee384c7e7e3415e5618872a614e26"
                    ),
                    "content": "개인정보는 1년 동안 보관합니다.",
                },
            )
            yield ResultMessage(
                subtype="success",
                duration_ms=1,
                duration_api_ms=1,
                is_error=False,
                num_turns=1,
                session_id=str(session_id),
                structured_output=_structured_output(
                    {
                        "prompt_contract_version": "2.1",
                        "decision_type": "ready_change",
                        "assistant_text": "변경안을 확인합니다.",
                        "search_query": "개인정보 1년",
                        "target_document_id": "REG-000001",
                        "source_sha256": (
                            "7e2d690883e207dea2880bef301fc000ea6ee384c7e7e3415e5618872a614e26"
                        ),
                        "operation": {
                            "type": "replace_exact",
                            "expected_text": "1년",
                            "replacement_text": "3년",
                            "expected_occurrences": 1,
                        },
                    },
                ),
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
    assert result.tool_calls == [
        "mcp__codegate__document_get",
        "mcp__codegate__source_file_read",
    ]
    assert captured["disconnected"] is True
    assert len(str(result.session_id)) == 36
    assert captured["options"].session_id == result.session_id
    assert captured["options"].resume is None
    assert captured["options"].output_format["type"] == "json_schema"
    assert "<runtime_contract>" in str(captured["options"].system_prompt)
    assert json.loads(captured["prompt"]) == {
        "prompt_contract_version": "2.1",
        "trusted_context": {
            "current_graph_version": "2026-07-21.2-demo",
            "evidence_scope": "current_turn_only",
            "selected_document_id": "REG-000001",
        },
        "untrusted_input": {
            "conversation_history": [],
            "user_message": '"1년"을 "3년"으로 변경',
        },
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
            yield AssistantMessage(
                content=[
                    ToolUseBlock(
                        id="tool-1",
                        name="mcp__codegate__knowledge_search",
                        input={"query": "개인정보"},
                    )
                ],
                model="test-model",
            )
            yield _tool_result_message(
                "tool-1",
                "knowledge_search",
                {"documents": [{"document_id": "REG-000001"}]},
            )
            yield ResultMessage(
                subtype="success",
                duration_ms=1,
                duration_api_ms=1,
                is_error=False,
                num_turns=1,
                session_id="11111111-1111-4111-8111-111111111111",
                structured_output=_structured_output(
                    {
                        "prompt_contract_version": "2.1",
                        "decision_type": "ready_locate",
                        "assistant_text": "근거를 찾습니다.",
                        "search_query": "개인정보",
                        "target_document_id": None,
                    }
                ),
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
    store = LocalJsonlSessionStore(tmp_path / "claude" / "transcripts")
    anyio.run(
        store.append,
        {
            "project_key": project_key_for_directory(Path("demo/source").resolve()),
            "session_id": resume_session_id,
        },
        [{"type": "user", "uuid": "entry-1"}],
    )

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


def test_local_session_store_round_trips_entries_with_private_permissions(tmp_path: Path) -> None:
    store = LocalJsonlSessionStore(tmp_path / "transcripts")
    key = {
        "project_key": project_key_for_directory(Path("demo/source").resolve()),
        "session_id": "22222222-2222-4222-8222-222222222222",
    }
    entries = [{"type": "user", "uuid": "entry-1", "message": {"content": "질문"}}]

    anyio.run(store.append, key, entries)

    assert anyio.run(store.load, key) == entries
    transcript = next((tmp_path / "transcripts").rglob("*.jsonl"))
    assert transcript.stat().st_mode & 0o777 == 0o600
    assert transcript.parent.stat().st_mode & 0o777 == 0o700


def test_missing_resume_session_starts_a_fresh_server_owned_session(
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
            del prompt

        async def receive_response(self):  # type: ignore[no-untyped-def]
            options = captured["options"]
            yield ResultMessage(
                subtype="success",
                duration_ms=1,
                duration_api_ms=1,
                is_error=False,
                num_turns=1,
                session_id=str(options.session_id),
                structured_output=_structured_output(
                    {
                        "prompt_contract_version": "2.1",
                        "decision_type": "needs_clarification",
                        "intent": "locate",
                        "assistant_text": "대상을 더 명확히 확인해야 합니다.",
                        "search_query": "문서",
                    }
                ),
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

    result = anyio.run(
        partial(
            gateway.decide,
            message="그 문서 요약해줘",
            selected_document_id=None,
            conversation_id="conversation-1",
            repository=repository,
            access_context=AccessContext.anonymous(),
            resume_session_id="33333333-3333-4333-8333-333333333333",
        )
    )

    assert result.session_id == captured["options"].session_id
    assert captured["options"].resume is None


def test_claude_gateway_rejects_ready_decision_without_current_turn_tool_trace(
    monkeypatch: Any,
    tmp_path: Path,
) -> None:
    class FakeClient:
        def __init__(self, options: Any) -> None:
            self._session_id = options.session_id

        async def __aenter__(self) -> "FakeClient":
            return self

        async def __aexit__(self, *_: object) -> None:
            return None

        async def query(self, prompt: str) -> None:
            del prompt

        async def receive_response(self):  # type: ignore[no-untyped-def]
            yield ResultMessage(
                subtype="success",
                duration_ms=1,
                duration_api_ms=1,
                is_error=False,
                num_turns=1,
                session_id=str(self._session_id),
                structured_output=_structured_output(
                    {
                        "prompt_contract_version": "2.1",
                        "decision_type": "ready_locate",
                        "assistant_text": "근거를 찾습니다.",
                        "search_query": "개인정보",
                        "target_document_id": None,
                    }
                ),
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

    with pytest.raises(AgentGatewayError) as raised:
        anyio.run(
            partial(
                gateway.decide,
                message="개인정보 문서 찾아줘",
                selected_document_id=None,
                conversation_id="conversation-1",
                repository=repository,
                access_context=AccessContext.anonymous(),
            )
        )

    assert raised.value.code == "AGENT_TOOL_TRACE_INVALID"


def test_claude_gateway_does_not_trust_assistant_authored_tool_results(
    monkeypatch: Any,
    tmp_path: Path,
) -> None:
    class FakeClient:
        def __init__(self, options: Any) -> None:
            self._session_id = options.session_id

        async def __aenter__(self) -> "FakeClient":
            return self

        async def __aexit__(self, *_: object) -> None:
            return None

        async def query(self, prompt: str) -> None:
            del prompt

        async def receive_response(self):  # type: ignore[no-untyped-def]
            yield AssistantMessage(
                content=[
                    ToolUseBlock(
                        id="tool-1",
                        name="mcp__codegate__knowledge_search",
                        input={"query": "개인정보"},
                    ),
                    _tool_result_block(
                        "tool-1",
                        "knowledge_search",
                        {"documents": [{"document_id": "REG-000001"}]},
                    ),
                ],
                model="test-model",
            )
            yield ResultMessage(
                subtype="success",
                duration_ms=1,
                duration_api_ms=1,
                is_error=False,
                num_turns=1,
                session_id=str(self._session_id),
                structured_output=_structured_output(
                    {
                        "prompt_contract_version": "2.1",
                        "decision_type": "ready_locate",
                        "assistant_text": "근거를 찾습니다.",
                        "search_query": "개인정보",
                        "target_document_id": None,
                    }
                ),
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

    with pytest.raises(AgentGatewayError) as raised:
        anyio.run(
            partial(
                gateway.decide,
                message="개인정보 문서를 찾아줘",
                selected_document_id=None,
                conversation_id="conversation-1",
                repository=repository,
                access_context=AccessContext.anonymous(),
            )
        )

    assert raised.value.code == "AGENT_TOOL_RESULT_INVALID"


def test_ready_change_rejects_missing_current_turn_tool_results() -> None:
    decision = AgentDecision.model_validate(
        {
            "prompt_contract_version": "2.1",
            "outcome": "ready",
            "intent": "change",
            "assistant_text": "변경 미리보기를 준비합니다.",
            "search_query": "개인정보 보관 기간",
            "target_document_id": "REG-000001",
            "source_sha256": "a" * 64,
            "operation": {
                "type": "replace_exact",
                "expected_text": "1년",
                "replacement_text": "3년",
                "expected_occurrences": 1,
            },
        }
    )
    tool_uses = [
        ToolUseBlock(
            id="tool-1",
            name="mcp__codegate__document_get",
            input={"document_id": "REG-000001"},
        ),
        ToolUseBlock(
            id="tool-2",
            name="mcp__codegate__source_file_read",
            input={"document_id": "REG-000001"},
        ),
    ]

    with pytest.raises(AgentGatewayError) as raised:
        _validate_tool_trace(
            decision,
            tool_uses,
            {},
            expected_graph_version="2026-07-21.2-demo",
            selected_document_id="REG-000001",
        )

    assert raised.value.code == "AGENT_TOOL_RESULT_INVALID"


def test_ready_file_deletion_requires_current_document_verification_without_source_read() -> None:
    decision = AgentDecision.model_validate(
        {
            "prompt_contract_version": "2.1",
            "outcome": "ready",
            "intent": "delete_file",
            "assistant_text": "파일 삭제 미리보기를 준비합니다.",
            "search_query": "REG-000001.md",
            "target_document_id": "REG-000001",
            "source_sha256": None,
            "operation": None,
        }
    )
    document_get = ToolUseBlock(
        id="tool-get",
        name="mcp__codegate__document_get",
        input={"document_id": "REG-000001"},
    )

    _validate_tool_trace(
        decision,
        [document_get],
        {
            "tool-get": _tool_result_block(
                "tool-get",
                "document_get",
                {"document": {"document_id": "REG-000001"}},
            )
        },
        expected_graph_version="2026-07-21.2-demo",
        selected_document_id="REG-000001",
    )


def test_ready_file_creation_requires_canonical_source_after_document_verification() -> None:
    decision = AgentDecision.model_validate(
        {
            "prompt_contract_version": "2.1",
            "outcome": "ready",
            "intent": "create_file",
            "assistant_text": "새 HWPX 미리보기를 준비했습니다.",
            "search_query": "이번주 보고서",
            "target_document_id": "REG-000001",
            "source_sha256": None,
            "operation": None,
            "target_filename": "주간업무보고서.hwpx",
            "document_markdown": "# 주간업무보고서\n\n이번 주 업무",
        }
    )
    document_get = ToolUseBlock(
        id="tool-get",
        name="mcp__codegate__document_get",
        input={"document_id": "REG-000001"},
    )
    canonical_read = ToolUseBlock(
        id="tool-canonical",
        name="mcp__codegate__knowledge_document_read",
        input={"document_id": "REG-000001"},
    )

    _validate_tool_trace(
        decision,
        [document_get, canonical_read],
        {
            "tool-get": _tool_result_block(
                "tool-get",
                "document_get",
                {"document": {"document_id": "REG-000001"}},
            ),
            "tool-canonical": _tool_result_block(
                "tool-canonical",
                "canonical_document",
                {"document_id": "REG-000001", "content": "이번 주 업무 근거"},
            ),
        },
        expected_graph_version="2026-07-21.2-demo",
        selected_document_id="REG-000001",
    )


def test_ready_change_can_resolve_an_exact_stable_id_from_recent_user_context() -> None:
    decision = AgentDecision.model_validate(
        {
            "prompt_contract_version": "2.1",
            "outcome": "ready",
            "intent": "change",
            "assistant_text": "변경 미리보기를 준비합니다.",
            "search_query": "REG-000001 개인정보 보관 기간",
            "target_document_id": "REG-000001",
            "source_sha256": "a" * 64,
            "operation": {
                "type": "replace_exact",
                "expected_text": "1년",
                "replacement_text": "",
                "expected_occurrences": 1,
            },
        }
    )
    document_get = ToolUseBlock(
        id="tool-get",
        name="mcp__codegate__document_get",
        input={"document_id": "REG-000001"},
    )
    source_read = ToolUseBlock(
        id="tool-source",
        name="mcp__codegate__source_file_read",
        input={"document_id": "REG-000001"},
    )
    results = {
        "tool-get": _tool_result_block(
            "tool-get",
            "document_get",
            {"document": {"document_id": "REG-000001"}},
        ),
        "tool-source": _tool_result_block(
            "tool-source",
            "current_source",
            {
                "document_id": "REG-000001",
                "source_sha256": "a" * 64,
                "content": "개인정보는 1년 동안 보관합니다.",
            },
        ),
    }

    _validate_tool_trace(
        decision,
        [document_get, source_read],
        results,
        expected_graph_version="2026-07-21.2-demo",
        selected_document_id=None,
        routing_document_ids=frozenset({"REG-000001"}),
    )


def test_ready_decision_binds_paraphrased_search_query_to_successful_tool_evidence() -> None:
    decision = AgentDecision.model_validate(
        {
            "prompt_contract_version": "2.1",
            "outcome": "ready",
            "intent": "change",
            "assistant_text": "변경 미리보기를 준비합니다.",
            "search_query": "실무 담당자 이름 변경",
            "target_document_id": "REG-000001",
            "source_sha256": "a" * 64,
            "operation": {
                "type": "replace_exact",
                "expected_text": "현재 이름",
                "replacement_text": "새 이름",
                "expected_occurrences": 1,
            },
        }
    )
    tool_use = ToolUseBlock(
        id="tool-search",
        name="mcp__codegate__knowledge_search",
        input={"query": "test (1).hwp 실무 담당자"},
    )
    result = _tool_result_block(
        "tool-search",
        "knowledge_search",
        {
            "documents": [
                {"document_id": "MAN-000001"},
                {"document_id": "REG-000001"},
            ]
        },
    )

    rebound = _bind_search_query_to_tool_evidence(
        decision,
        [tool_use],
        {"tool-search": result},
        expected_graph_version="2026-07-21.2-demo",
    )

    assert rebound.search_query == "test (1).hwp 실무 담당자"
    assert decision.search_query == "실무 담당자 이름 변경"


def test_search_query_binding_ignores_a_later_broad_target_result() -> None:
    decision = AgentDecision.model_validate(
        {
            "prompt_contract_version": "2.1",
            "outcome": "ready",
            "intent": "change",
            "assistant_text": "변경 미리보기를 준비합니다.",
            "search_query": "test (1).hwp 실무 담당자 이름 변경",
            "target_document_id": "REG-000001",
            "source_sha256": "a" * 64,
            "operation": {
                "type": "replace_exact",
                "expected_text": "현재 이름",
                "replacement_text": "새 이름",
                "expected_occurrences": 1,
            },
        }
    )
    relevant = ToolUseBlock(
        id="tool-relevant",
        name="mcp__codegate__knowledge_search",
        input={"query": "test (1).hwp 실무 책임자"},
    )
    broad = ToolUseBlock(
        id="tool-broad",
        name="mcp__codegate__knowledge_search",
        input={"query": "개인정보"},
    )
    results = {
        "tool-relevant": _tool_result_block(
            "tool-relevant",
            "knowledge_search",
            {"documents": [{"document_id": "REG-000001"}]},
        ),
        "tool-broad": _tool_result_block(
            "tool-broad",
            "knowledge_search",
            {"documents": [{"document_id": "REG-000001"}]},
        ),
    }

    rebound = _bind_search_query_to_tool_evidence(
        decision,
        [relevant, broad],
        results,
        expected_graph_version="2026-07-21.2-demo",
    )

    assert rebound.search_query == "test (1).hwp 실무 책임자"


@pytest.mark.parametrize("outcome", ["not_found", "tool_error"])
def test_evidence_based_non_ready_outcome_rejects_an_empty_tool_trace(outcome: str) -> None:
    decision = AgentDecision.model_validate(
        {
            "prompt_contract_version": "2.1",
            "outcome": outcome,
            "intent": "locate",
            "assistant_text": "현재 근거를 확인하지 못했습니다.",
            "search_query": "존재하지 않는 규정",
            "target_document_id": None,
            "source_sha256": None,
            "operation": None,
        }
    )

    with pytest.raises(AgentGatewayError) as raised:
        _validate_tool_trace(
            decision,
            [],
            {},
            expected_graph_version="2026-07-21.2-demo",
            selected_document_id=None,
        )

    assert raised.value.code == "AGENT_TOOL_TRACE_INVALID"


def test_not_found_requires_a_valid_empty_result_for_the_exact_search_query() -> None:
    decision = AgentDecision.model_validate(
        {
            "prompt_contract_version": "2.1",
            "outcome": "not_found",
            "intent": "locate",
            "assistant_text": "문서를 찾지 못했습니다.",
            "search_query": "존재하지 않는 규정",
            "target_document_id": None,
            "source_sha256": None,
            "operation": None,
        }
    )
    tool_use = ToolUseBlock(
        id="tool-1",
        name="mcp__codegate__knowledge_search",
        input={"query": "존재하지 않는 규정"},
    )

    _validate_tool_trace(
        decision,
        [tool_use],
        {"tool-1": _tool_result_block("tool-1", "knowledge_search", {"documents": []})},
        expected_graph_version="2026-07-21.2-demo",
        selected_document_id=None,
    )


def test_tool_error_requires_an_observed_failed_tool_result() -> None:
    decision = AgentDecision.model_validate(
        {
            "prompt_contract_version": "2.1",
            "outcome": "tool_error",
            "intent": "locate",
            "assistant_text": "도구 결과를 확인하지 못했습니다.",
            "search_query": "개인정보",
            "target_document_id": None,
            "source_sha256": None,
            "operation": None,
        }
    )
    tool_use = ToolUseBlock(
        id="tool-1",
        name="mcp__codegate__knowledge_search",
        input={"query": "개인정보"},
    )

    _validate_tool_trace(
        decision,
        [tool_use],
        {"tool-1": ToolResultBlock(tool_use_id="tool-1", content="denied", is_error=True)},
        expected_graph_version="2026-07-21.2-demo",
        selected_document_id=None,
    )


def test_ready_target_rejects_document_get_before_required_search() -> None:
    decision = AgentDecision.model_validate(
        {
            "prompt_contract_version": "2.1",
            "outcome": "ready",
            "intent": "locate",
            "assistant_text": "근거를 찾습니다.",
            "search_query": "개인정보",
            "target_document_id": "REG-000001",
            "source_sha256": None,
            "operation": None,
        }
    )
    tool_uses = [
        ToolUseBlock(
            id="tool-1",
            name="mcp__codegate__document_get",
            input={"document_id": "REG-000001"},
        ),
        ToolUseBlock(
            id="tool-2",
            name="mcp__codegate__knowledge_search",
            input={"query": "개인정보"},
        ),
    ]
    tool_results = {
        "tool-1": _tool_result_block(
            "tool-1",
            "document_get",
            {"document": {"document_id": "REG-000001"}},
        ),
        "tool-2": _tool_result_block(
            "tool-2",
            "knowledge_search",
            {"documents": [{"document_id": "REG-000001"}]},
        ),
    }

    with pytest.raises(AgentGatewayError) as raised:
        _validate_tool_trace(
            decision,
            tool_uses,
            tool_results,
            expected_graph_version="2026-07-21.2-demo",
            selected_document_id=None,
        )

    assert raised.value.code == "AGENT_TOOL_TRACE_INVALID"


def test_locate_allows_scoped_evidence_search_after_target_verification() -> None:
    query = "GBX-ONB-003_일정_리스크_추적표.xlsx 지연 일정 위험 요소 담당자"
    decision = AgentDecision.model_validate(
        {
            "prompt_contract_version": "2.1",
            "outcome": "ready",
            "intent": "locate",
            "assistant_text": "지연 일정과 위험 요소, 담당자를 찾았습니다.",
            "search_query": query,
            "target_document_id": "DOC-1111111111111111",
            "source_sha256": None,
            "operation": None,
        }
    )
    tool_uses = [
        ToolUseBlock(
            id="tool-search-route",
            name="mcp__codegate__knowledge_search",
            input={"query": query},
        ),
        ToolUseBlock(
            id="tool-target",
            name="mcp__codegate__document_get",
            input={"document_id": "DOC-1111111111111111"},
        ),
        ToolUseBlock(
            id="tool-search-evidence",
            name="mcp__codegate__knowledge_search",
            input={"query": query},
        ),
    ]
    tool_results = {
        "tool-search-route": _tool_result_block(
            "tool-search-route",
            "knowledge_search",
            {"documents": [{"document_id": "DOC-1111111111111111"}]},
        ),
        "tool-target": _tool_result_block(
            "tool-target",
            "document_get",
            {"document": {"document_id": "DOC-1111111111111111"}},
        ),
        "tool-search-evidence": _tool_result_block(
            "tool-search-evidence",
            "knowledge_search",
            {"documents": [{"document_id": "DOC-1111111111111111"}]},
        ),
    }

    _validate_tool_trace(
        decision,
        tool_uses,
        tool_results,
        expected_graph_version="2026-07-21.2-demo",
        selected_document_id=None,
    )


def test_selected_locate_requires_matching_search_evidence_for_target() -> None:
    query = "개인정보 보관 기간"
    decision = AgentDecision.model_validate(
        {
            "prompt_contract_version": "2.1",
            "outcome": "ready",
            "intent": "locate",
            "assistant_text": "보관 기간 근거를 찾았습니다.",
            "search_query": query,
            "target_document_id": "REG-000001",
            "source_sha256": None,
            "operation": None,
        }
    )
    tool_use = ToolUseBlock(
        id="tool-target",
        name="mcp__codegate__document_get",
        input={"document_id": "REG-000001"},
    )

    with pytest.raises(AgentGatewayError, match="위치 검색 도구 계약"):
        _validate_tool_trace(
            decision,
            [tool_use],
            {
                "tool-target": _tool_result_block(
                    "tool-target",
                    "document_get",
                    {"document": {"document_id": "REG-000001"}},
                )
            },
            expected_graph_version="2026-07-21.2-demo",
            selected_document_id="REG-000001",
        )


def test_selected_locate_allows_same_query_target_evidence_after_document_get() -> None:
    query = "개인정보 보관 기간"
    decision = AgentDecision.model_validate(
        {
            "prompt_contract_version": "2.1",
            "outcome": "ready",
            "intent": "locate",
            "assistant_text": "보관 기간 근거를 찾았습니다.",
            "search_query": query,
            "target_document_id": "REG-000001",
            "source_sha256": None,
            "operation": None,
        }
    )
    tool_uses = [
        ToolUseBlock(
            id="tool-target",
            name="mcp__codegate__document_get",
            input={"document_id": "REG-000001"},
        ),
        ToolUseBlock(
            id="tool-evidence",
            name="mcp__codegate__knowledge_search",
            input={"query": query},
        ),
    ]

    _validate_tool_trace(
        decision,
        tool_uses,
        {
            "tool-target": _tool_result_block(
                "tool-target",
                "document_get",
                {"document": {"document_id": "REG-000001"}},
            ),
            "tool-evidence": _tool_result_block(
                "tool-evidence",
                "knowledge_search",
                {"documents": [{"document_id": "REG-000001"}]},
            ),
        },
        expected_graph_version="2026-07-21.2-demo",
        selected_document_id="REG-000001",
    )


def test_locate_rejects_unscoped_search_after_target_verification() -> None:
    decision = AgentDecision.model_validate(
        {
            "prompt_contract_version": "2.1",
            "outcome": "ready",
            "intent": "locate",
            "assistant_text": "근거를 찾습니다.",
            "search_query": "일정 리스크",
            "target_document_id": "REG-000001",
            "source_sha256": None,
            "operation": None,
        }
    )
    tool_uses = [
        ToolUseBlock(
            id="tool-route",
            name="mcp__codegate__knowledge_search",
            input={"query": "일정 리스크"},
        ),
        ToolUseBlock(
            id="tool-target",
            name="mcp__codegate__document_get",
            input={"document_id": "REG-000001"},
        ),
        ToolUseBlock(
            id="tool-broad",
            name="mcp__codegate__knowledge_search",
            input={"query": "모든 문서"},
        ),
    ]
    tool_results = {
        "tool-route": _tool_result_block(
            "tool-route",
            "knowledge_search",
            {"documents": [{"document_id": "REG-000001"}]},
        ),
        "tool-target": _tool_result_block(
            "tool-target",
            "document_get",
            {"document": {"document_id": "REG-000001"}},
        ),
        "tool-broad": _tool_result_block(
            "tool-broad",
            "knowledge_search",
            {"documents": [{"document_id": "REG-000001"}]},
        ),
    }

    with pytest.raises(AgentGatewayError, match="위치 검색 도구 계약"):
        _validate_tool_trace(
            decision,
            tool_uses,
            tool_results,
            expected_graph_version="2026-07-21.2-demo",
            selected_document_id=None,
        )


def test_ready_target_must_appear_in_the_preceding_search_result() -> None:
    decision = AgentDecision.model_validate(
        {
            "prompt_contract_version": "2.1",
            "outcome": "ready",
            "intent": "locate",
            "assistant_text": "근거를 찾습니다.",
            "search_query": "개인정보",
            "target_document_id": "REG-000001",
            "source_sha256": None,
            "operation": None,
        }
    )
    tool_uses = [
        ToolUseBlock(
            id="tool-1",
            name="mcp__codegate__knowledge_search",
            input={"query": "개인정보"},
        ),
        ToolUseBlock(
            id="tool-2",
            name="mcp__codegate__document_get",
            input={"document_id": "REG-000001"},
        ),
    ]
    tool_results = {
        "tool-1": _tool_result_block(
            "tool-1",
            "knowledge_search",
            {"documents": [{"document_id": "REG-000002"}]},
        ),
        "tool-2": _tool_result_block(
            "tool-2",
            "document_get",
            {"document": {"document_id": "REG-000001"}},
        ),
    }

    with pytest.raises(AgentGatewayError) as raised:
        _validate_tool_trace(
            decision,
            tool_uses,
            tool_results,
            expected_graph_version="2026-07-21.2-demo",
            selected_document_id=None,
        )

    assert raised.value.code == "AGENT_TOOL_TRACE_INVALID"


def test_ready_decision_rejects_mismatched_tool_result_provenance() -> None:
    decision = AgentDecision.model_validate(
        {
            "prompt_contract_version": "2.1",
            "outcome": "ready",
            "intent": "locate",
            "assistant_text": "근거를 찾습니다.",
            "search_query": "개인정보",
            "target_document_id": None,
            "source_sha256": None,
            "operation": None,
        }
    )
    tool_use = ToolUseBlock(
        id="tool-1",
        name="mcp__codegate__knowledge_search",
        input={"query": "개인정보"},
    )
    result = _tool_result_block(
        "tool-1",
        "document_get",
        {"documents": []},
    )

    with pytest.raises(AgentGatewayError) as raised:
        _validate_tool_trace(
            decision,
            [tool_use],
            {"tool-1": result},
            expected_graph_version="2026-07-21.2-demo",
            selected_document_id=None,
        )

    assert raised.value.code == "AGENT_TOOL_RESULT_INVALID"


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
