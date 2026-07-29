from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest
import yaml
from pydantic import ValidationError

from codegate_api.config import Settings
from codegate_api.integrations.discord_source import (
    ChannelPolicy,
    DiscordEvent,
    DiscordEventStore,
    DiscordProjector,
    DiscordRestClient,
    DiscordSourceConnector,
)

TOKEN = "discord-token-for-tests"  # gitleaks:allow
GUILD_ID = "100000000000000001"
CHANNEL_ID = "200000000000000002"
THREAD_ID = "300000000000000003"


def _message(
    message_id: str,
    content: str,
    *,
    channel_id: str = CHANNEL_ID,
    parent_id: str | None = None,
) -> dict[str, Any]:
    value: dict[str, Any] = {
        "id": message_id,
        "guild_id": GUILD_ID,
        "channel_id": channel_id,
        "timestamp": "2026-07-29T00:00:00+00:00",
        "content": content,
        "author": {"id": "400000000000000004", "username": "mingyu"},
        "_folding_channel_name": "architecture",
    }
    if parent_id is not None:
        value["_folding_parent_id"] = parent_id
    return value


def test_channel_policy_is_explicit_and_inherits_parent_threads() -> None:
    with pytest.raises(ValueError, match="must not be empty"):
        ChannelPolicy.parse("")
    with pytest.raises(ValueError, match="numeric"):
        ChannelPolicy.parse("general")
    with pytest.raises(ValueError, match="cannot be combined"):
        ChannelPolicy.parse(f"*,{CHANNEL_ID}")

    policy = ChannelPolicy.parse(CHANNEL_ID)
    assert policy.allows(CHANNEL_ID)
    assert policy.allows(THREAD_ID, CHANNEL_ID)
    assert not policy.allows(THREAD_ID)
    assert ChannelPolicy.parse("*").allows("999")


def test_event_store_is_append_only_and_idempotent(tmp_path: Path) -> None:
    store = DiscordEventStore(tmp_path / "events.sqlite3")
    store.initialize()
    event = DiscordEvent.from_payload("MESSAGE_CREATE", _message("500", "first"))

    assert store.append(event)
    assert not store.append(event)
    assert store.count(guild_id=GUILD_ID) == 1
    assert store.iter_events(guild_id=GUILD_ID)[0].event.payload["content"] == "first"


def test_projector_replays_updates_deletes_and_neutralizes_links(tmp_path: Path) -> None:
    store = DiscordEventStore(tmp_path / "events.sqlite3")
    store.initialize()
    source_root = tmp_path / "source"
    input_root = tmp_path / "input"
    projector = DiscordProjector(
        store=store,
        source_root=source_root,
        input_root=input_root,
        guild_id=GUILD_ID,
        max_fragment_chars=500,
    )
    store.append(
        DiscordEvent.from_payload(
            "MESSAGE_CREATE",
            _message("501", "# fake heading\n[REG-000001](docs/secret.md)"),
        )
    )
    store.append(
        DiscordEvent.from_payload(
            "MESSAGE_UPDATE",
            {
                **_message("501", "approved architecture"),
                "edited_timestamp": "2026-07-29T00:01:00+00:00",
            },
        )
    )
    store.append(
        DiscordEvent.from_payload(
            "MESSAGE_CREATE",
            _message("503", "# fake heading\n[REG-000001](docs/secret.md)"),
        )
    )
    store.append(DiscordEvent.from_payload("MESSAGE_CREATE", _message("502", "delete me")))
    store.append(
        DiscordEvent.from_payload(
            "MESSAGE_DELETE",
            {
                "id": "502",
                "guild_id": GUILD_ID,
                "channel_id": CHANNEL_ID,
            },
        )
    )

    result = projector.project()

    assert result.changed
    assert result.event_count == 5
    assert result.document_ids == (f"DISCORD-{GUILD_ID}-{CHANNEL_ID}",)
    fragment = (input_root / result.fragment_files[0]).read_text(encoding="utf-8")
    assert "approved architecture" in fragment
    assert "delete me" not in fragment
    assert "[REG-000001](docs/secret.md)" not in fragment
    assert "[REG-000001] (docs/secret.md)" in fragment
    assert "`discord:200000000000000002:501`" in fragment
    raw = (source_root / result.raw_files[0]).read_text(encoding="utf-8")
    assert len(raw.strip().splitlines()) == 5

    metadata_text = fragment.split("---", 2)[1]
    metadata = yaml.safe_load(metadata_text)
    assert metadata["id"] == f"DISCORD-{GUILD_ID}-{CHANNEL_ID}"
    assert metadata["source"]["uri"].startswith("source://.folding/discord/")
    assert metadata["access"] == "internal"
    assert metadata["chunk_no"] == f"DISCORD-{GUILD_ID}-{CHANNEL_ID}__0001"

    second = projector.project()
    assert not second.changed


def test_projector_only_removes_owned_fragments(tmp_path: Path) -> None:
    store = DiscordEventStore(tmp_path / "events.sqlite3")
    store.initialize()
    input_root = tmp_path / "input"
    input_root.mkdir()
    foreign = input_root / "MAN-000001.md"
    foreign.write_text("keep", encoding="utf-8")
    (input_root / ".discord-source-manifest.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "owner": "folding-discord-source",
                "guild_id": GUILD_ID,
                "files": [f"DISCORD-{GUILD_ID}-{CHANNEL_ID}__0001.md"],
                "document_ids": [f"DISCORD-{GUILD_ID}-{CHANNEL_ID}"],
            }
        ),
        encoding="utf-8",
    )
    stale = input_root / f"DISCORD-{GUILD_ID}-{CHANNEL_ID}__0001.md"
    stale.write_text("stale", encoding="utf-8")

    projector = DiscordProjector(
        store=store,
        source_root=tmp_path / "source",
        input_root=input_root,
        guild_id=GUILD_ID,
    )
    projector.project()

    assert not stale.exists()
    assert foreign.read_text(encoding="utf-8") == "keep"


def test_rest_backfill_paginates_and_enforces_parent_allowlist(tmp_path: Path) -> None:
    store = DiscordEventStore(tmp_path / "events.sqlite3")
    store.initialize()
    calls: list[tuple[str, str | None]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        before = request.url.params.get("before")
        calls.append((request.url.path, before))
        if request.url.path.endswith("/channels"):
            return httpx.Response(
                200,
                json=[
                    {"id": CHANNEL_ID, "name": "architecture", "type": 0},
                    {"id": "299", "name": "private", "type": 0},
                ],
            )
        if request.url.path.endswith("/threads/active"):
            return httpx.Response(
                200,
                json={
                    "threads": [
                        {
                            "id": THREAD_ID,
                            "name": "design-thread",
                            "parent_id": CHANNEL_ID,
                        }
                    ]
                },
            )
        if request.url.path.endswith("/threads/archived/public"):
            return httpx.Response(200, json={"threads": []})
        if request.url.path.endswith(f"/channels/{CHANNEL_ID}/messages"):
            if before is None:
                return httpx.Response(
                    200,
                    json=[_message(str(1_000 - index), f"m{index}") for index in range(100)],
                )
            return httpx.Response(200, json=[_message("899", "last")])
        if request.url.path.endswith(f"/channels/{THREAD_ID}/messages"):
            return httpx.Response(
                200,
                json=[
                    _message(
                        "700",
                        "thread message",
                        channel_id=THREAD_ID,
                        parent_id=CHANNEL_ID,
                    )
                ],
            )
        raise AssertionError(f"unexpected request: {request.url}")

    client = httpx.Client(
        base_url="https://discord.test/api/v10",
        transport=httpx.MockTransport(handler),
    )
    rest = DiscordRestClient(
        token=TOKEN,
        policy=ChannelPolicy.parse(CHANNEL_ID),
        store=store,
        client=client,
    )

    assert rest.backfill_guild(GUILD_ID) == 102
    assert (f"/api/v10/channels/{CHANNEL_ID}/messages", None) in calls
    assert (f"/api/v10/channels/{CHANNEL_ID}/messages", "901") in calls
    assert all("/channels/299/messages" not in path for path, _ in calls)


def test_discord_settings_require_local_llmwiki_configuration(tmp_path: Path) -> None:
    with pytest.raises(ValidationError, match="KNOWLEDGE_MODE"):
        Settings(
            discord_enabled=True,
            discord_bot_token=TOKEN,
            discord_guild_id=GUILD_ID,
            discord_channel_allowlist=CHANNEL_ID,
        )

    settings = Settings(
        environment="local",
        auth_mode="local",
        bootstrap_demo=False,
        knowledge_mode="llmwiki",
        source_root=tmp_path / "source",
        runtime_root=tmp_path / "runtime",
        llmwiki_project_root=tmp_path / "project",
        llmwiki_input_root=tmp_path / "input",
        llmwiki_storage_root=tmp_path / "storage",
        discord_enabled=True,
        discord_bot_token=TOKEN,
        discord_guild_id=GUILD_ID,
        discord_channel_allowlist=CHANNEL_ID,
        discord_gateway_enabled=False,
    )

    assert (
        settings.resolved_discord_store_path()
        == (tmp_path / "runtime/discord/events.sqlite3").resolve()
    )


@pytest.mark.anyio
async def test_connector_rejects_other_guilds_and_debounces(tmp_path: Path) -> None:
    class Pipeline:
        def __init__(self) -> None:
            self.calls = 0

        async def rebuild(self) -> str:
            self.calls += 1
            return f"v{self.calls}"

    class Catalog:
        def snapshot(self) -> Any:
            raise AssertionError("search is not used in this test")

    pipeline = Pipeline()
    connector = DiscordSourceConnector(
        token=TOKEN,
        guild_id=GUILD_ID,
        channel_allowlist=CHANNEL_ID,
        store_path=tmp_path / "events.sqlite3",
        source_root=tmp_path / "source",
        input_root=tmp_path / "input",
        pipeline=pipeline,
        catalog=Catalog(),
        rebuild_debounce_seconds=0.01,
    )
    await connector.startup()
    try:
        other = {**_message("800", "ignored"), "guild_id": "999"}
        assert not await connector.ingest("MESSAGE_CREATE", other)
        assert await connector.ingest("MESSAGE_CREATE", _message("801", "kept"))
        await connector.flush()
        assert pipeline.calls == 1
    finally:
        await connector.shutdown()
