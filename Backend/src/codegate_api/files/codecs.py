from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import shutil
import subprocess
import tempfile
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Final

TEXT_SUFFIXES = frozenset({".md", ".markdown", ".txt"})
HWP_SUFFIXES = frozenset({".hwp", ".hwpx"})


class SourceCodecError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


_KORDOC_BRIDGE: Final = r"""
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const writeResult = process.stdout.write.bind(process.stdout);
process.stdout.write = () => true;
const require = createRequire(import.meta.url);
const denied = () => { throw new Error("operation denied in document codec"); };
for (const [moduleName, methods] of [
  ["node:child_process", ["exec", "execFile", "fork", "spawn"]],
  ["node:dgram", ["createSocket"]],
  ["node:http", ["get", "request"]],
  ["node:http2", ["connect"]],
  ["node:https", ["get", "request"]],
  ["node:net", ["connect", "createConnection", "createServer"]],
  ["node:tls", ["connect", "createServer"]],
]) {
  const module = require(moduleName);
  for (const method of methods) {
    if (typeof module[method] === "function") module[method] = denied;
  }
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const kordoc = await import(pathToFileURL(process.argv[1]).href);
const original = new Uint8Array(Buffer.from(request.original_base64, "base64"));

if (request.action === "parse") {
  const parsed = await kordoc.parse(original);
  const markdown = typeof parsed === "string" ? parsed : parsed?.markdown;
  writeResult(JSON.stringify({
    success: typeof parsed === "string" ? true : parsed?.success !== false,
    markdown,
  }));
} else if (request.action === "patch") {
  const patch = request.suffix === ".hwpx" ? kordoc.patchHwpx : kordoc.patchHwp;
  const result = await patch(original, request.markdown);
  const bytes = result?.data ? new Uint8Array(result.data) : null;
  const verified = bytes ? await kordoc.parse(bytes) : null;
  const verifiedMarkdown = typeof verified === "string" ? verified : verified?.markdown;
  writeResult(JSON.stringify({
    success: result?.success === true && verified !== null && verified?.success !== false,
    skipped_count: Array.isArray(result?.skipped) ? result.skipped.length : 0,
    data_base64: bytes ? Buffer.from(bytes).toString("base64") : null,
    verified_markdown: verifiedMarkdown,
  }));
} else {
  throw new Error("unsupported kordoc bridge action");
}
"""


@dataclass(frozen=True, slots=True)
class KordocBridge:
    entry_path: Path
    expected_entry_sha256: str | None = None
    expected_dependency_graph_sha256: str | None = None
    node_binary: str = "node"
    run_as_node: bool = False
    timeout_seconds: float = 30.0
    max_source_bytes: int = 10_485_760
    _dependency_roots: tuple[Path, ...] = field(init=False, repr=False)

    def __post_init__(self) -> None:
        try:
            roots = _package_dependency_roots(self.entry_path.resolve())
        except (OSError, ValueError, json.JSONDecodeError):
            roots = ()
        object.__setattr__(self, "_dependency_roots", roots)

    @property
    def available(self) -> bool:
        return self._base_available() and self._dependency_graph_digest_matches()

    def _base_available(self) -> bool:
        return (
            self.expected_entry_sha256 is not None
            and self.expected_dependency_graph_sha256 is not None
            and bool(self._dependency_roots)
            and self.entry_path.is_file()
            and not self.entry_path.is_symlink()
            and shutil.which(self.node_binary) is not None
            and self._entry_digest_matches()
        )

    def parse(self, content: bytes, *, suffix: str, max_text_bytes: int) -> str:
        payload = self._invoke("parse", content=content, suffix=suffix)
        markdown = payload.get("markdown")
        if (
            payload.get("success") is not True
            or not isinstance(markdown, str)
            or not markdown.strip()
        ):
            raise SourceCodecError("HWP_PARSE_FAILED", "한글 문서에서 내용을 읽지 못했습니다.")
        if len(markdown.encode("utf-8")) > max_text_bytes:
            raise SourceCodecError(
                "FILE_TOO_LARGE", "한글 문서 본문이 에이전트 읽기 제한을 초과했습니다."
            )
        return markdown

    def patch(self, content: bytes, *, suffix: str, markdown: str) -> bytes:
        payload = self._invoke("patch", content=content, suffix=suffix, markdown=markdown)
        encoded = payload.get("data_base64")
        if (
            payload.get("success") is not True
            or payload.get("skipped_count") != 0
            or not isinstance(encoded, str)
            or payload.get("verified_markdown") != markdown
        ):
            raise SourceCodecError(
                "HWP_PATCH_VERIFY_FAILED",
                "한글 문서의 모든 변경을 서식 보존 상태로 검증하지 못해 "
                "원본을 수정하지 않았습니다.",
            )
        try:
            patched = base64.b64decode(encoded, validate=True)
        except ValueError as error:
            raise SourceCodecError(
                "HWP_PATCH_VERIFY_FAILED", "한글 문서 수정 결과가 손상되었습니다."
            ) from error
        if not patched or len(patched) > self.max_source_bytes:
            raise SourceCodecError(
                "FILE_TOO_LARGE", "한글 문서 수정 결과가 허용된 파일 크기를 초과했습니다."
            )
        return patched

    def _invoke(
        self,
        action: str,
        *,
        content: bytes,
        suffix: str,
        markdown: str | None = None,
    ) -> dict[str, Any]:
        if not self._base_available():
            raise SourceCodecError(
                "HWP_WRITER_UNAVAILABLE", "한글 문서 편집 구성요소를 찾지 못했습니다."
            )
        if suffix not in HWP_SUFFIXES:
            raise SourceCodecError("UNSUPPORTED_WRITE_FORMAT", "지원하지 않는 문서 형식입니다.")
        if len(content) > self.max_source_bytes:
            raise SourceCodecError("FILE_TOO_LARGE", "한글 문서가 허용된 파일 크기를 초과했습니다.")
        if not self._dependency_graph_digest_matches():
            raise SourceCodecError(
                "HWP_CODEC_INTEGRITY_ERROR",
                "한글 문서 처리기의 무결성을 확인하지 못했습니다.",
            )
        request: dict[str, object] = {
            "action": action,
            "suffix": suffix,
            "original_base64": base64.b64encode(content).decode("ascii"),
        }
        if markdown is not None:
            request["markdown"] = markdown
        entry_path = self.entry_path.resolve()
        max_output_bytes = self.max_source_bytes * 3 + 1_048_576
        child_env = {
            name: value
            for name in (
                "PATH",
                "Path",
                "PATHEXT",
                "SystemRoot",
                "SYSTEMROOT",
                "WINDIR",
                "LANG",
                "LC_ALL",
                "TZ",
            )
            if (value := os.environ.get(name)) is not None
        }
        if self.run_as_node:
            child_env["ELECTRON_RUN_AS_NODE"] = "1"
        args = [
            self.node_binary,
            "--max-old-space-size=256",
            "--max-semi-space-size=16",
            "--experimental-permission" if self.run_as_node else "--permission",
            *[
                f"--allow-fs-read={allowed_path}"
                for allowed_path in _dependency_read_paths(self._dependency_roots)
            ],
            "--no-addons",
            "--disable-proto=delete",
            "--input-type=module",
            "--eval",
            _KORDOC_BRIDGE,
            str(entry_path),
        ]
        try:
            with (
                tempfile.TemporaryDirectory(prefix="codegate-kordoc-") as work_dir,
                tempfile.TemporaryFile(mode="w+b") as stdout_file,
                tempfile.TemporaryFile(mode="w+b") as stderr_file,
            ):
                returncode, output_exceeded = _run_bounded_process(
                    args,
                    input_text=json.dumps(
                        request,
                        ensure_ascii=False,
                        separators=(",", ":"),
                    ),
                    stdout=stdout_file,
                    stderr=stderr_file,
                    timeout=self.timeout_seconds,
                    cwd=work_dir,
                    env=child_env,
                    max_output_bytes=max_output_bytes,
                )
                if output_exceeded:
                    raise SourceCodecError(
                        "HWP_CODEC_OUTPUT_TOO_LARGE",
                        "한글 문서 처리 결과가 안전 제한을 초과했습니다.",
                    )
                stdout_file.seek(0)
                output = stdout_file.read(max_output_bytes + 1).decode("utf-8")
        except (OSError, subprocess.TimeoutExpired) as error:
            raise SourceCodecError(
                "HWP_CODEC_UNAVAILABLE", "한글 문서 처리기가 응답하지 않았습니다."
            ) from error
        if returncode != 0:
            raise SourceCodecError(
                "HWP_CODEC_FAILED", "한글 문서 처리기가 문서를 안전하게 처리하지 못했습니다."
            )
        try:
            payload: Any = json.loads(output)
        except json.JSONDecodeError as error:
            raise SourceCodecError(
                "HWP_CODEC_FAILED", "한글 문서 처리 결과가 올바르지 않습니다."
            ) from error
        if not isinstance(payload, dict):
            raise SourceCodecError("HWP_CODEC_FAILED", "한글 문서 처리 결과가 올바르지 않습니다.")
        return payload

    def _entry_digest_matches(self) -> bool:
        expected = self.expected_entry_sha256
        if expected is None or len(expected) != 64:
            return False
        try:
            actual = hashlib.sha256(self.entry_path.read_bytes()).hexdigest()
        except OSError:
            return False
        return secrets.compare_digest(actual, expected)

    def _dependency_graph_digest_matches(self) -> bool:
        expected = self.expected_dependency_graph_sha256
        if expected is None or len(expected) != 64 or not self._dependency_roots:
            return False
        try:
            actual = dependency_graph_sha256(self._dependency_roots)
        except OSError:
            return False
        return secrets.compare_digest(actual, expected)


def _package_dependency_roots(entry_path: Path) -> tuple[Path, ...]:
    roots: set[Path] = set()
    pending = [_find_package_root(entry_path)]
    while pending:
        package_root = pending.pop().resolve()
        if package_root in roots:
            continue
        metadata = _package_metadata(package_root)
        roots.add(package_root)
        dependencies = metadata.get("dependencies", {})
        if not isinstance(dependencies, dict):
            raise ValueError("package dependencies must be an object")
        for dependency in sorted(dependencies):
            if not isinstance(dependency, str) or not dependency:
                raise ValueError("package dependency name is invalid")
            pending.append(_resolve_package_dependency(package_root, dependency))
    return tuple(sorted(roots, key=str))


def _find_package_root(entry_path: Path, *, expected_name: str | None = None) -> Path:
    for candidate in (entry_path.parent, *entry_path.parents):
        package_json = candidate / "package.json"
        if not package_json.is_file() or package_json.is_symlink():
            continue
        metadata = _package_metadata(candidate)
        if expected_name is None or metadata.get("name") == expected_name:
            return candidate.resolve()
    raise OSError("package root was not found")


def _package_metadata(package_root: Path) -> dict[str, Any]:
    value = json.loads((package_root / "package.json").read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("package metadata must be an object")
    if not isinstance(value.get("name"), str) or not isinstance(value.get("version"), str):
        raise ValueError("package identity is invalid")
    return value


def _resolve_package_dependency(package_root: Path, dependency: str) -> Path:
    parts = dependency.split("/")
    search_roots = [package_root / "node_modules", package_root.parent]
    search_roots.extend(parent for parent in package_root.parents if parent.name == "node_modules")
    for node_modules in search_roots:
        candidate = node_modules.joinpath(*parts)
        try:
            resolved = candidate.resolve(strict=True)
        except OSError:
            continue
        try:
            return _find_package_root(resolved / "index.js", expected_name=dependency)
        except (OSError, ValueError, json.JSONDecodeError):
            continue
    raise OSError(f"package dependency was not found: {dependency}")


def dependency_graph_sha256(package_roots: tuple[Path, ...]) -> str:
    records: list[str] = []
    for package_root in package_roots:
        metadata = _package_metadata(package_root)
        identity = f"{metadata['name']}@{metadata['version']}"
        for file_path in sorted(package_root.rglob("*")):
            relative_path = file_path.relative_to(package_root)
            if (
                "node_modules" in relative_path.parts
                or file_path.is_symlink()
                or not file_path.is_file()
            ):
                continue
            relative = relative_path.as_posix()
            digest = hashlib.sha256(file_path.read_bytes()).hexdigest()
            records.append(f"{identity}\0{relative}\0{digest}\n")
    return hashlib.sha256("".join(sorted(records)).encode()).hexdigest()


def _dependency_read_paths(package_roots: tuple[Path, ...]) -> tuple[Path, ...]:
    paths = {root for root in package_roots}
    for root in package_roots:
        node_modules = next(
            (parent for parent in root.parents if parent.name == "node_modules"),
            root.parent,
        )
        paths.add(node_modules)
    return tuple(sorted(paths, key=str))


def _run_bounded_process(
    args: list[str],
    *,
    input_text: str,
    stdout: Any,
    stderr: Any,
    timeout: float,
    cwd: str,
    env: dict[str, str],
    max_output_bytes: int,
) -> tuple[int, bool]:
    """Monitor file-backed output without unsafe POSIX pre-exec hooks or RAM capture."""

    process = subprocess.Popen(  # noqa: S603 - fixed argv, no shell, attested entry
        args,
        stdin=subprocess.PIPE,
        stdout=stdout,
        stderr=stderr,
        text=True,
        cwd=cwd,
        env=env,
        close_fds=True,
        start_new_session=os.name == "posix",
    )
    stopped = threading.Event()
    output_exceeded = threading.Event()

    def monitor() -> None:
        while not stopped.wait(0.01):
            if (
                os.fstat(stdout.fileno()).st_size > max_output_bytes
                or os.fstat(stderr.fileno()).st_size > max_output_bytes
            ):
                output_exceeded.set()
                process.kill()
                return

    monitor_thread = threading.Thread(
        target=monitor,
        name="kordoc-output-monitor",
        daemon=True,
    )
    monitor_thread.start()
    try:
        process.communicate(input=input_text, timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill()
        process.communicate()
        raise
    finally:
        stopped.set()
        monitor_thread.join(timeout=1.0)
    if (
        os.fstat(stdout.fileno()).st_size > max_output_bytes
        or os.fstat(stderr.fileno()).st_size > max_output_bytes
    ):
        output_exceeded.set()
    if process.returncode is None:
        raise OSError("document codec process did not terminate")
    return process.returncode, output_exceeded.is_set()


class SourceDocumentCodecs:
    def __init__(self, *, kordoc: KordocBridge | None = None) -> None:
        self._kordoc = kordoc

    def supports_edit(self, suffix: str) -> bool:
        normalized = suffix.lower()
        return normalized in TEXT_SUFFIXES or (
            normalized in HWP_SUFFIXES and self._kordoc is not None and self._kordoc.available
        )

    def decode(self, content: bytes, *, suffix: str, max_text_bytes: int) -> str:
        normalized = suffix.lower()
        if normalized in TEXT_SUFFIXES:
            if len(content) > max_text_bytes:
                raise SourceCodecError("FILE_TOO_LARGE", "문서 본문이 읽기 제한을 초과했습니다.")
            try:
                return content.decode("utf-8")
            except UnicodeDecodeError as error:
                raise SourceCodecError(
                    "UNSUPPORTED_ENCODING", "UTF-8 문서만 수정할 수 있습니다."
                ) from error
        if normalized in HWP_SUFFIXES and self._kordoc is not None:
            return self._kordoc.parse(content, suffix=normalized, max_text_bytes=max_text_bytes)
        raise SourceCodecError(
            "UNSUPPORTED_WRITE_FORMAT", "현재 이 문서 형식은 수정할 수 없습니다."
        )

    def encode(self, content: bytes, *, suffix: str, text: str) -> bytes:
        normalized = suffix.lower()
        if normalized in TEXT_SUFFIXES:
            return text.encode("utf-8")
        if normalized in HWP_SUFFIXES and self._kordoc is not None:
            return self._kordoc.patch(content, suffix=normalized, markdown=text)
        raise SourceCodecError(
            "UNSUPPORTED_WRITE_FORMAT", "현재 이 문서 형식은 수정할 수 없습니다."
        )
