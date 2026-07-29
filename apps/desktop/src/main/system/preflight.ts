import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GIB = 1024 ** 3;

export type PreflightSeverity = 'error' | 'warning' | 'info';

export interface PreflightFinding {
  severity: PreflightSeverity;
  code: string;
  message: string;
  remediation?: string;
}

export interface GraphicsAdapter {
  name: string;
  driverVersion?: string;
}

export interface PlatformSnapshot {
  platform: NodeJS.Platform;
  architecture: string;
  osVersion: string;
  kernelRelease: string;
  totalMemoryBytes: number;
  freeDiskBytes?: number;
  glibcVersion?: string;
  vcRuntime?: {
    installed: boolean;
    version?: string;
  };
  directXVersion?: string;
  graphics: GraphicsAdapter[];
  missingRuntimeFiles: string[];
}

export interface PlatformPreflightReport {
  schemaVersion: 1;
  checkedAt: string;
  snapshot: PlatformSnapshot;
  findings: PreflightFinding[];
}

export interface PlatformPreflightOptions {
  userDataDir: string;
  resourcesPath: string;
  isPackaged: boolean;
  systemVersion: string;
}

export async function runPlatformPreflight(
  options: PlatformPreflightOptions,
): Promise<PlatformPreflightReport> {
  await fs.mkdir(options.userDataDir, { recursive: true });
  const snapshot = await collectPlatformSnapshot(options);
  const report: PlatformPreflightReport = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    snapshot,
    findings: assessPlatform(snapshot, options.isPackaged),
  };
  await fs.writeFile(
    path.join(options.userDataDir, 'runtime-diagnostics.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  return report;
}

export function assessPlatform(
  snapshot: PlatformSnapshot,
  isPackaged: boolean,
): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  if (!['win32', 'darwin', 'linux'].includes(snapshot.platform)) {
    findings.push({
      severity: 'error',
      code: 'unsupported-os',
      message: `지원하지 않는 운영체제입니다: ${snapshot.platform}`,
    });
  }
  if (!['x64', 'arm64'].includes(snapshot.architecture)) {
    findings.push({
      severity: 'error',
      code: 'unsupported-architecture',
      message: `지원하지 않는 CPU 아키텍처입니다: ${snapshot.architecture}`,
    });
  }

  if (snapshot.platform === 'win32') {
    const [, , build = 0] = versionParts(snapshot.kernelRelease);
    if (build < 19_045) {
      findings.push({
        severity: 'error',
        code: 'windows-version',
        message: 'Windows 10 22H2 이상이 필요합니다.',
        remediation: 'Windows Update를 완료한 뒤 다시 설치하십시오.',
      });
    }
    if (isPackaged && !snapshot.vcRuntime?.installed) {
      findings.push({
        severity: 'error',
        code: 'vc-runtime',
        message: 'Microsoft Visual C++ Runtime 설치가 완료되지 않았습니다.',
        remediation: 'Folding 설치 파일을 다시 실행하고 관리자 권한 요청을 승인하십시오.',
      });
    }
    if (!snapshot.directXVersion) {
      findings.push({
        severity: 'warning',
        code: 'directx-undetected',
        message: 'Windows DirectX 런타임 정보를 확인하지 못했습니다. CPU 추론으로 폴백할 수 있습니다.',
        remediation: 'Windows Update와 그래픽 드라이버 업데이트를 적용하십시오.',
      });
    }
    for (const adapter of snapshot.graphics) {
      const driver = nvidiaDisplayDriver(adapter);
      if (driver !== undefined && driver < 551.61) {
        findings.push({
          severity: 'warning',
          code: 'nvidia-driver',
          message: `${adapter.name} 드라이버 ${driver.toFixed(2)}는 GPU 추론 기준보다 낮습니다.`,
          remediation: 'NVIDIA 551.61 이상 드라이버로 업데이트하거나 CPU 추론을 사용하십시오.',
        });
      }
    }
  } else if (snapshot.platform === 'darwin') {
    if (versionParts(snapshot.osVersion)[0] < 14) {
      findings.push({
        severity: 'error',
        code: 'macos-version',
        message: 'macOS Sonoma 14 이상이 필요합니다.',
        remediation: 'macOS를 업데이트한 뒤 다시 설치하십시오.',
      });
    }
    if (snapshot.architecture === 'x64') {
      findings.push({
        severity: 'info',
        code: 'mac-intel-cpu',
        message: 'Intel Mac에서는 Ollama가 CPU 추론을 사용합니다.',
      });
    }
  } else if (
    snapshot.platform === 'linux' &&
    snapshot.glibcVersion &&
    compareVersions(snapshot.glibcVersion, '2.35') < 0
  ) {
    findings.push({
      severity: 'error',
      code: 'glibc-version',
      message: `glibc ${snapshot.glibcVersion}은 지원 기준 2.35보다 낮습니다.`,
      remediation: 'Ubuntu 22.04 LTS 이상 또는 동등한 배포판으로 업데이트하십시오.',
    });
  }

  if (snapshot.totalMemoryBytes < 8 * GIB) {
    findings.push({
      severity: 'warning',
      code: 'memory-critical',
      message: `메모리가 ${formatGib(snapshot.totalMemoryBytes)}로 매우 적어 Gemma4가 느리거나 시작되지 않을 수 있습니다.`,
      remediation: '다른 앱을 종료하고 더 작은 로컬 모델 또는 상용 API 모드를 사용하십시오.',
    });
  } else if (snapshot.totalMemoryBytes < 16 * GIB) {
    findings.push({
      severity: 'warning',
      code: 'memory-low',
      message: `메모리가 ${formatGib(snapshot.totalMemoryBytes)}입니다. 16 GB 이상을 권장합니다.`,
    });
  }

  if (snapshot.freeDiskBytes !== undefined && snapshot.freeDiskBytes < 12 * GIB) {
    findings.push({
      severity: 'warning',
      code: 'disk-low',
      message: `모델 저장소의 남은 공간이 ${formatGib(snapshot.freeDiskBytes)}입니다.`,
      remediation: 'Gemma4 e2b 최초 다운로드를 위해 최소 12 GB를 확보하십시오.',
    });
  }

  if (
    ['win32', 'linux'].includes(snapshot.platform) &&
    snapshot.graphics.length === 0
  ) {
    findings.push({
      severity: 'info',
      code: 'gpu-undetected',
      message: '지원 GPU를 확인하지 못해 Ollama가 CPU 추론을 사용할 수 있습니다.',
    });
  }

  if (isPackaged && snapshot.missingRuntimeFiles.length > 0) {
    findings.push({
      severity: 'error',
      code: 'runtime-files',
      message: `설치 파일에서 필수 런타임이 누락되었습니다: ${snapshot.missingRuntimeFiles.join(', ')}`,
      remediation: '설치 파일을 다시 내려받아 재설치하십시오.',
    });
  }
  return findings;
}

export function blockingPreflightMessage(report: PlatformPreflightReport): string | null {
  const errors = report.findings.filter((finding) => finding.severity === 'error');
  if (errors.length === 0) return null;
  return errors
    .map((finding) =>
      finding.remediation
        ? `${finding.message}\n${finding.remediation}`
        : finding.message,
    )
    .join('\n\n');
}

async function collectPlatformSnapshot(
  options: PlatformPreflightOptions,
): Promise<PlatformSnapshot> {
  const freeDiskBytes = await freeDiskSpace(options.userDataDir);
  const missingRuntimeFiles = options.isPackaged
    ? await missingPackagedRuntimeFiles(options.resourcesPath)
    : [];
  const windows =
    process.platform === 'win32' ? await windowsRuntimeDetails() : undefined;
  return {
    platform: process.platform,
    architecture: process.arch,
    osVersion: options.systemVersion,
    kernelRelease: os.release(),
    totalMemoryBytes: os.totalmem(),
    freeDiskBytes,
    glibcVersion: glibcRuntimeVersion(),
    vcRuntime: windows?.vcRuntime,
    directXVersion: windows?.directXVersion,
    graphics: windows?.graphics ?? [],
    missingRuntimeFiles,
  };
}

async function freeDiskSpace(directory: string): Promise<number | undefined> {
  const stats = await fs.statfs(directory).catch(() => null);
  return stats ? Number(stats.bavail) * Number(stats.bsize) : undefined;
}

async function missingPackagedRuntimeFiles(resourcesPath: string): Promise<string[]> {
  const executable = process.platform === 'win32' ? '.exe' : '';
  const ollama =
    process.platform === 'linux'
      ? path.join('local-llm', 'bin', 'ollama')
      : path.join('local-llm', `ollama${executable}`);
  const files = [
    path.join('sidecar', `codegate-local${executable}`),
    path.join('doc2md', `doc2md-local${executable}`),
    ollama,
    path.join('LLMWIKI', 'pyproject.toml'),
    path.join('prerequisites', 'platform-runtime.json'),
    path.join('app.asar.unpacked', 'node_modules', 'kordoc', 'package.json'),
    path.join(
      'app.asar.unpacked',
      'node_modules',
      '@rhwp',
      'core',
      'rhwp_bg.wasm',
    ),
    path.join(
      'app.asar.unpacked',
      'node_modules',
      'better-sqlite3',
      'build',
      'Release',
      'better_sqlite3.node',
    ),
  ];
  const results = await Promise.all(
    files.map(async (relative) => ({
      relative,
      exists: Boolean(await fs.stat(path.join(resourcesPath, relative)).catch(() => null)),
    })),
  );
  return results.filter((result) => !result.exists).map((result) => result.relative);
}

async function windowsRuntimeDetails(): Promise<{
  vcRuntime: { installed: boolean; version?: string };
  directXVersion?: string;
  graphics: GraphicsAdapter[];
}> {
  const script = [
    "$vc = Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64' -ErrorAction SilentlyContinue",
    "$dx = Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\DirectX' -ErrorAction SilentlyContinue",
    '$gpu = @(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Select-Object Name, DriverVersion)',
    "[pscustomobject]@{ VcInstalled = [bool]($vc.Installed -eq 1); VcVersion = [string]$vc.Version; DirectXVersion = [string]$dx.Version; Graphics = $gpu } | ConvertTo-Json -Depth 4 -Compress",
  ].join('; ');
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout: 15_000, windowsHide: true },
    );
    const payload = JSON.parse(stdout.trim()) as {
      VcInstalled?: boolean;
      VcVersion?: string;
      DirectXVersion?: string;
      Graphics?: { Name?: string; DriverVersion?: string } | Array<{
        Name?: string;
        DriverVersion?: string;
      }>;
    };
    const graphics = Array.isArray(payload.Graphics)
      ? payload.Graphics
      : payload.Graphics
        ? [payload.Graphics]
        : [];
    return {
      vcRuntime: {
        installed: payload.VcInstalled === true,
        version: payload.VcVersion || undefined,
      },
      directXVersion: payload.DirectXVersion || undefined,
      graphics: graphics
        .filter((adapter) => Boolean(adapter.Name))
        .map((adapter) => ({
          name: adapter.Name ?? 'Unknown GPU',
          driverVersion: adapter.DriverVersion || undefined,
        })),
    };
  } catch {
    return { vcRuntime: { installed: false }, graphics: [] };
  }
}

function glibcRuntimeVersion(): string | undefined {
  if (process.platform !== 'linux') return undefined;
  const report = process.report?.getReport() as {
    header?: { glibcVersionRuntime?: string };
  };
  return report.header?.glibcVersionRuntime;
}

function nvidiaDisplayDriver(adapter: GraphicsAdapter): number | undefined {
  if (!/nvidia/i.test(adapter.name) || !adapter.driverVersion) return undefined;
  const parts = adapter.driverVersion.split('.');
  if (parts.length >= 4) {
    const encoded = `${parts.at(-2)}${parts.at(-1)}`.replace(/\D/g, '');
    const lastFive = encoded.slice(-5);
    if (lastFive.length === 5) return Number(lastFive) / 100;
  }
  const direct = Number.parseFloat(adapter.driverVersion);
  return Number.isFinite(direct) ? direct : undefined;
}

function compareVersions(left: string, right: string): number {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function versionParts(version: string): number[] {
  return version
    .replace(/^[^\d]*/, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

function formatGib(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GB`;
}
