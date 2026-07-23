import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeHwpx } from '@main/kordoc/generate';
import { UserFacingError } from '@main/util/errors';

export interface CreateHwpxFileOptions {
  targetPath: string;
  markdown: string;
  generate?: (markdown: string, targetPath: string) => Promise<void>;
  verify?: (targetPath: string) => Promise<string>;
}

/**
 * Generate one verified HWPX without ever overwriting an existing path.
 *
 * Kordoc writes to a same-directory private candidate first. Parsing that candidate proves the
 * generated container is readable before `link` publishes it atomically with no-replace semantics.
 */
export async function createHwpxFile({
  targetPath,
  markdown,
  generate = generateWithInstalledKordoc,
  verify = verifyWithInstalledKordoc,
}: CreateHwpxFileOptions): Promise<void> {
  if (!markdown.trim()) throw new UserFacingError('내용이 비어 있어 문서를 만들지 않았습니다.');
  if (path.extname(targetPath).toLowerCase() !== '.hwpx') {
    throw new UserFacingError('새 한글 문서는 .hwpx 형식으로만 만들 수 있습니다.');
  }

  const parent = path.dirname(targetPath);
  const candidate = path.join(parent, `.codegate-create-${randomUUID()}.hwpx`);
  try {
    await generate(markdown, candidate);
    const stat = await fs.stat(candidate);
    if (!stat.isFile() || stat.size === 0) {
      throw new UserFacingError('생성된 HWPX 파일이 비어 있습니다.');
    }
    const reparsed = await verify(candidate);
    if (!reparsed.trim()) {
      throw new UserFacingError('생성된 HWPX를 다시 읽어 검증하지 못했습니다.');
    }
    assertReparsedContent(markdown, reparsed);
    try {
      await fs.link(candidate, targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new UserFacingError('같은 이름의 파일이 이미 있습니다.');
      }
      throw error;
    }
  } finally {
    await fs.rm(candidate, { force: true });
  }
}

function assertReparsedContent(expectedMarkdown: string, reparsedMarkdown: string): void {
  const expectedTerms = [
    ...new Set(expectedMarkdown.normalize('NFKC').match(/[0-9A-Za-z가-힣]{2,}/g) ?? []),
  ].slice(0, 32);
  const actual = reparsedMarkdown.normalize('NFKC').toLocaleLowerCase();
  const matched = expectedTerms.filter((term) => actual.includes(term.toLocaleLowerCase())).length;
  if (expectedTerms.length === 0 || matched / expectedTerms.length < 0.8) {
    throw new UserFacingError('생성된 HWPX의 내용이 승인한 미리보기와 일치하지 않습니다.');
  }
}

async function generateWithInstalledKordoc(markdown: string, targetPath: string): Promise<void> {
  await writeHwpx({ targetPath, markdown });
}

async function verifyWithInstalledKordoc(targetPath: string): Promise<string> {
  try {
    const kordoc = (await import('kordoc')) as unknown as {
      parse: (bytes: Uint8Array) => Promise<string | { markdown: string }>;
    };
    const parsed = await kordoc.parse(new Uint8Array(await fs.readFile(targetPath)));
    const markdown = typeof parsed === 'string' ? parsed : parsed.markdown;
    if (typeof markdown !== 'string') {
      throw new Error('Kordoc parse result has no Markdown body');
    }
    return markdown;
  } catch (error) {
    throw new UserFacingError('생성된 HWPX를 실제 Kordoc으로 다시 읽지 못했습니다.', {
      cause: error,
    });
  }
}

export function validatedHwpxBasename(filename: string): string {
  const stem = filename.slice(0, -path.extname(filename).length);
  const windowsReserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  if (
    filename !== path.basename(filename) ||
    path.extname(filename).toLowerCase() !== '.hwpx' ||
    /[\x00-\x1f<>:"/\\|?*]/.test(filename) ||
    !stem.trim() ||
    stem.endsWith('.') ||
    stem.endsWith(' ') ||
    windowsReserved.test(stem)
  ) {
    throw new UserFacingError('생성할 파일명은 폴더 경로 없는 .hwpx 이름이어야 합니다.');
  }
  return filename;
}
