import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  kordocDependencyGraphSha256,
  PINNED_KORDOC_DEPENDENCY_GRAPH_SHA256,
} from '@main/sidecar/kordoc-runtime';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('kordoc runtime attestation', () => {
  it('설치된 kordoc 필수 dependency graph가 검토된 digest와 일치한다', async () => {
    const entry = createRequire(import.meta.url).resolve('kordoc');

    expect(await kordocDependencyGraphSha256(entry)).toBe(
      PINNED_KORDOC_DEPENDENCY_GRAPH_SHA256,
    );
  });

  it('entry와 필수 dependency 파일 변경을 같은 graph hash로 결박한다', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codegate-kordoc-graph-'));
    temporaryRoots.push(root);
    const dependency = path.join(root, 'node_modules', 'fixture-dependency');
    await fs.mkdir(dependency, { recursive: true });
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'fixture-kordoc', version: '1.0.0', dependencies: { 'fixture-dependency': '1.0.0' } }),
    );
    await fs.writeFile(path.join(root, 'index.js'), 'module.exports = require("fixture-dependency");\n');
    await fs.writeFile(
      path.join(dependency, 'package.json'),
      JSON.stringify({ name: 'fixture-dependency', version: '1.0.0', main: 'index.js' }),
    );
    await fs.writeFile(path.join(dependency, 'index.js'), 'module.exports = "before";\n');
    const entry = path.join(root, 'index.js');
    const before = await kordocDependencyGraphSha256(entry);

    await fs.writeFile(path.join(dependency, 'index.js'), 'module.exports = "after";\n');

    expect(await kordocDependencyGraphSha256(entry)).not.toBe(before);
  });
});
