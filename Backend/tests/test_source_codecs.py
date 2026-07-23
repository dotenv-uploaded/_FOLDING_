from __future__ import annotations

import base64
import hashlib
import json
import subprocess
from pathlib import Path
from typing import Any, cast

import pytest

from codegate_api.files.codecs import (
    KordocBridge,
    SourceCodecError,
    SourceDocumentCodecs,
    dependency_graph_sha256,
)


def test_text_codec_round_trips_utf8_and_rejects_invalid_bytes() -> None:
    codecs = SourceDocumentCodecs()

    assert codecs.supports_edit(".md") is True
    assert codecs.decode("한글".encode(), suffix=".md", max_text_bytes=32) == "한글"
    assert codecs.encode(b"old", suffix=".txt", text="새 값") == "새 값".encode()
    with pytest.raises(SourceCodecError) as raised:
        codecs.decode(b"\xff", suffix=".txt", max_text_bytes=32)

    assert raised.value.code == "UNSUPPORTED_ENCODING"


def test_kordoc_bridge_pipes_bytes_and_requires_verified_markdown(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    entry = tmp_path / "kordoc.js"
    entry.write_text("export {};", encoding="utf-8")
    (tmp_path / "package.json").write_text(
        '{"name":"fake-kordoc","version":"1.0.0","dependencies":{}}',
        encoding="utf-8",
    )
    calls: list[dict[str, Any]] = []

    def fake_run(args: list[str], **kwargs: Any) -> tuple[int, bool]:
        request = json.loads(str(kwargs["input_text"]))
        calls.append({"args": args, "request": request, "kwargs": kwargs})
        if request["action"] == "parse":
            payload = {"success": True, "markdown": "# 문서\n\n현재 값"}
        else:
            payload = {
                "success": True,
                "skipped_count": 0,
                "data_base64": base64.b64encode(b"patched-hwp").decode("ascii"),
                "verified_markdown": request["markdown"],
            }
        kwargs["stdout"].write(json.dumps(payload).encode())
        return 0, False

    monkeypatch.setattr("codegate_api.files.codecs.shutil.which", lambda _: "/usr/bin/node")
    monkeypatch.setattr("codegate_api.files.codecs._run_bounded_process", fake_run)
    bridge = KordocBridge(
        entry_path=entry,
        expected_entry_sha256=hashlib.sha256(entry.read_bytes()).hexdigest(),
        expected_dependency_graph_sha256=dependency_graph_sha256((tmp_path,)),
        run_as_node=True,
    )

    assert bridge.parse(b"original-hwp", suffix=".hwp", max_text_bytes=100) == ("# 문서\n\n현재 값")
    assert (
        bridge.patch(
            b"original-hwp",
            suffix=".hwp",
            markdown="# 문서\n\n새 값",
        )
        == b"patched-hwp"
    )
    assert [call["request"]["action"] for call in calls] == ["parse", "patch"]
    assert base64.b64decode(calls[0]["request"]["original_base64"]) == b"original-hwp"
    assert calls[0]["kwargs"]["env"].get("ANTHROPIC_API_KEY") is None
    assert calls[0]["kwargs"]["stdout"] is not subprocess.PIPE
    assert "--experimental-permission" in calls[0]["args"]
    assert calls[0]["kwargs"]["env"]["ELECTRON_RUN_AS_NODE"] == "1"
    assert "--max-old-space-size=256" in calls[0]["args"]
    assert calls[0]["args"][-1] == str(entry.resolve())


def test_kordoc_bridge_rejects_partial_or_unverified_patch(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    entry = tmp_path / "kordoc.js"
    entry.write_text("export {};", encoding="utf-8")
    (tmp_path / "package.json").write_text(
        '{"name":"fake-kordoc","version":"1.0.0","dependencies":{}}',
        encoding="utf-8",
    )

    def fake_run(args: list[str], **kwargs: Any) -> tuple[int, bool]:
        payload = {
            "success": True,
            "skipped_count": 1,
            "data_base64": base64.b64encode(b"partial").decode("ascii"),
            "verified_markdown": "different",
        }
        kwargs["stdout"].write(json.dumps(payload).encode())
        return 0, False

    monkeypatch.setattr("codegate_api.files.codecs.shutil.which", lambda _: "/usr/bin/node")
    monkeypatch.setattr("codegate_api.files.codecs._run_bounded_process", fake_run)

    with pytest.raises(SourceCodecError) as raised:
        KordocBridge(
            entry_path=entry,
            expected_entry_sha256=hashlib.sha256(entry.read_bytes()).hexdigest(),
            expected_dependency_graph_sha256=dependency_graph_sha256((tmp_path,)),
        ).patch(
            b"original-hwp",
            suffix=".hwp",
            markdown="# 문서\n\n새 값",
        )

    assert raised.value.code == "HWP_PATCH_VERIFY_FAILED"


def test_kordoc_bridge_fails_closed_when_attested_entry_changes(tmp_path: Path) -> None:
    entry = tmp_path / "kordoc.js"
    entry.write_text("export {};", encoding="utf-8")
    (tmp_path / "package.json").write_text(
        '{"name":"fake-kordoc","version":"1.0.0","dependencies":{}}',
        encoding="utf-8",
    )
    bridge = KordocBridge(
        entry_path=entry,
        expected_entry_sha256=hashlib.sha256(entry.read_bytes()).hexdigest(),
        expected_dependency_graph_sha256=dependency_graph_sha256((tmp_path,)),
    )
    entry.write_text("export const replaced = true;", encoding="utf-8")

    assert bridge.available is False
    with pytest.raises(SourceCodecError) as raised:
        bridge.parse(b"original-hwp", suffix=".hwp", max_text_bytes=100)

    assert raised.value.code == "HWP_WRITER_UNAVAILABLE"


def test_kordoc_bridge_rejects_attested_dependency_change(tmp_path: Path) -> None:
    entry = tmp_path / "kordoc.js"
    dependency = tmp_path / "node_modules/dependency"
    dependency.mkdir(parents=True)
    entry.write_text("export {};", encoding="utf-8")
    (tmp_path / "package.json").write_text(
        '{"name":"fake-kordoc","version":"1.0.0","dependencies":{"dependency":"1.0.0"}}',
        encoding="utf-8",
    )
    (dependency / "package.json").write_text(
        '{"name":"dependency","version":"1.0.0","dependencies":{}}',
        encoding="utf-8",
    )
    dependency_entry = dependency / "index.js"
    dependency_entry.write_text("export const value = 1;", encoding="utf-8")
    roots = (tmp_path, dependency)
    bridge = KordocBridge(
        entry_path=entry,
        expected_entry_sha256=hashlib.sha256(entry.read_bytes()).hexdigest(),
        expected_dependency_graph_sha256=dependency_graph_sha256(roots),
    )
    dependency_entry.write_text("export const value = 2;", encoding="utf-8")

    assert bridge.available is False
    with pytest.raises(SourceCodecError) as raised:
        bridge.parse(b"original-hwp", suffix=".hwp", max_text_bytes=100)

    assert raised.value.code == "HWP_CODEC_INTEGRITY_ERROR"


def test_hwp_codec_is_enabled_only_with_an_available_local_bridge() -> None:
    class FakeBridge:
        available = True

        def parse(self, _: bytes, *, suffix: str, max_text_bytes: int) -> str:
            assert suffix == ".hwp"
            assert max_text_bytes == 100
            return "# 문서\n\n현재 값"

        def patch(self, _: bytes, *, suffix: str, markdown: str) -> bytes:
            assert suffix == ".hwp"
            return markdown.encode()

    codecs = SourceDocumentCodecs(kordoc=cast(KordocBridge, FakeBridge()))

    assert codecs.supports_edit(".hwp") is True
    assert codecs.decode(b"binary", suffix=".hwp", max_text_bytes=100).endswith("현재 값")
    assert codecs.encode(b"binary", suffix=".hwp", text="새 값") == "새 값".encode()
