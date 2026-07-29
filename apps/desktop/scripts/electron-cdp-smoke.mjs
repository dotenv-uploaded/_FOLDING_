import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.resolve(process.env.CODEGATE_ELECTRON_SMOKE_ROOT ?? path.join(appRoot, '..', '..'));
const profileRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folding-electron-smoke-'));
const screenshotPath = path.join(appRoot, 'build', 'electron-root-registration-smoke.png');
const port = await availablePort();
const executable =
  process.env.CODEGATE_ELECTRON_EXECUTABLE ??
  (process.platform === 'win32'
    ? path.join(appRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
    : path.join(appRoot, 'node_modules', 'electron', 'dist', 'electron'));
if (!process.env.CODEGATE_ELECTRON_EXECUTABLE) {
  const mainEntry = path.join(appRoot, 'out', 'main', 'index.js');
  await fs.access(mainEntry).catch(() => {
    throw new Error(`Electron build output is missing: ${mainEntry}. Run "pnpm build" first.`);
  });
}
const launchArguments = [
  ...(process.env.CODEGATE_ELECTRON_EXECUTABLE ? [] : ['.']),
  `--remote-debugging-port=${port}`,
];
const output = [];
const child = spawn(executable, launchArguments, {
  cwd: appRoot,
  env: {
    ...process.env,
    CODEGATE_USER_DATA_DIR: profileRoot,
    CODEGATE_MOCK: '1',
    CODEGATE_AUTH_MODE: 'local',
    CODEGATE_AGENT_MODE: 'deterministic',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => output.push(chunk));
child.stderr.on('data', (chunk) => output.push(chunk));

try {
  const target = await waitForPage(port, child);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await waitForBridge(cdp, child);
  const expression = `(async () => {
    const rootPath = ${JSON.stringify(sourceRoot)};
    const preview = await window.codegate.roots.scanPreview(rootPath);
    const registered = await window.codegate.roots.add(rootPath);
    const roots = await window.codegate.roots.list();
    const localLlm = await window.codegate.localLlm.setAcceleration('gpu');
    return { previewIncluded: preview.included.length, registered, roots, localLlm };
  })()`;
  const response = await cdp.command('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (response.result?.exceptionDetails) {
    throw new Error(JSON.stringify(response.result.exceptionDetails));
  }
  const result = response.result?.result?.value;
  if (!result?.roots?.some((root) => path.resolve(root.path) === sourceRoot)) {
    throw new Error(`Electron IPC did not register ${sourceRoot}`);
  }
  if (result.localLlm?.model !== 'gemma4:e2b' || result.localLlm?.acceleration !== 'gpu') {
    throw new Error(`Electron local model settings did not persist: ${JSON.stringify(result)}`);
  }
  const bundleModule = path.join(profileRoot, 'sidecar', 'llmwiki-bundle', 'src', 'wiki_builder');
  const bundleStat = await fs.stat(bundleModule).catch(() => null);
  if (!bundleStat?.isDirectory()) {
    throw new Error(`Isolated LLMWIKI runtime bundle is missing: ${bundleModule}`);
  }

  await cdp.command('Page.reload', { ignoreCache: true });
  await waitForBridge(cdp, child);
  await new Promise((resolve) => setTimeout(resolve, 750));
  const settingsResponse = await cdp.command('Runtime.evaluate', {
    expression: `(async () => {
      const settings = await window.codegate.localLlm.settings();
      const settingsButton = document.querySelector('svg.lucide-settings')?.closest('button');
      if (!settingsButton) throw new Error('Settings button is missing after reload');
      settingsButton.click();
      await new Promise((resolve) => setTimeout(resolve, 250));
      const accelerators = Array.from(document.querySelectorAll('button'))
        .map((button) => button.textContent?.trim().toUpperCase())
        .filter((text) => text === 'CPU' || text === 'GPU');
      return { settings, accelerators };
    })()`,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (settingsResponse.result?.exceptionDetails) {
    throw new Error(JSON.stringify(settingsResponse.result.exceptionDetails));
  }
  const reloadedSettings = settingsResponse.result?.result?.value;
  if (
    reloadedSettings?.settings?.acceleration !== 'gpu' ||
    reloadedSettings?.accelerators?.join(',') !== 'CPU,GPU'
  ) {
    throw new Error(
      `Electron local model settings did not survive reload: ${JSON.stringify(reloadedSettings)}`,
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const capture = await cdp.command('Page.captureScreenshot', { format: 'png' });
  await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
  await fs.writeFile(screenshotPath, Buffer.from(capture.result.data, 'base64'));
  console.info(
    JSON.stringify({
      sourceRoot,
      previewIncluded: result.previewIncluded,
      registeredRoot: result.registered.path,
      localLlm: reloadedSettings.settings,
      screenshotPath,
    }),
  );
  cdp.send('Browser.close');
  await waitForExit(child, 30_000);
  cdp.close();
} catch (error) {
  child.kill();
  console.error(output.join(''));
  throw error;
} finally {
  if (child.exitCode === null) child.kill();
  await fs.rm(profileRoot, { recursive: true, force: true }).catch(() => undefined);
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const selected = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (!selected) throw new Error('Could not allocate an Electron debugging port');
  return selected;
}

async function waitForPage(debugPort, process) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(`Electron exited before the renderer was ready (${process.exitCode})`);
    }
    try {
      const targets = await fetch(`http://127.0.0.1:${debugPort}/json`).then((response) =>
        response.json(),
      );
      const page = targets.find((target) => target.type === 'page');
      if (page) return page;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Electron renderer target did not start within 45 seconds');
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const handler = pending.get(message.id);
    if (!handler) return;
    pending.delete(message.id);
    handler(message);
  });
  return {
    command(method, params = {}) {
      const id = ++nextId;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => {
        pending.set(id, (message) =>
          message.error ? reject(new Error(message.error.message)) : resolve(message),
        );
      });
    },
    send(method, params = {}) {
      socket.send(JSON.stringify({ id: ++nextId, method, params }));
    },
    close() {
      socket.close();
    },
  };
}

async function waitForBridge(cdp, process) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(`Electron exited before the preload bridge was ready (${process.exitCode})`);
    }
    const response = await cdp.command('Runtime.evaluate', {
      expression:
        'Boolean(window.codegate?.roots?.scanPreview && window.codegate?.roots?.add && window.codegate?.localLlm?.settings)',
      returnByValue: true,
    });
    if (response.result?.result?.value === true) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Electron preload bridge did not become ready within 45 seconds');
}

async function waitForExit(process, timeoutMs) {
  if (process.exitCode !== null) return;
  await Promise.race([
    new Promise((resolve) => process.once('exit', resolve)),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Electron did not exit cleanly')), timeoutMs),
    ),
  ]);
}
