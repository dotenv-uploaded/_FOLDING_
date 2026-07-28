"""미들웨어가 스트리밍 응답(SSE)을 끊지 않는지.

이 두 가지가 실제로 `agent/stream` 을 죽였다. 둘 다 증상이 똑같아서 고약했다 —
헤더는 200 으로 나가고 본문은 이벤트 하나 없이 끝난다. 오류도 로그도 남지 않는다.

  1. `@app.middleware("http")`(BaseHTTPMiddleware)가 본문 제너레이터를 취소한다.
  2. 본문 크기 제한 미들웨어가 버퍼를 다 돌려준 뒤 `http.disconnect` 를 **지어낸다.**
     스트리밍 응답은 끊김을 감시하려고 receive() 를 지켜보므로, 그 가짜 끊김을 받고
     "클라이언트가 갔다"며 본문을 취소한다.

그래서 "이벤트가 실제로 도착하는가"를 못 박아 둔다.
"""

from __future__ import annotations

import asyncio

from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient

from codegate_api.request_limits import RequestBodyLimitMiddleware


def _streaming_app(max_bytes: int = 1_000_000) -> FastAPI:
    app = FastAPI()

    @app.post("/stream")
    async def stream() -> StreamingResponse:
        async def body():
            for index in range(3):
                # 첫 이벤트 전에 한 번 쉰다. 가짜 끊김은 바로 이 틈에 꽂혀 본문을 죽였다.
                await asyncio.sleep(0.01)
                yield f"data: {index}\n\n"

        return StreamingResponse(body(), media_type="text/event-stream")

    app.add_middleware(RequestBodyLimitMiddleware, max_bytes=max_bytes)
    return app


def test_본문제한_미들웨어를_지나도_스트리밍이_끝까지_온다():
    with TestClient(_streaming_app()) as client:
        response = client.post("/stream", json={"hello": "world"})
        assert response.status_code == 200
        # 이벤트가 하나도 없으면 예전 그대로 — 헤더만 200 이고 본문이 빈 상태다.
        assert response.text == "data: 0\n\ndata: 1\n\ndata: 2\n\n"


def test_본문이_커도_여전히_막는다():
    """스트리밍을 살리느라 크기 제한이 헐거워지지 않았는지."""
    with TestClient(_streaming_app(max_bytes=10)) as client:
        response = client.post("/stream", json={"padding": "x" * 100})
        assert response.status_code == 413
