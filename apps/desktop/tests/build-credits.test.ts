import { describe, expect, it } from 'vitest';
import { BASE_CREDITS, DOCUMENTS_PER_CREDIT, creditsForDocuments, toCredits } from '@codegate/contracts';
import { costUsdOf, priceFor } from '@main/build/pricing';

/**
 * 크레딧은 **제품 단위**다 — 원가 환산값이 아니다.
 *
 * 원가로 환산해 봤더니 문서 분석이 대화보다 훨씬 싸서, 코퍼스 119개 전체가 1~2 크레딧으로
 * 나왔다. 숫자가 아무것도 말해 주지 않고, 모델 단가가 바뀔 때마다 같은 크레딧이 조용히 다른
 * 양이 된다. 그래서 문서 수로 정한다.
 */
describe('creditsForDocuments', () => {
  it(`문서 ${DOCUMENTS_PER_CREDIT}개마다 1 크레딧`, () => {
    expect(creditsForDocuments(0)).toBe(0);
    expect(creditsForDocuments(1)).toBe(1);
    expect(creditsForDocuments(DOCUMENTS_PER_CREDIT)).toBe(1);
    expect(creditsForDocuments(DOCUMENTS_PER_CREDIT + 1)).toBe(2);
  });

  it('문서가 길든 짧든 같은 값이다 — 우리 원가의 출렁임을 사용자에게 떠넘기지 않는다', () => {
    // 예전 방식(원가 환산)에서는 같은 문서 수라도 길이에 따라 값이 달라졌다.
    expect(creditsForDocuments(119)).toBe(6);
  });

  it('실측 코퍼스(119개)도, 기본 크레딧으로 2,000개까지도 감당한다', () => {
    expect(creditsForDocuments(119)).toBeLessThan(BASE_CREDITS.build);
    expect(creditsForDocuments(2000)).toBe(BASE_CREDITS.build);
    expect(creditsForDocuments(2001)).toBeGreaterThan(BASE_CREDITS.build);
  });
});

describe('toCredits', () => {
  it('올림한다 — 쓴 것을 덜 세면 지갑이 조용히 샌다', () => {
    expect(toCredits(1)).toBe(1);
    expect(toCredits(100)).toBe(1);
    expect(toCredits(101)).toBe(2);
    expect(toCredits(0)).toBe(0);
  });
});

/**
 * 사용자가 보는 것은 크레딧이지만, **우리는 실제 원가를 따로 기록한다.**
 * 예전에는 이 계산이 아예 없어 폴더를 통째로 등록해도 사용량이 0 이었다.
 */
describe('costUsdOf', () => {
  it('토큰과 단가를 알면 값을 매긴다', () => {
    const cost = costUsdOf({
      inputTokens: 1_000_000,
      outputTokens: 0,
      model: 'gemini:gemini-2.0-flash',
    });
    expect(cost).toBeCloseTo(0.1, 6);
  });

  it('모르는 모델은 지어내지 않는다', () => {
    // 아무 값이나 넣어 "계산된 것처럼" 보이면, 틀린 사용량을 사실로 믿게 된다.
    expect(priceFor('처음 보는 모델')).toBeNull();
    expect(costUsdOf({ inputTokens: 1000, outputTokens: 10, model: '처음 보는 모델' })).toBeNull();
  });

  it('토큰을 못 받으면 금액도 없다 — 0 이 아니라 "모름"이다', () => {
    expect(
      costUsdOf({ inputTokens: null, outputTokens: null, model: 'gemini:flash-lite' }),
    ).toBeNull();
  });
});
