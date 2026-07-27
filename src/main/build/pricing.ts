/**
 * 문서 분석 호출의 값 — 토큰 수를 돈으로 바꾼다.
 *
 * 왜 표를 코드에 두는가
 * --------------------
 * 문서 분석은 제공자가 **금액을 알려주지 않는다** — 토큰 수만 준다(Claude Agent SDK 가
 * `total_cost_usd` 를 주는 대화 쪽과 다르다). 그래서 단가표가 없으면 문서 분석은 영원히
 * 사용량 0 으로 남는다. 실제로 그랬다.
 *
 * **여기 값은 우리가 검증한 것이 아니라 제공자가 공개한 목록가를 적어 둔 것이다.**
 * 틀릴 수 있고, 바뀐다. 그래서 두 가지를 지킨다:
 *   1. 환경변수로 덮어쓸 수 있게 한다 — 코드를 고치지 않고 바로잡을 수 있어야 한다
 *   2. **토큰 수를 원본으로 저장한다** — 단가가 틀렸다고 밝혀져도 나중에 다시 계산할 수 있다
 *
 * 모르는 모델은 `null` 을 돌려준다. 아무 값이나 넣어 "계산된 것처럼" 보이게 하지 않는다.
 */

export interface ModelPrice {
  /** 100만 입력 토큰당 USD */
  inputUsdPerMTok: number;
  /** 100만 출력 토큰당 USD */
  outputUsdPerMTok: number;
}

/** 제공자 공개 목록가(2026-07 기준, 우리가 검증하지는 않았다). */
const PRICES: { match: RegExp; price: ModelPrice }[] = [
  { match: /flash-lite/i, price: { inputUsdPerMTok: 0.075, outputUsdPerMTok: 0.3 } },
  { match: /gemini.*flash/i, price: { inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.4 } },
  { match: /gemini.*pro/i, price: { inputUsdPerMTok: 1.25, outputUsdPerMTok: 5 } },
  { match: /gpt-4o-mini/i, price: { inputUsdPerMTok: 0.15, outputUsdPerMTok: 0.6 } },
  { match: /gpt-4o/i, price: { inputUsdPerMTok: 2.5, outputUsdPerMTok: 10 } },
  { match: /haiku/i, price: { inputUsdPerMTok: 0.8, outputUsdPerMTok: 4 } },
  { match: /sonnet/i, price: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 } },
];

/**
 * 예상치를 낼 때 쓰는 기본 단가.
 *
 * 아직 어느 모델로 부를지 모르는 시점(빌드 시작 전)에도 어림은 보여줘야 한다. 실제 분석에
 * 쓰는 모델(flash 계열)의 값을 기본으로 둔다.
 */
export const DEFAULT_ENRICH_PRICE: ModelPrice = { inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.4 };

/** 모델 이름으로 단가를 찾는다. 모르면 `null` — 지어내지 않는다. */
export function priceFor(model: string): ModelPrice | null {
  const override = envPrice();
  if (override) return override;
  return PRICES.find((entry) => entry.match.test(model))?.price ?? null;
}

/** 예상치용 단가. 환경변수가 있으면 그것을, 없으면 기본값을 쓴다(항상 값이 있다). */
export function estimatePrice(): ModelPrice {
  return envPrice() ?? DEFAULT_ENRICH_PRICE;
}

/**
 * 이번 호출의 비용(USD). 토큰이나 단가를 모르면 `null`.
 *
 * `null` 은 "0원"이 아니라 **"모른다"** 다. 호출 자체는 사용량에 남기고(토큰과 함께),
 * 금액만 비워 둔다 — 그래야 나중에 "쓴 적 없음"과 구분된다.
 */
export function costUsdOf(
  usage: { inputTokens: number | null; outputTokens: number | null; model: string },
): number | null {
  const price = priceFor(usage.model);
  if (!price) return null;
  if (usage.inputTokens === null && usage.outputTokens === null) return null;
  const input = ((usage.inputTokens ?? 0) / 1_000_000) * price.inputUsdPerMTok;
  const output = ((usage.outputTokens ?? 0) / 1_000_000) * price.outputUsdPerMTok;
  return input + output;
}

function envPrice(): ModelPrice | null {
  const input = Number(process.env.CODEGATE_ENRICH_PRICE_IN);
  const output = Number(process.env.CODEGATE_ENRICH_PRICE_OUT);
  if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return null;
  return { inputUsdPerMTok: input, outputUsdPerMTok: output };
}
