import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const OLLAMA_VERSION = 'v0.30.8';
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, '..');
const buildRoot = path.join(appRoot, 'build');
const cacheRoot = path.join(buildRoot, 'cache', 'ollama', OLLAMA_VERSION);
const runtimeRoot = path.join(buildRoot, 'runtime', 'current', 'local-llm');
const extractRoot = path.join(buildRoot, 'ollama-extract');

const asset = selectAsset();
await fs.rm(runtimeRoot, { recursive: true, force: true });
await fs.mkdir(runtimeRoot, { recursive: true });

if (process.env.CODEGATE_SKIP_OLLAMA_BUNDLE === '1') {
  await fs.writeFile(
    path.join(runtimeRoot, 'BUNDLE_NOT_INCLUDED.txt'),
    'Set CODEGATE_LOCAL_LLM_BASE_URL or install Ollama/LM Studio before running this build.\n',
    'utf8',
  );
  console.warn('[runtime] Ollama bundle skipped by CODEGATE_SKIP_OLLAMA_BUNDLE=1');
  process.exit(0);
}

const archive =
  process.env.CODEGATE_OLLAMA_ARCHIVE ??
  path.join(cacheRoot, asset.filename);
if (!process.env.CODEGATE_OLLAMA_ARCHIVE) {
  await fs.mkdir(cacheRoot, { recursive: true });
  if (!(await checksumMatches(archive, asset.sha256))) {
    await fs.rm(archive, { force: true });
    console.info(`[runtime] downloading Ollama ${OLLAMA_VERSION} (${asset.filename})`);
    await download(asset.url, archive);
  }
}
if (!(await checksumMatches(archive, asset.sha256))) {
  throw new Error(`Ollama archive checksum mismatch: ${archive}`);
}

await fs.rm(extractRoot, { recursive: true, force: true });
await fs.mkdir(extractRoot, { recursive: true });
extractArchive(archive, extractRoot, asset.format);

if (process.platform === 'darwin') {
  const resources = path.join(extractRoot, 'Ollama.app', 'Contents', 'Resources');
  await requireFile(path.join(resources, 'ollama'), 'Ollama macOS CLI');
  await fs.cp(resources, runtimeRoot, { recursive: true, force: true });
} else {
  await fs.cp(extractRoot, runtimeRoot, { recursive: true, force: true });
}

const executable =
  process.platform === 'win32'
    ? path.join(runtimeRoot, 'ollama.exe')
    : process.platform === 'linux'
      ? path.join(runtimeRoot, 'bin', 'ollama')
      : path.join(runtimeRoot, 'ollama');
await requireFile(executable, 'bundled Ollama executable');
if (process.platform !== 'win32') await fs.chmod(executable, 0o755);
validateNativeDependencies(executable);
await fs.writeFile(
  path.join(runtimeRoot, 'FOLDING_OLLAMA_BUILD.txt'),
  [
    `version=${OLLAMA_VERSION}`,
    `asset=${asset.filename}`,
    `sha256=${asset.sha256}`,
    'license=https://github.com/ollama/ollama/blob/main/LICENSE',
    '',
  ].join('\n'),
  'utf8',
);
console.info(`[runtime] Ollama ${OLLAMA_VERSION} -> ${runtimeRoot}`);

function selectAsset() {
  const base = `https://github.com/ollama/ollama/releases/download/${OLLAMA_VERSION}`;
  if (process.platform === 'win32' && process.arch === 'x64') {
    return {
      filename: 'ollama-windows-amd64.zip',
      sha256: 'c2d26d97e698027329c252629d7113bbc05d874b49960cbb03e93a39ae9fd95c',
      url: `${base}/ollama-windows-amd64.zip`,
      format: 'zip',
    };
  }
  if (process.platform === 'win32' && process.arch === 'arm64') {
    return {
      filename: 'ollama-windows-arm64.zip',
      sha256: '487fa170d6eedc3ce12fbf144a39970d8322c4c6efbaa9a366ad7aa8769f5713',
      url: `${base}/ollama-windows-arm64.zip`,
      format: 'zip',
    };
  }
  if (process.platform === 'darwin' && ['x64', 'arm64'].includes(process.arch)) {
    return {
      filename: 'Ollama-darwin.zip',
      sha256: '62a68eacb27dde8d61560fd3bf4c5669c141f5482c5668ce7328420e871088e6',
      url: `${base}/Ollama-darwin.zip`,
      format: 'zip',
    };
  }
  if (process.platform === 'linux' && process.arch === 'x64') {
    return {
      filename: 'ollama-linux-amd64.tar.zst',
      sha256: 'ffe2b2c2f2f5f5b30c081ec353c2e0bb2d9ead516064a8e22663b24b8fd8dca0',
      url: `${base}/ollama-linux-amd64.tar.zst`,
      format: 'tar.zst',
    };
  }
  if (process.platform === 'linux' && process.arch === 'arm64') {
    return {
      filename: 'ollama-linux-arm64.tar.zst',
      sha256: '668a6f934b0b0455128bb4a76c9e50b9e5f274f9dc7710a066b7073e5bd36588',
      url: `${base}/ollama-linux-arm64.tar.zst`,
      format: 'tar.zst',
    };
  }
  throw new Error(`No embedded Ollama asset for ${process.platform}/${process.arch}`);
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Ollama download failed: HTTP ${response.status}`);
  }
  const temporary = `${destination}.download`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
  await fs.rename(temporary, destination);
}

async function checksumMatches(file, expected) {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) return false;
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex') === expected;
}

function extractArchive(archive, destination, format) {
  if (format === 'tar.zst') {
    run('tar', ['--zstd', '-xf', archive, '-C', destination]);
    return;
  }
  if (process.platform === 'win32') {
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Expand-Archive -LiteralPath $env:FOLDING_ARCHIVE -DestinationPath $env:FOLDING_DESTINATION -Force',
      ],
      {
        env: {
          ...process.env,
          FOLDING_ARCHIVE: archive,
          FOLDING_DESTINATION: destination,
        },
        stdio: 'inherit',
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`powershell.exe failed with exit code ${result.status}`);
    }
    return;
  }
  if (process.platform === 'darwin') {
    run('ditto', ['-x', '-k', archive, destination]);
    return;
  }
  run('unzip', ['-q', archive, '-d', destination]);
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit code ${result.status}`);
  }
}

async function requireFile(file, label) {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) throw new Error(`${label} not found: ${file}`);
}

function validateNativeDependencies(file) {
  if (process.platform === 'linux') {
    const result = spawnSync('ldd', [file], { encoding: 'utf8' });
    if (result.error) throw result.error;
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.status !== 0 || /\bnot found\b/i.test(output)) {
      throw new Error(`Bundled Ollama has unresolved Linux dependencies:\n${output}`);
    }
    return;
  }
  if (process.platform === 'darwin') {
    const result = spawnSync('otool', ['-L', file], { encoding: 'utf8' });
    if (result.error) throw result.error;
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.status !== 0) {
      throw new Error(`otool failed for bundled Ollama:\n${output}`);
    }
    const nonPortable = output
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.trim().split(/\s+\(/, 1)[0])
      .filter((library) => library.startsWith('/usr/local/') || library.startsWith('/opt/homebrew/'));
    if (nonPortable.length > 0) {
      throw new Error(`Bundled Ollama has non-portable dependencies: ${nonPortable.join(', ')}`);
    }
  }
}
