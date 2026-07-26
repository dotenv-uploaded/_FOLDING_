"""`can_use_tool` 콜백 — 에이전트가 도구를 쓰기 직전에 여기서 승인을 받는다.

이 콜백은 SDK 가 도구 실행 전에 부른다. 여기서:
  1. 도구 입력을 사람이 읽을 요약으로 만든다(승인 창에 보여줄 것)
  2. 위험 등급을 매긴다(무게를 정한다)
  3. 지식 도구(SAFE)는 자동 허용 — 읽기 전용이라 물을 것이 없다
  4. 그 외에는 승인 대기소에 등록하고 사용자의 결정을 기다린다

**자동 허용은 SAFE 에만.** 이 백엔드의 지식 도구는 등록 폴더 안을 읽기만 하므로 매번
물으면 승인 피로만 쌓인다. 파일을 고치거나(CAUTION) 밖으로 나가는(DANGER) 도구는
예외 없이 사용자에게 묻는다.
"""

from __future__ import annotations

import json
from typing import Any, Callable

from claude_agent_sdk import (
    PermissionResultAllow,
    PermissionResultDeny,
    ToolPermissionContext,
)

from codegate_api.agent.approvals import ApprovalRegistry, PendingApproval
from codegate_api.agent.tool_risk import ToolRisk, classify_tool

#: 승인 요청을 스트림으로 앱에 흘리는 함수. 사이드카가 주입한다.
EmitApproval = Callable[[PendingApproval], Any]


def build_can_use_tool(
    registry: ApprovalRegistry,
    emit: EmitApproval,
) -> Callable[[str, dict[str, Any], ToolPermissionContext], Any]:
    """승인 게이트를 거치는 `can_use_tool` 콜백을 만든다.

    `emit` 은 승인 요청을 앱으로 보내는 함수다(스트림 이벤트). `registry` 는 그 답을
    기다리는 대기소다. 이 둘을 주입받으므로 전송 방식(SSE 든 무엇이든)과 분리된다.
    """

    async def can_use_tool(
        tool_name: str,
        tool_input: dict[str, Any],
        context: ToolPermissionContext,
    ) -> PermissionResultAllow | PermissionResultDeny:
        del context
        risk, reason = classify_tool(tool_name, tool_input)

        # 읽기 전용은 물을 것이 없다. 승인 피로를 만들지 않는다.
        if risk is ToolRisk.SAFE:
            return PermissionResultAllow()

        pending = registry.create(
            tool_name=tool_name,
            risk=risk,
            reason=reason,
            summary=summarize_tool_input(tool_name, tool_input),
        )
        # 앱이 승인 창을 띄우도록 요청을 흘린다.
        await _maybe_await(emit(pending))
        # 사용자의 결정을 기다린다. 답이 없으면(끊김·시간초과) 거부로 온다.
        approved = await registry.wait(pending.approval_id)
        if approved:
            return PermissionResultAllow()
        return PermissionResultDeny(
            message="사용자가 이 도구 사용을 승인하지 않았습니다.",
        )

    return can_use_tool


def summarize_tool_input(tool_name: str, tool_input: dict[str, Any]) -> str:
    """도구 입력을 승인 창에 보여줄 한 줄로 만든다.

    사용자가 무엇을 승인하는지 정확히 보이게 한다 — Bash 는 명령 전체를, 파일 도구는
    경로를. 모르는 도구는 입력을 통째로 보여준다(가리지 않는다). 너무 길면 자른다.
    """
    if tool_name == "Bash":
        return str(tool_input.get("command", "")).strip()[:2000]
    if tool_name in {"Edit", "Write", "NotebookEdit", "Read"}:
        path = tool_input.get("file_path") or tool_input.get("notebook_path") or ""
        return str(path)
    if tool_name in {"WebFetch", "WebSearch"}:
        return str(tool_input.get("url") or tool_input.get("query") or "")
    if tool_name.endswith("edit_hwp_form"):
        cells = tool_input.get("cells") or []
        src = tool_input.get("input", "")
        out = tool_input.get("output", "")
        return f"{src} → {out} ({len(cells)}칸 채움)"
    if tool_name.endswith("edit_document_text"):
        src = tool_input.get("input", "")
        out = tool_input.get("output", "")
        return f"{src} → {out} ('{tool_input.get('find', '')}' → '{tool_input.get('replace', '')}')"
    if tool_name.endswith("annotate_pdf"):
        src = tool_input.get("input", "")
        out = tool_input.get("output", "")
        return f"{src} → {out} ('{tool_input.get('find', '')}' 에 주석)"
    # 모르는 도구는 입력을 가리지 않고 보여준다.
    try:
        return json.dumps(tool_input, ensure_ascii=False)[:2000]
    except (TypeError, ValueError):
        return str(tool_input)[:2000]


async def _maybe_await(value: Any) -> None:
    """emit 이 동기든 비동기든 받아들인다."""
    if hasattr(value, "__await__"):
        await value
