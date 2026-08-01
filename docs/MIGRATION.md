# 이관 — 남은 배선

코드는 한곳에 모였지만 **아직 하나로 돌지는 않는다.** 각 폴더가 자기 저장소였을 때의 설정을
그대로 들고 있기 때문이다. 여기 적은 순서대로 하면 `pnpm dev` 하나로 전부 뜨게 된다.

순서에는 이유가 있다 — **뒤 단계가 앞 단계의 결과에 기댄다.** 건너뛰지 말 것.

## 1. 계약(contracts)을 하나로

지금 `@codegate/contracts` 가 **두 곳에 복제**돼 있다:

- `apps/desktop/packages/contracts/src/index.ts`
- `services/agent/` 쪽 사본

두 파일은 "같아야 한다"는 약속으로만 유지돼 왔다. 한쪽만 고치면 조용히 어긋나고, 그 어긋남은
런타임에 가서야 드러난다. 저장소가 하나가 된 지금은 그럴 이유가 없다.

- [ ] `packages/contracts/` 로 올린다 (desktop 쪽을 원본으로 — 최신이다)
- [ ] desktop·agent 가 그것을 참조하게 경로를 바꾼다
- [ ] 두 사본이 실제로 같았는지 diff 로 확인하고, 다르면 **무엇이 달랐는지 기록**한다

## 2. 워크스페이스를 하나로

`apps/desktop/pnpm-workspace.yaml` 이 중첩 워크스페이스로 남아 있다. 루트에 워크스페이스를
두고 desktop 것을 걷어낸다.

- [ ] 루트 `pnpm-workspace.yaml` — `apps/*`, `packages/*`
- [ ] 루트 `package.json` — `dev`·`build`·`test`·`typecheck` 를 하위로 위임
- [ ] `apps/desktop/pnpm-workspace.yaml` 제거, 의존성 참조 경로 정리

## 3. 경로 설정을 없앤다

지금 `apps/desktop/.env` 가 **저장소가 흩어져 있어서 생긴 차이**를 메우고 있다:

```
CODEGATE_DOC2MD_PROJECT_ROOT=…/codegate-2026-convert/services/doc2md
CODEGATE_SIDECAR_BIN=…/codegate-2026-agent/.venv/bin/codegate-local
CODEGATE_LLMWIKI_PROJECT_ROOT=…/LLMWIKI
```

한 저장소가 되었으니 이 셋은 **상대 경로로 기본값을 잡을 수 있다.** 사람마다 다른 절대 경로를
`.env` 에 적어 두는 일이 사라진다.

- [ ] `services/convert`·`services/agent`·`packages/llmwiki` 를 저장소 루트 기준으로 찾게 한다
- [ ] `.env` 는 **비밀과 선택**만 남긴다 (API 키·인증 모드·모델 선택)
- [ ] `.env.example` 을 그에 맞게 줄인다

## 4. 부트스트랩 하나로

지금은 파이썬 가상환경 두 개(`agent`, `convert`)를 각각 손으로 만들어야 한다.

- [ ] `scripts/bootstrap` — 가상환경 생성·의존성 설치까지 한 번에
- [ ] `scripts/dev` — 지금의 `dev-integrated.mjs` 를 루트로 올린다
- [ ] `scripts/check` — 양쪽 타입체크 + 두 언어 테스트

> `pnpm` 이 버전 전환에 실패하는 환경이 있다(`ERR_PNPM_BAD_PM_VERSION`). 그래서 지금
> `dev-integrated.mjs` 는 `pnpm exec` 를 거치지 않고 로컬 바이너리를 직접 부른다. 이 성질은
> 옮겨 가서도 유지할 것 — 중간 단계를 없애면 그런 실패가 아예 생기지 않는다.

## 5. 팀 결과물 합치기 (이관과 별개 · 결정 필요)

아래는 **아직 가져오지 않았다.** 합칠지 말지가 코드 문제가 아니라 방향의 문제라서다.

| 출처 | 물건 | 지금 판단 |
|---|---|---|
| 민규 `Folding-JimiJimi` | `codegate-filesystem` (원자적 파일 조작·보안 가드) | 가져올 만하다. 우리 writer 와 겹치지 않는 하부 계층 |
| 민규 `Folding-JimiJimi` | 다형식 쓰기 v2 (API v2 전용 경로) | **안 가져온다.** 정해진 프로토콜 안에서만 도는 구조를 피하기로 했고, 대신 자기검증 writer 를 직접 만들었다 |
| 용휘 `folding-song` | `scripts/` 오케스트레이션·프로세스 감독 | 4번에서 참고 |
| 성주 `ghdtjdwn_complete` | `crosslink.ts` (문서번호 토큰 → 링크) | **안 가져온다.** 사람이 의미관계를 직접 찾아야 해서 방향과 어긋난다. 엔티티 겹침으로 대체됨 |
| 용휘·민규 | `GeminiAgentGateway` (답변용) | **안 가져온다.** 답변은 Claude. Gemini 는 그래프 enrichment 에만 남는다 |

## 6. 옮긴 뒤 확인

배선이 끝났다는 것을 무엇으로 아는가 — 아래가 전부 되면 끝난 것이다.

- [ ] `pnpm bootstrap && pnpm dev` 로 doc2md·agent·desktop 이 함께 뜬다
- [ ] 폴더를 등록하면 분석 전 크레딧 확인 창이 뜨고, 승인하면 위키가 만들어진다
- [ ] 그래프에 관계와 그 근거가 보인다
- [ ] 문서 편집을 시키면 승인 게이트를 거쳐 원본이 보존된 채 새 파일이 나온다
- [ ] `pnpm check` — 타입체크·테스트가 전부 통과한다

## 7. 개인 통합 저장소 이력 보존

2026-08-02에 이슈 [#2](https://github.com/dotenv-uploaded/_FOLDING_/issues/2)에 따라
`dotenv-uploaded/ghdtjdwn_complete`의 전체 이력을 공식 저장소로 이전했다.

- 이전한 최종 커밋: `314147855f01e81e1462b87613db443e8788c673`
- 이전한 커밋 수: 41개
- 보존 방식: 공식 `main`을 기준으로 한 브랜치에서 개인 저장소 `main`을 `ours` 전략으로 병합
- 선택 이유: 개인 저장소는 별도 통합 스냅샷이고, 공식 저장소는 이후 각 컴포넌트를 subtree로
  통합해 더 최신 구현을 포함한다. 개인 저장소의 작업 트리로 덮어쓰면 공식 기능이 삭제되므로,
  현재 트리는 유지하면서 병합 부모를 통해 커밋과 파일 객체 전체를 보존했다.
- 전달 결과: PR [#3](https://github.com/dotenv-uploaded/_FOLDING_/pull/3)을 merge commit
  `65d5c44bd4125193d4bc03b972fde6c742b37a42`로 병합했다. 공식 원격에서 위 최종 커밋이
  계속 조회되고 `main`의 조상임을 확인한 뒤 개인 저장소를 삭제했다.

## 8. Agent 분리 저장소 이력 보존

2026-08-02에 이슈 [#5](https://github.com/dotenv-uploaded/_FOLDING_/issues/5)에 따라
`dotenv-uploaded/codegate-2026-agent`의 원격 브랜치 이력을 공식 저장소로 이전했다. 기존 subtree
통합으로 `main`과 `feat/hwp-write`는 이미 보존돼 있었고, 아래 8개 브랜치 끝점을 추가로 연결했다.

| 브랜치 | 최종 커밋 |
|---|---|
| `agent/backend-foundation` | `19905e1ab7c698b3dbd0c1e52c2d04a6f881da46` |
| `agent/claude-answer-stability` | `aeb86c7bb810144a6b0857dc7d3643f5580171a0` |
| `docs/claude-prompt-merge-record` | `68083a3be0121945b566dfbd8e70e0c0168193cc` |
| `docs/doc2md-v0.2-contract` | `d835fbf219d69058a382c27b1d2afbda0d912610` |
| `docs/role-contract-audit` | `aedf70145c2ce9516b09251cd647ce9cbef531e1` |
| `feat/claude-prompt-hardening` | `70b5d717ea9e52f9ba5d5561e4215ad571c22ba2` |
| `feat/doc2md-v2-integration` | `6397147feb999ab492cf087cdfb5961d935fa59c` |
| `fix/llmwiki-server-v2-compat` | `76f5d8f88c615dadd1706d6c2e2648264a34f95b` |

공식 저장소의 현재 트리를 유지하는 `ours` 병합을 사용했다. PR
[#6](https://github.com/dotenv-uploaded/_FOLDING_/pull/6)을 merge commit
`b0dc714c0d5a769eec1e72477dd945733f9a1a43`로 병합하고, 원본의 10개 원격 브랜치 끝점이 모두
공식 `main`의 조상이며 공식 원격 API에서 조회되는 것을 확인한 뒤 원본 저장소를 삭제했다. 로컬
`Backend` 작업 트리의 미커밋 변경은 이 이전에 포함하지 않고 그대로 보존했다.
