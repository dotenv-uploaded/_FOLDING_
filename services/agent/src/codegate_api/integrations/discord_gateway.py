from __future__ import annotations

import asyncio
import contextlib
import io
from typing import Any

import discord
from discord import app_commands

from codegate_api.integrations.discord_source import DiscordSourceConnector
from codegate_api.knowledge.access import AccessContext
from codegate_api.knowledge.schemas import AccessLevel
from codegate_api.models import DocumentResult


class DiscordGateway:
    def __init__(
        self,
        *,
        token: str,
        guild_id: str,
        connector: DiscordSourceConnector,
    ) -> None:
        self.token = token
        self.guild_id = guild_id
        self.connector = connector
        self.error: str | None = None
        self._task: asyncio.Task[None] | None = None
        self.client = _FoldingDiscordClient(guild_id=guild_id, connector=connector)

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done() and self.client.is_ready()

    async def start(self) -> None:
        if self._task is not None and not self._task.done():
            return
        self.error = None
        self._task = asyncio.create_task(
            self.client.start(self.token),
            name="folding-discord-gateway",
        )
        self._task.add_done_callback(self._capture_failure)

    async def stop(self) -> None:
        task = self._task
        self._task = None
        await self.client.close()
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    def _capture_failure(self, task: asyncio.Task[None]) -> None:
        if task.cancelled():
            return
        exception = task.exception()
        if exception is not None:
            self.error = f"{type(exception).__name__}: {exception}"


class _FoldingDiscordClient(discord.Client):
    def __init__(self, *, guild_id: str, connector: DiscordSourceConnector) -> None:
        intents = discord.Intents.none()
        intents.guilds = True
        intents.guild_messages = True
        intents.message_content = True
        super().__init__(intents=intents)
        self.guild_id = guild_id
        self.connector = connector
        self.tree = app_commands.CommandTree(self)
        self._register_commands()

    async def setup_hook(self) -> None:
        guild = discord.Object(id=int(self.guild_id))
        self.tree.copy_global_to(guild=guild)
        await self.tree.sync(guild=guild)

    async def on_message(self, message: discord.Message) -> None:
        if message.guild is None or message.author == self.user:
            return
        await self.connector.ingest("MESSAGE_CREATE", _message_payload(message))

    async def on_message_edit(
        self,
        before: discord.Message,
        after: discord.Message,
    ) -> None:
        del before
        if after.guild is None or after.author == self.user:
            return
        await self.connector.ingest("MESSAGE_UPDATE", _message_payload(after))

    async def on_raw_message_delete(self, payload: discord.RawMessageDeleteEvent) -> None:
        if payload.guild_id is None:
            return
        channel = self.get_channel(payload.channel_id)
        parent_id = getattr(channel, "parent_id", None)
        value: dict[str, Any] = {
            "id": str(payload.message_id),
            "channel_id": str(payload.channel_id),
            "guild_id": str(payload.guild_id),
        }
        if parent_id is not None:
            value["_folding_parent_id"] = str(parent_id)
        await self.connector.ingest("MESSAGE_DELETE", value)

    async def on_thread_create(self, thread: discord.Thread) -> None:
        await self.connector.ingest("THREAD_CREATE", _thread_payload(thread))

    async def on_thread_update(self, before: discord.Thread, after: discord.Thread) -> None:
        del before
        await self.connector.ingest("THREAD_UPDATE", _thread_payload(after))

    def _register_commands(self) -> None:
        administrator = app_commands.default_permissions(administrator=True)
        admin_check = app_commands.checks.has_permissions(administrator=True)

        @self.tree.command(name="context", description="Search Discord evidence in Folding")
        @administrator
        @admin_check
        async def context(interaction: discord.Interaction, query: str) -> None:
            await interaction.response.send_message(
                _format_results(self.connector.search(query, access_context=_admin_context())),
                ephemeral=True,
            )

        @self.tree.command(name="summary", description="Show a retrieval-based project digest")
        @administrator
        @admin_check
        async def summary(interaction: discord.Interaction) -> None:
            await interaction.response.send_message(
                _format_results(
                    self.connector.search(
                        "summary recent activity decisions tasks unresolved",
                        access_context=_admin_context(),
                        top_k=8,
                    )
                ),
                ephemeral=True,
            )

        @self.tree.command(name="decisions", description="Find recorded project decisions")
        @administrator
        @admin_check
        async def decisions(interaction: discord.Interaction) -> None:
            await interaction.response.send_message(
                _format_results(
                    self.connector.search(
                        "decision decided approved rejected architecture",
                        access_context=_admin_context(),
                        top_k=8,
                    )
                ),
                ephemeral=True,
            )

        @self.tree.command(name="tasks", description="Find active project tasks")
        @administrator
        @admin_check
        async def tasks(interaction: discord.Interaction) -> None:
            await interaction.response.send_message(
                _format_results(
                    self.connector.search(
                        "task todo action item owner due",
                        access_context=_admin_context(),
                        top_k=8,
                    )
                ),
                ephemeral=True,
            )

        @self.tree.command(name="export-md", description="Export projected Discord Markdown")
        @administrator
        @admin_check
        async def export_markdown(interaction: discord.Interaction) -> None:
            content = self.connector.export_markdown().encode("utf-8")
            await interaction.response.send_message(
                file=discord.File(io.BytesIO(content), filename="folding-discord-export.md"),
                ephemeral=True,
            )


def _message_payload(message: discord.Message) -> dict[str, Any]:
    parent_id = getattr(message.channel, "parent_id", None)
    payload: dict[str, Any] = {
        "id": str(message.id),
        "guild_id": str(message.guild.id) if message.guild is not None else None,
        "channel_id": str(message.channel.id),
        "timestamp": message.created_at.isoformat(),
        "edited_timestamp": message.edited_at.isoformat() if message.edited_at else None,
        "content": message.content,
        "author": {
            "id": str(message.author.id),
            "username": message.author.name,
            "global_name": message.author.display_name,
        },
        "attachments": [
            {
                "id": str(attachment.id),
                "filename": attachment.filename,
                "url": attachment.url,
                "content_type": attachment.content_type,
                "size": attachment.size,
            }
            for attachment in message.attachments
        ],
        "_folding_channel_name": getattr(message.channel, "name", str(message.channel.id)),
    }
    if parent_id is not None:
        payload["_folding_parent_id"] = str(parent_id)
    if message.reference is not None and message.reference.message_id is not None:
        payload["message_reference"] = {"message_id": str(message.reference.message_id)}
    return payload


def _thread_payload(thread: discord.Thread) -> dict[str, Any]:
    return {
        "id": str(thread.id),
        "guild_id": str(thread.guild.id),
        "name": thread.name,
        "parent_id": str(thread.parent_id),
    }


def _admin_context() -> AccessContext:
    return AccessContext(
        subject_id="discord-administrator",
        tenant_id="local",
        readable_access=frozenset(AccessLevel),
        writable_document_ids=frozenset(),
        provisioned=True,
        allow_all_writes=False,
        authz_source="discord-administrator",
    )


def _format_results(results: list[DocumentResult]) -> str:
    if not results:
        return "No indexed Discord evidence matched."
    blocks: list[str] = []
    for result in results:
        quote = result.evidence[0].quote if result.evidence else ""
        citations = ", ".join(result.citations[:2])
        blocks.append(f"**{result.title}**\n{quote}\n`{citations}`")
    return "\n\n".join(blocks)[:1_900]
