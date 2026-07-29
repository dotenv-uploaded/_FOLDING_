"""한글(HWP/HWPX) 본문을 kordoc으로 읽는다.

왜 pyhwp2md를 두고 이 경로를 쓰나
--------------------------------
pyhwp2md는 **셀이 병합된 표에서 내용을 잃는다.** 같은 파일을 두 파서로 뽑아 글자 수를
맞대 본 결과다(본문 문자 수, 프론트매터 제외):

    파일                                   pyhwp2md   kordoc   보존율   병합셀
    그린박스 업무진행사항.hwpx                 1,100    1,097     100%       0
    (양식)전문가 자문 위촉 계약서.hwp             841      844     100%       0
    평가의견 반영내역.hwpx                     1,281    1,276     100%       0
    소재개발 실증연구 신청서.hwpx               3,771    6,668      57%       —
    일일업무.hwp                                222    1,296      17%      39
    메디바이오 수요기술제안서.hwp               1,293    9,513      14%      15
    강한소상공인 사업계획서.hwp                   133    4,026       3%      21

병합셀이 없으면 두 파서가 같고, 병합셀이 많을수록 pyhwp2md가 무너진다. 강한소상공인
파일에서 남은 133자는 안내문 한 문장이 전부였고, 서류평가 배점표와 사업계획서 서식은
통째로 사라졌다. 그런데 pyhwp2md는 예외도 경고도 내지 않는다 — 200에 133자를 정상이라며
돌려준다. 한국 공공·사업 서식은 거의 전부 병합셀 표라, 가장 중요한 문서에서 가장 크게
틀리는 셈이다.

덤으로 얻는 것
--------------
문서를 고치는 경로(codegate-api의 KordocBridge)가 이미 kordoc을 쓴다. 읽기까지 kordoc이면
에이전트가 **본 글자와 고칠 글자가 같아진다.** 파서가 다르면 앵커가 영원히 안 맞는다.
`kordoc.parse`의 출력이 그 쪽 `blocksToMarkdown`과 문자 단위로 같음을 확인했다.

조용한 실패 금지
----------------
kordoc은 Node 라이브러리라 Node가 없는 호스트가 있을 수 있다. 그때는 pyhwp2md로 되돌아가되
**경고를 남긴다.** 말없이 되돌아가면 표가 빠진 결과가 정상처럼 나간다.
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
from pathlib import Path

#: kordoc을 설치해 둔 디렉터리(`node_modules/kordoc`이 있는 곳). codegate-api와 같은 이름을
#: 쓴다 — 한 대에서 둘 다 돌 때 설치본을 나눠 쓰기 위해서다.
KORDOC_DIR_ENV = "CODEGATE_KORDOC_DIR"

#: 검증한 버전. 조용히 올라가면 표 렌더링이 달라질 수 있어 설치 시 고정한다.
KORDOC_VERSION = "4.2.5"

# `node -e`로 실행하면 스크립트 파일명이 없어 인자가 argv[1]부터 들어온다. 인자 대신
# stdin으로 주고받아 그 함정을 아예 피한다. 모듈은 이름으로 요구하고 해석은 cwd에 맡긴다.
_NODE_SCRIPT = r"""
const kordoc = require('kordoc');
let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', async () => {
  try {
    const req = JSON.parse(raw);
    const bytes = Uint8Array.from(Buffer.from(req.original_b64, 'base64'));
    const parsed = await kordoc.parse(bytes);
    const markdown = typeof parsed === 'string' ? parsed : parsed.markdown;
    process.stdout.write(JSON.stringify({ ok: true, markdown }));
  } catch (error) {
    process.stdout.write(
      JSON.stringify({ ok: false, error: String((error && error.message) || error) }),
    );
  }
});
"""


class KordocUnavailableError(RuntimeError):
    """Node나 kordoc이 없다. 호출부는 pyhwp2md로 되돌아가고 경고를 남긴다."""


class KordocFailedError(RuntimeError):
    """kordoc은 있는데 이 파일을 읽지 못했다."""


class KordocBridge:
    """Node에 얹힌 kordoc을 부르는 얇은 어댑터.

    `node_path`/`install_dir`을 주입할 수 있게 열어 둔 이유는 테스트다 — 실제 Node 없이도
    호출 계약과 되돌아가기(fallback)를 검증할 수 있어야 한다.
    """

    def __init__(
        self,
        *,
        node_path: str | None = None,
        install_dir: str | None = None,
        timeout_seconds: float = 180.0,
    ) -> None:
        self._node = node_path or shutil.which("node")
        self._install_dir = install_dir or os.environ.get(KORDOC_DIR_ENV) or str(Path.cwd())
        self._timeout = timeout_seconds

    def available(self) -> bool:
        """Node 실행 파일이 있는가. kordoc 설치 여부는 실제로 불러 봐야 안다."""
        return bool(self._node)

    def to_markdown(self, path: Path) -> str:
        """한글 원본에서 본문 마크다운을 뽑는다."""
        if not self._node:
            raise KordocUnavailableError("node executable not found")

        payload = {"original_b64": base64.b64encode(path.read_bytes()).decode("ascii")}
        try:
            completed = subprocess.run(  # noqa: S603 - 고정된 스크립트만 실행한다
                [self._node, "-e", _NODE_SCRIPT],
                input=json.dumps(payload).encode("utf-8"),
                capture_output=True,
                timeout=self._timeout,
                check=False,
                cwd=self._install_dir,  # 여기서 `require('kordoc')`이 풀린다
            )
        except FileNotFoundError as error:
            raise KordocUnavailableError(f"node not runnable: {error}") from error
        except subprocess.TimeoutExpired as error:
            raise KordocFailedError(f"kordoc timed out after {self._timeout}s") from error

        if completed.returncode != 0:
            stderr = completed.stderr.decode("utf-8", "replace")
            # 모듈을 못 찾는 건 설정 문제지 파일 문제가 아니다. 되돌아갈 수 있게 구분한다.
            if "Cannot find module 'kordoc'" in stderr or "MODULE_NOT_FOUND" in stderr:
                raise KordocUnavailableError(
                    f"kordoc not installed under {self._install_dir}; "
                    f"`npm i kordoc@{KORDOC_VERSION}` and point {KORDOC_DIR_ENV} at it"
                )
            raise KordocFailedError(f"kordoc failed: {_reason(stderr)}")

        try:
            result = json.loads(completed.stdout.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise KordocFailedError("kordoc returned unreadable output") from error
        if not isinstance(result, dict) or result.get("error"):
            detail = result.get("error") if isinstance(result, dict) else "malformed response"
            raise KordocFailedError(f"kordoc failed: {detail}")

        markdown = result.get("markdown")
        if not isinstance(markdown, str) or not markdown.strip():
            raise KordocFailedError("kordoc produced no body text")
        return markdown


def _reason(stderr: str) -> str:
    """stderr에서 원인이 담긴 줄을 고른다.

    마지막 줄만 집으면 Node가 찍는 `Node.js v24.16.0` 같은 꼬리가 잡혀 원인이 가려진다.
    """
    lines = [line.strip() for line in stderr.splitlines() if line.strip()]
    for line in lines:
        if "Error" in line or "error" in line:
            return line
    return lines[-1] if lines else ""
