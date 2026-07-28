import { describe, expect, it } from 'vitest';
import type { BuildPhase, BuildState } from '@contracts';
import { buildHeadline } from '@renderer/lib/build-voice';

/**
 * 빌드가 도는 동안 건네는 한 줄.
 *
 * 살아 있는 문장을 쓰되 세 가지는 지켜야 한다.
 *   1. **떨리지 않는다** — 진행률은 초당 여러 번 갱신된다. 그때마다 문장이 바뀌면 못 읽는다.
 *   2. **흐르긴 한다** — 몇 분짜리 빌드에서 한 문장만 떠 있으면 멈춘 것처럼 보인다.
 *   3. **실패는 꾸미지 않는다** — 무엇이 잘못됐는지 알아야 하는 순간에 비유를 들이밀지 않는다.
 */
describe('buildHeadline', () => {
  const state = (patch: Partial<BuildState> = {}): BuildState => ({
    buildId: 'build-abc',
    status: 'enriching',
    progress: 40,
    phase: { name: 'enrich', done: 12, total: 37 },
    message: '분석 12/37',
    updatedAt: '2026-07-27T05:00:00.000Z',
    ...patch,
  });

  it('같은 상태에서는 같은 문장 — 리렌더에 글자가 떨리지 않는다', () => {
    expect(buildHeadline(state())).toBe(buildHeadline(state()));
  });

  it('시간이 흐르면 다음 문장으로 넘어간다', () => {
    const first = buildHeadline(state({ updatedAt: '2026-07-27T05:00:00.000Z' }));
    const later = buildHeadline(state({ updatedAt: '2026-07-27T05:00:08.000Z' }));
    expect(later).not.toBe(first);
  });

  it('연달아 같은 문장이 나오지 않는다 — 무작위가 아니라 한 칸씩 넘어간다', () => {
    // 무작위로 뽑으면 같은 문장이 두 번 연속 나와 멈춘 것처럼 보인다.
    const seen = new Set<string>();
    let previous = '';
    for (let i = 0; i < 5; i += 1) {
      // 한 칸(약 7초)씩 흐르게 둔다.
      const at = new Date(Date.parse('2026-07-27T05:00:00.000Z') + i * 7000).toISOString();
      const line = buildHeadline(state({ updatedAt: at }));
      expect(line).not.toBe(previous);
      previous = line;
      seen.add(line);
    }
    expect(seen.size).toBe(5); // 한 바퀴 도는 동안 모두 다른 문장
  });

  it('단계마다 그 단계가 실제로 하는 일을 말한다', () => {
    const lines: Record<BuildPhase, string> = {
      convert: buildHeadline(state({ phase: { name: 'convert', done: 1, total: 9 } })),
      enrich: buildHeadline(state({ phase: { name: 'enrich', done: 1, total: 9 } })),
      assemble: buildHeadline(state({ phase: { name: 'assemble', done: 1, total: 9 } })),
    };
    expect(new Set(Object.values(lines)).size).toBe(3);
    expect(lines.assemble).toMatch(/잇|찾|손|실핏줄|그래프/); // 관계를 잇는 단계
  });

  it('거의 끝났으면 마무리 문장으로 바뀐다', () => {
    expect(buildHeadline(state({ progress: 98 }))).toMatch(/매듭|숨/);
  });

  it('실패는 꾸미지 않고, 끝났으면 조용해진다', () => {
    expect(buildHeadline(state({ status: 'failed' }))).toBe('빌드 실패');
    expect(buildHeadline(state({ status: 'done', progress: 100 }))).toBe('최신 상태');
    expect(buildHeadline(state({ status: 'idle', progress: 0 }))).toBe('최신 상태');
    expect(buildHeadline(null)).toBe('최신 상태');
  });

  it('단계가 정해지기 전(폴더를 훑는 중)에도 할 말이 있다', () => {
    const line = buildHeadline(state({ status: 'scanning', phase: undefined, progress: 3 }));
    expect(line).toMatch(/폴더|세어|불러/);
  });

  it('시각이 깨져 있어도 문장을 낸다', () => {
    // 상태가 이상하다고 화면이 비면 안 된다.
    expect(buildHeadline(state({ updatedAt: '언제인지 모름' }))).toBeTruthy();
  });
});
