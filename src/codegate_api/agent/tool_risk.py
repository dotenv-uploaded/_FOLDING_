"""도구 호출을 위험 등급으로 나눈다.

왜 등급이 필요한가
------------------
"모든 도구에 승인"은 옳은 방향이지만, 모든 승인이 같은 무게면 며칠 만에 사용자는
'예'만 누르게 된다(승인 피로). 그러면 게이트가 있으나 마나다. 되돌릴 수 있는 읽기와
되돌릴 수 없는 삭제가 같은 창으로 뜨면, 진짜 위험한 순간에 손이 먼저 나간다.

그래서 세 등급으로 나눠 승인 창의 무게를 다르게 한다:

- SAFE      읽기·검색. 되돌릴 것도 없다. 지식 도구가 여기.
- CAUTION   파일을 쓰거나 고친다. 되돌릴 수 있다(백업·되돌리기). Edit/Write.
- DANGER    되돌릴 수 없거나 밖으로 나간다. Bash·네트워크·삭제. 여기에 추가 확인을 건다.

이 분류는 **막기 위한 것이 아니라 무게를 정하기 위한 것**이다. 무엇도 자동 차단하지
않는다 — 사용자가 결정한다. 다만 무엇을 결정하는지 그 위험이 보이게 한다.

파괴적 Bash 판별은 완벽할 수 없다
--------------------------------
`rm`·`git push --force` 같은 명령을 문자열로 걸러내지만, 셸은 우회가 무한하다
(`$(echo rm) -rf`, 별칭, 스크립트 실행). 그래서 이 판별은 **보수적**이다 — 애매하면
더 위험한 쪽으로 올린다. 놓친 파괴적 명령을 CAUTION 으로 낮추느니, 무해한 명령을
DANGER 로 올려 확인 한 번 더 받는 편이 안전하다.
"""

from __future__ import annotations

import re
from enum import StrEnum


class ToolRisk(StrEnum):
    SAFE = "safe"
    CAUTION = "caution"
    DANGER = "danger"


#: 이 백엔드가 제공하는 지식 도구 — 읽기 전용, 되돌릴 것 없음.
_SAFE_TOOLS = frozenset(
    {
        "mcp__codegate__knowledge_search",
        "mcp__codegate__document_get",
        "mcp__codegate__knowledge_document_read",
        "mcp__codegate__source_file_read",
    }
)

#: Claude Code 기본 도구 중 되돌릴 수 있는 파일 조작.
_CAUTION_TOOLS = frozenset({"Edit", "Write", "NotebookEdit"})

#: 밖으로 나가거나 임의 실행이 되는 도구 — 기본 DANGER.
_DANGER_TOOLS = frozenset({"Bash", "WebFetch", "WebSearch"})

#: 읽기만 하는 기본 도구.
_READ_TOOLS = frozenset({"Read", "Glob", "Grep", "LS"})

#: Bash 명령 안에서 **되돌릴 수 없거나 밖으로 나가는** 신호.
#:
#: 보수적으로 넓게 잡는다. 하나라도 걸리면 DANGER 를 유지하고, 승인 창에 그 이유를 적어
#: 사용자가 "왜 이게 위험으로 떴는지" 알게 한다.
_IRREVERSIBLE_BASH = [
    (re.compile(r"\brm\s+-[a-z]*[rf]", re.I), "파일 삭제(rm)"),
    (re.compile(r"\brmdir\b", re.I), "디렉터리 삭제(rmdir)"),
    (re.compile(r"\bgit\s+push\b.*(--force|-f)\b", re.I), "강제 푸시(git push --force)"),
    (re.compile(r"\bgit\s+reset\s+--hard\b", re.I), "되돌릴 수 없는 리셋(git reset --hard)"),
    (re.compile(r"\bgit\s+clean\b", re.I), "추적 안 된 파일 삭제(git clean)"),
    (re.compile(r"\bdd\b", re.I), "디스크 직접 쓰기(dd)"),
    (re.compile(r"\bmkfs", re.I), "파일시스템 포맷(mkfs)"),
    (re.compile(r":\s*>\s*/", re.I), "파일 비우기(truncate)"),
    (re.compile(r">\s*/dev/sd", re.I), "블록 장치 쓰기"),
    (re.compile(r"\b(curl|wget)\b", re.I), "외부 네트워크 요청(curl/wget)"),
    (re.compile(r"\bnc\b|\bnetcat\b", re.I), "네트워크 연결(netcat)"),
    (re.compile(r"\bssh\b|\bscp\b|\brsync\b.*::", re.I), "원격 전송"),
    (re.compile(r"\bsudo\b", re.I), "관리자 권한(sudo)"),
    (re.compile(r"\bchmod\s+-R\b", re.I), "재귀 권한 변경(chmod -R)"),
    (re.compile(r"\bkill(all)?\b", re.I), "프로세스 종료(kill)"),
]


def classify_tool(tool_name: str, tool_input: dict[str, object]) -> tuple[ToolRisk, str | None]:
    """도구 호출의 위험 등급과, 위험하면 그 이유를 돌려준다.

    이유(reason)는 DANGER 일 때만 채워진다 — 승인 창이 "왜 위험한지"를 보여주게 하기
    위해서다. "curl 이 들어 있어 외부로 나갈 수 있습니다" 가 "정말 실행할까요?" 보다 낫다.
    """
    if tool_name in _SAFE_TOOLS or tool_name in _READ_TOOLS:
        return ToolRisk.SAFE, None

    if tool_name in _CAUTION_TOOLS:
        return ToolRisk.CAUTION, None

    if tool_name == "Bash":
        command = str(tool_input.get("command", ""))
        reasons = [label for pattern, label in _IRREVERSIBLE_BASH if pattern.search(command)]
        if reasons:
            return ToolRisk.DANGER, " · ".join(dict.fromkeys(reasons))
        # 되돌릴 수 없는 신호가 없는 Bash 도 임의 실행이라 CAUTION 아래로는 못 내린다.
        return ToolRisk.CAUTION, None

    if tool_name in _DANGER_TOOLS:
        return ToolRisk.DANGER, "외부 네트워크 접근"

    # 모르는 도구는 보수적으로 — 애매하면 더 위험한 쪽.
    return ToolRisk.DANGER, f"알 수 없는 도구({tool_name})"
