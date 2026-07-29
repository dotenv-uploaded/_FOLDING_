from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass

from codegate_api.agent.approval_hub import ApprovalHub
from codegate_api.agent.gateway import AgentGateway, build_agent_gateway
from codegate_api.agent.session_memory import SessionMemory
from codegate_api.application.chat_service import ChatService
from codegate_api.auth import TokenAuthenticator, build_authenticator
from codegate_api.changes.service import ChangeExecutionService, ChangePlanService
from codegate_api.config import Settings
from codegate_api.files.atomic import DocumentLockManager, SafeSourceFileStore
from codegate_api.files.resolver import SourceUriResolver
from codegate_api.integrations.discord_gateway import DiscordGateway
from codegate_api.integrations.discord_source import DiscordSourceConnector
from codegate_api.integrations.doc2md import Doc2MdClient
from codegate_api.knowledge.catalog import KnowledgeCatalog
from codegate_api.knowledge.llmwiki import (
    InProcessLLMWikiBuildRunner,
    LLMWikiCompatibilityAdapter,
    NativeLLMWikiCatalog,
    NativeLLMWikiPipeline,
)
from codegate_api.knowledge.pipeline import LocalKnowledgePipeline
from codegate_api.knowledge.worker import KnowledgeSyncWorker
from codegate_api.runtime_workspace import RuntimeWorkspace
from codegate_api.state.store import StateStore


@dataclass(slots=True)
class AppContainer:
    settings: Settings
    workspace: RuntimeWorkspace
    state: StateStore
    resolver: SourceUriResolver
    files: SafeSourceFileStore
    catalog: KnowledgeCatalog | NativeLLMWikiCatalog
    pipeline: LocalKnowledgePipeline | NativeLLMWikiPipeline
    sync_worker: KnowledgeSyncWorker
    plans: ChangePlanService
    executions: ChangeExecutionService
    agent: AgentGateway
    chat: ChatService
    authenticator: TokenAuthenticator
    doc2md: Doc2MdClient | None
    discord_source: DiscordSourceConnector | None
    discord_gateway: DiscordGateway | None
    reset_lock: asyncio.Lock
    approval_hub: ApprovalHub
    #: 열린 에이전트의 대화별 세션 — 다음 턴이 앞 턴을 이어받게 한다.
    agent_sessions: SessionMemory

    async def startup(self) -> None:
        if (
            self.settings.environment in {"local", "production"}
            and self.settings.agent_mode == "claude"
            and not os.environ.get("ANTHROPIC_API_KEY")
        ):
            raise RuntimeError("Claude Agent SDK requires ANTHROPIC_API_KEY")
        self.workspace.bootstrap()
        self.state.initialize()
        await self.executions.recover_files()
        has_pending_events = self.state.has_unpublished_events()
        self.catalog.bootstrap(
            allow_stale_sources=has_pending_events,
            replace_invalid_demo_seed=(
                self.settings.bootstrap_demo
                and self.settings.environment != "production"
                and not has_pending_events
            ),
            allow_seed_bootstrap=self.settings.bootstrap_demo,
        )
        self.state.record_knowledge_version(
            version=self.catalog.snapshot().version,
            parent_version=None,
            event_ids=[],
            status="active",
        )
        if self.discord_source is not None:
            await self.discord_source.startup()
        self.sync_worker.start()
        # 요약은 뒤따라 만든다. 부팅 경로에 넣으면 헬스 체크가 만료돼 sidecar 가 죽는다.
        # 결과는 캐시에만 남고 다음 빌드가 담아 간다 — 자세한 이유는 메서드 주석 참고.
        # LLMWIKI 모드에만 있는 기능이라 타입을 확인하고 부른다.
        if isinstance(self.catalog, NativeLLMWikiCatalog):
            self.catalog.enrich_in_background()
        if self.discord_gateway is not None:
            await self.discord_gateway.start()

    async def shutdown(self) -> None:
        if self.discord_gateway is not None:
            await self.discord_gateway.stop()
        if self.discord_source is not None:
            await self.discord_source.shutdown()
        await self.sync_worker.stop()

    async def reset_demo(self) -> str:
        if self.settings.environment == "production":
            raise RuntimeError("demo reset is forbidden in production")
        async with self.reset_lock:
            self.state.reset()
            self.workspace.reset_source()
            version = self.catalog.reset_to_seed()
            self.state.record_knowledge_version(
                version=version,
                parent_version=None,
                event_ids=[],
                status="active",
            )
            return version

    @property
    def agent_available(self) -> bool:
        if self.settings.agent_mode in {"deterministic", "local"}:
            return True
        return bool(os.environ.get("ANTHROPIC_API_KEY"))

    @property
    def converter_available(self) -> bool:
        return self.doc2md.health() if self.doc2md is not None else True


def build_container(settings: Settings) -> AppContainer:
    workspace = RuntimeWorkspace(settings)
    resolver = SourceUriResolver(settings.resolved_source_root())
    state = StateStore(settings.resolved_database_path())
    files = SafeSourceFileStore(
        resolver,
        backup_root=settings.resolved_backup_root(),
        max_bytes=settings.max_edit_bytes,
    )
    locks = DocumentLockManager(settings.resolved_runtime_root() / "locks")
    doc2md = None
    if settings.doc2md_base_url:
        doc2md = Doc2MdClient(
            base_url=settings.doc2md_base_url,
            resolver=resolver,
            timeout_seconds=settings.doc2md_timeout_seconds,
            source_kind=settings.doc2md_source_kind,
            api_token=(
                settings.doc2md_api_token.get_secret_value()
                if settings.doc2md_api_token is not None
                else None
            ),
            max_source_bytes=settings.doc2md_max_source_bytes,
        )
    if settings.knowledge_mode == "llmwiki":
        project_root = settings.resolved_llmwiki_project_root()
        input_root = settings.resolved_llmwiki_input_root()
        storage_root = settings.resolved_llmwiki_storage_root()
        assert project_root is not None and input_root is not None and storage_root is not None
        runner = InProcessLLMWikiBuildRunner(
            project_root=project_root,
            input_root=input_root,
            storage_root=storage_root,
            tenant_id=settings.llmwiki_tenant_id,
            wiki_id=settings.llmwiki_wiki_id,
            actor_id=settings.llmwiki_actor_id,
        )
        adapter = LLMWikiCompatibilityAdapter(
            source_resolver=resolver,
            input_root=input_root,
            storage_root=storage_root,
            compatibility_root=settings.resolved_knowledge_releases_root(),
            tenant_id=settings.llmwiki_tenant_id,
            wiki_id=settings.llmwiki_wiki_id,
        )
        native_catalog = NativeLLMWikiCatalog(
            adapter=adapter,
            runner=runner,
            source_resolver=resolver,
            state_store=state,
        )
        catalog: KnowledgeCatalog | NativeLLMWikiCatalog = native_catalog
        pipeline: LocalKnowledgePipeline | NativeLLMWikiPipeline = NativeLLMWikiPipeline(
            catalog=native_catalog,
            file_store=files,
            state_store=state,
            lock_manager=locks,
            doc2md=doc2md,
        )
    else:
        catalog = KnowledgeCatalog(
            seed_root=settings.resolved_seed_knowledge_root(),
            releases_root=settings.resolved_knowledge_releases_root(),
            pointer_path=settings.resolved_knowledge_pointer_path(),
            source_resolver=resolver,
        )
        pipeline = LocalKnowledgePipeline(
            catalog=catalog,
            file_store=files,
            state_store=state,
            doc2md=doc2md,
        )
    sync_worker = KnowledgeSyncWorker(pipeline=pipeline, state_store=state)
    plan_service = ChangePlanService(settings=settings, file_store=files, state_store=state)
    execution_service = ChangeExecutionService(
        catalog=catalog,
        file_store=files,
        state_store=state,
        lock_manager=locks,
        pipeline=pipeline,
        sync_notifier=sync_worker.notify,
    )
    agent = build_agent_gateway(settings)
    chat = ChatService(agent=agent, plans=plan_service, state=state)
    discord_source = None
    discord_gateway = None
    if settings.discord_enabled:
        assert isinstance(pipeline, NativeLLMWikiPipeline)
        assert isinstance(catalog, NativeLLMWikiCatalog)
        input_root = settings.resolved_llmwiki_input_root()
        token = settings.discord_bot_token
        guild_id = settings.discord_guild_id
        channel_allowlist = settings.discord_channel_allowlist
        assert input_root is not None
        assert token is not None
        assert guild_id is not None
        assert channel_allowlist is not None
        discord_source = DiscordSourceConnector(
            token=token.get_secret_value(),
            guild_id=guild_id,
            channel_allowlist=channel_allowlist,
            store_path=settings.resolved_discord_store_path(),
            source_root=settings.resolved_source_root(),
            input_root=input_root,
            pipeline=pipeline,
            catalog=catalog,
            rebuild_debounce_seconds=settings.discord_rebuild_debounce_seconds,
        )
        if settings.discord_gateway_enabled:
            discord_gateway = DiscordGateway(
                token=token.get_secret_value(),
                guild_id=guild_id,
                connector=discord_source,
            )
    return AppContainer(
        settings=settings,
        workspace=workspace,
        state=state,
        resolver=resolver,
        files=files,
        catalog=catalog,
        pipeline=pipeline,
        sync_worker=sync_worker,
        plans=plan_service,
        executions=execution_service,
        agent=agent,
        chat=chat,
        authenticator=build_authenticator(settings),
        doc2md=doc2md,
        discord_source=discord_source,
        discord_gateway=discord_gateway,
        reset_lock=asyncio.Lock(),
        approval_hub=ApprovalHub(),
        agent_sessions=SessionMemory(),
    )
