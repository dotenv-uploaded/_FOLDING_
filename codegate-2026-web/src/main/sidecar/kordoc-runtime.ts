import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from '@main/util/fsx';

interface PackageMetadata {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
}

// kordoc 4.2.5와 pnpm lock에 고정된 필수 dependency 파일 전체의 canonical SHA-256.
// 의존성을 올릴 때는 설치 산출물을 검토한 뒤 이 값도 명시적으로 갱신한다.
export const PINNED_KORDOC_DEPENDENCY_GRAPH_SHA256 =
  'f886b407a9f72d99899ccbafeba9a412b05d117dd31814d86f0a1a6d2f398363';

export async function kordocDependencyGraphSha256(entryPath: string): Promise<string> {
  const roots = await dependencyRoots(entryPath);
  const records: string[] = [];
  for (const root of roots) {
    const metadata = await packageMetadata(root);
    const identity = `${metadata.name}@${metadata.version}`;
    for (const file of await packageFiles(root)) {
      const relative = path.relative(root, file).split(path.sep).join('/');
      records.push(`${identity}\0${relative}\0${sha256(await fs.readFile(file))}\n`);
    }
  }
  return sha256(records.sort().join(''));
}

async function dependencyRoots(entryPath: string): Promise<string[]> {
  const roots = new Set<string>();
  const pending = [await findPackageRoot(entryPath)];
  while (pending.length > 0) {
    const root = await fs.realpath(pending.pop()!);
    if (roots.has(root)) continue;
    const metadata = await packageMetadata(root);
    roots.add(root);
    for (const dependency of Object.keys(metadata.dependencies ?? {}).sort()) {
      pending.push(await resolvePackageDependency(root, dependency));
    }
  }
  return [...roots].sort();
}

async function resolvePackageDependency(packageRoot: string, dependency: string): Promise<string> {
  const searchRoots = [path.join(packageRoot, 'node_modules'), path.dirname(packageRoot)];
  let current = path.dirname(packageRoot);
  while (true) {
    if (path.basename(current) === 'node_modules') searchRoots.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const nodeModules of searchRoots) {
    const candidate = path.join(nodeModules, ...dependency.split('/'));
    const resolved = await fs.realpath(candidate).catch(() => null);
    if (!resolved) continue;
    const metadata = await packageMetadata(resolved).catch(() => null);
    if (metadata?.name === dependency) return resolved;
  }
  throw new Error(`kordoc dependency package not found: ${dependency}`);
}

async function findPackageRoot(entryPath: string, expectedName?: string): Promise<string> {
  let current = path.dirname(path.resolve(entryPath));
  while (true) {
    const metadata = await packageMetadata(current).catch(() => null);
    if (metadata && (!expectedName || metadata.name === expectedName)) {
      return fs.realpath(current);
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`kordoc dependency package root not found: ${entryPath}`);
    current = parent;
  }
}

async function packageMetadata(root: string): Promise<PackageMetadata> {
  const value = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as Partial<PackageMetadata>;
  if (typeof value.name !== 'string' || typeof value.version !== 'string') {
    throw new Error(`invalid package metadata: ${root}`);
  }
  if (value.dependencies !== undefined && (!value.dependencies || typeof value.dependencies !== 'object')) {
    throw new Error(`invalid package dependencies: ${root}`);
  }
  return value as PackageMetadata;
}

async function packageFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && entry.name !== 'node_modules') pending.push(candidate);
      else if (entry.isFile()) files.push(candidate);
    }
  }
  return files.sort();
}
