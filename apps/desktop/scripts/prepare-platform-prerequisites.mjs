import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const WINDOWS_VC_RUNTIME = {
  version: '14.50.35719.0',
  filename: 'vc_redist.x64.exe',
  url: 'https://aka.ms/vs/18/release/14.50.35719/VC_redist.x64.exe',
  sha256: '8995548dfffcde7c49987029c764355612ba6850ee09a7b6f0fddc85bdc5c280',
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, '..');
const runtimeRoot = path.join(appRoot, 'build', 'runtime', 'current', 'prerequisites');
const cacheRoot = path.join(
  appRoot,
  'build',
  'cache',
  'prerequisites',
  'windows',
  WINDOWS_VC_RUNTIME.version,
);

await fs.rm(runtimeRoot, { recursive: true, force: true });
await fs.mkdir(runtimeRoot, { recursive: true });

const manifest = {
  schemaVersion: 1,
  generatedFor: {
    platform: process.platform,
    architecture: process.arch,
  },
  requirements: {
    win32: {
      minimumRelease: '10.0.19045',
      minimumWindowsName: 'Windows 10 22H2',
      architectures: ['x64', 'arm64'],
      directX: 'OS-managed DirectX 12 runtime',
      vcRuntime: WINDOWS_VC_RUNTIME.version,
    },
    darwin: {
      minimumProductVersion: '14.0',
      minimumMacOsName: 'macOS Sonoma',
      architectures: ['x64', 'arm64'],
      graphics: 'OS-managed Metal runtime',
    },
    linux: {
      minimumGlibc: '2.35',
      baselineDistribution: 'Ubuntu 22.04 LTS or equivalent',
      architectures: ['x64', 'arm64'],
      graphics: 'Host-managed NVIDIA, ROCm, or Vulkan driver',
    },
  },
  bundled: [],
};

if (process.platform === 'win32') {
  if (!['x64', 'arm64'].includes(process.arch)) {
    throw new Error(`Unsupported Windows architecture: ${process.arch}`);
  }
  const cached = path.join(cacheRoot, WINDOWS_VC_RUNTIME.filename);
  await fs.mkdir(cacheRoot, { recursive: true });
  if (!(await checksumMatches(cached, WINDOWS_VC_RUNTIME.sha256))) {
    await fs.rm(cached, { force: true });
    console.info(`[runtime] downloading Microsoft VC++ ${WINDOWS_VC_RUNTIME.version}`);
    await download(WINDOWS_VC_RUNTIME.url, cached);
  }
  await requireChecksum(cached, WINDOWS_VC_RUNTIME.sha256);
  verifyMicrosoftSignature(cached);

  const targetDir = path.join(runtimeRoot, 'windows');
  const target = path.join(targetDir, WINDOWS_VC_RUNTIME.filename);
  await fs.mkdir(targetDir, { recursive: true });
  await fs.copyFile(cached, target);
  manifest.bundled.push({
    id: 'microsoft-vc-runtime-x64-arm64',
    version: WINDOWS_VC_RUNTIME.version,
    file: `windows/${WINDOWS_VC_RUNTIME.filename}`,
    sha256: WINDOWS_VC_RUNTIME.sha256,
    source: WINDOWS_VC_RUNTIME.url,
    signature: 'Microsoft Authenticode verified at package build',
  });
}

await fs.writeFile(
  path.join(runtimeRoot, 'platform-runtime.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
);
console.info(`[runtime] platform prerequisites -> ${runtimeRoot}`);

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Prerequisite download failed: HTTP ${response.status}`);
  }
  const temporary = `${destination}.download`;
  await fs.rm(temporary, { force: true });
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
    await fs.rename(temporary, destination);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function checksumMatches(file, expected) {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) return false;
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex') === expected;
}

async function requireChecksum(file, expected) {
  if (!(await checksumMatches(file, expected))) {
    throw new Error(`Prerequisite checksum mismatch: ${file}`);
  }
}

function verifyMicrosoftSignature(file) {
  const command = [
    "$signature = Get-AuthenticodeSignature -LiteralPath $env:FOLDING_PREREQUISITE",
    "$subject = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { '' }",
    "[pscustomobject]@{ Status = [string]$signature.Status; Subject = $subject } | ConvertTo-Json -Compress",
  ].join('; ');
  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
    {
      env: { ...process.env, FOLDING_PREREQUISITE: file },
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Authenticode verification failed with exit code ${result.status}`);
  }
  const signature = JSON.parse(result.stdout.trim());
  if (
    signature.Status !== 'Valid' ||
    !String(signature.Subject).includes('O=Microsoft Corporation')
  ) {
    throw new Error(
      `Prerequisite is not signed by Microsoft: ${signature.Status} ${signature.Subject}`,
    );
  }
}
