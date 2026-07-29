import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  prepareLlmwikiRuntimeBundle,
  type ServicesOptions,
} from '../src/main/services';
import { validateSidecarRuntimePaths } from '../src/main/sidecar/supervisor';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('LLMWIKI runtime bundle', () => {
  it('copies only runtime inputs outside a selected source tree', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folding-llmwiki-bundle-'));
    temporaryRoots.push(root);
    const resourcesPath = path.join(root, 'selected-source', 'installed-app', 'resources');
    const source = path.join(resourcesPath, 'LLMWIKI');
    const userDataDir = path.join(root, 'user-data');
    await fs.mkdir(path.join(source, 'src'), { recursive: true });
    await fs.mkdir(path.join(source, 'samples', 'input'), { recursive: true });
    await fs.writeFile(path.join(source, 'src', 'provider.py'), 'LOCAL = True\n');
    await fs.writeFile(path.join(source, 'pyproject.toml'), '[project]\nname = "llmwiki"\n');
    await fs.writeFile(path.join(source, 'samples', 'input', 'private.md'), 'exclude me\n');

    const options: ServicesOptions = {
      userDataDir,
      homeDir: root,
      resourcesPath,
      isPackaged: true,
      send: () => undefined,
    };
    const previous = process.env.CODEGATE_LLMWIKI_PROJECT_ROOT;
    delete process.env.CODEGATE_LLMWIKI_PROJECT_ROOT;
    try {
      const destination = await prepareLlmwikiRuntimeBundle(options);

      expect(destination.startsWith(userDataDir)).toBe(true);
      await expect(fs.readFile(path.join(destination, 'src', 'provider.py'), 'utf8')).resolves.toBe(
        'LOCAL = True\n',
      );
      await expect(fs.stat(path.join(destination, 'samples'))).rejects.toThrow();
      await expect(
        validateSidecarRuntimePaths({
          sourceRoot: path.join(root, 'selected-source'),
          llmwikiProjectRoot: destination,
          llmwikiInputRoot: path.join(userDataDir, 'sidecar', 'source-md'),
          llmwikiStorageRoot: path.join(userDataDir, 'sidecar', 'llmwiki-storage'),
          dataRoot: path.join(userDataDir, 'sidecar', 'app-data'),
          deterministicAgent: true,
          claudeAgent: false,
          localLlmBackend: 'auto',
          localLlmModel: 'gemma4:e2b',
          localLlmTimeoutSeconds: 120,
          localLlmContextTokens: 8192,
          localLlmMaxOutputTokens: 2048,
        }),
      ).resolves.toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.CODEGATE_LLMWIKI_PROJECT_ROOT;
      else process.env.CODEGATE_LLMWIKI_PROJECT_ROOT = previous;
    }
  });
});
