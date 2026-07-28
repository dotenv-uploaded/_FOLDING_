# Folding

내 컴퓨터 안의 문서를 읽고, 잇고, 고치는 로컬 우선 문서 에이전트.

문서는 **이 컴퓨터를 떠나지 않는다.** 서버에 묻는 것은 로그인과 구독뿐이고, 변환·분석·조립·
편집은 전부 사용자 PC에서 돈다.

## 이 저장소의 구조

```
folding/
├── apps/
│   └── desktop/        Electron + React 데스크톱 앱. 사이드카를 직접 띄우고 지켜본다
├── services/
│   ├── agent/          답변 브레인 (Claude 열린 에이전트) + 승인 게이트 + 문서 쓰기 도구
│   └── convert/        doc2md — 원본(hwp·docx·pdf)을 마크다운으로
└── packages/
    └── llmwiki/        위키 빌더 — 문서를 불변 빌드로 조립하고 관계를 유도한다
```

한 몸이라 한 저장소에 둔다. Electron이 `agent`·`convert`를 **사이드카로 직접 spawn** 하고,
전부 사용자 PC 한 대에서 함께 켜진다. 분산 서비스가 아니라 한 번에 켜지는 번들이다.
게다가 `@codegate/contracts` 타입을 desktop과 agent가 함께 쓰므로, 계약 하나를 바꾸면 여러
컴포넌트가 **한 커밋에서** 같이 바뀌어야 한다.

## 여기 없는 것 — `folding-cloud-api`

OAuth·세션·구독 서버는 [`folding-cloud-api`](https://github.com/dotenv-uploaded/folding-cloud-api)
로 갈라 두었다. 이것만 성격이 다르기 때문이다:

- 사용자 PC가 아니라 **서버에 배포**된다 (모든 사용자 대상, 별도 수명주기·스케일링)
- client secret·session pepper 등 **로컬에 절대 내려가지 않는 비밀**을 쥔다
- 그 자체가 네트워크 경계다

로컬 번들과는 **계약으로만** 연결된다.

## 히스토리

각 폴더는 원래 저장소의 커밋 기록을 그대로 가지고 들어왔다(`git subtree`). `git log` 에
네 사람의 이름이 남아 있고, `git log -- apps/desktop` 처럼 폴더별로 원래 이력을 볼 수 있다.

| 폴더 | 온 곳 |
|---|---|
| `apps/desktop` | `codegate-2026-local` |
| `services/agent` | `codegate-2026-agent` |
| `services/convert` | `codegate-2026-convert` (민규) |
| `packages/llmwiki` | `codegate-2026-backend/wiki-builder` (용휘·성주) |

기존 저장소는 지우지 않았다. 이 저장소에 문제가 생기면 거기로 돌아갈 수 있다.

## 지금 상태 — 읽고 가야 할 것

**아직 `pnpm dev` 하나로 전부 뜨지 않는다.** 이 저장소는 지금 *기록을 보존한 채 코드를 한곳에
모은 상태*이고, 각 폴더는 여전히 자기 저장소였을 때의 설정을 그대로 들고 있다.

남은 배선 작업은 [`docs/MIGRATION.md`](docs/MIGRATION.md) 에 순서대로 적어 두었다.
그때까지는 각 폴더에서 원래 방식대로 실행하면 된다.
