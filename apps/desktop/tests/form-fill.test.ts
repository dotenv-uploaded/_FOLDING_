import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isFormFillRequest, loadSourceDocuments } from '@main/agent/form-fill';
import { placeholderNames } from '@main/kordoc/docx-template';

/**
 * 양식 채우기 요청을 가려내는 문지기.
 *
 * 이 판정이 헐거우면 **평범한 질문까지 가로채** 문서 검색 대신 양식을 채우려 든다.
 * 반대로 너무 좁으면 시연에서 아무 일도 일어나지 않는다. 양쪽을 다 고정한다.
 */
describe('isFormFillRequest', () => {
  it('양식을 채워 달라는 말을 알아본다', () => {
    for (const text of [
      '일일업무보고 양식 채워줘',
      '업무일지 양식에 오늘 내용 작성해줘',
      '보고서 템플릿 채워주세요',
      '일일 업무 보고 만들어줘',
    ]) {
      expect(isFormFillRequest(text), text).toBe(true);
    }
  });

  it('평범한 질문을 가로채지 않는다', () => {
    for (const text of [
      '사업계획서의 콜라겐 주장 근거가 뭐야?',
      '지난달 제출한 신청서 요약해줘',
      '이 문서 어디에 저장돼 있어?',
      '계약서에서 대금 지급 조건 알려줘',
    ]) {
      expect(isFormFillRequest(text), text).toBe(false);
    }
  });
});

describe('placeholderNames', () => {
  it('양식이 요구하는 자리를 모은다', () => {
    expect(placeholderNames('작성자: {{작성자}} / 부서: {{ 부서 }}')).toEqual(['작성자', '부서']);
  });

  it('같은 자리가 여러 번 나와도 한 번만 센다', () => {
    expect(placeholderNames('{{날짜}} ... {{날짜}}')).toEqual(['날짜']);
  });

  it('자리 표시가 아닌 중괄호는 무시한다', () => {
    expect(placeholderNames('{ 그냥 중괄호 } 와 {{}} 빈 것')).toEqual([]);
  });
});

/**
 * 양식을 채울 근거를 모으는 쪽.
 *
 * 여기서 문서가 조용히 빠지면 **빈 양식이 나오는데 이유를 알 수 없다.** 예전에는
 * `readdir` 순서로 앞 6개만 읽어서, 문서 14개 중 8개가 말없이 빠져 있었다. 그날 결과가
 * 멀쩡했던 건 필요한 기록이 우연히 앞쪽에 있었기 때문이다 — 문서 하나만 늘어도 깨진다.
 */
describe('loadSourceDocuments', () => {
  const temporary: string[] = [];
  afterEach(async () => {
    await Promise.all(
      temporary.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  async function corpus(bodies: Record<string, string>): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codegate-sources-'));
    temporary.push(dir);
    for (const [name, body] of Object.entries(bodies)) {
      await fs.writeFile(path.join(dir, name), `---\n{ "id": "${name}" }\n---\n${body}`, 'utf8');
    }
    return dir;
  }

  it('예산 안에서는 문서를 하나도 버리지 않는다', async () => {
    const dir = await corpus(
      Object.fromEntries(
        Array.from({ length: 14 }, (_, i) => [`DOC-${i}.md`, `본문${i}`]),
      ),
    );
    const loaded = await loadSourceDocuments(dir);
    for (let i = 0; i < 14; i += 1) expect(loaded, `본문${i} 가 빠졌다`).toContain(`본문${i}`);
  });

  it('파일시스템 순서와 무관하게 같은 근거를 만든다', async () => {
    const dir = await corpus({ 'DOC-B.md': '나중', 'DOC-A.md': '먼저', 'DOC-C.md': '마지막' });
    // 이름순으로 고정 — readdir 이 어떤 순서를 주든 결과가 흔들리면 안 된다.
    expect(await loadSourceDocuments(dir)).toBe('먼저\n\n---\n\n나중\n\n---\n\n마지막');
  });

  it('frontmatter 는 근거에 넣지 않는다', async () => {
    const dir = await corpus({ 'DOC-A.md': '진짜 본문' });
    const loaded = await loadSourceDocuments(dir);
    expect(loaded).toBe('진짜 본문');
    expect(loaded).not.toContain('schema');
  });

  it('예산을 넘으면 넘치는 문서만 빼고 나머지는 담는다', async () => {
    const dir = await corpus({ 'DOC-A.md': 'A'.repeat(50), 'DOC-B.md': 'B'.repeat(500) });
    const loaded = await loadSourceDocuments(dir, 100);
    expect(loaded).toContain('A'.repeat(50));
    expect(loaded).not.toContain('B'.repeat(500));
  });

  it('폴더가 없어도 터지지 않는다', async () => {
    expect(await loadSourceDocuments('/그런/경로는/없다')).toBe('');
  });
});
