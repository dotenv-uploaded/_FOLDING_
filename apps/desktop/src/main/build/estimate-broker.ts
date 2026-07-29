import { randomUUID } from 'node:crypto';
import type { BuildEstimate, BuildEstimateEnvelope } from '@contracts';

/**
 * 문서 분석을 시작하기 전 사용자에게 예상 크레딧을 묻고 답을 기다린다.
 *
 * 도구 승인(ApprovalBroker)과 모양은 같지만 성격이 다르다 — 이건 위험을 막는 게이트가
 * 아니라 **비용에 대한 동의**다. 그래서 위험도도 없고, 사용자가 취소하면 실패가 아니라
 * "하지 않기로 했다"로 끝난다.
 *
 * 답이 없으면 **거부로 본다.** 창이 사라졌거나 앱이 닫히는 중일 수 있는데, 그때 기본값이
 * 승인이면 사용자가 보지도 못한 채 크레딧이 나간다.
 */
export class BuildEstimateBroker {
  private readonly waiting = new Map<string, (approved: boolean) => void>();

  constructor(
    private readonly options: {
      send: (envelope: BuildEstimateEnvelope) => void;
      /** 이만큼 답이 없으면 거부로 처리한다(ms). */
      timeoutMs?: number;
    },
  ) {}

  request = (estimate: BuildEstimate): Promise<boolean> => {
    const id = randomUUID();
    return new Promise<boolean>((resolve) => {
      const timeout = this.options.timeoutMs ?? 5 * 60_000;
      const timer = setTimeout(() => this.settle(id, false), timeout);
      this.waiting.set(id, (approved) => {
        clearTimeout(timer);
        resolve(approved);
      });
      this.options.send({ id, estimate });
    });
  };

  /** 렌더러의 답. 모르는 id 는 조용히 버린다(이미 시간이 지나 거부된 것). */
  respond(id: string, approved: boolean): void {
    this.settle(id, approved);
  }

  /** 창이 닫히는 등으로 물어볼 곳이 사라졌을 때 — 기다리던 것을 전부 거부로 끝낸다. */
  rejectAll(): void {
    for (const id of [...this.waiting.keys()]) this.settle(id, false);
  }

  private settle(id: string, approved: boolean): void {
    const resolve = this.waiting.get(id);
    if (!resolve) return;
    this.waiting.delete(id);
    resolve(approved);
  }
}
