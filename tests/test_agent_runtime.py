from pathlib import Path

import anyio
from claude_agent_sdk import ClaudeSDKClient

from codegate_api.agent.runtime import (
    SAFE_AGENT_TOOLS,
    build_claude_agent_options,
    create_claude_agent_client,
    enforce_tool_allowlist,
)
from codegate_api.files.resolver import SourceUriResolver
from codegate_api.knowledge.access import AccessContext
from codegate_api.knowledge.repository import KnowledgeRepository


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
