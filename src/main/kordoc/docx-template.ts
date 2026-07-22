/**
 * Word 양식을 **플레이스홀더로 채운다.**
 *
 * 왜 이 방식인가
 * -------------
 * 문서를 마크다운으로 파싱해 되먹이는 방식(kordoc patch)은 원본 서식을 잘 지키지만,
 * 표 구조·머리말·개체가 걸린 자리에서 조용히 비껴간다. 양식을 채우는 일에는 그 불확실성이
 * 치명적이다 — 보고서 한 칸이 비어 나가면 그대로 사고다.
 *
 * `{{작성자}}` 처럼 **자리를 미리 표시해 둔 양식**은 그런 모호함이 없다. 어디를 무엇으로
 * 바꿀지 양식이 스스로 선언하므로, 채워졌는지 여부를 확실히 알 수 있다.
 *
 * 원본 양식은 읽기만 한다. 채운 결과는 **새 파일**로 나간다.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { UserFacingError } from '@main/util/errors';

/** 양식 안의 자리 표시 — `{{이름}}` */
const PLACEHOLDER_RE = /\{\{\s*([^}\s][^}]*?)\s*\}\}/g;

/** 이 경로가 다루는 확장자. */
export const DOCX_EXTENSION = '.docx';

export function isDocxTemplate(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === DOCX_EXTENSION;
}

/**
 * 양식이 요구하는 자리 이름을 모은다.
 *
 * 채우기 전에 **무엇을 물어봐야 하는지** 알아야 한다. 이름을 모르면 LLM 에게 무엇을
 * 만들어 달라고 할지도 정할 수 없다.
 */
export function placeholderNames(documentXml: string): string[] {
  const names = new Set<string>();
  PLACEHOLDER_RE.lastIndex = 0;
  for (let m = PLACEHOLDER_RE.exec(documentXml); m !== null; m = PLACEHOLDER_RE.exec(documentXml)) {
    names.add(m[1].trim());
  }
  return [...names];
}

/**
 * docx 는 zip 이다. 안의 `word/document.xml` 에 본문이 들어 있다.
 *
 * Word 가 한 낱말을 여러 조각(run)으로 쪼개 저장하는 일이 흔해서, XML 을 그대로 훑으면
 * `{{작성자}}` 가 `{{작성` + `자}}` 로 갈려 안 잡힐 수 있다. 그래서 태그를 걷어낸
 * **본문 텍스트**에서 자리 이름을 찾는다.
 */
export async function readPlaceholders(templatePath: string): Promise<string[]> {
  if (!isDocxTemplate(templatePath)) {
    throw new UserFacingError('Word 양식(.docx)만 열 수 있습니다.');
  }
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(await fs.readFile(templatePath));
  const xml = await zip.file('word/document.xml')?.async('string');
  if (!xml) throw new UserFacingError('Word 양식에서 본문을 찾지 못했습니다.');
  // 태그를 지워 run 으로 쪼개진 자리 표시를 다시 붙인다.
  return placeholderNames(xml.replace(/<[^>]+>/g, ''));
}

export interface FillDocxOptions {
  templatePath: string;
  /** 자리 이름 → 넣을 값 */
  values: Record<string, string>;
  targetPath: string;
}

/**
 * 양식을 채워 **새 파일**로 저장한다.
 *
 * 채우지 못한 자리가 있으면 조용히 넘어가지 않고 알린다 — 빈 칸이 남은 보고서가
 * 완성본인 척 나가는 것이 가장 나쁘다.
 */
export async function fillDocxTemplate({
  templatePath,
  values,
  targetPath,
}: FillDocxOptions): Promise<{ filled: string[]; missing: string[] }> {
  if (path.resolve(templatePath) === path.resolve(targetPath)) {
    throw new UserFacingError('원본 양식은 덮어쓸 수 없습니다. 다른 이름으로 저장해 주세요.');
  }

  const required = await readPlaceholders(templatePath);
  const filled = required.filter((name) => (values[name] ?? '').trim().length > 0);
  const missing = required.filter((name) => !filled.includes(name));

  const { patchDocument, PatchType, TextRun } = await import('docx');
  const patches = Object.fromEntries(
    required.map((name) => [
      name,
      {
        type: PatchType.PARAGRAPH,
        children: [new TextRun(values[name]?.trim() || '')],
      },
    ]),
  );

  const output = await patchDocument({
    outputType: 'nodebuffer',
    data: await fs.readFile(templatePath),
    patches,
    // 양식의 글꼴·크기·정렬을 그대로 둔다. 값만 갈아끼운다.
    keepOriginalStyles: true,
  });
  await fs.writeFile(targetPath, output as Uint8Array, { flag: 'wx' });
  return { filled, missing };
}
