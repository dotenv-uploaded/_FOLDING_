import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const command = process.platform === 'win32' ? 'electron-vite.cmd' : 'electron-vite';
const child = spawn(command, ['dev'], {
  cwd: appRoot,
  env: { ...process.env, CODEGATE_MOCK: '1', CODEGATE_AUTH_MODE: 'local' },
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

child.once('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});
