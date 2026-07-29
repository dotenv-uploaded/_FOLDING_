"""한글(HWP/HWPX) 원본을 읽고 서식을 보존한 채 고치는 다리.

왜 다리가 필요한가
------------------
이 서비스의 수정 모델은 **텍스트**다. 원본을 UTF-8로 읽어 앵커를 정확히 한 번 찾아
바꾸고 다시 쓴다. Markdown/TXT는 원본이 곧 텍스트라 그대로 성립하지만, HWP는
바이너리(OLE2/CFB)라 `decode("utf-8")` 자체가 되지 않는다.

kordoc이 그 간극을 메운다. 두 단계로 나뉜다.

    원본 바이트 ──parse──▶ 마크다운   (이 위에서 앵커 검사·치환을 한다)
    마크다운   ──patch──▶ 원본 바이트 (서식·표·스타일을 보존한 채 텍스트만 갈아끼운다)

즉 **안전 검사(앵커 유일성·해시 일치·Undo 보장)는 하나도 우회하지 않는다.** 검사 대상이
"파일의 텍스트"에서 "파일에서 뽑아낸 마크다운"으로 바뀔 뿐이다.

kordoc은 Node 라이브러리다. Python에서 쓰려고 CLI를 부르지 않는다 — kordoc CLI는
읽기 전용(문서→Markdown)이라 patch 서브커맨드가 없다. 쓰기는 라이브러리 API에만 있어서
짧은 Node 스크립트를 stdin/stdout으로 태운다.

조용한 실패 금지
----------------
patchHwp는 못 고친 부분을 예외가 아니라 `skipped[]`로 **보고**한다(블록 추가·삭제,
표 구조 변경, 머리말/꼬리말, 컨트롤 포함 문단 등). 이걸 무시하면 "승인했고 오류도 없는데
원본은 그대로"가 된다. 그래서 skipped가 비어 있지 않으면 실패로 올린다.
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

#: 이 다리가 책임지는 확장자. 나머지는 기존 텍스트 경로가 그대로 처리한다.
HWP_SUFFIXES = frozenset({".hwp", ".hwpx"})

#: 검증한 kordoc 버전. 조용히 올라가면 patch 동작이 바뀔 수 있으므로 설치 시 고정한다.
#:
#:     npm i kordoc@4.2.5      # 그 디렉터리를 CODEGATE_KORDOC_DIR 로 지정
KORDOC_VERSION = "4.2.5"

#: kordoc 을 설치해 둔 디렉터리(`node_modules/kordoc` 이 있는 곳)를 가리키는 환경변수.
KORDOC_DIR_ENV = "CODEGATE_KORDOC_DIR"

# `node -e` 로 실행하면 **스크립트 파일명이 없어** 추가 인자가 argv[1] 부터 들어온다.
# (argv[2] 로 읽었다가 `id must be of type string, received undefined` 로 죽었다.)
# 모듈은 이름으로 요구하고, 해석은 실행 디렉터리(cwd = 설치 위치)에 맡긴다.
_NODE_SCRIPT = r"""
const kordoc = require('kordoc');
let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', async () => {
  try {
    const req = JSON.parse(raw);
    const original = Uint8Array.from(Buffer.from(req.original_b64, 'base64'));
    if (req.op === 'parse') {
      const parsed = await kordoc.parse(original);
      const markdown = typeof parsed === 'string' ? parsed : parsed.markdown;
      process.stdout.write(JSON.stringify({ ok: true, markdown }));
      return;
    }
    const patch = req.suffix === '.hwpx' ? kordoc.patchHwpx : kordoc.patchHwp;
    const res = await patch(original, req.markdown);
    const data = res.data ?? res.bytes ?? res.buffer;
    process.stdout.write(
      JSON.stringify({
        ok: Boolean(res.success) && Boolean(data),
        skipped: res.skipped ?? [],
        applied: res.applied ?? null,
        patched_b64: data ? Buffer.from(data).toString('base64') : null,
      }),
    );
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: String((error && error.message) || error) }));
  }
});
"""


class KordocError(RuntimeError):
    """kordoc 경로에서 난 오류. 호출부가 사용자 문장으로 바꿔 올린다."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class PatchOutcome:
    """패치 결과. `skipped` 가 비어 있어야만 성공으로 친다."""

    content: bytes
    skipped: list[str]


def is_hwp(source_uri: str) -> bool:
    """이 원본을 한글 경로로 다뤄야 하는가."""
    return _suffix(source_uri) in HWP_SUFFIXES


def _suffix(source_uri: str) -> str:
    path = source_uri.split("://", 1)[-1]
    return PurePosixPath(path).suffix.lower()


class KordocBridge:
    """Node에 얹힌 kordoc을 부르는 얇은 어댑터.

    `node_path`/`package_path`를 주입할 수 있게 열어 둔 이유는 테스트 때문이다 —
    실제 Node 없이도 호출 계약을 검증할 수 있어야 한다.
    """

    def __init__(
        self,
        *,
        node_path: str | None = None,
        install_dir: str | None = None,
        timeout_seconds: float = 180.0,
    ) -> None:
        self._node = node_path or shutil.which("node") or "node"
        # kordoc 은 Node 라이브러리라 설치 위치가 있어야 `require` 가 해석된다.
        # 지정이 없으면 이 서비스 디렉터리에서 찾는다.
        self._install_dir = install_dir or os.environ.get(KORDOC_DIR_ENV) or str(Path.cwd())
        self._timeout = timeout_seconds

    def to_markdown(self, original: bytes) -> str:
        """원본 바이트에서 앵커 검사에 쓸 마크다운을 뽑는다."""
        result = self._run({"op": "parse", "original_b64": _b64(original)})
        markdown = result.get("markdown")
        if not isinstance(markdown, str) or not markdown.strip():
            raise KordocError("HWP_PARSE_FAILED", "한글 문서에서 본문을 읽지 못했습니다.")
        return markdown

    def patch(self, original: bytes, markdown: str, source_uri: str) -> PatchOutcome:
        """편집된 마크다운을 원본에 되먹여 서식 보존 패치본을 만든다."""
        result = self._run(
            {
                "op": "patch",
                "original_b64": _b64(original),
                "markdown": markdown,
                "suffix": _suffix(source_uri),
            }
        )
        skipped = [str(item) for item in result.get("skipped") or []]
        if skipped:
            # 일부만 반영된 파일을 남기면 "승인했는데 원본이 그대로"가 된다.
            raise KordocError(
                "HWP_PARTIAL_PATCH",
                "이 변경은 한글 원본에 그대로 반영할 수 없습니다 "
                f"({len(skipped)}곳). 표 구조·머리말·개체가 걸린 부분은 한글에서 직접 고쳐 주세요.",
            )
        encoded = result.get("patched_b64")
        if not result.get("ok") or not isinstance(encoded, str):
            raise KordocError("HWP_PATCH_FAILED", "한글 원본을 수정하지 못했습니다.")
        return PatchOutcome(content=base64.b64decode(encoded), skipped=skipped)

    def _run(self, payload: dict[str, object]) -> dict[str, object]:
        try:
            completed = subprocess.run(  # noqa: S603 - 고정된 스크립트만 실행한다
                [self._node, "-e", _NODE_SCRIPT],
                input=json.dumps(payload).encode("utf-8"),
                capture_output=True,
                timeout=self._timeout,
                check=False,
                cwd=self._install_dir,  # 여기서 `require('kordoc')` 이 풀린다
            )
        except FileNotFoundError as error:
            raise KordocError(
                "KORDOC_UNAVAILABLE",
                "한글 문서를 다루려면 Node 와 kordoc 이 필요합니다. 설치 상태를 확인해 주세요.",
            ) from error
        except subprocess.TimeoutExpired as error:
            raise KordocError("KORDOC_TIMEOUT", "한글 문서 처리 시간이 초과되었습니다.") from error

        if completed.returncode != 0:
            stderr = completed.stderr.decode("utf-8", "replace")
            # 모듈을 못 찾는 건 설정 문제다. "실패했습니다"로 뭉뚱그리지 말고 고칠 방법을 말한다.
            if "Cannot find module 'kordoc'" in stderr or "MODULE_NOT_FOUND" in stderr:
                raise KordocError(
                    "KORDOC_UNAVAILABLE",
                    f"kordoc 을 찾지 못했습니다({self._install_dir}). "
                    f"`npm i kordoc@{KORDOC_VERSION}` 로 설치한 디렉터리를 "
                    f"{KORDOC_DIR_ENV} 에 지정해 주세요.",
                )
            raise KordocError("KORDOC_FAILED", f"한글 문서 처리에 실패했습니다. {_reason(stderr)}")
        try:
            result = json.loads(completed.stdout.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise KordocError("KORDOC_BAD_OUTPUT", "한글 처리기의 응답을 해석하지 못했습니다.") from error
        if not isinstance(result, dict):
            raise KordocError("KORDOC_BAD_OUTPUT", "한글 처리기의 응답 형식이 올바르지 않습니다.")
        if result.get("error"):
            raise KordocError("KORDOC_FAILED", f"한글 문서 처리에 실패했습니다. {result['error']}")
        return result


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _reason(stderr: str) -> str:
    """stderr 에서 **원인이 담긴 줄**을 고른다.

    마지막 줄만 집으면 Node 가 찍는 `Node.js v24.16.0` 같은 꼬리가 잡혀 원인이 가려진다.
    실제로 그것 때문에 모듈 해석 실패를 한참 못 봤다. 오류 타입이 적힌 줄을 우선한다.
    """
    lines = [line.strip() for line in stderr.splitlines() if line.strip()]
    for line in lines:
        if "Error" in line or "error" in line:
            return line
    return lines[-1] if lines else ""
