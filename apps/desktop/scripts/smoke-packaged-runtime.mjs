#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = path.join(projectDir, 'build', 'runtime', 'current');
const executableSuffix = process.platform === 'win32' ? '.exe' : '';

process.env.CODEGATE_SIDECAR_BIN = path.join(
  runtimeRoot,
  'sidecar',
  `codegate-local${executableSuffix}`,
);
process.env.CODEGATE_DOC2MD_BIN = path.join(
  runtimeRoot,
  'doc2md',
  `doc2md-local${executableSuffix}`,
);

await import('./smoke-integrations.mjs');
