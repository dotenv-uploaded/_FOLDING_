from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import os
import re
import sqlite3
import time
from collections import defaultdict
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any, Protocol

import httpx
import yaml

from codegate_api.knowledge.access import AccessContext
from codegate_api.knowledge.repository import KnowledgeRepository
from codegate_api.models import DocumentResult

SUPPORTED_DISPATCH_TYPES = frozenset(
    {
        "MESSAGE_CREATE",
        "MESSAGE_UPDATE",
        "MESSAGE_DELETE",
        "THREAD_CREATE",
        "THREAD_UPDATE",
    }
)
TEXT_CHANNEL_TYPES = frozenset({0, 5})
OWNERSHIP_FILE = ".discord-source-manifest.json"
DOCUMENT_ID_RE = re.compile(r"^DISCORD-[0-9]+-[0-9]+$")


class RebuildPipeline(Protocol):
    async def rebuild(self) -> str: ...


class KnowledgeCatalog(Protocol):
    def snapshot(self) -> KnowledgeRepository: ...


@dataclass(frozen=True, slots=True)
class ChannelPolicy:
    all_channels: bool
    channel_ids: frozenset[str]

    @classmethod
    def parse(cls, value: str) -> ChannelPolicy:
        entries = frozenset(part.strip() for part in value.split(",") if part.strip())
        if not entries:
            raise ValueError("CODEGATE_DISCORD_CHANNEL_ALLOWLIST must not be empty")
        if "*" in entries:
            if len(entries) != 1:
                raise ValueError("'*' cannot be combined with Discord channel IDs")
            return cls(all_channels=True, channel_ids=frozenset())
        if any(not entry.isdigit() for entry in entries):
            raise ValueError("Discord channel allowlist entries must be numeric IDs")
        return cls(all_channels=False, channel_ids=entries)

    def allows(self, channel_id: str, parent_id: str | None = None) -> bool:
        return (
            self.all_channels
            or channel_id in self.channel_ids
            or (parent_id is not None and parent_id in self.channel_ids)
        )


@dataclass(frozen=True, slots=True)
class DiscordEvent:
    event_key: str
    dispatch_type: str
    guild_id: str
    channel_id: str
    message_id: str | None
    parent_id: str | None
    occurred_at: str
    payload: dict[str, Any]

    @classmethod
    def from_payload(cls, dispatch_type: str, payload: Mapping[str, Any]) -> DiscordEvent:
        if dispatch_type not in SUPPORTED_DISPATCH_TYPES:
            raise ValueError(f"unsupported Discord dispatch type: {dispatch_type}")
        normalized = json.loads(json.dumps(dict(payload), ensure_ascii=False))
        guild_id = _required_snowflake(normalized, "guild_id")
        if dispatch_type.startswith("THREAD_"):
            channel_id = _required_snowflake(normalized, "id")
            message_id = None
        else:
            channel_id = _required_snowflake(normalized, "channel_id")
            message_id = _required_snowflake(normalized, "id")
        parent = normalized.get("parent_id") or normalized.get("_folding_parent_id")
        parent_id = str(parent) if parent is not None else None
        occurred_at = str(
            normalized.get("edited_timestamp")
            or normalized.get("timestamp")
            or (normalized.get("thread_metadata") or {}).get("archive_timestamp")
            or datetime.now(UTC).isoformat()
        )
        event_key = _event_key(dispatch_type, normalized, message_id, channel_id)
        return cls(
            event_key=event_key,
            dispatch_type=dispatch_type,
            guild_id=guild_id,
            channel_id=channel_id,
            message_id=message_id,
            parent_id=parent_id,
            occurred_at=occurred_at,
            payload=normalized,
        )


@dataclass(frozen=True, slots=True)
class StoredDiscordEvent:
    sequence: int
    event: DiscordEvent


@dataclass(frozen=True, slots=True)
class ProjectionResult:
    changed: bool
    event_count: int
    document_ids: tuple[str, ...]
    fragment_files: tuple[str, ...]
    raw_files: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class DiscordSourceStatus:
    enabled: bool
    guild_id: str
    allowed_channels: tuple[str, ...]
    event_count: int
    projected_documents: tuple[str, ...]
    last_knowledge_version: str | None


class DiscordEventStore:
    def __init__(self, path: Path) -> None:
        self.path = path

    def initialize(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.executescript(
                """
                PRAGMA journal_mode = WAL;
                PRAGMA synchronous = FULL;
                CREATE TABLE IF NOT EXISTS discord_events (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_key TEXT NOT NULL UNIQUE,
                    dispatch_type TEXT NOT NULL,
                    guild_id TEXT NOT NULL,
                    channel_id TEXT NOT NULL,
                    message_id TEXT,
                    parent_id TEXT,
                    occurred_at TEXT NOT NULL,
                    payload_json TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS discord_events_guild_channel
                    ON discord_events(guild_id, channel_id, sequence);
                CREATE TABLE IF NOT EXISTS discord_metadata (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                """
            )

    def append(self, event: DiscordEvent) -> bool:
        with self._connect() as connection:
            cursor = connection.execute(
                """
                INSERT OR IGNORE INTO discord_events(
                    event_key, dispatch_type, guild_id, channel_id, message_id,
                    parent_id, occurred_at, payload_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    event.event_key,
                    event.dispatch_type,
                    event.guild_id,
                    event.channel_id,
                    event.message_id,
                    event.parent_id,
                    event.occurred_at,
                    json.dumps(event.payload, ensure_ascii=False, sort_keys=True),
                ),
            )
            return cursor.rowcount == 1

    def iter_events(self, *, guild_id: str | None = None) -> list[StoredDiscordEvent]:
        query = """
            SELECT sequence, event_key, dispatch_type, guild_id, channel_id,
                   message_id, parent_id, occurred_at, payload_json
            FROM discord_events
        """
        parameters: tuple[str, ...] = ()
        if guild_id is not None:
            query += " WHERE guild_id = ?"
            parameters = (guild_id,)
        query += " ORDER BY sequence"
        with self._connect() as connection:
            rows = connection.execute(query, parameters).fetchall()
        return [
            StoredDiscordEvent(
                sequence=int(row["sequence"]),
                event=DiscordEvent(
                    event_key=str(row["event_key"]),
                    dispatch_type=str(row["dispatch_type"]),
                    guild_id=str(row["guild_id"]),
                    channel_id=str(row["channel_id"]),
                    message_id=(str(row["message_id"]) if row["message_id"] is not None else None),
                    parent_id=(str(row["parent_id"]) if row["parent_id"] is not None else None),
                    occurred_at=str(row["occurred_at"]),
                    payload=json.loads(str(row["payload_json"])),
                ),
            )
            for row in rows
        ]

    def count(self, *, guild_id: str | None = None) -> int:
        query = "SELECT COUNT(*) FROM discord_events"
        parameters: tuple[str, ...] = ()
        if guild_id is not None:
            query += " WHERE guild_id = ?"
            parameters = (guild_id,)
        with self._connect() as connection:
            return int(connection.execute(query, parameters).fetchone()[0])

    def get_metadata(self, key: str) -> str | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT value FROM discord_metadata WHERE key = ?",
                (key,),
            ).fetchone()
        return str(row[0]) if row is not None else None

    def set_metadata(self, key: str, value: str) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO discord_metadata(key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
                """,
                (key, value),
            )

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        return connection


class DiscordProjector:
    def __init__(
        self,
        *,
        store: DiscordEventStore,
        source_root: Path,
        input_root: Path,
        guild_id: str,
        max_fragment_chars: int = 6_000,
    ) -> None:
        self.store = store
        self.source_root = source_root.resolve()
        self.input_root = input_root.resolve()
        self.guild_id = guild_id
        self.max_fragment_chars = max_fragment_chars

    def project(self) -> ProjectionResult:
        events = self.store.iter_events(guild_id=self.guild_id)
        messages, names = _replay_messages(events)
        by_channel: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for payload in messages.values():
            by_channel[str(payload["channel_id"])].append(payload)
        event_channels: dict[str, list[StoredDiscordEvent]] = defaultdict(list)
        for stored in events:
            event_channels[stored.event.channel_id].append(stored)

        self.source_root.mkdir(parents=True, exist_ok=True)
        self.input_root.mkdir(parents=True, exist_ok=True)
        previous = self._owned_fragments()
        current: set[str] = set()
        document_ids: list[str] = []
        raw_files: list[str] = []
        changed = False

        for channel_id, channel_events in sorted(event_channels.items()):
            raw_relative = PurePosixPath(
                ".folding",
                "discord",
                self.guild_id,
                f"{channel_id}.jsonl",
            )
            raw_target = self.source_root / Path(*raw_relative.parts)
            raw_content = _render_raw_events(channel_events)
            changed = _atomic_write(raw_target, raw_content.encode("utf-8")) or changed
            raw_files.append(raw_relative.as_posix())

            channel_messages = sorted(
                by_channel.get(channel_id, []),
                key=lambda item: (str(item.get("timestamp") or ""), str(item.get("id") or "")),
            )
            if not channel_messages:
                continue
            document_id = f"DISCORD-{self.guild_id}-{channel_id}"
            if not DOCUMENT_ID_RE.fullmatch(document_id):
                raise ValueError(f"invalid projected Discord document ID: {document_id}")
            channel_name = names.get(channel_id, channel_id)
            fragments = _pack_messages(channel_messages, self.max_fragment_chars)
            source_sha256 = hashlib.sha256(raw_content.encode("utf-8")).hexdigest()
            metadata = _source_metadata(
                document_id=document_id,
                title=f"Discord #{channel_name}",
                guild_id=self.guild_id,
                channel_id=channel_id,
                source_relative=raw_relative,
                source_sha256=source_sha256,
            )
            for index, fragment in enumerate(fragments, start=1):
                chunk_no = f"{document_id}__{index:04d}"
                value = dict(metadata)
                value["chunk_no"] = chunk_no
                body = _render_fragment_body(
                    title=str(metadata["title"]),
                    chunk_no=chunk_no,
                    fragment=fragment,
                    include_h1=index == 1,
                )
                content = (
                    "---\n"
                    + yaml.safe_dump(value, allow_unicode=True, sort_keys=False)
                    + "---\n"
                    + body
                )
                filename = f"{chunk_no}.md"
                target = self.input_root / filename
                changed = _atomic_write(target, content.encode("utf-8")) or changed
                current.add(filename)
            document_ids.append(document_id)

        for stale in sorted(previous - current):
            if not stale.startswith("DISCORD-") or not stale.endswith(".md"):
                raise ValueError(f"unsafe Discord ownership entry: {stale}")
            target = (self.input_root / stale).resolve()
            if not target.is_relative_to(self.input_root):
                raise ValueError(f"Discord ownership entry escapes input root: {stale}")
            if target.exists():
                if target.is_symlink() or not target.is_file():
                    raise ValueError(f"unsafe stale Discord projection: {stale}")
                target.unlink()
                changed = True

        manifest = {
            "schema_version": 1,
            "owner": "folding-discord-source",
            "guild_id": self.guild_id,
            "files": sorted(current),
            "document_ids": sorted(document_ids),
        }
        manifest_bytes = (
            json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        ).encode()
        changed = _atomic_write(self.input_root / OWNERSHIP_FILE, manifest_bytes) or changed
        return ProjectionResult(
            changed=changed,
            event_count=len(events),
            document_ids=tuple(sorted(document_ids)),
            fragment_files=tuple(sorted(current)),
            raw_files=tuple(sorted(raw_files)),
        )

    def export_markdown(self) -> str:
        parts: list[str] = []
        for filename in sorted(self._owned_fragments()):
            target = self.input_root / filename
            if target.is_file() and not target.is_symlink():
                parts.append(target.read_text(encoding="utf-8"))
        return "\n\n".join(parts)

    def projected_document_ids(self) -> tuple[str, ...]:
        manifest = self._ownership_manifest()
        values = manifest.get("document_ids", [])
        return tuple(sorted(str(value) for value in values if isinstance(value, str)))

    def _owned_fragments(self) -> set[str]:
        manifest = self._ownership_manifest()
        values = manifest.get("files", [])
        return {str(value) for value in values if isinstance(value, str)}

    def _ownership_manifest(self) -> dict[str, Any]:
        path = self.input_root / OWNERSHIP_FILE
        if not path.exists():
            return {}
        if path.is_symlink() or not path.is_file():
            raise ValueError("Discord ownership manifest must be a regular file")
        value = json.loads(path.read_text(encoding="utf-8"))
        if (
            not isinstance(value, dict)
            or value.get("owner") != "folding-discord-source"
            or value.get("guild_id") != self.guild_id
        ):
            raise ValueError("Discord ownership manifest is invalid")
        return value


class DiscordRestClient:
    def __init__(
        self,
        *,
        token: str,
        policy: ChannelPolicy,
        store: DiscordEventStore,
        client: httpx.Client | None = None,
        base_url: str = "https://discord.com/api/v10",
    ) -> None:
        self.policy = policy
        self.store = store
        self._owned_client = client is None
        self.client = client or httpx.Client(
            base_url=base_url,
            headers={"Authorization": f"Bot {token}", "User-Agent": "Folding-LLMWiki/1.0"},
            timeout=30.0,
        )

    def close(self) -> None:
        if self._owned_client:
            self.client.close()

    def backfill_guild(self, guild_id: str) -> int:
        channels = self._request_json("GET", f"/guilds/{guild_id}/channels")
        if not isinstance(channels, list):
            raise RuntimeError("Discord guild channels response must be a list")
        selected = [
            channel
            for channel in channels
            if isinstance(channel, dict)
            and int(channel.get("type", -1)) in TEXT_CHANNEL_TYPES
            and self.policy.allows(str(channel.get("id", "")))
        ]
        active = self._request_json("GET", f"/guilds/{guild_id}/threads/active")
        active_threads = active.get("threads", []) if isinstance(active, dict) else []
        threads = [
            thread
            for thread in active_threads
            if isinstance(thread, dict)
            and self.policy.allows(
                str(thread.get("id", "")),
                str(thread.get("parent_id")) if thread.get("parent_id") is not None else None,
            )
        ]
        for channel in selected:
            archived = self._request_json(
                "GET",
                f"/channels/{channel['id']}/threads/archived/public",
                params={"limit": 100},
            )
            if isinstance(archived, dict):
                threads.extend(
                    thread
                    for thread in archived.get("threads", [])
                    if isinstance(thread, dict)
                    and self.policy.allows(
                        str(thread.get("id", "")),
                        (
                            str(thread.get("parent_id"))
                            if thread.get("parent_id") is not None
                            else str(channel["id"])
                        ),
                    )
                )

        inserted = 0
        seen_channels: set[str] = set()
        for channel in [*selected, *threads]:
            channel_id = str(channel["id"])
            if channel_id in seen_channels:
                continue
            seen_channels.add(channel_id)
            parent_id = str(channel.get("parent_id")) if channel.get("parent_id") else None
            for payload in self.iter_channel_messages(channel_id):
                enriched = dict(payload)
                enriched["guild_id"] = guild_id
                enriched["_folding_channel_name"] = str(channel.get("name") or channel_id)
                if parent_id:
                    enriched["_folding_parent_id"] = parent_id
                inserted += int(
                    self.store.append(DiscordEvent.from_payload("MESSAGE_CREATE", enriched))
                )
        return inserted

    def iter_channel_messages(self, channel_id: str) -> Iterable[dict[str, Any]]:
        before: str | None = None
        while True:
            params: dict[str, Any] = {"limit": 100}
            if before is not None:
                params["before"] = before
            page = self._request_json("GET", f"/channels/{channel_id}/messages", params=params)
            if not isinstance(page, list):
                raise RuntimeError("Discord channel messages response must be a list")
            values = [dict(item) for item in page if isinstance(item, dict)]
            yield from values
            if len(values) < 100:
                break
            before = str(values[-1]["id"])

    def _request_json(
        self,
        method: str,
        path: str,
        *,
        params: Mapping[str, Any] | None = None,
    ) -> Any:
        for attempt in range(4):
            response = self.client.request(method, path, params=params)
            if response.status_code != 429:
                response.raise_for_status()
                return response.json()
            if attempt == 3:
                response.raise_for_status()
            retry_after = float(response.headers.get("Retry-After", "1"))
            time.sleep(min(max(retry_after, 0.05), 30.0))
        raise RuntimeError("Discord request retry loop ended unexpectedly")


class DiscordSourceConnector:
    def __init__(
        self,
        *,
        token: str,
        guild_id: str,
        channel_allowlist: str,
        store_path: Path,
        source_root: Path,
        input_root: Path,
        pipeline: RebuildPipeline,
        catalog: KnowledgeCatalog,
        rebuild_debounce_seconds: float = 5.0,
    ) -> None:
        self.guild_id = guild_id
        self.policy = ChannelPolicy.parse(channel_allowlist)
        self.store = DiscordEventStore(store_path)
        self.projector = DiscordProjector(
            store=self.store,
            source_root=source_root,
            input_root=input_root,
            guild_id=guild_id,
        )
        self.rest = DiscordRestClient(token=token, policy=self.policy, store=self.store)
        self.pipeline = pipeline
        self.catalog = catalog
        self.rebuild_debounce_seconds = rebuild_debounce_seconds
        self._flush_lock = asyncio.Lock()
        self._flush_task: asyncio.Task[None] | None = None

    async def startup(self) -> None:
        await asyncio.to_thread(self.store.initialize)

    async def shutdown(self) -> None:
        task = self._flush_task
        self._flush_task = None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        await asyncio.to_thread(self.rest.close)

    async def backfill(self) -> tuple[int, ProjectionResult, str]:
        inserted = await asyncio.to_thread(self.rest.backfill_guild, self.guild_id)
        projection, version = await self.flush(force_rebuild=True)
        return inserted, projection, version

    async def ingest(self, dispatch_type: str, payload: Mapping[str, Any]) -> bool:
        event = DiscordEvent.from_payload(dispatch_type, payload)
        if event.guild_id != self.guild_id:
            return False
        if not self.policy.allows(event.channel_id, event.parent_id):
            return False
        inserted = await asyncio.to_thread(self.store.append, event)
        if inserted:
            self.schedule_flush()
        return inserted

    def schedule_flush(self) -> None:
        if self._flush_task is None or self._flush_task.done():
            self._flush_task = asyncio.create_task(
                self._debounced_flush(),
                name="folding-discord-llmwiki-flush",
            )

    async def flush(self, *, force_rebuild: bool = False) -> tuple[ProjectionResult, str]:
        async with self._flush_lock:
            projection = await asyncio.to_thread(self.projector.project)
            previous = self.store.get_metadata("knowledge_version")
            if projection.changed or force_rebuild or previous is None:
                version = await self.pipeline.rebuild()
                await asyncio.to_thread(self.store.set_metadata, "knowledge_version", version)
            else:
                version = previous
            return projection, version

    async def _debounced_flush(self) -> None:
        await asyncio.sleep(self.rebuild_debounce_seconds)
        await self.flush()

    def search(
        self,
        query: str,
        *,
        access_context: AccessContext,
        top_k: int = 5,
    ) -> list[DocumentResult]:
        projected_ids = frozenset(self.projector.projected_document_ids())
        if not projected_ids:
            return []
        candidates = self.catalog.snapshot().search(
            query,
            access_context=access_context,
            top_k=max(10_000, top_k),
        )
        return [value for value in candidates if value.document_id in projected_ids][:top_k]

    def export_markdown(self) -> str:
        return self.projector.export_markdown()

    def status(self) -> DiscordSourceStatus:
        allowed = ("*",) if self.policy.all_channels else tuple(sorted(self.policy.channel_ids))
        return DiscordSourceStatus(
            enabled=True,
            guild_id=self.guild_id,
            allowed_channels=allowed,
            event_count=self.store.count(guild_id=self.guild_id),
            projected_documents=self.projector.projected_document_ids(),
            last_knowledge_version=self.store.get_metadata("knowledge_version"),
        )


def _required_snowflake(payload: Mapping[str, Any], key: str) -> str:
    value = payload.get(key)
    normalized = str(value) if value is not None else ""
    if not normalized.isdigit():
        raise ValueError(f"Discord payload requires numeric {key}")
    return normalized


def _event_key(
    dispatch_type: str,
    payload: Mapping[str, Any],
    message_id: str | None,
    channel_id: str,
) -> str:
    if dispatch_type == "MESSAGE_CREATE":
        return f"{dispatch_type}:{message_id}"
    if dispatch_type == "MESSAGE_DELETE":
        return f"{dispatch_type}:{message_id}"
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    digest = hashlib.sha256(encoded).hexdigest()[:24]
    return f"{dispatch_type}:{message_id or channel_id}:{digest}"


def _replay_messages(
    events: Iterable[StoredDiscordEvent],
) -> tuple[dict[str, dict[str, Any]], dict[str, str]]:
    messages: dict[str, dict[str, Any]] = {}
    channel_names: dict[str, str] = {}
    for stored in events:
        event = stored.event
        payload = event.payload
        declared_name = payload.get("_folding_channel_name") or payload.get("name")
        if declared_name:
            channel_names[event.channel_id] = str(declared_name)
        if event.dispatch_type == "MESSAGE_CREATE" and event.message_id is not None:
            messages[event.message_id] = dict(payload)
        elif event.dispatch_type == "MESSAGE_UPDATE" and event.message_id is not None:
            previous = messages.get(event.message_id, {})
            messages[event.message_id] = {**previous, **payload}
        elif event.dispatch_type == "MESSAGE_DELETE" and event.message_id is not None:
            messages.pop(event.message_id, None)
    return messages, channel_names


def _render_raw_events(events: Iterable[StoredDiscordEvent]) -> str:
    return "".join(
        json.dumps(
            {
                "sequence": stored.sequence,
                "event_key": stored.event.event_key,
                "dispatch_type": stored.event.dispatch_type,
                "occurred_at": stored.event.occurred_at,
                "payload": stored.event.payload,
            },
            ensure_ascii=False,
            sort_keys=True,
        )
        + "\n"
        for stored in events
    )


def _pack_messages(messages: Iterable[dict[str, Any]], max_chars: int) -> list[list[str]]:
    rendered = [_render_message(message) for message in messages]
    pieces: list[str] = []
    for value in rendered:
        if len(value) <= max_chars:
            pieces.append(value)
            continue
        for start in range(0, len(value), max_chars):
            pieces.append(value[start : start + max_chars])
    fragments: list[list[str]] = []
    current: list[str] = []
    current_length = 0
    for value in pieces:
        addition = len(value) + (2 if current else 0)
        if current and current_length + addition > max_chars:
            fragments.append(current)
            current = []
            current_length = 0
        current.append(value)
        current_length += len(value) + (2 if current_length else 0)
    if current:
        fragments.append(current)
    return fragments


def _render_message(payload: Mapping[str, Any]) -> str:
    channel_id = str(payload.get("channel_id") or "unknown")
    message_id = str(payload.get("id") or "unknown")
    timestamp = str(payload.get("timestamp") or payload.get("edited_timestamp") or "unknown-time")
    author = payload.get("author")
    author_map = author if isinstance(author, dict) else {}
    author_name = str(
        author_map.get("global_name")
        or author_map.get("username")
        or author_map.get("id")
        or "unknown"
    )
    content = _safe_discord_markdown(str(payload.get("content") or "(내용 없음)"))
    quoted = "\n".join(f"> {line}" if line else ">" for line in content.splitlines())
    lines = [
        f"**{timestamp} · {author_name}** `discord:{channel_id}:{message_id}`",
        "",
        quoted,
    ]
    reference = payload.get("message_reference")
    if isinstance(reference, dict) and reference.get("message_id"):
        lines.extend(["", f"- 답글 대상: `discord:{channel_id}:{reference['message_id']}`"])
    attachments = payload.get("attachments")
    if isinstance(attachments, list):
        for attachment in attachments:
            if not isinstance(attachment, dict):
                continue
            filename = _safe_discord_markdown(str(attachment.get("filename") or "attachment"))
            url = str(attachment.get("url") or "")
            if url.startswith(("https://", "http://")):
                lines.append(f"- 첨부: {filename} (<{url}>)")
            else:
                lines.append(f"- 첨부: {filename}")
    return "\n".join(lines).strip()


def _safe_discord_markdown(value: str) -> str:
    return value.replace("](", "] (").replace("\x00", "")


def _source_metadata(
    *,
    document_id: str,
    title: str,
    guild_id: str,
    channel_id: str,
    source_relative: PurePosixPath,
    source_sha256: str,
) -> dict[str, Any]:
    return {
        "schema_version": "1.0.0",
        "id": document_id,
        "title": title[:500],
        "doc_type": "meeting_note",
        "language": "und",
        "revision": source_sha256[:12],
        "status": "active",
        "official_number": None,
        "authority_level": "reference",
        "issuing_org": f"Discord guild {guild_id}",
        "issued_on": None,
        "effective_from": None,
        "effective_to": None,
        "source": {
            "filename": source_relative.as_posix(),
            "uri": f"source://{source_relative.as_posix()}",
            "sha256": source_sha256,
            "verification": "verified",
        },
        "access": "internal",
        "tags": ["discord", "team-memory", f"channel:{channel_id}"],
        "aliases": [f"Discord {channel_id}", title],
    }


def _render_fragment_body(
    *,
    title: str,
    chunk_no: str,
    fragment: Iterable[str],
    include_h1: bool,
) -> str:
    lines: list[str] = []
    if include_h1:
        lines.extend([f"# {title}", ""])
    lines.extend([f"<!-- source-chunk: {chunk_no} -->", "", *fragment, ""])
    return "\n".join(lines)


def _atomic_write(path: Path, content: bytes) -> bool:
    if path.exists():
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"refusing to replace non-regular file: {path}")
        if path.read_bytes() == content:
            return False
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        with temporary.open("wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        _fsync_directory(path.parent)
    finally:
        if temporary.exists():
            temporary.unlink()
    return True


def _fsync_directory(path: Path) -> None:
    if os.name == "nt":
        return
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
