"""도구 승인 대기소 — 에이전트가 도구를 쓰기 전에 사용자에게 묻고 답을 기다린다.

왜 대기소가 필요한가
--------------------
`can_use_tool` 콜백은 사이드카 **안에서** 돈다. 그런데 승인을 누를 사람은 앱(다른 프로세스)
에 있다. 이 콜백이 앱에 질문을 보내고, 앱이 답할 때까지 **멈춰 기다려야** 한다.

그 다리가 이 대기소다. 흐름은:

    1. can_use_tool 이 요청을 등록한다 → id 를 받고, 그 id 의 Future 를 기다린다(await)
    2. 스트림이 approval_request(id, 도구, 위험) 이벤트를 앱으로 흘린다
    3. 사용자가 승인/거부 → 앱이 resolve(id, 허용?) 를 부른다
    4. Future 가 풀리고, can_use_tool 이 허용/거부를 돌려준다

되돌릴 수 없는 작업 앞에서 **묻지 않고 지나가는 일이 없어야** 한다. 그래서 답을 못 받으면
(연결이 끊기거나 시간이 초과되면) **거부로 친다** — 애매하면 실행하지 않는 쪽이 안전하다.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from uuid import uuid4

from codegate_api.agent.tool_risk import ToolRisk


@dataclass(frozen=True)
class PendingApproval:
    """앱에 보여줄 승인 요청 한 건."""

    approval_id: str
    tool_name: str
    risk: ToolRisk
    #: 위험한 이유(있으면). 승인 창이 "왜 위험한지"를 보여주는 데 쓴다.
    reason: str | None
    #: 도구 입력의 사람이 읽을 요약(명령 문자열, 파일 경로 등).
    summary: str


@dataclass
class ApprovalRegistry:
    """한 대화(에이전트 실행) 동안의 승인 대기 건들.

    실행 하나마다 새로 만든다 — 다른 실행의 승인이 섞이지 않게 한다.
    """

    #: 답을 못 받았을 때 거부로 처리하기까지 기다리는 시간(초).
    #: 사람이 창을 보고 누르는 시간이므로 넉넉히 둔다.
    timeout_seconds: float = 300.0

    _waiters: dict[str, asyncio.Future[bool]] = field(default_factory=dict)
    _requests: dict[str, PendingApproval] = field(default_factory=dict)

    def create(
        self,
        *,
        tool_name: str,
        risk: ToolRisk,
        reason: str | None,
        summary: str,
    ) -> PendingApproval:
        """승인 요청을 등록하고, 그 건을 돌려준다. 아직 기다리지는 않는다."""
        approval_id = f"appr_{uuid4().hex}"
        pending = PendingApproval(
            approval_id=approval_id,
            tool_name=tool_name,
            risk=risk,
            reason=reason,
            summary=summary,
        )
        self._requests[approval_id] = pending
        self._waiters[approval_id] = asyncio.get_event_loop().create_future()
        return pending

    async def wait(self, approval_id: str) -> bool:
        """사용자의 결정을 기다린다. 시간이 초과되면 거부로 친다.

        되돌릴 수 없는 작업 앞에서 답 없이 통과시키지 않는다 — 못 받은 답은 '아니오'다.
        """
        future = self._waiters.get(approval_id)
        if future is None:
            return False
        try:
            return await asyncio.wait_for(future, timeout=self.timeout_seconds)
        except (TimeoutError, asyncio.TimeoutError):
            return False
        finally:
            self._waiters.pop(approval_id, None)
            self._requests.pop(approval_id, None)

    def resolve(self, approval_id: str, approved: bool) -> bool:
        """앱이 사용자의 결정을 전달한다. 그런 요청이 없으면 False.

        같은 요청을 두 번 결정해도(사용자가 두 번 눌러도) 조용히 무시한다.
        """
        future = self._waiters.get(approval_id)
        if future is None or future.done():
            return False
        future.set_result(approved)
        return True

    def cancel_all(self) -> None:
        """실행이 끝나거나 끊기면 남은 대기를 전부 거부로 풀어 준다.

        풀어 주지 않으면 대기 중인 콜백이 타임아웃까지 멈춰 있게 된다.
        """
        for future in self._waiters.values():
            if not future.done():
                future.set_result(False)
        self._waiters.clear()
        self._requests.clear()
