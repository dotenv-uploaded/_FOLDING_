import { describe, expect, it } from 'vitest';
import {
  assessPlatform,
  blockingPreflightMessage,
  type PlatformSnapshot,
} from '@main/system/preflight';

const baseSnapshot: PlatformSnapshot = {
  platform: 'win32',
  architecture: 'x64',
  osVersion: '10.0.19045',
  kernelRelease: '10.0.19045',
  totalMemoryBytes: 16 * 1024 ** 3,
  freeDiskBytes: 20 * 1024 ** 3,
  vcRuntime: { installed: true, version: 'v14.50.35719.0' },
  directXVersion: '4.09.00.0904',
  graphics: [{ name: 'NVIDIA GeForce RTX 3060', driverVersion: '32.0.15.7688' }],
  missingRuntimeFiles: [],
};

describe('platform preflight', () => {
  it('지원 기준을 만족하는 Windows 설치본을 통과시킨다', () => {
    expect(assessPlatform(baseSnapshot, true)).toEqual([]);
  });

  it('낡은 OS와 누락된 VC++ 런타임을 차단한다', () => {
    const findings = assessPlatform(
      {
        ...baseSnapshot,
        kernelRelease: '10.0.19044',
        vcRuntime: { installed: false },
      },
      true,
    );
    expect(findings.map((finding) => finding.code)).toEqual([
      'windows-version',
      'vc-runtime',
    ]);
    expect(
      blockingPreflightMessage({
        schemaVersion: 1,
        checkedAt: '2026-07-29T00:00:00.000Z',
        snapshot: baseSnapshot,
        findings,
      }),
    ).toContain('Windows 10 22H2');
  });

  it('메모리·디스크·드라이버 성능 저하를 명시적으로 경고한다', () => {
    const findings = assessPlatform(
      {
        ...baseSnapshot,
        totalMemoryBytes: 7 * 1024 ** 3,
        freeDiskBytes: 8 * 1024 ** 3,
        graphics: [{ name: 'NVIDIA GeForce GTX 1650', driverVersion: '31.0.15.5000' }],
      },
      true,
    );
    expect(findings.map((finding) => finding.code)).toEqual([
      'nvidia-driver',
      'memory-critical',
      'disk-low',
    ]);
  });

  it('Linux glibc 기준과 패키지 런타임 누락을 차단한다', () => {
    const findings = assessPlatform(
      {
        ...baseSnapshot,
        platform: 'linux',
        osVersion: 'Ubuntu 20.04',
        kernelRelease: '5.15.0',
        glibcVersion: '2.31',
        vcRuntime: undefined,
        directXVersion: undefined,
        graphics: [],
        missingRuntimeFiles: ['local-llm/bin/ollama'],
      },
      true,
    );
    expect(findings.map((finding) => finding.code)).toEqual([
      'glibc-version',
      'gpu-undetected',
      'runtime-files',
    ]);
  });
});
