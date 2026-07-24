/**
 * `@codegate/agent`(성주 레포) 로더.
 * 아직 배포 전이라 해석에 실패할 수 있으므로, 실패하면 내장 목 에이전트로 폴백한다.
 * 어느 쪽이 선택됐는지는 로그로 분명히 남긴다 (조용한 폴백 금지).
 */
import type { CreateAgent } from '@contracts';
import { createMockAgent } from './mock-agent';
import { createSidecarAgent } from './sidecar-agent';
import { createOpenAgent } from './open-agent';
import { createFormFillAgent } from './form-fill';

export type AgentSource = 'real' | 'mock';

export interface LoadedAgentFactory {
  createAgent: CreateAgent;
  source: AgentSource;
}

export async function loadCreateAgent(
  /** 호출 비용을 받아 구독 사용량에 더한다. */
  onUsage?: (costUsd: number | null) => void,
): Promise<LoadedAgentFactory> {
  if (process.env.CODEGATE_MOCK === '1') {
    console.info('[codegate:agent] CODEGATE_MOCK=1 — 내장 목 에이전트를 사용합니다.');
    return { createAgent: createMockAgent, source: 'mock' };
  }
  /*
   * 열린 에이전트 — 도구를 가리지 않고 매번 승인을 받는다.
   *
   * 아직 기본값이 아니다. 전면 개방은 승인 게이트가 유일한 방어선이므로, 실제 문서로
   * 위험 케이스를 확인한 뒤에 기본으로 올린다. 그전까지는 이 플래그로만 켠다.
   *
   * `CODEGATE_AGENT_MODE` 와는 다른 축이다 — 그쪽은 사이드카의 동작(claude·deterministic)을
   * 정하고, 이쪽은 앱이 어느 에이전트를 태울지를 정한다.
   */
  if (process.env.CODEGATE_OPEN_AGENT === '1') {
    console.info('[codegate:agent] CODEGATE_OPEN_AGENT=1 — 열린 에이전트(전면 승인 게이트)를 사용합니다.');
    return { createAgent: (deps) => createOpenAgent(deps, onUsage), source: 'real' };
  }

  console.info('[codegate:agent] Python sidecar API를 사용합니다.');
  /*
   * 양식 채우기만 앱이 직접 처리하고 나머지는 sidecar 가 답한다.
   *
   * sidecar 의 변경 계약은 "기존 문서의 한 대목을 정확히 지목해 바꾸기"에 맞춰져 있어서,
   * 여러 칸을 한꺼번에 채워 **새 파일**을 만드는 일과는 모양이 다르다. 억지로 태우지 않는다.
   * 승인 게이트는 그대로 거친다 — 파일이 생기기 전에 사용자가 보고 승인한다.
   */
  const createAgent: CreateAgent = (deps) => createFormFillAgent(deps, createSidecarAgent(deps, onUsage));
  return { createAgent, source: 'real' };
}
