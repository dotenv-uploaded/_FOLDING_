"""한글(HWP) 편집 다리 — 사이드카에서 Node rhwp 워커를 부른다.

rhwp(@rhwp/core)는 Rust+WASM Node 라이브러리라 Python 에서 직접 못 부른다. 그래서 장수 Node
프로세스(`native/rhwp/rhwp_worker.mjs`)를 하나 띄우고, stdin 으로 JSON 요청을 보내고 stdout
으로 응답을 받는다(민규의 kordoc 워커와 같은 구조).

요청은 락으로 직렬화한다 — 워커는 한 번에 한 요청만 처리하므로, stdout 을 요청마다 순서대로
읽으면 응답이 섞이지 않는다. stderr 는 블로킹을 막으려고 별도 스레드로 흘려보내고 마지막
몇 줄만 진단용으로 붙잡아 둔다.

되돌릴 수 없는 훼손을 막는 규칙은 워커 안에 있다: 채운 뒤 재파싱으로 검증하고, 한 칸이라도
어긋나면 결과 파일을 지우고 실패를 돌려준다.
"""

from __future__ import annotations

import json
import subprocess
import threading
import uuid
from collections import deque
from pathlib import Path
from typing import Any


class RhwpError(Exception):
    """rhwp 워커 호출 실패. `retryable` 은 프로세스가 죽어 다시 띄우면 될 때 True."""

    def __init__(self, code: str, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable


class RhwpWorkerClient:
    """Node rhwp 워커를 감싼 클라이언트. 한 사이드카에 하나 두고 재사용한다."""

    def __init__(
        self,
        *,
        node_bin: Path,
        worker_script: Path,
        staging_root: Path,
        rhwp_root: Path,
        timeout_seconds: float = 30.0,
    ) -> None:
        self._node_bin = str(node_bin)
        self._worker_script = str(worker_script)
        self._staging_root = staging_root.resolve()
        self._rhwp_root = str(rhwp_root)
        self._timeout_seconds = timeout_seconds
        self._process: subprocess.Popen[str] | None = None
        self._lock = threading.Lock()
        self._stderr_tail: deque[str] = deque(maxlen=20)

    # -- 프로세스 수명 --------------------------------------------------------

    def _ensure_process(self) -> subprocess.Popen[str]:
        process = self._process
        if process is not None and process.poll() is None:
            return process
        self._staging_root.mkdir(parents=True, exist_ok=True)
        process = subprocess.Popen(
            [self._node_bin, self._worker_script, str(self._staging_root), self._rhwp_root],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        # stderr 를 흘려보내 블로킹을 막고 마지막 줄만 붙잡는다.
        threading.Thread(target=self._drain_stderr, args=(process,), daemon=True).start()
        self._process = process
        return process

    def _drain_stderr(self, process: subprocess.Popen[str]) -> None:
        assert process.stderr is not None
        for line in process.stderr:
            self._stderr_tail.append(line.rstrip("\n"))

    def close(self) -> None:
        with self._lock:
            process, self._process = self._process, None
            if process is not None and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()

    # -- 요청 ---------------------------------------------------------------

    def request(self, command: str, **payload: Any) -> dict[str, Any]:
        with self._lock:
            process = self._ensure_process()
            request_id = uuid.uuid4().hex
            line = json.dumps({"id": request_id, "command": command, **payload}, ensure_ascii=False)
            assert process.stdin is not None and process.stdout is not None
            try:
                process.stdin.write(line + "\n")
                process.stdin.flush()
            except (BrokenPipeError, OSError) as error:
                self._process = None
                raise RhwpError("worker_crash", "rhwp 워커가 죽었습니다.", retryable=True) from error

            # 워커는 요청을 직렬로 처리하므로 우리 id 가 나올 때까지 stdout 을 읽는다.
            while True:
                out = process.stdout.readline()
                if not out:
                    self._process = None
                    tail = " / ".join(self._stderr_tail)
                    raise RhwpError(
                        "worker_eof",
                        f"rhwp 워커 응답이 끊겼습니다. {tail}".strip(),
                        retryable=True,
                    )
                try:
                    response = json.loads(out)
                except json.JSONDecodeError:
                    continue
                if response.get("id") != request_id:
                    continue
                if not response.get("ok", False):
                    raise RhwpError(
                        str(response.get("error", "worker_error")),
                        str(response.get("message", "rhwp 편집에 실패했습니다.")),
                    )
                return response

    # -- 편의 메서드 ---------------------------------------------------------

    def ping(self) -> str:
        """워커를 띄우고 rhwp 버전을 확인한다(연결 확인용)."""
        return str(self.request("ping").get("rhwp_version", "?"))

    def read_structure(self, input_rel: str) -> dict[str, Any]:
        """표와 셀(인덱스·현재 글자)을 읽는다 — 에이전트가 어느 칸을 채울지 정하는 근거."""
        return self.request("read_structure", input=input_rel)

    def fill(self, input_rel: str, output_rel: str, values: dict[int, str]) -> dict[str, Any]:
        """셀 인덱스별 값을 채워 새 파일로 저장한다. 워커가 재파싱 검증까지 한다."""
        return self.request(
            "fill",
            input=input_rel,
            output=output_rel,
            values={str(k): v for k, v in values.items()},
        )
