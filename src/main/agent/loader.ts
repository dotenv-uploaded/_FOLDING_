/**
 * `@codegate/agent`(성주 레포) 로더.
 * 아직 배포 전이라 해석에 실패할 수 있으므로, 실패하면 내장 목 에이전트로 폴백한다.
 * 어느 쪽이 선택됐는지는 로그로 분명히 남긴다 (조용한 폴백 금지).
 */
import type { CreateAgent } from '@contracts';
import { createMockAgent } from './mock-agent';

export type AgentSource = 'real' | 'mock';

export interface LoadedAgentFactory {
  createAgent: CreateAgent;
  source: AgentSource;
}

/** 정적 해석을 피하기 위해 변수 지정자로 import 한다 (패키지가 없어도 타입체크가 통과해야 한다). */
const AGENT_PACKAGE = '@codegate/agent';

export async function loadCreateAgent(): Promise<LoadedAgentFactory> {
  if (process.env.CODEGATE_MOCK === '1') {
    console.info('[codegate:agent] CODEGATE_MOCK=1 — 내장 목 에이전트를 사용합니다.');
    return { createAgent: createMockAgent, source: 'mock' };
  }
  try {
    const mod = (await import(/* @vite-ignore */ AGENT_PACKAGE)) as {
      createAgent?: CreateAgent;
      default?: { createAgent?: CreateAgent };
    };
    const createAgent = mod.createAgent ?? mod.default?.createAgent;
    if (typeof createAgent !== 'function') {
      throw new Error('createAgent export 를 찾지 못했습니다');
    }
    console.info('[codegate:agent] @codegate/agent 를 불러왔습니다.');
    return { createAgent, source: 'real' };
  } catch (err) {
    console.warn(
      `[codegate:agent] @codegate/agent 를 불러오지 못해 내장 목 에이전트로 대체합니다: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { createAgent: createMockAgent, source: 'mock' };
  }
}
