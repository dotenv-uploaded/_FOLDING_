/**
 * 사용량을 기본 → 추가 크레딧 순으로 나누는 규칙.
 *
 * 저장은 총액 하나뿐이고 어느 칸에서 나갔는지는 여기서 복원한다. 소진 순서가 어긋나면
 * 사용자는 "기본이 남았는데 왜 크레딧이 줄지?"를 보게 되므로 경계를 못 박아 둔다.
 */
import { describe, expect, it } from 'vitest';
import { usageBreakdown, type UsageStatus } from '@codegate/contracts';

function status(partial: Partial<UsageStatus>): UsageStatus {
  return {
    usedKrw: 0,
    limitKrw: 20_000,
    extraKrw: 0,
    remainingKrw: 0,
    blocked: false,
    calls: 0,
    pools: {
      chat: { kind: 'chat', usedCredits: 0, limitCredits: 200, remainingCredits: 200 },
      build: { kind: 'build', usedCredits: 0, limitCredits: 50, remainingCredits: 50 },
    },
    extraCredits: 0,
    ...partial,
  };
}

describe('usageBreakdown', () => {
  it('기본 한도 안에서는 크레딧이 줄지 않는다', () => {
    const { base, credit } = usageBreakdown(status({ usedKrw: 8_000, extraKrw: 10_000 }));
    expect(base).toEqual({ limitKrw: 20_000, usedKrw: 8_000, remainingKrw: 12_000 });
    expect(credit).toEqual({ limitKrw: 10_000, usedKrw: 0, remainingKrw: 10_000 });
  });

  it('기본을 정확히 다 쓰면 크레딧은 아직 그대로다', () => {
    const { base, credit } = usageBreakdown(status({ usedKrw: 20_000, extraKrw: 10_000 }));
    expect(base.remainingKrw).toBe(0);
    expect(credit.usedKrw).toBe(0);
    expect(credit.remainingKrw).toBe(10_000);
  });

  it('기본이 떨어진 뒤부터 크레딧이 줄어든다', () => {
    const { base, credit } = usageBreakdown(status({ usedKrw: 23_000, extraKrw: 10_000 }));
    expect(base).toEqual({ limitKrw: 20_000, usedKrw: 20_000, remainingKrw: 0 });
    expect(credit).toEqual({ limitKrw: 10_000, usedKrw: 3_000, remainingKrw: 7_000 });
  });

  it('전부 소진되면 두 칸 모두 0 이 남는다', () => {
    const { base, credit } = usageBreakdown(status({ usedKrw: 30_000, extraKrw: 10_000 }));
    expect(base.remainingKrw).toBe(0);
    expect(credit.remainingKrw).toBe(0);
    expect(credit.usedKrw).toBe(10_000);
  });

  it('한도를 넘겨 쓴 경우에도 칸 밖으로 삐져나오지 않는다', () => {
    // 막기 전에 한 번 더 나갈 수 있어 총액이 한도를 넘길 수 있다.
    const { base, credit } = usageBreakdown(status({ usedKrw: 35_000, extraKrw: 10_000 }));
    expect(base.usedKrw).toBe(20_000);
    expect(credit.usedKrw).toBe(10_000);
    expect(credit.remainingKrw).toBe(0);
  });

  it('크레딧을 산 적이 없으면 크레딧 칸은 0 이다', () => {
    const { credit } = usageBreakdown(status({ usedKrw: 5_000, extraKrw: 0 }));
    expect(credit).toEqual({ limitKrw: 0, usedKrw: 0, remainingKrw: 0 });
  });
});
