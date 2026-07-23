import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHwpxFile, validatedHwpxBasename } from '@main/kordoc/create';

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'codegate-create-hwpx-'));
}

function fakeGenerate(markdown: string, outPath: string): Promise<void> {
  return fs.writeFile(outPath, `hwpx:${markdown}`).then(() => undefined);
}

describe('approved HWPX creation', () => {
  it('creates and reparses a real HWPX with the installed Kordoc runtime', async () => {
    const dir = await tempDir();
    const target = path.join(dir, '실제주간업무보고서.hwpx');

    await createHwpxFile({
      targetPath: target,
      markdown: '# 주간업무보고서\n\n| 구분 | 내용 |\n| --- | --- |\n| 완료 | 실제 생성 검증 |',
    });

    const bytes = await fs.readFile(target);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(bytes.subarray(0, 2).toString()).toBe('PK');
  }, 300_000);

  it('publishes a reparsed candidate to a new path', async () => {
    const dir = await tempDir();
    const target = path.join(dir, '주간업무보고서.hwpx');

    await createHwpxFile({
      targetPath: target,
      markdown: '# 주간업무',
      generate: fakeGenerate,
      verify: async () => '# 주간업무',
    });

    expect(await fs.readFile(target, 'utf8')).toBe('hwpx:# 주간업무');
    expect((await fs.readdir(dir)).filter((name) => name.startsWith('.codegate-create-'))).toEqual(
      [],
    );
  });

  it('never overwrites an existing file', async () => {
    const dir = await tempDir();
    const target = path.join(dir, '주간업무보고서.hwpx');
    await fs.writeFile(target, 'original');

    await expect(
      createHwpxFile({
        targetPath: target,
        markdown: '# 새 내용',
        generate: fakeGenerate,
        verify: async () => '# 새 내용',
      }),
    ).rejects.toThrow(/이미 있습니다/);
    expect(await fs.readFile(target, 'utf8')).toBe('original');
  });

  it('rejects an unreadable generated candidate before publication', async () => {
    const dir = await tempDir();
    const target = path.join(dir, '주간업무보고서.hwpx');

    await expect(
      createHwpxFile({
        targetPath: target,
        markdown: '# 새 내용',
        generate: fakeGenerate,
        verify: async () => ' ',
      }),
    ).rejects.toThrow(/다시 읽어/);
    await expect(fs.access(target)).rejects.toThrow();
  });

  it('rejects a readable HWPX whose content differs from the approved preview', async () => {
    const dir = await tempDir();
    const target = path.join(dir, '주간업무보고서.hwpx');

    await expect(
      createHwpxFile({
        targetPath: target,
        markdown: '# 주간업무보고서\n\n- 승인한 내용',
        generate: fakeGenerate,
        verify: async () => '# 완전히 다른 문서\n\n- 다른 결과',
      }),
    ).rejects.toThrow(/미리보기와 일치하지 않습니다/);
    await expect(fs.access(target)).rejects.toThrow();
  });

  it('accepts only a basename with the HWPX extension', () => {
    expect(validatedHwpxBasename('주간업무보고서.hwpx')).toBe('주간업무보고서.hwpx');
    expect(() => validatedHwpxBasename('../주간업무보고서.hwpx')).toThrow(/폴더 경로 없는/);
    expect(() => validatedHwpxBasename('주간업무보고서.hwp')).toThrow(/\.hwpx/);
    expect(() => validatedHwpxBasename('..hwpx')).toThrow(/폴더 경로 없는/);
    expect(() => validatedHwpxBasename('CON.hwpx')).toThrow(/폴더 경로 없는/);
  });
});
