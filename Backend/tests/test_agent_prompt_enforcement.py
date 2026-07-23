import json
from pathlib import Path
from typing import Any

import anyio
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from mcp.shared.memory import create_connected_server_and_client_session

from codegate_api.agent.gateway import (
    AgentDecision,
    AgentGatewayError,
    AgentOutcome,
    AgentRunResult,
    ClaudeAgentGateway,
)
from codegate_api.agent.tools import create_codegate_tool_server
from codegate_api.config import Settings
from codegate_api.files.resolver import SourceUriResolver
from codegate_api.knowledge.access import AccessContext
from codegate_api.knowledge.repository import KnowledgeRepository
from codegate_api.knowledge.schemas import AccessLevel
from codegate_api.state.store import StateStore


class StubAgent:
    def __init__(self, decision: AgentDecision) -> None:
        self._decision = decision
        self.calls = 0
        self.requests: list[dict[str, Any]] = []

    @property
    def session_ttl_seconds(self) -> None:
        return None

    def session_fingerprint(self, **_: Any) -> None:
        return None

    async def decide(self, **kwargs: Any) -> AgentRunResult:
        self.calls += 1
        self.requests.append(kwargs)
        return AgentRunResult(decision=self._decision, provider="stub")


class SessionStubAgent:
    def __init__(self, decision: AgentDecision) -> None:
        self._decision = decision
        self.resume_attempts: list[str | None] = []
        self.conversation_histories: list[list[dict[str, str | None]]] = []

    @property
    def session_ttl_seconds(self) -> int:
        return 3_600

    def session_fingerprint(self, **_: Any) -> str:
        return "a" * 64

    async def decide(self, **kwargs: Any) -> AgentRunResult:
        self.resume_attempts.append(kwargs.get("resume_session_id"))
        self.conversation_histories.append(kwargs.get("conversation_history") or [])
        if len(self.resume_attempts) == 2:
            raise AgentGatewayError("AGENT_TIMEOUT", "timed out")
        return AgentRunResult(
            decision=self._decision,
            provider="stub",
            session_id="11111111-1111-4111-8111-111111111111",
        )


def _decision(
    *,
    outcome: AgentOutcome,
    intent: str,
    target_document_id: str | None = None,
    source_sha256: str | None = None,
    expected_text: str | None = None,
    replacement_text: str | None = None,
    search_query: str = "개인정보 보관 기간",
    target_filename: str | None = None,
    document_markdown: str | None = None,
    source_document_ids: list[str] | None = None,
) -> AgentDecision:
    operation = None
    if expected_text is not None and replacement_text is not None:
        operation = {
            "type": "replace_exact",
            "expected_text": expected_text,
            "replacement_text": replacement_text,
            "expected_occurrences": 1,
        }
    return AgentDecision.model_validate(
        {
            "prompt_contract_version": "2.1",
            "outcome": outcome,
            "intent": intent,
            "assistant_text": "검증 상태를 확인했습니다.",
            "search_query": search_query,
            "target_document_id": target_document_id,
            "source_document_ids": (
                source_document_ids
                if source_document_ids is not None
                else [target_document_id]
                if intent == "create_file" and target_document_id is not None
                else []
            ),
            "source_sha256": source_sha256,
            "operation": operation,
            "target_filename": target_filename,
            "document_markdown": document_markdown,
        }
    )


def _install_stub(test_app: FastAPI, decision: AgentDecision) -> StubAgent:
    agent = StubAgent(decision)
    test_app.state.container.chat._agent = agent  # noqa: SLF001
    return agent


@pytest.mark.parametrize(
    ("outcome", "intent", "expected_code", "retryable"),
    [
        (AgentOutcome.NEEDS_CLARIFICATION, "change", "CHANGE_DETAILS_REQUIRED", False),
        (AgentOutcome.NOT_FOUND, "locate", "DOCUMENT_NOT_FOUND", False),
        (AgentOutcome.TOOL_ERROR, "locate", "AGENT_TOOL_ERROR", True),
        (AgentOutcome.UNSUPPORTED, "locate", "UNSUPPORTED_AGENT_REQUEST", False),
    ],
)
def test_non_ready_agent_outcomes_stop_before_successful_search(
    client: TestClient,
    test_app: FastAPI,
    auth_headers: dict[str, str],
    outcome: AgentOutcome,
    intent: str,
    expected_code: str,
    retryable: bool,
) -> None:
    _install_stub(test_app, _decision(outcome=outcome, intent=intent))

    response = client.post(
        "/api/v1/chat/messages",
        headers=auth_headers,
        json={
            "conversation_id": f"outcome-{outcome.value}",
            "message": "개인정보 보관 기간을 찾아줘",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["response_type"] == "error"
    assert body["documents"] == []
    assert body["error"] == {
        "code": expected_code,
        "message": body["assistant_text"],
        "retryable": retryable,
    }


def test_agent_routes_natural_language_file_deletion_to_approval_preview_without_writing(
    client: TestClient,
    test_app: FastAPI,
    auth_headers: dict[str, str],
    app_settings: Settings,
) -> None:
    agent = _install_stub(
        test_app,
        _decision(
            outcome=AgentOutcome.READY,
            intent="delete_file",
            target_document_id="REG-000001",
            search_query="일일업무 보고서",
        ),
    )

    response = client.post(
        "/api/v1/chat/messages",
        headers=auth_headers,
        json={
            "conversation_id": "file-delete-preview",
            "message": "일일업무 보고서 파일 삭제해줘",
        },
    )

    body = response.json()
    assert body["response_type"] == "change_preview"
    assert body["error"] is None
    assert body["change_plan"]["operation"]["type"] == "delete_file"
    assert "/dev/null" in body["change_plan"]["unified_diff"]
    assert "승인하기 전에는 파일이 삭제되지 않으며" in body["assistant_text"]
    assert (app_settings.resolved_source_root() / "regulations/REG-000001.md").exists()
    assert agent.calls == 1
    assert agent.requests[0]["message"] == "일일업무 보고서 파일 삭제해줘"


def test_agent_routes_report_creation_to_grounded_hwpx_preview(
    client: TestClient,
    test_app: FastAPI,
    auth_headers: dict[str, str],
) -> None:
    agent = _install_stub(
        test_app,
        _decision(
            outcome=AgentOutcome.READY,
            intent="create_file",
            target_document_id="REG-000001",
            source_document_ids=["REG-000001", "REG-000002"],
            search_query="이번주 보고서",
            target_filename="주간업무보고서.hwpx",
            document_markdown="# 주간업무보고서\n\n- 이번 주 업무 근거",
        ),
    )

    response = client.post(
        "/api/v1/chat/messages",
        headers=auth_headers,
        json={
            "conversation_id": "weekly-report-create",
            "message": (
                "이번 주 업무보고 문서들을 참고해서 핵심 진행사항, 완료 업무, 이슈, "
                "다음 주 계획을 정리한 주간 업무보고서.hwpx를 만들어줘."
            ),
        },
    )

    body = response.json()
    assert body["response_type"] == "document_creation_preview"
    assert body["generated_document"] == {
        "filename": "주간업무보고서.hwpx",
        "markdown": "# 주간업무보고서\n\n- 이번 주 업무 근거",
        "source_document_ids": ["REG-000001", "REG-000002"],
    }
    assert [document["document_id"] for document in body["documents"]] == [
        "REG-000001",
        "REG-000002",
    ]
    assert body["change_plan"] is None
    assert agent.calls == 1
    assert agent.requests[0]["message"].startswith("이번 주 업무보고 문서들을 참고해서")


def test_filename_scoped_content_deletion_is_not_mistaken_for_file_deletion(
    client: TestClient,
    test_app: FastAPI,
    auth_headers: dict[str, str],
) -> None:
    agent = _install_stub(
        test_app,
        _decision(outcome=AgentOutcome.NEEDS_CLARIFICATION, intent="change"),
    )

    response = client.post(
        "/api/v1/chat/messages",
        headers=auth_headers,
        json={
            "conversation_id": "file-content-delete",
            "message": "sample (1).hwp에서 담당자 이름을 지워",
        },
    )

    assert response.json()["error"]["code"] == "CHANGE_DETAILS_REQUIRED"
    assert agent.calls == 1


def test_locate_clarification_uses_acl_filtered_direct_evidence_fallback(
    client: TestClient,
    test_app: FastAPI,
    auth_headers: dict[str, str],
) -> None:
    _install_stub(
        test_app,
        _decision(
            outcome=AgentOutcome.NEEDS_CLARIFICATION,
            intent="locate",
            search_query="일반 검색어",
        ),
    )

    response = client.post(
        "/api/v1/chat/messages",
        headers=auth_headers,
        json={
            "conversation_id": "direct-evidence-fallback",
            "message": "개인정보 보관 기간의 근거가 뭐야?",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["response_type"] == "location_result"
    assert body["documents"][0]["evidence"]


def test_ready_locate_preserves_ranked_search_evidence_for_verified_target(
    client: TestClient,
    test_app: FastAPI,
    auth_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    query = "개인정보 보관 기간"
    target_document_id = "REG-000001"
    _install_stub(
        test_app,
        _decision(
            outcome=AgentOutcome.READY,
            intent="locate",
            target_document_id=target_document_id,
            search_query=query,
        ),
    )
    repository = test_app.state.container.catalog.snapshot()
    ranked_target = next(
        document
        for document in repository.search(
            query,
            access_context=AccessContext.anonymous(),
        )
        if document.document_id == target_document_id
    )
    original_get = repository.get

    def generic_get(document_id: str, *, access_context: AccessContext):
        document = original_get(document_id, access_context=access_context)
        if document_id != target_document_id or document is None:
            return document
        return document.model_copy(
            update={
                "evidence": [
                    document.evidence[0].model_copy(update={"quote": "generic first chunk"})
                ]
            }
        )

    monkeypatch.setattr(repository, "get", generic_get)

    response = client.post(
        "/api/v1/chat/messages",
        headers=auth_headers,
        json={
            "conversation_id": "ranked-target-evidence",
            "message": "개인정보 보관 기간을 찾아줘",
        },
    )

    body = response.json()
    assert body["response_type"] == "location_result"
    assert body["documents"][0]["document_id"] == target_document_id
    assert body["documents"][0]["evidence"][0]["quote"] == ranked_target.evidence[0].quote


def test_ready_locate_rejects_verified_target_without_matching_search_evidence(
    client: TestClient,
    test_app: FastAPI,
    auth_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target_document_id = "REG-000001"
    _install_stub(
        test_app,
        _decision(
            outcome=AgentOutcome.READY,
            intent="locate",
            target_document_id=target_document_id,
            search_query="zzzz-no-current-target-evidence-987654",
        ),
    )
    repository = test_app.state.container.catalog.snapshot()

    def forbidden_get(*_: Any, **__: Any):
        raise AssertionError("location response must not substitute generic document evidence")

    monkeypatch.setattr(repository, "get", forbidden_get)

    response = client.post(
        "/api/v1/chat/messages",
        headers=auth_headers,
        json={
            "conversation_id": "missing-target-evidence",
            "message": "선택한 문서에서 현재 근거를 찾아줘",
            "selected_document_id": target_document_id,
        },
    )

    body = response.json()
    assert body["response_type"] == "error"
    assert body["error"]["code"] == "DOCUMENT_NOT_FOUND"
    assert body["documents"] == []


def test_chat_service_resumes_only_after_the_latest_successful_sdk_run(
    client: TestClient,
    test_app: FastAPI,
    auth_headers: dict[str, str],
) -> None:
    agent = SessionStubAgent(_decision(outcome=AgentOutcome.UNSUPPORTED, intent="locate"))
    test_app.state.container.chat._agent = agent  # noqa: SLF001

    for index in range(3):
        response = client.post(
            "/api/v1/chat/messages",
            headers=auth_headers,
            json={
                "conversation_id": "session-rotation",
                "message": f"unsafe request {index}",
            },
        )
        assert response.status_code == 200

    assert agent.resume_attempts == [
        None,
        "11111111-1111-4111-8111-111111111111",
        None,
    ]
    assert agent.conversation_histories[0] == []
    assert [message["role"] for message in agent.conversation_histories[1]] == [
        "user",
        "assistant",
    ]
    assert agent.conversation_histories[1][0]["content"] == "unsafe request 0"


def test_change_preview_rejects_selected_and_verified_target_mismatch(
    client: TestClient,
    test_app: FastAPI,
    auth_headers: dict[str, str],
) -> None:
    _install_stub(
        test_app,
        _decision(
            outcome=AgentOutcome.READY,
            intent="change",
            target_document_id="REG-000002",
            source_sha256=("b91943f04a4bb2631e357fdc36de67b4b4e2b30bca58ccb279192d913e8bec01"),
            expected_text="분기마다",
            replacement_text="매월",
            search_query="REG-000002 접근 권한",
        ),
    )

    response = client.post(
        "/api/v1/chat/messages",
        headers=auth_headers,
        json={
            "conversation_id": "selected-mismatch",
            "message": 'REG-000002에서 "분기마다"를 "매월"로 변경해줘',
            "selected_document_id": "REG-000001",
        },
    )

    assert response.json()["error"]["code"] == "SELECTED_DOCUMENT_MISMATCH"
    assert response.json()["change_plan"] is None


def test_change_preview_binds_decision_to_current_source_hash(
    client: TestClient,
    test_app: FastAPI,
    auth_headers: dict[str, str],
) -> None:
    _install_stub(
        test_app,
        _decision(
            outcome=AgentOutcome.READY,
            intent="change",
            target_document_id="REG-000001",
            source_sha256="f" * 64,
            expected_text="1년",
            replacement_text="3년",
        ),
    )

    response = client.post(
        "/api/v1/chat/messages",
        headers=auth_headers,
        json={
            "conversation_id": "source-hash-binding",
            "message": 'REG-000001에서 "1년"을 "3년"으로 변경해줘',
            "selected_document_id": "REG-000001",
        },
    )

    assert response.json()["error"]["code"] == "SOURCE_HASH_CONFLICT"
    assert response.json()["change_plan"] is None


def test_change_preview_rejects_replacement_not_present_in_user_request(
    client: TestClient,
    test_app: FastAPI,
    auth_headers: dict[str, str],
) -> None:
    _install_stub(
        test_app,
        _decision(
            outcome=AgentOutcome.READY,
            intent="change",
            target_document_id="REG-000001",
            source_sha256=("7e2d690883e207dea2880bef301fc000ea6ee384c7e7e3415e5618872a614e26"),
            expected_text="1년",
            replacement_text="5년",
        ),
    )

    response = client.post(
        "/api/v1/chat/messages",
        headers=auth_headers,
        json={
            "conversation_id": "replacement-grounding",
            "message": 'REG-000001에서 "1년"을 "3년"으로 변경해줘',
            "selected_document_id": "REG-000001",
        },
    )

    assert response.json()["error"]["code"] == "CHANGE_REPLACEMENT_UNVERIFIED"
    assert response.json()["change_plan"] is None


def test_change_preview_strips_model_added_shared_context_from_replacement(
    client: TestClient,
    test_app: FastAPI,
    auth_headers: dict[str, str],
) -> None:
    _install_stub(
        test_app,
        _decision(
            outcome=AgentOutcome.READY,
            intent="change",
            target_document_id="REG-000001",
            source_sha256=("7e2d690883e207dea2880bef301fc000ea6ee384c7e7e3415e5618872a614e26"),
            expected_text="1년 동안",
            replacement_text="3년 동안",
        ),
    )

    response = client.post(
        "/api/v1/chat/messages",
        headers=auth_headers,
        json={
            "conversation_id": "replacement-context",
            "message": "REG-000001의 개인정보 보관 기간을 3년으로 바꿔줘",
            "selected_document_id": "REG-000001",
        },
    )

    assert response.json()["response_type"] == "change_preview"
    assert response.json()["change_plan"]["operation"] == {
        "type": "replace_exact",
        "expected_text": "1년",
        "replacement_text": "3년",
        "expected_occurrences": 1,
    }


def test_change_preview_allows_empty_replacement_only_for_explicit_deletion(
    client: TestClient,
    test_app: FastAPI,
    auth_headers: dict[str, str],
) -> None:
    _install_stub(
        test_app,
        _decision(
            outcome=AgentOutcome.READY,
            intent="change",
            target_document_id="REG-000001",
            source_sha256=("7e2d690883e207dea2880bef301fc000ea6ee384c7e7e3415e5618872a614e26"),
            expected_text="1년",
            replacement_text="",
        ),
    )

    allowed = client.post(
        "/api/v1/chat/messages",
        headers=auth_headers,
        json={
            "conversation_id": "explicit-delete",
            "message": "REG-000001의 보관 기간을 지워줘",
            "selected_document_id": "REG-000001",
        },
    )
    rejected = client.post(
        "/api/v1/chat/messages",
        headers=auth_headers,
        json={
            "conversation_id": "implicit-delete",
            "message": "REG-000001의 보관 기간을 수정해줘",
            "selected_document_id": "REG-000001",
        },
    )

    assert allowed.json()["response_type"] == "change_preview"
    stored_operation = allowed.json()["change_plan"]["operation"]
    assert "1년" in stored_operation["expected_text"]
    assert "1년" not in stored_operation["replacement_text"]
    assert stored_operation["replacement_text"]
    assert rejected.json()["error"]["code"] == "CHANGE_DELETION_UNVERIFIED"
    assert rejected.json()["change_plan"] is None


def test_state_store_returns_bounded_oldest_first_conversation_history(tmp_path: Path) -> None:
    store = StateStore(tmp_path / "history.sqlite3")
    store.initialize()
    for index in range(4):
        store.record_message(
            conversation_id="conversation-1",
            tenant_id="tenant-1",
            subject_id="user-1",
            message_id=f"message-{index}",
            role="user" if index % 2 == 0 else "assistant",
            content=f"content-{index}",
            response_type="error" if index % 2 else None,
        )

    assert store.recent_messages(
        conversation_id="conversation-1",
        tenant_id="tenant-1",
        subject_id="user-1",
        limit=3,
    ) == [
        {"role": "assistant", "content": "content-1", "response_type": "error"},
        {"role": "user", "content": "content-2", "response_type": None},
        {"role": "assistant", "content": "content-3", "response_type": "error"},
    ]


def _repository() -> KnowledgeRepository:
    repository = KnowledgeRepository(
        Path("demo/llm-wiki"),
        SourceUriResolver(Path("demo/source")),
    )
    repository.load()
    return repository


def test_session_fingerprint_rotates_for_model_and_authorization_changes() -> None:
    repository = _repository()
    anonymous = AccessContext.anonymous()
    editor = AccessContext(
        subject_id="user-1",
        tenant_id="tenant-1",
        readable_access=frozenset({AccessLevel.PUBLIC}),
        writable_document_ids=frozenset({"REG-000001"}),
        provisioned=True,
        authz_source="test",
    )
    first = ClaudeAgentGateway(Settings(agent_mode="claude", claude_model="model-a"))
    second = ClaudeAgentGateway(Settings(agent_mode="claude", claude_model="model-b"))

    fingerprint = first.session_fingerprint(repository=repository, access_context=anonymous)

    assert len(fingerprint) == 64
    assert fingerprint == first.session_fingerprint(
        repository=repository,
        access_context=anonymous,
    )
    assert fingerprint != first.session_fingerprint(
        repository=repository,
        access_context=editor,
    )
    assert fingerprint != second.session_fingerprint(
        repository=repository,
        access_context=anonymous,
    )


def test_state_store_resumes_only_matching_runtime_fingerprint(tmp_path: Path) -> None:
    store = StateStore(tmp_path / "state.sqlite3")
    store.initialize()
    store.record_message(
        conversation_id="conversation-1",
        tenant_id="tenant-1",
        subject_id="user-1",
        message_id="message-1",
        role="user",
        content="문서를 찾아줘",
    )
    store.record_agent_run(
        run_id="run-1",
        conversation_id="conversation-1",
        tenant_id="tenant-1",
        subject_id="user-1",
        status="succeeded",
        provider="claude-agent-sdk",
        runtime_fingerprint="a" * 64,
        session_id="11111111-1111-4111-8111-111111111111",
    )

    assert (
        store.latest_agent_session(
            conversation_id="conversation-1",
            tenant_id="tenant-1",
            subject_id="user-1",
            runtime_fingerprint="a" * 64,
            max_age_seconds=3_600,
        )
        == "11111111-1111-4111-8111-111111111111"
    )
    assert (
        store.latest_agent_session(
            conversation_id="conversation-1",
            tenant_id="tenant-1",
            subject_id="user-1",
            runtime_fingerprint="b" * 64,
            max_age_seconds=3_600,
        )
        is None
    )


@pytest.mark.parametrize("status", ["failed", "running"])
def test_state_store_rotates_session_after_non_successful_latest_run(
    tmp_path: Path,
    status: str,
) -> None:
    store = StateStore(tmp_path / "state.sqlite3")
    store.initialize()
    store.record_message(
        conversation_id="conversation-1",
        tenant_id="tenant-1",
        subject_id="user-1",
        message_id="message-1",
        role="user",
        content="문서를 찾아줘",
    )
    store.record_agent_run(
        run_id="run-1",
        conversation_id="conversation-1",
        tenant_id="tenant-1",
        subject_id="user-1",
        status="succeeded",
        provider="claude-agent-sdk",
        runtime_fingerprint="a" * 64,
        session_id="11111111-1111-4111-8111-111111111111",
    )
    store.record_agent_run(
        run_id="run-2",
        conversation_id="conversation-1",
        tenant_id="tenant-1",
        subject_id="user-1",
        status=status,
        provider="claude-agent-sdk",
        runtime_fingerprint="a" * 64,
        error_code="AGENT_TIMEOUT" if status == "failed" else None,
    )

    assert (
        store.latest_agent_session(
            conversation_id="conversation-1",
            tenant_id="tenant-1",
            subject_id="user-1",
            runtime_fingerprint="a" * 64,
            max_age_seconds=3_600,
        )
        is None
    )
    assert (
        store.latest_agent_session(
            conversation_id="conversation-1",
            tenant_id="tenant-1",
            subject_id="user-1",
            runtime_fingerprint="a" * 64,
            max_age_seconds=0,
        )
        is None
    )


def test_mcp_tools_expose_detailed_read_only_contract_and_untrusted_provenance() -> None:
    async def scenario() -> tuple[Any, Any]:
        repository = _repository()
        server = create_codegate_tool_server(repository, AccessContext.anonymous())
        async with create_connected_server_and_client_session(server["instance"]) as session:
            listed = await session.list_tools()
            source = await session.call_tool(
                "source_file_read",
                {"document_id": "REG-000001"},
            )
            return listed, source

    listed, source = anyio.run(scenario)

    assert {tool.name for tool in listed.tools} == {
        "knowledge_search",
        "document_get",
        "knowledge_document_read",
        "source_file_read",
    }
    for tool in listed.tools:
        assert tool.annotations is not None
        assert tool.annotations.readOnlyHint is True
        assert tool.annotations.openWorldHint is False
        assert len(tool.description.split(".")) >= 4
        for definition in tool.inputSchema["properties"].values():
            assert definition["description"]

    payload = json.loads(source.content[0].text)
    assert source.isError is False
    assert payload["tool_contract_version"] == "2.0"
    assert payload["provenance"] == {
        "trust": "untrusted_content",
        "source_kind": "current_source",
        "graph_version": "2026-07-21.2-demo",
    }
    assert payload["source_sha256"] == (
        "7e2d690883e207dea2880bef301fc000ea6ee384c7e7e3415e5618872a614e26"
    )
