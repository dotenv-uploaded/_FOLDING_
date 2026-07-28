# 프론트엔드 — 화면·컴포넌트·상태

## 목차
1. [기술 스택](#기술-스택)
2. [앱 셸 구조](#앱-셸-구조)
3. [화면](#화면)
4. [컴포넌트](#컴포넌트)
5. [UI 프리미티브](#ui-프리미티브)
6. [상태 훅](#상태-훅)
7. [스타일 시스템](#스타일-시스템)
8. [렌더러가 지켜야 할 것](#렌더러가-지켜야-할-것)

## 기술 스택

| 층 | 무엇 | 비고 |
|---|---|---|
| 셸 | Electron 33 + electron-vite | 메인/프리로드/렌더러 3분할 빌드 |
| UI | React 18 + TypeScript(strict) | |
| 스타일 | Tailwind v4 (`@theme inline`) | 토큰 CSS 를 그대로 소비 — 값 복제 없음 |
| 변형 | `class-variance-authority` + `clsx` | 버튼·배지의 variant |
| 프리미티브 | Radix (dialog·tabs·tooltip·scroll-area) | |
| 마크다운 | `react-markdown` + `remark-gfm` | 답변 렌더링(표 포함) |
| 상태 | 자체 훅 (`useChat` 등) | 상태 라이브러리 없음 |
| 테스트 | vitest | `tests/` 에 평면 배치 |

**폰트는 자체 호스팅**이다(Pretendard 가변, JetBrains Mono). 오프라인에서도 같게 보여야
하므로 CDN 을 쓰지 않는다.

## 앱 셸 구조

```
┌─ TitleBar (56px, 드래그 영역) ─────────────────────┐
├──────────────┬────────────────────┬────────────────┤
│ ChatList     │ ChatPane / GraphPane│ TreePane      │
│ 260px        │ 1fr (min-w-0!)      │ 320px         │
└──────────────┴────────────────────┴────────────────┘
```

`min-w-0` 이 없으면 그래프 SVG 가 넓어질 때 `1fr` 트랙이 함께 늘어나 **우측 패널을
밀어낸다.** 실제로 겪은 버그다.

채팅은 탭을 바꿔도 **언제나 마운트된 채로 둔다**(숨기기만). 언마운트하면 스트리밍 중인
답변과 승인 대기가 끊긴다.

## 화면

| 화면 | 역할 | 주의 |
|---|---|---|
| `LoginScreen` | 구글 로그인 | 좌측 그라디언트 레일(18초 순환). 로그인은 단일 진행 |
| `OnboardingScreen` | 폴더 등록 | **여러 폴더 선택 가능**. 겹치면 최상위만 남긴다 |
| `MainScreen` | 3분할 셸 + 탭(chat/graph) | `chat`·`workspace` 훅을 받아 배분 |
| `SettingsScreen` | 계정·구독 사용량·등록 폴더 | LLM 키 입력 UI 는 없다(내부 키 사용) |

## 컴포넌트

| 컴포넌트 | 무엇 | 설계 요점 |
|---|---|---|
| `ChatList` | 좌측 대화 목록 | hover 시 휴지통 → **같은 자리에서** 삭제 확인(모달 없음) |
| `ChatPane` | 대화 본문 + 입력 | 빌드 진행·인증 오류 배너를 위에 얹는다 |
| `MessageBubble` | 메시지 하나 | 사용자=회색 버블(우), 에이전트=전폭. 생각중 점 3개는 시차 0.14s |
| `Markdown` | 답변 렌더링 | 위키 원문의 표·제목 때문에 필요. `<!--- page N --->` 를 페이지로 나눈다 |
| `CitationChip` | 인용 칩 | **브랜드 파랑을 쓰는 몇 안 되는 곳.** 클릭하면 원본이 열린다 |
| `ToolBadge` | 도구 실행 배지 | 무엇을 하는 중인지 알린다 |
| `ApprovalModal` | 변경 승인 | 파일이 바뀌기 **전에** diff 를 보여준다. 가장 중요한 안전장치 |
| `DiffView` | diff 렌더링 | |
| `TreePane` | 우측 문서 트리 | 파일별 상태(pending/converting/done/error) + 빌드 버튼 |
| `GraphPane` | 지식 그래프 | 생성 SVG. 컨테이너로 크기를 제한해야 한다 |
| `UsagePanel` | 구독 사용량 | 남은 금액을 크게, 막대는 색+문구 양쪽으로 알림. "결제 연동 전" 배지 |
| `LlmKeyForm` | LLM 키 입력 | 현재 설정 화면에서 쓰지 않음(내부 키 방식) |

## UI 프리미티브

`src/renderer/src/ui/` — `Button` `Badge` `Card` `Dialog` `Input` `ProgressBar` `Spinner`
`TitleBar` `Wordmark`.

`Button` 은 5 variant(primary·secondary·subtle·ghost·danger) × 3 size. 규칙:
**한 화면에 primary 는 하나**, hover 는 한 단계 어둡게, press 는 한 단계 더 + 0.5px 눌림.
바운스·확대 없음.

## 상태 훅

| 훅 | 소유 | 요점 |
|---|---|---|
| `useChat` | 대화·메시지·스트리밍 | `AgentEvent` 를 누적. 메인이 SQLite 에 영속하므로 여기는 **화면용 캐시** |
| `useWorkspace` | 폴더·트리·빌드 상태 | |
| `useSession` | 로그인 세션 | |
| `useApproval` | 승인 모달 큐 | |
| `useLlmKey` | LLM 키 상태 | |

`useChat` 에서 `activeIdRef`·`conversationsRef` 를 쓰는 이유는, 이벤트 구독 콜백이 최신
값을 봐야 하는데 의존성에 넣으면 구독이 매번 재생성되기 때문이다.

## 스타일 시스템

토큰 원본은 `src/renderer/src/styles/tokens/` 다(`DESIGN.md` 에 근거가 적혀 있다).

```
index.css: 토큰 → Tailwind → @theme inline → base.css (layer(base) 로 감쌀 것)
```

**`layer(base)` 를 빠뜨리면 안 된다.** 레이어에 속하지 않은 규칙은 특정도와 무관하게
레이어 규칙을 이겨서, `h1 { color }` 가 `text-white` 를 눌러 버린다.

핵심 토큰: 브랜드 `--blue-500 #2B5DFD`, 잉크 `--ink-950 #0D1630`, 헤어라인 `--ink-100`.
그림자는 **남색 기운**(`rgba(13,22,48,…)`) — 검정 그림자는 흰 바탕에서 얼룩으로 보인다.

## 렌더러가 지켜야 할 것

- **하드코딩한 hex 금지.** 모든 색은 토큰이고 `@theme inline` 으로 유틸리티까지 이어진다.
- **텍스트 선택은 기본 꺼짐.** 데스크톱 앱이라 `[data-selectable]` 로 본문에만 켠다.
- **`transform`·`opacity` 만 애니메이션.** `prefers-reduced-motion` 은 `base.css` 에서
  전역으로 꺼진다 — 컴포넌트에서 되살리지 않는다.
- **행 단위 동작에 모달을 쓰지 않는다.** 같은 자리에서 상태만 바꾼다(채팅 삭제가 그 예).
- **오류를 삼키지 않는다.** 실패하면 무엇이 왜 실패했는지 한국어 문장으로 보여준다.
