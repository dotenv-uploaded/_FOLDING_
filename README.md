<p align="center">
  <img src="docs/assets/folding-logo.png" width="290" alt="Folding">
</p>

<p align="center">
  내 컴퓨터 안의 문서를 읽고, 서로 잇고, 근거를 남긴 채 고치는<br>
  로컬 우선 문서 에이전트
</p>

<p align="center">
  <code>Electron · React · TypeScript</code>&nbsp;&nbsp;
  <code>FastAPI · Python</code>&nbsp;&nbsp;
  <code>Claude Agent SDK</code>&nbsp;&nbsp;
  <code>HWP · DOCX · XLSX · PPTX · PDF</code>
</p>

---

## Folding

업무 문서는 형식도 폴더도 제각각이라, 필요한 내용을 찾는 것도 찾은 내용을 다시 문서에 반영하는
것도 매번 끊깁니다. Folding은 사용자가 고른 로컬 폴더를 하나의 지식 버전으로 정리해 자연어로
묻고, 답의 근거를 원문에서 확인하고, 같은 대화 안에서 문서를 고칠 수 있게 합니다.

**문서는 이 컴퓨터를 떠나지 않습니다.** 서버에 묻는 것은 로그인과 구독뿐이고 변환·분석·조립·
편집은 전부 사용자 PC에서 돕니다.

에이전트는 도구를 가리지 않습니다. 대신 **모든 도구 사용이 승인 게이트를 지납니다.** 무엇을
하려는지, 얼마나 위험한지, 원래 시킨 일이 무엇이었는지를 보여 주고 사람이 정합니다.

## 시연

`<TBD>`

## 지식 그래프

![Folding 지식 그래프](docs/assets/knowledge-graph.png)

<p align="center">
  실제 화면 — 문서 119개와 관계 285개, 서로 이어진 덩어리별로 색이 다르다
</p>

그래프의 색은 장식이 아니라 **네트워크**입니다. 서로 링크로 이어진 덩어리를 하나로 보고 색을
주며, 이름은 사람이 붙이지 않고 구성원이 가장 많이 들어 있는 폴더에서 뽑습니다. 위 화면에서는
119개 문서가 네트워크 11개와 어디에도 이어지지 않은 문서 29개로 갈렸습니다. 우측 문서 트리의
색점도 같은 계산을 쓰므로, 같은 뭉치는 두 화면에서 언제나 같은 색입니다.

### 관계는 어떻게 생기나

변환된 실제 문서(hwp·docx·pdf)는 서로를 마크다운 링크로 가리키지 않습니다. 명시적 링크만
세면 그래프에 점만 남습니다. 그래서 **문서마다 뽑아 둔 엔티티가 겹치는지**로 관계를 유도합니다.

| 단계 | 하는 일 |
| --- | --- |
| 흔한 것 제외 | 거의 모든 문서에 나오는 엔티티는 판별력이 없습니다. 전부를 전부에 잇는 것을 막습니다. |
| 문서당 상한 | 각 문서는 가장 강하게 겹치는 몇 개까지만 잇습니다. |
| 근거 보존 | 겹친 엔티티 전부와, **양쪽 문서가 각각 그것을 말한 문장**을 함께 남깁니다. |

문서를 고르면 아래 정보줄이 연결 목록으로 펼쳐집니다. 이웃마다 무엇을 함께 언급했는지 칩으로
보이고, 펼치면 양쪽 문장이 나란히 나옵니다. 한쪽만 보이면 "이 문서가 저 문서를 가리킨다"로
읽히는데, 엔티티 겹침에는 방향이 없기 때문입니다. 네트워크 이름을 누르면 **무엇이 이 뭉치를
묶었는지**가 많이 나온 순으로 나옵니다 — 사람 이름만 잔뜩이라면 그 자체가 알아야 할 사실입니다.

## 문서를 고칠 때

에이전트에게 도구를 제한하지 않습니다. 다만 **형식 전용 편집 도구를 쓰도록 유도**합니다. 범용
편집기로 hwp·docx를 직접 만지면 서식이 뭉개지기 때문입니다.

| 형식 | 도구 | 방식 |
| --- | --- | --- |
| HWP | rhwp (Rust·WASM) | 표 칸 인덱스로 값을 넣고 `.hwp` 로 그대로 내보냅니다 |
| DOCX · XLSX · PPTX | python-docx · openpyxl · python-pptx | 문단·표 칸·도형을 찾아 바꿉니다. 수식은 건드리지 않습니다 |
| PDF | pymupdf | 본문은 안전하게 못 바꿉니다. **고치는 척하지 않고** 주석 사본을 만듭니다 |

세 가지를 계약으로 못 박았습니다.

- **원본을 덮어쓰지 않습니다.** 결과는 언제나 새 파일입니다.
- **저장한 뒤 다시 열어 확인합니다.** 바뀐 내용이 실제로 들어갔는지 재파싱으로 검증합니다.
- **못 바꿨으면 결과 파일을 남기지 않습니다.** 반쪽짜리 사본을 완성본인 척 남기는 것이 가장
  나쁘기 때문입니다.

## 승인 게이트

도구를 가리지 않는 대신, 도구가 실행되기 전에 사람이 봅니다.

| 등급 | 무엇이 | 어떻게 |
| --- | --- | --- |
| SAFE | 읽기·검색 | 자동 허용 — 되돌릴 것이 없고, 매번 물으면 승인 피로만 쌓입니다 |
| CAUTION | 파일을 쓰거나 고침 | 승인을 받습니다. 되돌릴 수 있습니다 |
| DANGER | 되돌릴 수 없거나 밖으로 나감 | 이유를 함께 보여 줍니다 (`rm` · 강제 푸시 · 외부 요청 …) |

승인 창은 **사용자가 원래 시킨 일**을 함께 보여 줍니다. 프롬프트 인젝션은 자동으로 가려낼 수
없지만, 요약을 시켰는데 `rm` 이 뜨면 사람은 알아봅니다. 답이 없으면 **거부**로 처리합니다 —
보지도 못한 채 실행되면 안 되기 때문입니다.

## 크레딧

사용자에게는 토큰도 원화도 보이지 않습니다. 토큰은 사용자의 언어가 아니고, 원화를 그대로
띄우면 모델 단가가 바뀔 때마다 같은 금액이 조용히 다른 양이 됩니다.

```
대화 1건        = 1 크레딧
문서 20개 분석  = 1 크레딧
```

지갑은 둘입니다. 하나로 두면 폴더를 크게 등록한 날 대화를 한 번도 못 하게 됩니다. **문서를
분석하기 전에** 이번에 분석할 문서 수와 드는 크레딧을 보여 주고 확인받습니다 — 시작한 뒤에
알려주면 크레딧은 이미 나가 있습니다. 이미 분석한 문서는 내용이 바뀌지 않는 한 다시 부르지
않으므로 그 수는 빼고 셉니다.

## 아키텍처

```mermaid
flowchart LR
    U[사용자] --> UI[Electron + React<br/>대화 · 그래프 · 승인 · 사용량]

    subgraph DEVICE[사용자 기기]
        UI --> MAIN[Electron Main<br/>폴더 권한 · 사이드카 수명주기 · OAuth]
        MAIN --> AGENT[FastAPI 사이드카<br/>Claude 열린 에이전트 · 승인 게이트]
        MAIN --> CONV[doc2md<br/>HWP · Office · PDF → Markdown]
        MAIN --> WIKI[LLMWIKI<br/>불변 빌드 · 관계 유도]
        CONV --> WIKI
        WIKI --> AGENT
        AGENT --> WRITER[형식 전용 writer<br/>원본 보존 · 재파싱 검증]
    end

    MAIN -. OAuth + PKCE .-> CLOUD[folding-cloud-api]
    AGENT -. 모델 추론 .-> CLAUDE[Anthropic API]
    WIKI -. 문서 분석 .-> GEMINI[Gemini API]
    WRITER --> FILES[(사용자 원본 문서)]
    FILES --> CONV
```

로그인은 **누구인가**를 확인하고, 폴더 선택은 **어느 파일을 다룰 수 있는가**를 정합니다.
로그인만으로 파일 권한이 생기지 않습니다.

## 구현 구성

| 모듈 | 역할 | 온 곳 |
| --- | --- | --- |
| [`apps/desktop`](apps/desktop) | Electron 앱, 3분할 UI, 승인 모달, 사용량, 사이드카 감독 | `codegate-2026-local` |
| [`services/agent`](services/agent) | Claude 열린 에이전트, 승인 게이트, 형식 전용 writer | `codegate-2026-agent` |
| [`services/convert`](services/convert) | doc2md — 원본을 마크다운으로 | `codegate-2026-convert` (민규) |
| [`packages/llmwiki`](packages/llmwiki) | 위키 빌더 — 불변 빌드, 관계 유도, 근거 보존 | `codegate-2026-backend` (용휘·성주) |

각 폴더는 원래 저장소의 커밋 기록을 그대로 가지고 들어왔습니다(`git subtree`). `git log` 에
네 사람의 이름이 남아 있습니다. 기존 저장소는 지우지 않았습니다.

OAuth·세션·구독 서버는 [`folding-cloud-api`](https://github.com/dotenv-uploaded/folding-cloud-api)
로 갈랐습니다. 이것만 사용자 PC가 아니라 **서버에 배포**되고, 로컬에 절대 내려가지 않는 비밀을
쥐며, 그 자체가 네트워크 경계이기 때문입니다.

## 실행

> **아직 `pnpm dev` 하나로 전부 뜨지 않습니다.** 지금은 기록을 보존한 채 코드를 한곳에 모은
> 상태이고, 각 폴더는 자기 저장소였을 때의 설정을 그대로 들고 있습니다. 남은 배선은
> [`docs/MIGRATION.md`](docs/MIGRATION.md) 에 순서대로 적어 두었습니다.

### 준비 사항

- macOS 또는 Linux
- Node.js 18 이상 · pnpm
- [uv](https://docs.astral.sh/uv/)
- Anthropic API key · Gemini API key

```bash
git clone https://github.com/dotenv-uploaded/folding.git
cd folding
```

배선이 끝나기 전까지는 각 폴더에서 원래 방식대로 실행합니다.

```bash
# 데스크톱 + 사이드카 + 변환기를 함께
cd apps/desktop && cp .env.example .env   # 경로와 키를 채운다
node scripts/dev-integrated.mjs
```

API key, OAuth 세션, 사용자 문서, 로컬 지식 인덱스는 Git에 포함되지 않습니다.

## 더 보기

- [남은 이관 배선](docs/MIGRATION.md)
- [쓰기 도구 설계](services/agent/docs/WRITE_TOOLS_DESIGN.md)
- [프런트엔드 명세](apps/desktop/docs/FRONTEND_SPEC.md)
- [기획 개요](apps/desktop/docs/기획안/README.md)
- [트러블슈팅](apps/desktop/docs/TROUBLESHOOTING.md)
