from __future__ import annotations

import hashlib
import ipaddress
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.datastructures import MutableHeaders

from codegate_api.api import (
    agent_stream,
    auth_session,
    change_plans,
    chat,
    demo,
    discord_source,
    documents,
    executions,
    health,
    knowledge,
)
from codegate_api.config import Settings, get_settings
from codegate_api.container import build_container
from codegate_api.rate_limit import FixedWindowRateLimiter
from codegate_api.request_limits import RequestBodyLimitMiddleware


def _normalized_caller_identity(authorization: str | None, client_host: str) -> str:
    if authorization:
        scheme, separator, token = authorization.partition(" ")
        normalized_token = token.strip()
        if separator and scheme.lower() == "bearer" and normalized_token:
            digest = hashlib.sha256(normalized_token.encode()).hexdigest()
            return f"bearer:{digest}"
    return f"anonymous:{client_host}"


def _is_loopback_client(value: str) -> bool:
    try:
        return ipaddress.ip_address(value).is_loopback
    except ValueError:
        return False


def create_app(settings: Settings | None = None) -> FastAPI:
    application_settings = settings or get_settings()
    container = build_container(application_settings)
    chat_rate_limiter = FixedWindowRateLimiter(
        limit=application_settings.chat_rate_limit_requests,
        window_seconds=application_settings.chat_rate_limit_window_seconds,
    )
    chat_ip_rate_limiter = FixedWindowRateLimiter(
        limit=application_settings.chat_rate_limit_requests * 4,
        window_seconds=application_settings.chat_rate_limit_window_seconds,
    )
    auth_ip_rate_limiter = FixedWindowRateLimiter(
        limit=application_settings.auth_rate_limit_requests,
        window_seconds=application_settings.auth_rate_limit_window_seconds,
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        await container.startup()
        try:
            yield
        finally:
            await container.shutdown()

    application = FastAPI(
        title=application_settings.app_name,
        version="0.2.0",
        lifespan=lifespan,
    )
    application.state.container = container
    application.add_middleware(
        CORSMiddleware,
        allow_origins=application_settings.cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "Idempotency-Key", "X-Request-ID"],
    )

    async def rejection_for(request: Request, request_id: str) -> Response | None:
        """요청을 막아야 하면 그 응답을, 통과시켜도 되면 None 을 돌려준다.

        **순수 ASGI 미들웨어에서 쓴다.** 예전에는 `@app.middleware("http")` 로 붙였는데,
        그것이 만드는 `BaseHTTPMiddleware` 는 **스트리밍 응답의 본문을 취소한다.**
        SSE(`agent/stream`)가 헤더만 200 으로 나가고 이벤트 하나 없이 끊기던 원인이
        이것이었다 — CancelledError 가 본문 제너레이터에 꽂혔다. 검사 내용은 그대로 두고
        감싸는 방식만 바꾼다.
        """
        authorization = request.headers.get("Authorization")
        client_host = request.client.host if request.client else "unknown"
        if application_settings.environment == "local" and not _is_loopback_client(client_host):
            return JSONResponse(
                status_code=403,
                content={
                    "detail": {
                        "code": "LOCAL_ACCESS_ONLY",
                        "message": "로컬 앱 API는 loopback 요청만 허용합니다.",
                    }
                },
                headers={"X-Request-ID": request_id},
            )
        if authorization and len(authorization.encode("utf-8")) > (
            application_settings.authorization_header_max_bytes
        ):
            return JSONResponse(
                status_code=431,
                content={
                    "detail": {
                        "code": "REQUEST_HEADER_TOO_LARGE",
                        "message": "Authorization 헤더 크기 제한을 초과했습니다.",
                    }
                },
                headers={"X-Request-ID": request_id},
            )
        if authorization and not await auth_ip_rate_limiter.allow(f"auth-ip:{client_host}"):
            return JSONResponse(
                status_code=429,
                content={
                    "detail": {
                        "code": "RATE_LIMITED",
                        "message": "인증 요청 한도를 초과했습니다.",
                    }
                },
                headers={
                    "X-Request-ID": request_id,
                    "Retry-After": str(auth_ip_rate_limiter.retry_after_seconds),
                },
            )
        if request.method == "POST" and request.url.path == "/api/v1/chat/messages":
            caller_identity = _normalized_caller_identity(authorization, client_host)
            allowed_by_ip = await chat_ip_rate_limiter.allow(f"ip:{client_host}")
            allowed_by_caller = await chat_rate_limiter.allow(caller_identity)
            if not allowed_by_ip or not allowed_by_caller:
                return JSONResponse(
                    status_code=429,
                    content={
                        "detail": {
                            "code": "RATE_LIMITED",
                            "message": "채팅 요청 한도를 초과했습니다.",
                        }
                    },
                    headers={
                        "X-Request-ID": request_id,
                        "Retry-After": str(chat_rate_limiter.retry_after_seconds),
                    },
                )
        return None

    class RequestGuardMiddleware:
        """검사 통과 후에는 **손대지 않고** 그대로 흘려보내는 순수 ASGI 미들웨어.

        응답을 감싸거나 별도 태스크로 옮기지 않으므로 스트리밍(SSE)이 그대로 산다.
        하는 일은 요청 id 를 정하고, 막을 요청을 막고, 나가는 헤더에 그 id 를 얹는 것뿐이다.
        """

        def __init__(self, app: Any) -> None:
            self.app = app

        async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
            if scope["type"] != "http":
                await self.app(scope, receive, send)
                return

            request = Request(scope, receive=receive)
            request_id = request.headers.get("X-Request-ID")
            if not request_id or len(request_id) > 128:
                request_id = str(uuid4())

            rejection = await rejection_for(request, request_id)
            if rejection is not None:
                await rejection(scope, receive, send)
                return

            async def send_with_request_id(message: Any) -> None:
                if message["type"] == "http.response.start":
                    headers = MutableHeaders(scope=message)
                    headers["X-Request-ID"] = request_id
                await send(message)

            await self.app(scope, receive, send_with_request_id)

    application.add_middleware(RequestGuardMiddleware)

    application.add_middleware(
        RequestBodyLimitMiddleware,
        max_bytes=application_settings.max_request_bytes,
    )

    application.include_router(health.router, prefix="/api/v1")
    application.include_router(auth_session.router, prefix="/api/v1")
    application.include_router(chat.router, prefix="/api/v1")
    application.include_router(documents.router, prefix="/api/v1")
    application.include_router(change_plans.router, prefix="/api/v1")
    application.include_router(executions.router, prefix="/api/v1")
    application.include_router(knowledge.router, prefix="/api/v1")
    application.include_router(discord_source.router, prefix="/api/v1")
    application.include_router(agent_stream.router, prefix="/api/v1")
    application.include_router(demo.router, prefix="/api/v1")
    return application


app = create_app()
