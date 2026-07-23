<p align="center">
  <img src="codegate-2026-web/src/renderer/public/brand/folding-logo.png" width="290" alt="Folding">
</p>

<p align="center">
  로컬 업무 문서를 근거가 남는 지식으로 연결하고,<br>
  검색부터 승인형 변경·복구까지 이어 주는 데스크톱 문서 에이전트
</p>

<p align="center">
  <code>Electron · React · TypeScript</code>&nbsp;&nbsp;
  <code>FastAPI · Python</code>&nbsp;&nbsp;
  <code>Claude Agent SDK</code>&nbsp;&nbsp;
  <code>HWP/HWPX</code>
</p>

---

## Folding

업무 문서는 형식과 폴더가 제각각이고, 필요한 내용을 찾은 뒤 다시 문서에 반영하는 과정은
쉽게 끊깁니다. Folding은 사용자가 선택한 로컬 폴더를 정규화된 지식 버전으로 구성해 자연어로
탐색하고, 원문 근거를 확인하며, 지원되는 문서는 같은 대화 안에서 수정·삭제·생성할 수 있게 합니다.

에이전트의 판단과 파일시스템 권한은 분리되어 있습니다. 모델은 원본 파일을 직접 다루지 않으며,
모든 변경은 화면에 표시된 diff의 정확한 `plan_hash`를 사용자가 승인한 뒤 결정적인 실행 경로를
통해서만 적용됩니다.

## 시연

![Folding 완성본 시연](docs/demo/folding-final-demo.gif)

<p align="center">
  <a href="https://github.com/dotenv-uploaded/ghdtjdwn_complete/blob/main/docs/demo/folding-final-demo.mp4?raw=1">
    고화질 MP4로 보기
  </a>
</p>

시연에서는 로그인과 폴더 등록부터 문서 질의, 근거 확인, HWP 작성자 변경 승인, 여러 업무 문서를
바탕으로 한 주간업무보고서 HWPX 생성까지 하나의 흐름으로 확인할 수 있습니다.

## 담당 구현 — Agent Runtime & Consistency

이 프로젝트에서 성주가 담당한 영역은 FastAPI Backend와 Claude Agent runtime, 그리고 실제 파일
변경이 발생하는 side effect 경계입니다. Frontend, 문서 변환기, LLMWIKI가 만든 각각의 기능을
하나의 사용자 흐름으로 연결하고, 모델의 제안이 권한 검증과 사용자 승인 없이 실행되지 않도록
제품의 control plane을 구성했습니다.

```mermaid
flowchart LR
    U[사용자 요청] --> UI[Electron UI]

    subgraph CORE[성주 담당 · Local Agent Control Plane]
        API[FastAPI · OpenAPI<br/>chat · document · execution]
        AGENT[Claude Agent SDK<br/>typed decision · tool trace]
        TRUST[Evidence & Authorization<br/>ACL · source hash · canonical quote]
        PLAN[Change Plan<br/>exact diff · plan_hash · expiry]
        TX[File Transaction<br/>backup · journal · atomic replace]
        STATE[SQLite State Machine<br/>idempotency · retry · recovery · Undo]
        SYNC[Knowledge Orchestrator<br/>outbox · publish barrier · CAS]

        API --> AGENT
        AGENT --> TRUST
        TRUST --> PLAN
        PLAN --> TX
        TX --> STATE
        STATE --> SYNC
    end

    UI --> API
    SYNC --> CONVERT[doc2md<br/>문서 재변환]
    SYNC --> WIKI[LLMWIKI<br/>FTS · vector · graph]
    WIKI --> SNAPSHOT[Immutable knowledge version]
    SNAPSHOT --> API
    TX --> SOURCE[(사용자 원본 문서)]

    classDef owned fill:#EEF3FF,stroke:#2B5DFD,stroke-width:2px,color:#0D1630;
    class API,AGENT,TRUST,PLAN,TX,STATE,SYNC owned;
```

### 맡은 문제와 해결 방식

| 책임 | 구현한 경계 |
| --- | --- |
| Agent runtime | Claude Agent SDK를 로컬 sidecar에서 구동하고 app-owned read tool만 제공합니다. built-in `Edit`, `Write`, `Bash`, Web tool은 비활성화하며 tool trace와 구조화 결과를 Python에서 다시 검증합니다. |
| 근거 기반 응답 | 검색 결과의 source SHA-256, canonical section, exact quote와 graph version을 대조합니다. 응답은 문서 ID·revision·section citation을 포함하고 현재 turn에서 읽지 않은 근거는 사용할 수 없습니다. |
| 인증과 권한 | cloud identity와 local file capability를 분리합니다. 검색·relation 확장·preview·approve·Undo의 각 경계에서 ACL을 다시 적용해 권한 없는 문서의 존재도 모델 context에 넣지 않습니다. |
| 승인형 변경 | 현재 원본 hash, typed operation, unified diff, 결과 hash, 만료 시각을 canonical `plan_hash`로 묶습니다. 화면에 표시된 동일 plan을 승인하기 전에는 source write가 발생하지 않습니다. |
| 파일 transaction | allowlisted `source://`만 해석하고 symlink escape를 차단합니다. immutable backup과 durable journal을 남긴 뒤 same-directory temporary file, `fsync`, atomic replace 순서로 적용합니다. |
| 실패 복구와 Undo | 파일시스템과 SQLite 사이의 중단 상태를 before/after hash로 복구합니다. idempotency key로 중복 실행을 막고, 현재 원본이 앞선 실행 결과와 일치할 때만 Undo를 새 감사 execution으로 수행합니다. |
| 지식 동기화 | 원본 적용과 지식 게시 상태를 분리하고 outbox worker로 doc2md와 LLMWIKI를 연결합니다. FTS·vector·graph가 모두 검증된 candidate만 CAS로 공개하며 실패 중에는 직전 정상 version을 제공합니다. |
| 문서 lifecycle | 자연어 수정뿐 아니라 정확한 파일 삭제, 여러 대상의 개별 승인, 삭제 후 tombstone, 복원, 여러 문서를 근거로 한 HWPX 생성 preview까지 typed decision으로 연결했습니다. |

### 모델보다 애플리케이션이 결정하는 것

Claude는 사용자의 의도를 해석하고 읽을 대상을 제안하지만, 실행 권한을 갖지 않습니다. 다음 판단은
모델 출력과 독립된 애플리케이션 코드가 담당합니다.

- 어떤 source root와 문서에 접근할 수 있는지
- 인용한 문장이 현재 canonical section에 실제로 존재하는지
- 계획을 만든 뒤 원본이 바뀌지 않았는지
- 사용자가 보고 승인한 diff와 실행할 operation이 같은지
- HWP/HWPX runtime과 dependency graph가 attestation을 통과했는지
- 새 knowledge build가 active pointer를 바꿀 만큼 완전한지
- 실패한 실행을 재시도할지, 복구할지, Undo할 수 있는지

이 분리 덕분에 prompt나 모델이 바뀌어도 파일 권한, 승인, 원자적 쓰기와 복구 규칙은 같은
결정론적 경계를 유지합니다. Agent가 문서를 “잘 이해하는가”와 실제 원본을 “안전하게 바꿀 수
있는가”를 서로 다른 검증 문제로 다룹니다.

### 구현 규모와 검증

| 항목 | 현재 저장소 기준 |
| --- | --- |
| Architecture Decision Record | Backend 경계, 지식 게시, crash recovery, prompt contract, HWP 왕복 편집, 삭제·생성 lifecycle 등 [ADR 11개](Backend/docs/adr) |
| Application API | chat, documents, change plans, approval, execution, retry, Undo, health를 포함한 10개 endpoint |
| Backend 자동화 검증 | Pytest 286개 통과, line coverage 84% |
| 정적 검증 | Ruff lint와 mypy 통과 |
| 실제 통합 경로 | Claude Agent SDK → 승인 변경 → 원본 write → doc2md → LLMWIKI publish → 변경 근거 재검색 → Undo |

세부 책임과 설계 근거는 [성주 역할 및 백엔드 로드맵](Backend/docs/ROLE_AND_ROADMAP.md),
[통합 계약](Backend/docs/INTEGRATION_CONTRACT.md), [Backend 작업 기록](Backend/docs/WORK_LOG.md)에
정리되어 있습니다.

## 문서 작업의 한 흐름

| 탐색 | 변경 | 생성 |
| --- | --- | --- |
| 질문과 관련된 문서를 에이전트가 검색하고 현재 turn에서 원문을 검증합니다. | 대상·원본 hash·exact diff를 결박한 변경 계획을 만들고 사용자 승인을 기다립니다. | 여러 근거 문서를 검색해 초안을 구성하고 새 HWPX 전체 diff를 먼저 보여 줍니다. |
| 답변의 사실 문장은 문서 ID, revision, section이 포함된 canonical quote로 돌아갑니다. | 승인 후 backup, journal, atomic replace, 지식 버전 게시를 수행하며 Undo가 가능합니다. | 승인 후 Kordoc으로 생성·재파싱하고 기존 파일을 덮어쓰지 않는 방식으로 게시합니다. |

읽기는 HWP/HWPX, PDF, DOCX, XLSX, PPT/PPTX, CSV, HTML, Markdown, TXT를 정규화합니다.
원본 변경은 검증 가능한 writer가 있는 Markdown/TXT와 로컬 Kordoc attestation을 통과한
HWP/HWPX에만 열리며, 그 밖의 형식은 읽기 전용으로 유지됩니다.

## 지식 그래프

![Folding 지식 그래프 화면](docs/demo/knowledge-graph-overview.png)

<p align="center">
  활성 지식 버전의 문서 15개와 빌드된 관계 32개를 시각화한 실제 시연 화면
</p>

Folding의 지식 그래프는 문서 내용을 임의로 연결한 그림이 아니라, **어떤 문서의 어느 섹션이
다른 문서를 어떻게 참조하는지** 보존하는 관계 계층입니다. 노드는 stable `document_id`를 가진
문서이고, 방향이 있는 엣지는 `references`, `implements`, `based_on`, `supersedes`와 같은
문서 간 관계입니다.

### 왜 필요한가

키워드 검색은 질문과 같은 단어가 들어 있는 문서를 찾는 데는 유용하지만, 문서 사이의 맥락까지
설명하지는 못합니다. 예를 들어 계획서가 어떤 요구사항을 근거로 작성됐는지, 운영 문서가 어떤
정책을 구현하는지, 새 문서가 무엇을 대체하는지는 단어의 유사도만으로 확정하기 어렵습니다.

지식 그래프는 이 간격을 다음과 같이 보완합니다.

| 역할 | Folding에서의 사용 |
| --- | --- |
| 연관 문서 발견 | 검색된 문서와 직접 연결된 현재 문서 중 `VERIFIED` 관계를 에이전트 결과의 `relations`로 함께 제공합니다. |
| 관계의 설명 가능성 | 엣지마다 `from_section_id`와 `evidence_quote`를 보존해 연결이 생긴 원문 위치를 추적합니다. |
| 문서 집합의 무결성 | 존재하지 않는 문서를 가리키는 링크는 빌드를 실패시킵니다. 승인된 삭제만 정확한 tombstone 범위에서 예외로 처리합니다. |
| 변경 후 일관성 | 문서 수정·삭제·Undo마다 그래프를 포함한 새 불변 지식 버전을 만들고, 완성된 버전만 활성화합니다. |
| 사용자 탐색 | 그래프 화면에서 문서를 선택해 이웃 관계를 강조하고 원본 문서로 바로 이동할 수 있습니다. |

현재 그래프는 검색 결과에 검증된 직접 관계를 제공하고 전체 문서 지도를 탐색하는 범위에 집중합니다.
근거 없는 자동 multi-hop 추론을 사실처럼 제시하지 않습니다.

### 관계가 만들어지는 과정

```mermaid
flowchart LR
    S[원본 문서] --> C[doc2md<br/>Canonical Markdown]
    C --> I[stable document ID<br/>section anchor]
    I --> E[명시적 내부 링크 추출]
    E --> R[관계 유형 분류<br/>references · implements · based_on · supersedes]
    R --> V[Schema · 대상 존재 · 원문 quote 검증]
    V --> P[manifest.jsonl<br/>retrieval/links.jsonl]
    P --> B[content-addressed<br/>immutable build]
    B --> A[Backend ACL filter<br/>VERIFIED relations]
    B --> G[Electron SVG<br/>force-directed graph]
```

1. doc2md가 원본을 canonical Markdown으로 바꾸고 문서 ID와 안정된 section anchor를 부여합니다.
2. LLMWIKI builder가 Markdown의 내부 링크를 추출합니다. 승인된 enrichment가 있으면 명시적 링크의
   관계 유형만 구체화할 수 있으며, 새 연결을 근거 없이 만들지는 않습니다. 이 분류 결과는
   Backend에서 `PROPOSED`로 유지되고 명시적 원문 링크만 `VERIFIED`가 됩니다.
3. 각 엣지는 JSON Schema Draft 2020-12로 검증됩니다. 출발 문서·섹션, 대상 문서, 관계 유형,
   링크가 실제로 적힌 `evidence_quote`가 모두 있어야 합니다.
4. `manifest.jsonl`과 `retrieval/links.jsonl`은 checksum에 포함되고 내용 hash 기반의 불변 build로
   게시됩니다. FTS·vector·graph 산출물 중 하나라도 일치하지 않으면 기존 정상 build를 유지합니다.
5. Backend는 요청의 graph version을 고정하고 ACL을 먼저 적용합니다. 현재 사용자가 읽을 수 있고
   원본 hash가 최신인 대상의 `VERIFIED` 관계만 에이전트에 전달합니다.

그래프 화면은 별도 시각화 라이브러리 없이 React와 SVG로 구현했습니다. 결정적인 초기 배치 위에서
노드 반발력, 엣지 스프링, 중앙 인력, 감쇠를 계산하는 force-directed simulation을
`requestAnimationFrame`으로 실행합니다. 에너지가 임계값 아래로 내려가면 계산을 멈추고
드래그할 때만 다시 시작해 Electron 유휴 CPU 사용을 줄입니다. 확대·축소, 노드 드래그, 문서 유형별
색상, 선택한 문서의 관계 강조와 원본 열기를 지원합니다.

## 설계에서 지키는 것

### 근거와 추론을 분리합니다

검색용 보강 정보는 후보를 넓히는 데만 사용합니다. 사용자에게 제시하는 근거는 보존된 원문에서
정확히 찾을 수 있는 quote여야 하며 `document_id`, `revision`, `graph_version`, `chunk_id`,
`section_id`로 다시 추적할 수 있습니다. 한 요청은 하나의 지식 snapshot에 고정되어 서로 다른
버전의 근거가 섞이지 않습니다.

### 승인은 실제 파일 변경의 경계입니다

```text
요청 → 대상·권한·원본 SHA 확인 → exact diff + plan_hash
     → 사용자 승인 → SHA 재확인 → immutable backup + durable journal
     → atomic replace → 문서 재변환 → 새 지식 버전 공개
```

승인 전 원본 write는 0건입니다. 실행 직전 ACL과 원본 SHA-256을 다시 확인하며, 파일과 SQLite가
하나의 transaction이 될 수 없는 경계는 journal과 재시작 복구 절차로 다룹니다. Undo 역시 현재
파일 hash가 앞선 실행 결과와 일치할 때만 backup을 새 실행으로 복원합니다.

### 게시 중인 지식은 항상 완성된 버전입니다

변경된 입력은 staging에서 변환되고 FTS·vector·graph artifact 검증을 거칩니다. 검증이 끝난
`build-<hash>`만 불변 버전으로 설치하며, `current.json` 포인터는 compare-and-swap 방식으로
교체됩니다. 새 빌드가 실패해도 읽기 요청은 직전 정상 버전을 계속 사용합니다.

## 아키텍처

```mermaid
flowchart LR
    U[사용자] --> UI[Electron + React<br/>대화 · 근거 · 승인 · Undo]

    subgraph DEVICE[사용자 기기]
        UI --> MAIN[Electron Main<br/>폴더 capability · OAuth · process supervision]
        MAIN --> SIDE[FastAPI Sidecar<br/>Claude Agent SDK · ACL · change plan]
        MAIN --> DOC[doc2md<br/>HWP/HWPX · Office · PDF · OCR]
        SIDE --> DOC
        DOC --> CANON[Canonical Markdown<br/>stable document / section ID]
        SIDE --> WIKI[LLMWIKI<br/>FTS · vector · graph]
        CANON --> WIKI
        WIKI --> VER[Immutable knowledge version]
        VER --> SIDE
        SIDE --> WRITER[Approved writer<br/>backup · journal · atomic replace]
    end

    MAIN -. Authorization Code + PKCE .-> AUTH[Google OAuth / Cloud API]
    SIDE -. model inference .-> CLAUDE[Anthropic API]
    WRITER --> FILES[(사용자 원본 문서)]
    FILES --> DOC
```

클라우드 로그인은 사용자 신원을 확인하지만 로컬 파일 권한을 만들지 않습니다. 파일 capability는
OS 폴더 선택으로 별도 획득하고, cloud API client와 loopback sidecar client를 분리해 cloud bearer가
로컬 서비스로 전달되지 않게 합니다. Anthropic key, 사용자 문서, 절대 경로, 세션 상태는 renderer와
저장소에 두지 않습니다.

## 구현 구성

| 모듈 | 역할 | 주요 경계 |
| --- | --- | --- |
| [`codegate-2026-web`](codegate-2026-web) | Electron 데스크톱 앱, React UI, OAuth, 폴더 동기화 | diff 승인 UI, sidecar 수명주기, 최소 환경 전달 |
| [`Backend`](Backend) | FastAPI sidecar와 Claude Agent SDK | typed decision, ACL, change plan, 실행·복구·Undo |
| [`codegate-2026-api`](codegate-2026-api) | doc2md 문서 변환 서비스 | 형식별 변환, OCR, 구조 정규화, resource limit |
| [`LLMWIKI`](LLMWIKI) | 지식 패키지와 검색 인덱스 빌더 | stable ID, canonical evidence, immutable build publish |

각 모듈은 adapter와 명시적인 artifact 계약으로 연결됩니다. 에이전트에는 app-owned read tool만
노출하고 범용 `Read/Edit/Write/Bash` 권한은 주지 않습니다. HWP/HWPX writer는 고정된 Kordoc
dependency graph의 digest를 확인하고, patch 결과를 다시 parse해 요청 결과와 일치할 때만 원본을
교체합니다.

## 검증

현재 monorepo를 기준으로 다음 검증을 통과했습니다.

| 범위 | 결과 |
| --- | --- |
| Backend / Agent Runtime | Pytest 286개 통과, line coverage 84% |
| Electron / React | Vitest 159개 통과, 환경 의존 integration 1개 skip |
| doc2md | Pytest 117개 통과 |
| XLSX 안전 정규화 | 집중 테스트 8개 통과 |
| 통합 launcher | 집중 테스트 3개 통과 |
| 정적 검증 | TypeScript typecheck, Node 구문 검사 통과 |
| 공개 트리 | gitleaks finding 0건 |

XLSX는 request-local copy만 정규화해 원본 bytes를 보존하며 ZIP/XML resource abuse와 외부
relationship을 거부합니다. Electron은 child process 종료를 추적하고 sidecar에 필요한 최소 환경만
전달합니다. 실패 원인과 복구 과정은 회귀 테스트와
[`TROUBLESHOOTING.md`](Backend/docs/TROUBLESHOOTING.md)에 함께 기록합니다.

## 실행

### 준비 사항

- macOS 또는 Linux
- Node.js 18 이상
- [uv](https://docs.astral.sh/uv/)
- Anthropic API key

```bash
git clone https://github.com/dotenv-uploaded/ghdtjdwn_complete.git
cd ghdtjdwn_complete
./scripts/bootstrap.sh
```

bootstrap은 pnpm과 uv lockfile에 고정된 Electron, Backend, doc2md 의존성을 설치하고
`codegate-2026-web/.env`를 준비합니다. 생성된 파일에 API key를 입력합니다.

```dotenv
CODEGATE_ANTHROPIC_API_KEY=your-key
```

```bash
./scripts/run-app.sh
```

실행 스크립트는 실제 Google OAuth, 고정 loopback callback
`http://127.0.0.1:47821/auth/callback`, Claude Sonnet, 통합 doc2md를 사용합니다. 새 컴퓨터에서는
Google 로그인을 다시 하고 사용할 문서 폴더를 직접 선택해야 합니다.

API key, OAuth 세션, 사용자 문서, 로컬 지식 인덱스는 Git에 포함되지 않습니다.

## 더 읽기

- [통합 계약](Backend/docs/INTEGRATION_CONTRACT.md)
- [로컬 런타임](Backend/docs/LOCAL_RUNTIME.md)
- [아키텍처 결정 기록](Backend/docs/adr)
- [Frontend 명세](codegate-2026-web/docs/FRONTEND_SPEC.md)
- [작업 기록](codegate-2026-web/docs/WORK_LOG.md)
- [문서 변환기 설계](codegate-2026-api/services/doc2md/README.md)
