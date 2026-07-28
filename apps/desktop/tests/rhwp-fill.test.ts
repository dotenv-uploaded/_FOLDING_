import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fillHwpTemplate, isHwpTemplate, readTemplateCells } from '@main/rhwp/fill';

/**
 * rhwp 로 한글 양식을 셀 단위로 채운다.
 *
 * 여기가 kordoc 대비 rhwp 의 이점을 지키는 곳이다 — **빈 칸을 인덱스로 직접 채우고,
 * 저장한 파일을 다시 열어 값이 실제로 들어갔는지 확인한다.** 진짜 rhwp WASM 과 진짜
 * 파일을 쓴다(목이 아니다). rhwp 미설치 환경에서는 건너뛴다.
 */
const TEMPLATE = '/Users/jeong-uchang/Downloads/[시연]업무기록/일일업무.hwp';

const enabled = await fs
  .access(TEMPLATE)
  .then(() => true)
  .catch(() => false);

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((f) => fs.rm(f, { recursive: true, force: true })));
});

async function copyTemplate(): Promise<{ src: string; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-fill-'));
  temporary.push(dir);
  const src = path.join(dir, 'src.hwp');
  await fs.copyFile(TEMPLATE, src);
  return { src, dir };
}

describe.skipIf(!enabled)('rhwp HWP 양식 채우기', () => {
  it('확장자를 가린다', () => {
    expect(isHwpTemplate('/a/일일업무.hwp')).toBe(true);
    expect(isHwpTemplate('/a/양식.docx')).toBe(false);
    expect(isHwpTemplate('/a/문서.hwpx')).toBe(false); // export API 가 아직 없어 제외
  });

  it('표의 셀을 읽어 빈 칸과 채워진 칸을 구분한다', async () => {
    const { src } = await copyTemplate();
    const cells = await readTemplateCells(src);
    const filled = cells.filter((c) => c.text);
    const empty = cells.filter((c) => !c.text);
    // 일일업무.hwp 는 22x7 표, 논리셀 50개 — 라벨은 차 있고 입력란은 비어 있다.
    expect(cells.length).toBeGreaterThan(40);
    expect(filled.some((c) => c.text.includes('보고번호'))).toBe(true);
    expect(empty.length).toBeGreaterThan(10);
  });

  it('빈 칸을 채워 새 파일로 저장하고, 재파싱으로 값이 들어갔음을 확인한다', async () => {
    const { src, dir } = await copyTemplate();
    const before = await fs.readFile(src);
    const cells = await readTemplateCells(src);
    const target = path.join(dir, '채운본.hwp');

    // 빈 칸 두 곳을 고른다.
    const empties = cells.filter((c) => !c.text).slice(0, 2);
    const values = new Map<number, string>([
      [empties[0]!.cellIndex, '금일 업무 내용 확인'],
      [empties[1]!.cellIndex, '명일 업무 계획 확인'],
    ]);

    const result = await fillHwpTemplate({ templatePath: src, values, targetPath: target });
    expect(result.filled).toHaveLength(2);

    // 원본은 바이트 단위로 그대로다.
    expect(await fs.readFile(src)).toEqual(before);

    // 저장본을 새로 읽어 값이 실제로 들어갔는지 본다.
    const reparsed = await readTemplateCells(target);
    const byIndex = new Map(reparsed.map((c) => [c.cellIndex, c.text]));
    expect(byIndex.get(empties[0]!.cellIndex)).toContain('금일 업무 내용 확인');
    expect(byIndex.get(empties[1]!.cellIndex)).toContain('명일 업무 계획 확인');
  });

  it('원본과 같은 경로로 저장하려 하면 막는다', async () => {
    const { src } = await copyTemplate();
    await expect(
      fillHwpTemplate({ templatePath: src, values: new Map(), targetPath: src }),
    ).rejects.toThrow('덮어쓸 수 없습니다');
  });
});
