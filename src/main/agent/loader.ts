/**
 * `@codegate/agent`(성주 레포) 로더.
 * 아직 배포 전이라 해석에 실패할 수 있으므로, 실패하면 내장 목 에이전트로 폴백한다.
 * 어느 쪽이 선택됐는지는 로그로 분명히 남긴다 (조용한 폴백 금지).
 */
import type { CreateAgent } from '@contracts';
import { createMockAgent } from './mock-agent';
import { createSidecarAgent } from './sidecar-agent';
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
