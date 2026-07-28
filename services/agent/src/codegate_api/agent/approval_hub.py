"""활성 스트림들의 승인 대기소를 모아 둔다.

승인 요청은 SSE 스트림으로 앱에 나가고, 사용자의 답은 **별도 HTTP 요청**으로 돌아온다.
그 답이 올바른 대기소에 닿아야 하는데, 스트림과 resolve 엔드포인트는 서로 다른 요청이라
같은 대기소를 공유할 장소가 필요하다. 그 장소가 이 허브다 — 컨테이너가 하나 들고 있는다.

승인 id 는 전역 유일(uuid)하므로, resolve 는 활성 대기소를 훑어 그 id 를 아는 곳에
전달한다. 동시 스트림은 몇 개 안 되므로 훑는 비용은 무시할 만하다.
"""

from __future__ import annotations

from codegate_api.agent.approvals import ApprovalRegistry


class ApprovalHub:
    """활성 스트림 → 대기소. 스트림이 시작할 때 등록하고 끝나면 뗀다."""

    def __init__(self) -> None:
        self._registries: dict[str, ApprovalRegistry] = {}

    def open(self, stream_id: str, *, timeout_seconds: float) -> ApprovalRegistry:
        registry = ApprovalRegistry(timeout_seconds=timeout_seconds)
        self._registries[stream_id] = registry
        return registry

    def close(self, stream_id: str) -> None:
        registry = self._registries.pop(stream_id, None)
        if registry is not None:
            registry.cancel_all()

    def resolve(self, approval_id: str, approved: bool) -> bool:
        """승인 id 를 아는 대기소에 사용자의 결정을 전달한다. 아무도 모르면 False.

        id 가 유일하므로 최대 한 대기소만 True 를 돌려준다. 이미 끝났거나 없는 id 는
        조용히 False — 사용자가 늦게 눌렀거나 두 번 눌러도 터지지 않는다.
        """
        for registry in self._registries.values():
            if registry.resolve(approval_id, approved):
                return True
        return False
