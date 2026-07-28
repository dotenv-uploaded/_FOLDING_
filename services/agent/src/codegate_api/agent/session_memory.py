"""대화별 Claude 세션 id 를 기억한다 — 다음 턴이 앞 턴을 이어받게.

왜 필요한가
-----------
스트림은 매 요청이 독립된 HTTP 호출이다. 세션 id 를 넘기지 않으면 SDK 는 **매번 새 대화**를
시작한다. 그러면 방금 자기가 만든 파일도 기억하지 못한다 — "방금 만든 파일에 덧붙여줘"가
"그런 파일 만든 적 없다"로 돌아온다. 실제로 그렇게 끊겼다.

왜 메모리인가
-------------
기존 단발 채팅은 `agent_runs` 테이블에 세션을 남기지만 그 경로는 **로그인한 사용자만**
기록한다(`authenticated` 분기). 열린 에이전트는 로그인 여부와 무관하게 대화가 이어져야
하므로 프로세스 메모리에 둔다. 사이드카가 다시 뜨면 잊는데, 그때는 CLI 쪽 세션도 이미
정리 대상이라 이어 붙일 것이 없다 — 잊는 편이 맞다.
"""

from __future__ import annotations

from collections import OrderedDict


class SessionMemory:
    """대화 id → 마지막 Claude 세션 id.

    대화가 무한히 쌓이지 않게 오래된 것부터 버린다(LRU).
    """

    def __init__(self, max_entries: int = 200) -> None:
        self._max_entries = max_entries
        self._sessions: OrderedDict[str, str] = OrderedDict()

    def get(self, conversation_id: str) -> str | None:
        session_id = self._sessions.get(conversation_id)
        if session_id is not None:
            self._sessions.move_to_end(conversation_id)
        return session_id

    def remember(self, conversation_id: str, session_id: str | None) -> None:
        if not session_id:
            return
        self._sessions[conversation_id] = session_id
        self._sessions.move_to_end(conversation_id)
        while len(self._sessions) > self._max_entries:
            self._sessions.popitem(last=False)

    def forget(self, conversation_id: str) -> None:
        """이어 붙이기가 실패했을 때 지운다 — 다음 턴은 새 대화로 깨끗하게 시작한다."""
        self._sessions.pop(conversation_id, None)
