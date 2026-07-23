#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceDir = path.resolve(projectDir, '..');
// 설정 파일은 `.env` 하나뿐이다 — Electron 메인도 같은 파일을 읽는다(src/main/env.ts).
const envFile = path.join(projectDir, '.env');
if (existsSync(envFile)) loadEnvFile(envFile);
const doc2mdRoot =
  process.env.CODEGATE_DOC2MD_PROJECT_ROOT ??
  path.join(workspaceDir, 'codegate-2026-api', 'services', 'doc2md');
const configuredPython = process.env.CODEGATE_DOC2MD_PYTHON;
const command = configuredPython ?? 'uv';
const prefix = configuredPython
  ? []
  : ['run', '--isolated', '--python', '3.12', '--project', doc2mdRoot, 'python'];
const children = [];
let cleanupPromise = null;
const cleanup = () => (cleanupPromise ??= Promise.all([...children].reverse().map(stop)));
const removeSignalHandlers = installSignalCleanup(cleanup);

try {
  const port = await allocatePort();
  const doc2mdUrl = `http://127.0.0.1:${port}`;
  const doc2md = start(command, [...prefix, '-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: doc2mdRoot,
    env: safeProcessEnvironment(process.env),
    name: 'doc2md',
  });
  children.push(doc2md);
  // 개발 UI는 먼저 띄운다. 무거운 OCR 초기화는 최초 background conversion에서 진행률과 함께 돈다.
  // release 성격의 integrations:smoke는 별도로 deep health를 끝까지 검증한다.
  await waitForHealth(`${doc2mdUrl}/health`, doc2md);

  /*
   * OAuth 백엔드(cloud-api)도 이 스택이 함께 띄운다.
   *
   * 예전에는 사람이 따로 띄워 두는 프로세스였다. 그래서 스택을 재기동할 때마다 조용히
   * 사라졌고, 앱은 멀쩡한데 **로그인만 안 되는** 상태가 반복됐다. 원인은 언제나
   * `ECONNREFUSED 127.0.0.1:8000` 이었는데, 그걸 알아내는 데 매번 왕복이 들었다.
   *
   * 설정이 없으면 조용히 건너뛴다 — cloud-api 없이 도는 구성(로컬 인증 모드)도 있다.
   */
  const cloudApiBin = process.env.CODEGATE_CLOUD_API_BIN;
  if (cloudApiBin && existsSync(cloudApiBin)) {
    // 실행 파일은 `<root>/.venv/bin/<name>` 에 있다 — root 는 세 단계 위다. cloud-api 는
    // 자기 `.env` 를 cwd 에서 읽으므로 여기를 틀리면 설정을 통째로 못 읽고 죽는다.
    const cloudApiRoot =
      process.env.CODEGATE_CLOUD_API_ROOT ??
      path.dirname(path.dirname(path.dirname(cloudApiBin)));
    /*
     * **cloud-api 가 죽어도 스택은 산다.**
     *
     * 이건 로그인을 위한 보조 서비스지 앱의 심장이 아니다. 그런데 `waitForHealth` 로
     * 임계 경로에 묶었더니, cloud-api 하나가 설정 오류로 못 뜨자 doc2md 와 Electron 까지
     * 통째로 내려갔다. 보조 서비스의 실패가 전부를 멈추게 하면 안 된다.
     */
    try {
      const cloudApi = start(cloudApiBin, [], {
        cwd: cloudApiRoot,
        env: safeProcessEnvironment(process.env),
        name: 'cloud-api',
      });
      children.push(cloudApi);
      await waitForHealth('http://127.0.0.1:8000/api/v1/health', cloudApi);
    } catch (error) {
      console.warn(
        `[codegate:dev] cloud-api 를 띄우지 못했습니다 — Google 로그인만 실패합니다: ${error.message}`,
      );
    }
  } else if (process.env.CODEGATE_AUTH_MODE === 'cloud') {
    // 클라우드 인증을 쓰겠다고 해놓고 백엔드가 없으면 로그인만 조용히 실패한다. 미리 말한다.
    console.warn(
      '[codegate:dev] CODEGATE_AUTH_MODE=cloud 인데 CODEGATE_CLOUD_API_BIN 이 없습니다 — ' +
        'Google 로그인이 실패합니다. cloud-api 를 따로 띄우거나 이 변수를 설정하세요.',
    );
  }

  // 로컬 바이너리를 직접 부른다. `pnpm exec` 를 거치면 packageManager 핀이 맞지 않는
  // 컴퓨터에서 pnpm 이 버전 전환을 시도하다 죽고, 그 실패가 "electron 종료 코드 1" 로만
  // 보여 원인을 찾기 어려웠다. 중간 단계를 없애면 그런 실패가 아예 생기지 않는다.
  const electronVite = path.join(
    projectDir,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'electron-vite.cmd' : 'electron-vite',
  );
  const electron = start(electronVite, ['dev'], {
    cwd: projectDir,
    env: { ...process.env, CODEGATE_DOC2MD_URL: doc2mdUrl },
    name: 'electron',
    stdio: 'inherit',
  });
  children.push(electron);
  await waitForExit(electron);
} finally {
  removeSignalHandlers();
  await cleanup();
}

function start(command, args, { cwd, env, name, stdio = ['ignore', 'inherit', 'inherit'] }) {
  const child = spawn(command, args, { cwd, env, stdio, detached: process.platform !== 'win32' });
  const tracked = { child, name, spawnError: null };
  child.once('error', (error) => {
    tracked.spawnError = error;
  });
  return tracked;
}

function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('doc2md용 loopback port를 할당하지 못했습니다.'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function waitForHealth(url, tracked) {
  const deadline = Date.now() + 30_000;
  let lastError = '응답 없음';
  while (Date.now() < deadline) {
    if (tracked.spawnError) throw tracked.spawnError;
    if (tracked.child.exitCode !== null || tracked.child.signalCode !== null) {
      throw new Error(`${tracked.name} process가 준비되기 전에 종료됐습니다.`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      const payload = await response.json();
      if (response.ok && payload.status === 'ok') return;
      lastError = `HTTP ${response.status}: ${JSON.stringify(payload)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }
  throw new Error(`doc2md 준비 시간이 초과됐습니다: ${lastError}`);
}

function waitForExit(tracked) {
  return new Promise((resolve, reject) => {
    if (tracked.spawnError) {
      reject(tracked.spawnError);
      return;
    }
    if (tracked.child.exitCode !== null) {
      if (tracked.child.exitCode === 0) resolve();
      else reject(new Error(`${tracked.name} process가 종료 코드 ${tracked.child.exitCode}로 끝났습니다.`));
      return;
    }
    tracked.child.once('error', reject);
    tracked.child.once('exit', (code, signal) => {
      if (signal === 'SIGINT' || signal === 'SIGTERM' || code === 0) resolve();
      else reject(new Error(`${tracked.name} process가 종료 코드 ${code ?? signal}로 끝났습니다.`));
    });
  });
}

function safeProcessEnvironment(baseEnv) {
  const safe = {};
  for (const name of [
    'PATH',
    'Path',
    'PATHEXT',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'HOME',
    'USERPROFILE',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'TZ',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'UV_CACHE_DIR',
    'XDG_CACHE_HOME',
    // doc2md 가 한글 본문을 kordoc 으로 읽는 데 쓴다. 이게 안 넘어가면 대체 변환기로
    // 내려가고, 병합된 표의 내용이 빠진 채 변환된다 (경고는 남지만 내용은 이미 없다).
    'CODEGATE_KORDOC_DIR',
  ]) {
    if (baseEnv[name] !== undefined) safe[name] = baseEnv[name];
  }
  return safe;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stop({ child }) {
  if (!processTreeRunning(child)) return;
  await signalProcessTree(child, 'SIGTERM');
  if (await waitForProcessTreeExit(child, 5_000)) return;
  await signalProcessTree(child, 'SIGKILL');
  if (!(await waitForProcessTreeExit(child, 5_000))) {
    throw new Error(`process tree ${child.pid ?? 'unknown'}를 종료하지 못했습니다.`);
  }
}

async function waitForProcessTreeExit(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processTreeRunning(child)) return true;
    await delay(100);
  }
  return !processTreeRunning(child);
}

function processTreeRunning(child) {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      return error?.code !== 'ESRCH';
    }
  }
  return child.exitCode === null && child.signalCode === null;
}

async function signalProcessTree(child, signal) {
  if (!child.pid) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      try {
        child.kill(signal);
      } catch {
        return;
      }
    }
    return;
  }
  await new Promise((resolve) => {
    const args = ['/pid', String(child.pid), '/t'];
    if (signal === 'SIGKILL') args.push('/f');
    const killer = spawn('taskkill.exe', args, {
      stdio: 'ignore',
    });
    killer.once('error', () => resolve());
    killer.once('exit', () => resolve());
  }).catch(() => undefined);
}

function installSignalCleanup(cleanupAction) {
  const handlers = new Map();
  for (const [signal, exitCode] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ]) {
    const handler = () => {
      void cleanupAction().finally(() => process.exit(exitCode));
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
}
