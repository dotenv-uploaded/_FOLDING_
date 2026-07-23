import logging
from collections import deque
from pathlib import Path

from claude_agent_sdk import (
    ClaudeAgentOptions,
    ClaudeSDKClient,
    HookContext,
    HookInput,
    HookJSONOutput,
    HookMatcher,
)

from codegate_api.agent.instructions import build_system_prompt
from codegate_api.agent.tools import create_codegate_tool_server
from codegate_api.knowledge.access import AccessContext
from codegate_api.knowledge.repository import KnowledgeRepository

logger = logging.getLogger(__name__)

#: 서브프로세스가 죽었을 때 원인을 찾으려고 붙잡아 두는 마지막 stderr 줄 수.
#:
#: SDK 는 프로세스가 exit 1 로 죽으면 `ProcessError: ... Error output: Check stderr output
#: for details` 만 올린다. **정작 그 stderr 를 넘겨주지 않아서** 원인을 볼 방법이 없었다.
#: 실제로 채팅이 세 번에 한 번꼴로 죽는데 로그에는 저 문장뿐이었다.
#:
#: `options.stderr` 콜백을 등록하면 SDK 가 stderr 를 파이프해 줄 단위로 넘겨준다. 전부
#: 로그로 흘리면 정상 실행의 잡음까지 쏟아지므로, 마지막 몇 줄만 들고 있다가 실패했을 때
#: 함께 남긴다.
STDERR_TAIL_LINES = 40


class SubprocessStderrTail:
    """Claude Code 서브프로세스의 stderr 를 붙잡아 둔다.

    죽은 뒤에 물어봐야 하므로, 흘려보내지 않고 마지막 `STDERR_TAIL_LINES` 줄을 남긴다.
    호출마다 새로 만들어 다른 요청의 출력이 섞이지 않게 한다.
    """

    def __init__(self, limit: int = STDERR_TAIL_LINES) -> None:
        self._lines: deque[str] = deque(maxlen=limit)

    def __call__(self, line: str) -> None:
        text = line.rstrip()
        if text:
            self._lines.append(text)

    def text(self) -> str:
        return "\n".join(self._lines)


SAFE_AGENT_TOOLS = frozenset(
    {
        "mcp__codegate__knowledge_search",
        "mcp__codegate__document_get",
        "mcp__codegate__knowledge_document_read",
        "mcp__codegate__source_file_read",
    }
)
SDK_CONTROL_TOOLS = frozenset({"StructuredOutput"})
ALLOWED_AGENT_TOOLS = SAFE_AGENT_TOOLS | SDK_CONTROL_TOOLS


async def enforce_tool_allowlist(
    input_data: HookInput,
    tool_use_id: str | None,
    context: HookContext,
) -> HookJSONOutput:
    del tool_use_id, context
    tool_name = str(input_data.get("tool_name", ""))
    if tool_name in ALLOWED_AGENT_TOOLS:
        return {}
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": "Tool is outside the CODEGATE backend allowlist.",
        }
    }


def build_claude_agent_options(
    repository: KnowledgeRepository,
    *,
    working_directory: Path,
    state_directory: Path,
    access_context: AccessContext,
    output_schema: dict[str, object] | None = None,
    model: str | None = None,
    session_id: str | None = None,
    resume: str | None = None,
    stderr: SubprocessStderrTail | None = None,
) -> ClaudeAgentOptions:
    tool_server = create_codegate_tool_server(repository, access_context)
    return ClaudeAgentOptions(
        system_prompt=build_system_prompt(repository.agent_guide),
        tools=[],
        mcp_servers={"codegate": tool_server},
        strict_mcp_config=True,
        allowed_tools=sorted(ALLOWED_AGENT_TOOLS),
        disallowed_tools=["Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"],
        permission_mode="dontAsk",
        hooks={
            "PreToolUse": [
                HookMatcher(hooks=[enforce_tool_allowlist]),
            ]
        },
        cwd=working_directory.resolve(),
        env={
            "CLAUDE_CONFIG_DIR": str(state_directory.resolve()),
            # `CLAUDE_CODE_SKIP_PROMPT_HISTORY` 를 켜지 않는다.
            #
            # 켜 두면 CLI 가 대화 전사본을 아예 남기지 않는데, 우리는 다음 턴에 그 대화를
            # `resume` 으로 이어받으라고 요청한다. **저장하지 말라고 해놓고 이어받으라는**
            # 조합이라 구조적으로 항상 실패했다 — 세션 디렉터리 31개에 전사본이 0개였고,
            # 대화 두 번째 질문부터 서브프로세스가 exit 1 로 죽었다.
            #
            # 자동 메모리는 계속 꺼 둔다. 작업 디렉터리가 **사용자의 문서 폴더**라,
            # 켜면 거기 있는 메모리 파일을 그대로 읽어 들인다 — 신뢰할 수 없는 문서가
            # 지시를 주입할 수 있는 통로가 된다.
            "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1",
        },
        setting_sources=[],
        skills=[],
        plugins=[],
        output_format=(
            {"type": "json_schema", "schema": output_schema} if output_schema is not None else None
        ),
        model=model,
        session_id=session_id,
        resume=resume,
        # 콜백을 등록해야 SDK 가 stderr 를 파이프한다. 없으면 프로세스가 죽어도
        # "Check stderr output for details" 만 남고 정작 그 stderr 는 사라진다.
        stderr=stderr,
        max_turns=8,
        max_budget_usd=0.50,
        enable_file_checkpointing=False,
    )


def create_claude_agent_client(
    repository: KnowledgeRepository,
    *,
    working_directory: Path,
    state_directory: Path,
    access_context: AccessContext,
    output_schema: dict[str, object] | None = None,
    model: str | None = None,
    session_id: str | None = None,
    resume: str | None = None,
    stderr: SubprocessStderrTail | None = None,
) -> ClaudeSDKClient:
    return ClaudeSDKClient(
        options=build_claude_agent_options(
            repository,
            working_directory=working_directory,
            state_directory=state_directory,
            access_context=access_context,
            output_schema=output_schema,
            model=model,
            session_id=session_id,
            resume=resume,
            stderr=stderr,
        )
    )
