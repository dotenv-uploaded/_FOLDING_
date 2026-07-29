import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(appRoot, '..', '..');
const runtimeRoot = path.join(appRoot, 'build', 'runtime', 'current');
const workRoot = path.join(appRoot, 'build', 'pyinstaller');

const projects = [
  {
    name: 'sidecar',
    root: path.join(repoRoot, 'services', 'agent'),
    syncArgs: ['sync', '--group', 'dev'],
    spec: 'codegate-local.spec',
    bundle: 'codegate-local',
    executable: process.platform === 'win32' ? 'codegate-local.exe' : 'codegate-local',
  },
  {
    name: 'doc2md',
    root: path.join(repoRoot, 'services', 'convert', 'services', 'doc2md'),
    syncArgs: ['sync', '--extra', 'packaging'],
    spec: 'doc2md-local.spec',
    bundle: 'doc2md-local',
    executable: process.platform === 'win32' ? 'doc2md-local.exe' : 'doc2md-local',
  },
];

const selectedNames = new Set(
  (process.env.CODEGATE_RUNTIME_COMPONENTS ?? 'sidecar,doc2md')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean),
);
const selectedProjects = projects.filter((project) => selectedNames.has(project.name));
if (selectedProjects.length === 0 || selectedProjects.length !== selectedNames.size) {
  throw new Error(
    `CODEGATE_RUNTIME_COMPONENTS must contain only: ${projects.map(({ name }) => name).join(', ')}`,
  );
}

for (const project of selectedProjects) {
  if (process.env.CODEGATE_SKIP_UV_SYNC !== '1') {
    run('uv', project.syncArgs, project.root);
  }
  const python = path.join(
    project.root,
    '.venv',
    process.platform === 'win32' ? 'Scripts' : 'bin',
    process.platform === 'win32' ? 'python.exe' : 'python',
  );
  await requireFile(python, `${project.name} .venv Python`);
  const distPath = path.join(workRoot, 'dist', project.name);
  const workPath = path.join(workRoot, 'work', project.name);
  await fs.rm(distPath, { recursive: true, force: true });
  await fs.rm(workPath, { recursive: true, force: true });
  run(
    python,
    [
      '-m',
      'PyInstaller',
      '--noconfirm',
      '--clean',
      '--distpath',
      distPath,
      '--workpath',
      workPath,
      path.join(project.root, project.spec),
    ],
    project.root,
  );
  const source = path.join(distPath, project.bundle);
  const target = path.join(runtimeRoot, project.name);
  await requireFile(path.join(source, project.executable), `${project.name} executable`);
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(source, target, { recursive: true, force: true });
  validateNativeDependencies(path.join(target, project.executable));
  console.info(`[runtime] ${project.name} -> ${target}`);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, PYTHONUTF8: '1' },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

async function requireFile(file, label) {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) throw new Error(`${label} not found: ${file}`);
}

function validateNativeDependencies(executable) {
  if (process.platform === 'linux') {
    const result = capture('ldd', [executable]);
    if (/\bnot found\b/i.test(result)) {
      throw new Error(`Unresolved Linux dependency in ${executable}:\n${result}`);
    }
    return;
  }
  if (process.platform === 'darwin') {
    const result = capture('otool', ['-L', executable]);
    const nonPortable = result
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.trim().split(/\s+\(/, 1)[0])
      .filter((library) => library.startsWith('/usr/local/') || library.startsWith('/opt/homebrew/'));
    if (nonPortable.length > 0) {
      throw new Error(
        `Non-portable macOS dependencies in ${executable}: ${nonPortable.join(', ')}`,
      );
    }
  }
}

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}
