# ADR 0009: 상태별 Claude 구조화 출력 계약

- 상태: 채택
- 날짜: 2026-07-22

## 배경

Prompt contract 2.0은 하나의 평면 JSON object에 `outcome`, `intent`, nullable source hash와
operation을 함께 뒀다. Claude Agent SDK의 structured output은 이 JSON Schema를 만족시켰지만,
Pydantic `model_validator`에만 있던 교차 필드 규칙은 schema에 표현되지 않았다. 그 결과
`ready change`인데 operation이 없거나 non-ready 결과에 operation이 남는 등 schema-valid 조합이 후단에서
`AGENT_RESULT_INVALID`로 실패할 수 있었다.

짧은 후속 발화는 SDK session만으로 복원하지 않고 최근 같은 대화의 message를 별도 untrusted context로
전달해야 했다. 반대로 이전 tool result는 현재 turn의 근거로 재사용하면 안 된다.

## 결정

Prompt contract 2.1의 SDK-facing output을 top-level `decision` object와 다음 `decision_type` union으로
구성한다.

- `ready_locate`: target만 선택적으로 포함하고 change 필드는 schema에 존재하지 않는다.
- `ready_change`: 검증된 target, source SHA-256과 `replace_exact` operation을 모두 필수로 둔다.
- `needs_clarification`, `not_found`, `tool_error`, `unsupported`: intent와 상태 설명만 포함하고 change
  필드를 schema에 노출하지 않는다.

SDK가 이 union을 검증하고 재시도한 뒤 Backend가 이를 기존 `AgentDecision` domain model로 변환한다.
Domain cross-field validator와 current-turn tool trace, source hash, replacement wording, plan approval 검사는
그대로 유지한다. 공식 structured output의 enum casing 예외만 허용된 값 안에서 case-insensitive하게
정규화하고, validation log에는 고정 schema location과 error type만 남긴다. 모델이 만든 임의 key와
입력값은 기록하지 않는다.

최근 같은 대화 message는 bounded oldest-first JSON으로 보내되 계속 untrusted input으로 취급한다.
한국어 조사가 붙은 stable ID도 ASCII ID 경계로만 추출해 routing hint로 사용할 수 있다. 모든 ready
결과는 현재 turn에서 검색·문서 확인·원본 읽기를 다시 수행한다.

이 결정은 Anthropic의
[Agent SDK structured output](https://code.claude.com/docs/en/agent-sdk/structured-outputs)과
[Claude structured output 제한](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)을
따른다.

## 검토한 대안

- Prompt 문구만 강화: schema와 application validator 사이의 표현력 차이를 제거하지 못해 제외했다.
- LangChain 또는 LangGraph 추가: 현재 문제는 workflow checkpoint가 아니라 한 응답의 type contract다.
  추가 orchestration 계층은 보장을 늘리지 않고 운영 표면만 넓혀 제외했다.
- Claude에 filesystem write/delete tool을 직접 허용: approval hash, immutable backup, atomic replace와 Undo를
  우회하므로 제외했다. 파일 자체 삭제는 recoverable delete journal과 UI 계약이 생길 때 별도 operation으로
  설계한다. 그 전에는 앱이 agent 호출 전에 파일 삭제 문장을 차단해 내용 삭제 operation으로 오해할 수
  없게 한다.

## 결과

상태와 필드의 잘못된 조합은 모델 출력 단계에서 표현할 수 없다. Schema 변경은 runtime fingerprint를
바꿔 기존 SDK session을 자동 회전시킨다. Semantic field change와 대화 history 기반 삭제를 고정 prompt
eval corpus에 추가한다.
