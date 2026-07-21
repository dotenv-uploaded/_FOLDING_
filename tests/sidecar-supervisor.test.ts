import { describe, expect, it, vi } from 'vitest';
import {
  SidecarSupervisor,
  buildSidecarArgs,
  normalizeSidecarOrigin,
  type SidecarRuntimePaths,
} from '@main/sidecar/supervisor';

const runtime: SidecarRuntimePaths = {
  sourceRoot: '/workspace/source',
  llmwikiProjectRoot: '/app/LLMWIKI',
  llmwikiInputRoot: '/workspace/source-md',
  llmwikiStorageRoot: '/app-data/llmwiki',
  dataRoot: '/app-data/codegate',
  doc2mdUrl: 'http://127.0.0.1:9000',
  deterministicAgent: true,
  tenantId: 'local',
  wikiId: 'workspace',
};

describe('SidecarSupervisor contract', () => {
  it('Backend CLI가 요구하는 runtime 인자를 모두 만든다', () => {
    expect(buildSidecarArgs('http://127.0.0.1:43123', 'app://codegate', runtime)).toEqual([
      '--source-root',
      '/workspace/source',
      '--llmwiki-project-root',
      '/app/LLMWIKI',
      '--llmwiki-input-root',
      '/workspace/source-md',
      '--llmwiki-storage-root',
      '/app-data/llmwiki',
      '--data-root',
      '/app-data/codegate',
      '--port',
      '43123',
      '--cors-origin',
      'app://codegate',
      '--tenant-id',
      'local',
      '--wiki-id',
      'workspace',
      '--doc2md-url',
      'http://127.0.0.1:9000',
      '--deterministic-agent',
    ]);
  });

  it('외부 API base를 origin으로 정규화하고 health URL을 한 번만 붙인다', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ status: 'ok', agent_available: true }), { status: 200 }),
    );
    const supervisor = new SidecarSupervisor({
      corsOrigin: 'app://codegate',
      externalUrl: 'http://127.0.0.1:8000/api/v1/',
      onState: vi.fn(),
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(supervisor.prepare()).resolves.toBe('http://127.0.0.1:8000');
    await supervisor.start();

    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:8000/api/v1/health');
    expect(supervisor.getState().status).toBe('external');
  });

  it('문서 폴더가 정해지기 전에는 managed sidecar를 실행하지 않는다', async () => {
    const supervisor = new SidecarSupervisor({
      corsOrigin: 'app://codegate',
      onState: vi.fn(),
    });
    await supervisor.prepare();
    await supervisor.start();

    expect(supervisor.configured).toBe(false);
    expect(supervisor.getState().status).toBe('stopped');
    expect(supervisor.getState().message).toContain('문서 폴더');
  });

  it('API path가 없는 외부 주소도 그대로 정규화한다', () => {
    expect(normalizeSidecarOrigin('http://127.0.0.1:8000/')).toBe('http://127.0.0.1:8000');
  });
});
