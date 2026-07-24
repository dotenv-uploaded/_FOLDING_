# 백엔드 — 사이드카·변환·위키·에이전트

## 목차
1. [사이드카 (codegate-2026-agent)](#사이드카-codegate-2026-agent)
2. [에이전트 런타임](#에이전트-런타임)
3. [문서 변환 (doc2md)](#문서-변환-doc2md)
4. [한글 처리 (kordoc)](#한글-처리-kordoc)
5. [위키 빌더 (LLMWIKI)](#위키-빌더-llmwiki)
6. [메인 프로세스 (앱 쪽)](#메인-프로세스-앱-쪽)
7. [환경변수](#환경변수)

## 사이드카 (codegate-2026-agent)

FastAPI. 앱이 `SidecarSupervisor` 로 띄우고 헬스 체크로 감시한다.

| 엔드포인트 | 용도 |
|---|---|
| `GET /api/v1/health` | 상태 + `knowledge_version` |
| `POST /api/v1/chat/messages` | 채팅 (단일 JSON 응답, 스트리밍 아님) |
| `POST /api/v1/knowledge/rebuild` | 수동 재빌드 — 현재 입력·요약으로 새 빌드 활성화 |
| `POST /api/v1/change-plans/{id}/approve` \| `/reject` | 변경 승인 |
| `GET /api/v1/executions/{id}` · `/retry-sync` · `/undo` | 실행 상태·재시도·되돌리기 |

**핵심 클래스:**

- `NativeLLMWikiCatalog` — 활성 빌드 소유. `bootstrap()`(첫 빌드) · `rebuild()`(수동
  재빌드) · `enrich_in_background()`(요약, 배경).
- `NativeLLMWikiPipeline` — `process_pending()`(승인된 편집 반영) · `rebuild()`.
  둘 다 **같은 publish 락**으로 직렬화된다.
- `ChatService` — 대화 잠금, 세션 이어받기, 사용량 수집.
- `ClaudeAgentGateway` — Agent SDK 호출, 도구 추적 검증, 구조화 결과 파싱.

**빌드 활성화의 안전장치:** `activate` 는 `expected_current_build_id` 가 맞을 때만
성립한다. 다른 경로가 중간에 빌드를 바꿨으면 조용히 덮어쓰지 않고 실패한다.

## 에이전트 런타임

`agent/runtime.py` 가 `ClaudeAgentOptions` 를 만든다.

```python
mcp_servers={"codegate": tool_server}   # 지식 도구 4개
allowed_tools=[...]                      # 허용 목록
disallowed_tools=["Bash","Edit","Write",...]
hooks={"PreToolUse": [enforce_tool_allowlist]}   # 목록 밖이면 deny
output_format={"type":"json_schema", ...}        # AgentDecision 강제
env={"CLAUDE_CONFIG_DIR": <세션별>, "CLAUDE_CODE_DISABLE_AUTO_MEMORY":"1"}
max_turns=8, max_budget_usd=0.50
```

**세션 지속에 대해 알아야 할 것:** `CLAUDE_CODE_SKIP_PROMPT_HISTORY` 를 켜면 CLI 가 대화
전사본을 남기지 않아 다음 턴의 `resume` 이 항상 실패한다. 그래서 켜지 않는다.
자동 메모리는 계속 끈다 — 작업 디렉터리가 **사용자의 문서 폴더**라, 켜면 신뢰할 수 없는
문서가 지시를 주입하는 통로가 된다.

**SDK 실패 원인을 보려면** `options.stderr` 콜백을 등록해야 한다(`SubprocessStderrTail`).
없으면 `ProcessError: ... Check stderr output for details` 만 남고 정작 stderr 는 사라진다.

**프롬프트 인젝션 방어**는 `agent/instructions.py` 에 있다 — 문서·도구 결과는 전부
untrusted 이고 지시를 내릴 수 없다는 계약.

## 문서 변환 (doc2md)

| 형식 | 텍스트 | 비고 |
|---|---|---|
| `.hwp` / `.hwpx` | **kordoc** (대체: pyhwp2md) | 아래 참고 |
| `.pptx` | markitdown | 슬라이드 이미지 OCR |
| `.pdf` | markitdown 페이지 단위 | 텍스트 레이어 없으면 전체 OCR |
| 그 외 | markitdown | |

**한글은 반드시 kordoc 으로 읽는다.** `pyhwp2md` 는 **병합된 셀의 내용을 조용히 잃는다.**
실측(본문 문자 수):

| 파일 | pyhwp2md | kordoc | 보존율 |
|---|---:|---:|---:|
| 병합셀 없는 문서 3종 | — | — | 100% |
| 소재개발 신청서.hwpx | 3,771 | 6,668 | 57% |
| 일일업무.hwp | 222 | 1,296 | 17% |
| 사업계획서.hwp | 133 | 4,026 | **3%** |

마지막 파일에서 남은 133자는 안내문 한 문장이었고 배점표·서식은 통째로 사라졌다.
그런데 경고도 예외도 없었다. 한국 공공·사업 서식은 거의 전부 병합셀 표다.

kordoc 이 없으면 pyhwp2md 로 내려가되 **`hwp_kordoc_unavailable` 경고를 남긴다** —
표가 빠진 결과가 온전한 척 나가면 안 된다.

## 한글 처리 — 세 라이브러리 비교

같은 파일(`일일업무.hwp`, 22×7 표)로 세 라이브러리를 직접 측정했다. 이 표가 있어야
나중에 잘못된 라이브러리로 되돌아가는 걸 막는다.

| | LibreOffice | kordoc | **rhwp** |
|---|---|---|---|
| HWP 읽기 | ✅ | ✅ | ✅ |
| **HWP 로 되돌려 쓰기** | ❌ 필터 없음 | ✅ 원본 바이트 패치 | ✅ **네이티브 `exportHwp`** |
| 편집 모델 | — | 마크다운 왕복(앵커 매칭) | **셀 인덱스 직접** |
| 빈 칸 지목 | 접혀서 사라짐(51칸) | 마크다운 자리(154칸) | 논리셀 인덱스(50셀, 17참/33빈) |
| 표 조작 | — | 마크다운 편집 | 셀 병합/분할·서식·폼필드 300+ 메서드 |
| 언어/배포 | 앱 | Node `kordoc` | Rust+WASM `@rhwp/core` |

**LibreOffice 를 쓰지 않는 이유(가장 결정적):** `docx → HWP` 가 `no export filter for
.hwp` 로 거부된다. 읽기 전용 한 방향이라, 이 경로로 고치면 사용자의 `.hwp` 가 `.docx` 로
바뀐다. "한글 파일 고쳐줘"에 한글 파일이 안 나오는 것은 품질 저하가 아니라 요청을 못
들어준 것이다.

**kordoc 과 rhwp 는 둘 다 되돌려 쓸 수 있다.** 차이는 편집 모델이다 — kordoc 은 마크다운
앵커를 찾아 되먹이는 간접 방식이고, rhwp 는 표의 논리 셀을 인덱스로 직접 읽고 쓴다
(`getTextInCell`/`insertTextInCell`). "3행 2열 빈 칸에 이 값"이 그대로 성립해서, 빈 칸을
하나씩 지목하는 양식 채우기에는 rhwp 가 더 정확하다. rhwp 왕복은 검증됐다(빈 셀 삽입 →
`exportHwp` → 재파싱 값 일치, 원본 바이트 불변).

### 현재 어디에 무엇이 쓰이나

- **양식 채우기(HWP)** → `src/main/rhwp/fill.ts`(**rhwp**, 셀 인덱스 직접). 검증 포함.
- **doc2md 읽기** → kordoc(마크다운 산출, 위키 입력용). 아직 rhwp 로 옮기지 않았다 —
  rhwp 는 셀 구조를 주지만 위키가 먹는 **마크다운 serializer** 가 별도로 필요하다.
- **변경 적용(replace_exact)** → 사이드카의 kordoc(마크다운 앵커). rhwp 의 셀 모델과
  계약이 달라 이전하려면 replace_exact 자체를 다시 봐야 한다.

즉 **write 경로 중 양식 채우기부터 rhwp 로 옮겼고**, 읽기·변경적용은 kordoc 이 남아 있다.
다음 이전 대상은 위 둘이며, 각각 serializer / 계약 재검토가 선행돼야 한다.

### kordoc API (읽기·변경적용 경로에 아직 쓰임)


Node 라이브러리다. Python 에서 `node -e` 로 부른다(`changes/kordoc.py`, `app/kordoc.py`).
`CODEGATE_KORDOC_DIR` 이 `node_modules/kordoc` 이 있는 디렉터리를 가리켜야 한다.

| API | 용도 |
|---|---|
| `parse` / `parseHwp` / `parseHwpx` | 문서 → 마크다운(표는 HTML `<table>` 로 보존) |
| `patchHwp` / `patchHwpx` | 편집된 마크다운을 원본에 되먹임(서식 보존) |
| `markdownToHwpx` | 새 문서 생성 |
| `blocksToMarkdown` | 파싱 블록 → 마크다운 (`parse` 와 결과 동일) |

**빈 칸도 채울 수 있다.** 마크다운에 `<tr><td colspan="2"></td>…` 로 남아 있어서, 그 자리에
값을 넣고 `patchHwp` 하면 서식·크기 그대로 채워진다(검증: applied 2, skipped 0,
27,648 → 27,648 bytes).

`skipped` 가 비어 있지 않으면 **실패로 올린다** — 일부만 반영된 파일을 남기지 않는다.

## 위키 빌더 (LLMWIKI)

- 청크·링크·매니페스트를 만들고 `current.json` 을 원자적으로 교체한다.
- **간선(그래프)은 `[제목](DOC-xxx.md)` 링크에서만** 뽑는다. 그래서 앱이
  `applyCrossLinks()` 로 본문의 문서번호를 링크로 바꿔 준다.
- enrichment(요약·키워드·관계)는 **Gemini** 를 쓴다(`gemini.py` 하나뿐, 제공자 추상화 없음).
- **비공개 문서를 무료 등급 LLM 으로 보내는 것을 거부한다.** 시연·개발용 가상 코퍼스일
  때만 `CODEGATE_LLMWIKI_SYNTHETIC_CORPUS=1` 로 사실을 적어 통과시킨다.
  **실제 사용자 문서에서는 반드시 꺼야 한다.**

## 메인 프로세스 (앱 쪽)

| 파일 | 역할 |
|---|---|
| `services.ts` | 오케스트레이션 — 폴더·빌드·채팅·사용량·사이드카 수명주기 |
| `ipc.ts` | IPC 핸들러. 모든 예외를 한국어 문장으로 정규화 |
| `db/store.ts` · `db/schema.ts` | SQLite (better-sqlite3, 동기 API) |
| `sidecar/supervisor.ts` | 사이드카 기동·감시·재시작, 환경 구성 |
| `sidecar/input-sync.ts` | doc2md 호출 → source-md 생성, 변환기 판 관리 |
| `sidecar/crosslink.ts` | 문서번호 → 마크다운 링크 |
| `agent/host.ts` | `ChatService` — 스트림을 IPC 로 중계, SQLite 영속 |
| `agent/form-fill.ts` | 양식 채우기(사이드카 우회, 승인은 거침) |
| `kordoc/docx-template.ts` | Word 양식 `{{자리}}` 채우기 |
| `net/http.ts` | 공통 HTTP. 401/402/403 을 `AuthError` 로 번역 |
| `util/errors.ts` | `UserFacingError`, `logError`(cause 사슬 추적) |

## 환경변수

| 이름 | 용도 |
|---|---|
| `CODEGATE_ANTHROPIC_API_KEY` | 에이전트·양식 채우기 |
| `CODEGATE_GEMINI_API_KEY` | 위키 enrichment |
| `CODEGATE_FILL_PROVIDER` | 양식 채우기 제공자(`anthropic`/`gemini`). 폴백 없음 |
| `CODEGATE_KORDOC_DIR` | kordoc 설치 위치 |
| `CODEGATE_LLMWIKI_SYNTHETIC_CORPUS` | 시연용 가상 코퍼스 선언(기본 꺼짐) |
| `CODEGATE_CLOUD_API_BIN` | OAuth 백엔드 실행 파일(스택이 함께 띄운다) |
| `CODEGATE_USD_KRW_RATE` | 사용량 표시 환율(기본 1,400) |
| `CODEGATE_DOC2MD_*` / `CODEGATE_SIDECAR_BIN` / `CODEGATE_LLMWIKI_PROJECT_ROOT` | 로컬 경로 |

설정은 `.env` **하나**로 통일돼 있다(`src/main/env.ts`). 실제 환경변수가 있으면 그쪽이 이긴다.
