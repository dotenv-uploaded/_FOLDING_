/**
 * 한글(HWP) 양식을 **셀 단위로 직접 채운다** — rhwp 로.
 *
 * 왜 rhwp 인가 (kordoc 대비)
 * -------------------------
 * kordoc 은 문서를 마크다운으로 바꿔 앵커를 찾아 되먹인다 — 간접적이고, 표가 마크다운으로
 * 접힐 때 어느 칸이 어느 자리였는지 흐려진다. rhwp 는 표의 **논리 셀을 인덱스로 직접**
 * 읽고 쓴다(`getTextInCell`/`insertTextInCell`). "3번 행 2번 열 빈 칸에 이 값" 이 그대로
 * 성립하므로, 양식 채우기처럼 **빈 칸을 하나씩 지목**하는 작업에 정확히 맞는다.
 *
 * 그리고 rhwp 는 **HWP 로 네이티브 저장**한다(`exportHwp`). LibreOffice 는 HWP 로 되돌려
 * 쓰지 못하고(필터 없음), kordoc 은 원본 바이트에 패치하는 방식이다. rhwp 는 문서 객체를
 * 편집해 새 HWP 를 쓴다 — 확장자·표 레이아웃·글꼴이 그대로 유지된다.
 *
 * 원본은 건드리지 않는다
 * --------------------
 * 일일업무일지 같은 문서는 빈 양식을 두고 매번 새 사본을 채운다. 원본을 고치면 다음에 쓸
 * 양식이 사라진다. 그래서 이 경로는 원본을 **읽기만** 하고 채운 결과는 새 파일로 낸다.
 *
 * 채운 뒤 반드시 확인한다
 * --------------------
 * 저장한 파일을 다시 열어 넣은 값이 실제로 들어갔는지 확인한다. "채운 줄 알았는데 비어 있는
 * 보고서"가 나가는 것이 가장 나쁘다. 한 칸이라도 확인에 실패하면 실패로 올린다.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { UserFacingError } from '@main/util/errors';

/** 이 경로가 다루는 확장자. HWPX 는 별도 export API 가 필요해 아직 포함하지 않는다. */
export const RHWP_FILL_EXTENSIONS = ['.hwp'] as const;

export function isHwpTemplate(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === '.hwp';
}

/** 표 한 자리 — 위치와 현재 글자. */
export interface TemplateCell {
  /** rhwp 좌표: 표를 가리키는 (섹션, 상위 문단, 컨트롤) + 셀 인덱스 */
  section: number;
  parentPara: number;
  control: number;
  cellIndex: number;
  /** 셀에 이미 든 글자 (빈 칸이면 '') */
  text: string;
}

/** rhwp WASM 모듈 — 필요한 것만 추린 얇은 타입. */
interface RhwpModule {
  initSync(input: { module: Buffer }): unknown;
  HwpDocument: new (bytes: Uint8Array) => RhwpDocument;
}
interface RhwpDocument {
  getTableDimensions(section: number, para: number, control: number): string;
  getTextInCell(
    section: number,
    para: number,
    control: number,
    cell: number,
    cellPara: number,
    charOffset: number,
    count: number,
  ): string;
  insertTextInCell(
    section: number,
    para: number,
    control: number,
    cell: number,
    cellPara: number,
    charOffset: number,
    text: string,
  ): string;
  exportHwp(): Uint8Array;
}

let cached: RhwpModule | null = null;

/**
 * rhwp 을 로드하고 WASM 을 초기화한다.
 *
 * WASM 은 한 번만 초기화하면 되므로 모듈을 캐시한다. 실패하면 설치 문제이므로 고칠 방법을
 * 말한다 — "실패했습니다" 로 뭉뚱그리지 않는다.
 */
function loadRhwp(): RhwpModule {
  if (cached) return cached;
  const require = createRequire(import.meta.url);
  let mod: RhwpModule;
  try {
    mod = require('@rhwp/core') as RhwpModule;
  } catch (error) {
    throw new UserFacingError(
      '한글 문서를 다루려면 @rhwp/core 가 필요합니다. 설치 상태를 확인해 주세요.',
      { cause: error },
    );
  }
  // WASM 바이너리는 패키지 옆에 있다. require.resolve 로 그 디렉터리를 찾는다.
  const dir = path.dirname(require.resolve('@rhwp/core'));
  const wasm = require('node:fs').readFileSync(path.join(dir, 'rhwp_bg.wasm')) as Buffer;
  mod.initSync({ module: wasm });
  cached = mod;
  return mod;
}

/**
 * 표에서 **빈 칸이 있는 첫 표**를 찾아 셀 목록을 돌려준다.
 *
 * 문서에 표가 여러 개일 수 있으므로 (섹션·문단·컨트롤)을 훑어 처음 나오는 표를 쓴다.
 * 양식은 보통 표 하나가 본문이라 이 규칙으로 충분하다. 표를 못 찾으면 그 사실을 알린다.
 */
export async function readTemplateCells(templatePath: string): Promise<TemplateCell[]> {
  if (!isHwpTemplate(templatePath)) {
    throw new UserFacingError('한글 양식(.hwp)만 채울 수 있습니다.');
  }
  const rhwp = loadRhwp();
  const doc = new rhwp.HwpDocument(new Uint8Array(await fs.readFile(templatePath)));
  const table = findFirstTable(doc);
  if (!table) {
    throw new UserFacingError('양식에서 표를 찾지 못했습니다.');
  }

  const cells: TemplateCell[] = [];
  for (let cellIndex = 0; cellIndex < table.cellCount; cellIndex += 1) {
    let text = '';
    try {
      text = doc.getTextInCell(table.section, table.para, table.control, cellIndex, 0, 0, 9999);
    } catch {
      // 접근할 수 없는 셀(병합으로 가려진 자리)은 빈 칸으로 둔다.
    }
    cells.push({
      section: table.section,
      parentPara: table.para,
      control: table.control,
      cellIndex,
      text: (text ?? '').trim(),
    });
  }
  return cells;
}

interface TableLocation {
  section: number;
  para: number;
  control: number;
  cellCount: number;
}

/** (섹션 0)에서 문단·컨트롤을 훑어 처음 나오는 표를 찾는다. */
function findFirstTable(doc: RhwpDocument): TableLocation | null {
  for (let para = 0; para < 60; para += 1) {
    for (let control = 0; control < 8; control += 1) {
      try {
        const dim = JSON.parse(doc.getTableDimensions(0, para, control)) as {
          cellCount: number;
        };
        if (dim.cellCount > 0) {
          return { section: 0, para, control, cellCount: dim.cellCount };
        }
      } catch {
        // 이 자리에 표가 없다 — 다음으로.
      }
    }
  }
  return null;
}

export interface FillOptions {
  templatePath: string;
  /** 셀 인덱스 → 넣을 값. 빈 칸에만 채운다. */
  values: Map<number, string>;
  targetPath: string;
}

/**
 * 양식을 채워 **새 파일**로 저장한다.
 *
 * 넣은 값을 저장 후 재파싱으로 확인한다. 하나라도 어긋나면 실패로 올린다 — 부분만 채워진
 * 사본을 완성본인 척 남기지 않는다.
 */
export async function fillHwpTemplate({
  templatePath,
  values,
  targetPath,
}: FillOptions): Promise<{ filled: number[]; skipped: number[] }> {
  if (path.resolve(templatePath) === path.resolve(targetPath)) {
    throw new UserFacingError('원본 양식은 덮어쓸 수 없습니다. 다른 이름으로 저장해 주세요.');
  }
  const rhwp = loadRhwp();
  const doc = new rhwp.HwpDocument(new Uint8Array(await fs.readFile(templatePath)));
  const table = findFirstTable(doc);
  if (!table) {
    throw new UserFacingError('양식에서 표를 찾지 못했습니다.');
  }

  const filled: number[] = [];
  const skipped: number[] = [];
  for (const [cellIndex, value] of values) {
    const text = value.trim();
    if (!text) continue;
    try {
      doc.insertTextInCell(table.section, table.para, table.control, cellIndex, 0, 0, text);
      filled.push(cellIndex);
    } catch {
      skipped.push(cellIndex);
    }
  }

  const output = doc.exportHwp();
  await fs.writeFile(targetPath, Buffer.from(output), { flag: 'wx' });

  // 저장한 파일을 다시 열어 실제로 들어갔는지 확인한다.
  const verify = new rhwp.HwpDocument(new Uint8Array(await fs.readFile(targetPath)));
  const vt = findFirstTable(verify);
  const unverified: number[] = [];
  for (const cellIndex of filled) {
    const expected = (values.get(cellIndex) ?? '').trim();
    let actual = '';
    try {
      actual = verify.getTextInCell(vt!.section, vt!.para, vt!.control, cellIndex, 0, 0, 9999) ?? '';
    } catch {
      /* 확인 실패 */
    }
    if (!actual.includes(expected)) unverified.push(cellIndex);
  }
  if (unverified.length > 0) {
    // 저장은 됐는데 값이 안 들어간 칸이 있다 — 완성본인 척 남기지 않는다.
    await fs.rm(targetPath, { force: true });
    throw new UserFacingError(
      `채운 값이 저장되지 않은 칸이 있습니다 (${unverified.length}곳). 양식을 확인해 주세요.`,
    );
  }

  return { filled, skipped };
}
