# doc2md

문서(pdf/docx/xlsx/pptx/csv/html/hwp/hwpx)를 프론트매터가 포함된 마크다운으로 변환하는
순수 네이티브 Python FastAPI 서비스. 외부 바이너리/subprocess 없이 pip 패키지만으로 동작한다.

## 파이프라인

```
파일 → [변환] → [후처리 정제] → [메타데이터 추출] → [프론트매터 조립] → 마크다운
```

## 라우팅 규칙 (변환 단계)

- `.hwp`, `.hwpx` → `pyhwp2md`
- `.pptx` → `markitdown`(텍스트·표) + `RapidOCR`(슬라이드 이미지 속 텍스트)
- 그 외 전부 (pdf/docx/xlsx/csv/html/...) → `markitdown`
- 변환 결과가 빈 문자열이면 `warnings`에 `empty_output`을 담아 반환 (스캔 PDF 등)

## PPTX 이미지 OCR

markitdown은 슬라이드 이미지를 `![alt](img)`로만 참조하고 **이미지 안의 텍스트는 읽지 못한다**.
그래서 이미지로 만든/스캔한 슬라이드는 본문이 비어버린다. 이를 메우기 위해 python-pptx로 각
슬라이드의 그림을 꺼내 OCR하고, 인식된 텍스트를 해당 슬라이드 밑에 `#### 이미지 텍스트 (OCR)`
블록으로 끼워 넣는다.

- **OCR 모델**: RapidOCR(ONNX) + `korean_PP-OCRv5_rec_mobile` (~13MB). PP-OCR 기본 인식 모델은
  중국어라 한글을 한자로 오인식(`입찰안내서→吾卫出京`)하므로 **한국어 v5 mobile 모델을 명시 지정**.
  v5=최신·최고정확도, mobile=최경량. 실측 한글 인식 신뢰도 0.97~0.99.
- onnxruntime CPU만으로 동작(GPU 불필요). 엔진은 첫 pptx 요청 때 lazy 로드되고 이후 재사용되며,
  비-pptx 요청은 OCR 비용을 전혀 지불하지 않는다. 최초 1회 모델 다운로드(~23MB) 후 캐시.
- 신뢰도 `< 0.6` 라인은 로고·텍스처 노이즈로 보고 버린다. OCR/onnxruntime 미설치 시에도 죽지 않고
  `warnings`에 사유를 담아 나머지 변환은 정상 진행.

## 후처리 정제 (`postprocess.py`)

원본을 손상시킬 수 없는 결정적 변환만 수행한다:

- **글리프 런 붕괴**: PDF 레이어드 글리프로 `실실실…실시시시…시`처럼 같은 글자가 10~15회 반복돼
  깨진 표지 텍스트를 원복(`실시설계 기술제안입찰 [BIM 포함사업]`). 글자 4회+/기호 6회+/공백 6칸+만
  대상이고 `- | =`(표·구분선)과 숫자는 건드리지 않는다.
- **빈 표 제거**: 데이터 셀이 전부 비어있는 레이아웃용 표를 삭제.
- **제목/H1 승격**: H1이 없거나 중간 줄이 잘못 H1로 승격된 문서에서, **첫 실질 라인**(배너 `< … >` 또는
  표지 줄)을 문서 제목으로 잡아 H1으로 만든다.

일부러 하지 않는 것(잘못 고치면 더 나빠지므로): 잘못 매겨진 헤딩 레벨 재조정, 추출 과정에서 한 셀로
합쳐진 표를 다시 행으로 분해.

## 입찰 메타데이터 자동 추출 (`metadata_extract.py`)

보수적으로만 채운다(틀린 값은 빈 값보다 나쁘므로). 확신 신호가 있을 때만 채우고 나머지는 `null`:

- `official_number`: 파일명/본문의 조달청 공고코드(`R26DC00229304` 형태) 우선, 없으면 숫자가 실제로
  들어있는 `공고번호 : …` 필드.
- `issuing_org`: `수요기관/발주기관 : …` 필드에서 조직명(산문 문장은 배제).

추출값은 요청의 `metadata` override로 항상 덮어쓸 수 있다 (override > 자동추출 > 휴리스틱).

## UTF-8 기본값

Windows 콘솔은 기본 코드페이지가 cp949라, 아무 조치 없이 print/log를 하면 한글 파일명·본문이
`UnicodeEncodeError`로 죽거나 깨진 문자로 출력된다. 이 서비스는 플랫폼/로케일과 무관하게
항상 UTF-8로 동작하도록 다음을 강제한다:

- `app/main.py` 임포트 시 `sys.stdout`/`sys.stderr`를 `encoding="utf-8"`로 `reconfigure()`
- 모든 파일 I/O(`cache.py`, `frontmatter.py`)는 `encoding="utf-8"` 명시
- `agent_tool_example.py`도 동일하게 자체 stdout/stderr를 UTF-8로 강제하고, Agent SDK가 띄우는
  CLI 서브프로세스에도 `env={"PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}`를 전달

## 실행

```bash
cd services/doc2md
uv sync   # 또는: pip install -e .
uv run uvicorn app.main:app --reload --port 8000
```

## API

```
GET  /health  -> {"status": "ok"}

POST /convert
  body: { "path": "<절대경로>", "metadata": { ... } }   # metadata는 전부 optional override
  ->
  {
    "markdown": "<프론트매터 + 본문 전체>",
    "frontmatter": { schema_version, id, title, doc_type, language, revision, status,
                      official_number, authority_level, issuing_org,
                      issued_on, effective_from, effective_to,
                      source: { filename, uri, sha256 }, access, tags, aliases },
    "body": "<본문만, 프론트매터 제외>",
    "format": "pdf" | "hwpx" | ...,
    "library_used": "markitdown" | "pyhwp2md",
    "warnings": [],
    "cached": false
  }
```

파일 경로 기반(로컬 파일시스템 공유 전제)이다. 원문 변환 결과는 파일 내용(mtime+size) 기준으로
`.cache/raw/`에 캐시되어 재변환하지 않지만, `frontmatter`는 요청마다 `metadata` override를 반영해
매번 새로 조립된다. 단, `frontmatter.id`는 파일 내용(sha256) 기준으로 한 번 발급되면
`.cache/id_by_sha256.json`에 고정되어 override 유무와 무관하게 같은 문서는 항상 같은 id를 갖는다.

## Agent 툴로 노출할 때

[claude-agent-sdk-python](https://github.com/anthropics/claude-agent-sdk-python)의
인프로세스 MCP 툴(`@tool` + `create_sdk_mcp_server`)로 감싸는 예제는
[`agent_tool_example.py`](agent_tool_example.py) 참고. 핵심만 발췌:

```python
from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient, create_sdk_mcp_server, tool
import httpx

@tool(
    "convert_to_markdown",
    "그래프에서 찾은 문서 파일을 프론트매터 포함 마크다운으로 변환한다",
    {"path": str},
)
async def convert_to_markdown(args: dict) -> dict:
    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post("http://localhost:8000/convert", json={"path": args["path"]})
        resp.raise_for_status()
    return {"content": [{"type": "text", "text": resp.json()["markdown"]}]}

doc2md_server = create_sdk_mcp_server(name="doc2md", tools=[convert_to_markdown])

options = ClaudeAgentOptions(
    mcp_servers={"doc2md": doc2md_server},
    allowed_tools=["mcp__doc2md__convert_to_markdown"],  # server=doc2md, tool=convert_to_markdown
    env={"PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"},
)
```

실행:

```bash
uv sync --extra agent
# 별도 터미널에서 uvicorn을 띄운 채로:
uv run python agent_tool_example.py "C:/path/to/문서.hwpx"
```
