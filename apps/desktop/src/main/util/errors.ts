/**
 * 사용자에게 보이는 오류는 반드시 한국어 문장이어야 한다 (스펙 v1.3 §5 — silent fail 금지).
 * raw stack 이 렌더러로 새어나가지 않도록 여기서 한 번 걸러준다.
 */

/** 이미 한국어 문장으로 다듬어진 오류. */
export class UserFacingError extends Error {
  readonly userFacing = true;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'UserFacingError';
  }
}

function isUserFacing(err: unknown): err is UserFacingError {
  return typeof err === 'object' && err !== null && 'userFacing' in err;
}

/**
 * 임의의 throw 값을 사용자 문장으로 바꾼다.
 * `fallback` 은 원인을 모를 때 보여줄 한국어 문장.
 */
export function toUserMessage(err: unknown, fallback: string): string {
  if (isUserFacing(err)) return err.message;
  if (err instanceof Error && err.name === 'AuthError') return err.message;
  return fallback;
}

/**
 * 디버깅용 상세 로그 — 사용자에게는 절대 보이지 않는다.
 *
 * **`cause` 사슬을 끝까지 따라간다.** 이 앱은 오류를 한국어 문장으로 감싸서 올리는데,
 * 감싼 것만 찍으면 로그에 남는 건 "Google 로그인에 실패했습니다" 뿐이고 진짜 이유(HTTP
 * 몇 번인지, 어느 요청이 죽었는지)는 사라진다. 실제로 그 한 줄만 보고 원인을 찾느라
 * 한참 헤맸다 — `cause` 에 이미 담겨 있었는데 출력에서 버리고 있었다.
 *
 * 순환 참조가 있어도 멈추도록 깊이를 제한한다.
 */
export function logError(scope: string, err: unknown): void {
  const lines: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current !== undefined && current !== null && depth < 5; depth += 1) {
    const detail =
      current instanceof Error ? (current.stack ?? current.message) : String(current);
    lines.push(depth === 0 ? detail : `  caused by: ${detail}`);
    current = current instanceof Error ? (current.cause as unknown) : undefined;
  }
  console.error(`[codegate:${scope}] ${lines.join('\n')}`);
}
